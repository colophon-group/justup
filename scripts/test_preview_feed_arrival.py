"""Offline release attribution with real Jobseek adaptation and Justup SQLite."""

from contextlib import closing
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

import test_import_jobs as fixtures


SCRIPT = Path(__file__).with_name("verify-feed-arrival.py")
SPEC = importlib.util.spec_from_file_location("preview_feed_arrival", SCRIPT)
PROOF = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROOF)
APP = SCRIPT.parent.parent
BUILD = "a" * 64
FIRST = "2026-10-31T16:00:20.123Z"
BASELINE = "2026-10-31T16:00:10.000Z"
CANONICAL = "https://employer.example/careers/%C3%A9"


def retain(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    path.chmod(0o600)
    return hashlib.sha256(path.read_bytes()).hexdigest()


class PreviewFeedArrival(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.directory.cleanup)
        root = Path(cls.directory.name).resolve()
        cls.producer = root / "producer"
        cls.receipts = root / "receipts"
        cls.receipts.mkdir(mode=0o700)
        cls.candidate = root / "arrived.json"
        cls.database = root / "committed.sqlite"
        cls.browser = root / "browser.json"
        posting = fixtures.feed_posting(fixtures.JOB_B, sourceUrl="https://EMPLOYER.example:443/careers/é",
                                        firstSeenAt="2026-10-31T16:00:20.123456Z",
                                        lastSeenAt="2026-10-31T16:00:21.000Z",
                                        updatedAt="2026-10-31T16:00:21.000Z")
        baseline, first = fixtures.write_feed_bundle(cls.producer, [fixtures.feed_posting()], batch_id="1" * 32)
        partial, second = fixtures.write_feed_bundle(cls.producer, [posting], batch_id="2" * 32, kind="changes",
                                                      from_cursor=first["toCursor"], complete=False,
                                                      cutoff="2026-10-31T16:01:00.345678Z", source_count=2)
        replacement, third = fixtures.write_feed_bundle(cls.producer, [
            {**posting, "title": "Senior Engineer", "updatedAt": "2026-10-31T16:01:15.000Z"},
        ], batch_id="3" * 32, kind="changes", from_cursor=second["toCursor"], complete=False,
            cutoff="2026-10-31T16:01:20.654321Z", source_count=2)
        arrived, last = fixtures.write_feed_bundle(cls.producer, [], batch_id="4" * 32, kind="changes",
                                                    from_cursor=third["toCursor"],
                                                    cutoff="2026-10-31T16:01:30.123456Z", source_count=2)
        importer = fixtures.IMPORT
        before = importer.import_feed_bundle(baseline, now=fixtures.NOW)
        staged = importer.import_feed_bundle(partial, previous=before, now=importer.utc(second["cutoffAt"]))
        staged = importer.import_feed_bundle(replacement, previous=staged, now=importer.utc(third["cutoffAt"]))
        final = importer.import_feed_bundle(arrived, previous=staged, now=importer.utc(last["cutoffAt"]))
        retained_sha = retain(cls.candidate, final)
        committed = root / "application.sqlite"
        result = subprocess.run(
            ["node", "--input-type=module", "--eval", """
import { readFileSync } from 'node:fs';
import { openStore } from './server/store.mjs';
const store = openStore(process.argv[1]);
try {
  const [baseline, arrived] = JSON.parse(readFileSync(0, 'utf8'));
  process.stdout.write(JSON.stringify([baseline, arrived].map(snapshot => store.importSnapshot(snapshot).generation)));
} finally { store.close(); }
""", str(committed)], input=json.dumps([before, final]), capture_output=True, text=True, cwd=APP, check=True, timeout=10,
        )
        with closing(sqlite3.connect(committed)) as live, closing(sqlite3.connect(cls.database)) as db:
            live.backup(db)
        cls.database.chmod(0o600)
        baseline_generation, final_generation = json.loads(result.stdout)
        accepted = []
        for path, manifest in ((baseline, first), (partial, second), (replacement, third), (arrived, last)):
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            accepted.append({"manifest": str(path.relative_to(cls.producer)), "sha256": digest,
                             "acceptedAt": manifest["cutoffAt"], "backupVerifiedAt": None})
            retain(cls.receipts / f"{path.parent.name}.json", {"schemaVersion": 1, "manifestSha256": digest})
            retain(cls.receipts / f"{path.parent.name}-candidate.json", {"schemaVersion": 1, "manifestSha256": digest,
                   "candidateSha256": retained_sha if path == arrived else "b" * 64,
                   "buildIdentity": BUILD if path != baseline else "c" * 64})
        cls.partial_digest = accepted[2]["sha256"]
        cls.arrival_digest = accepted[3]["sha256"]
        retain(cls.producer / "state.json", {"schemaVersion": 1, "cursor": last["toCursor"], "scope": last["scope"],
                                            "pending": None, "accepted": accepted})
        retain(cls.browser, {"liveArrival": {
            "baselineGeneration": baseline_generation, "baselineAsOf": BASELINE,
            "arrivalGeneration": final_generation, "firstObserved": FIRST, "observedAfterMs": 80_000,
            "sourcePostingSha256": hashlib.sha256(json.dumps([fixtures.JOB_B, CANONICAL, FIRST], separators=(",", ":")).encode()).hexdigest(),
            "readerPreserved": True, "sourceCommit": "d" * 40, "frontendArtifactSha256": "e" * 64,
            "apiBuildIdentity": BUILD, "runnerIdentity": "fixed-preview-runner",
        }})

    def run_proof(self):
        return PROOF.verify(self.browser, self.producer, self.receipts, self.database, self.candidate)

    def restore(self, path):
        self.addCleanup(path.write_bytes, path.read_bytes())
        return json.loads(path.read_text())

    def test_reports_the_partial_source_and_the_exact_complete_import_without_private_content(self):
        result = self.run_proof()
        self.assertTrue(result["passed"])
        self.assertFalse(result["completeReleaseGate"])
        self.assertEqual(result["acceptedBatches"], 4)
        self.assertEqual(result["completeImports"], 2)
        self.assertEqual(result["postingSourceManifestSha256"], self.partial_digest)
        self.assertEqual(result["arrivalManifestSha256"], self.arrival_digest)
        for private in (CANONICAL, fixtures.JOB_B, "Verifiable public role details"):
            self.assertNotIn(private, json.dumps(result))

    def test_refuses_a_partial_batch_without_both_durable_acknowledgements(self):
        path = self.receipts / f"batch-{'2' * 32}.json"
        receipt = self.restore(path)
        receipt["manifestSha256"] = "f" * 64
        retain(path, receipt)
        with self.assertRaisesRegex(PROOF.source.ImportFailure, "durable consumer receipt"):
            self.run_proof()

    def test_refuses_a_history_that_skips_a_cursor_link(self):
        path = self.producer / "state.json"
        state = self.restore(path)
        state["accepted"].pop(1)
        retain(path, state)
        with self.assertRaisesRegex(PROOF.source.ImportFailure, "cursor chain"):
            self.run_proof()

    def test_a_partial_cursor_must_describe_the_last_hashed_row(self):
        batch = f"batch-{'2' * 32}"
        manifest_path = self.producer / batch / "manifest.json"
        manifest = self.restore(manifest_path)
        manifest["toCursor"]["updatedAt"] = "2026-10-31T16:00:22.000Z"
        digest = retain(manifest_path, manifest)
        for name in (f"{batch}.json", f"{batch}-candidate.json"):
            path = self.receipts / name
            value = self.restore(path)
            value["manifestSha256"] = digest
            retain(path, value)
        state_path = self.producer / "state.json"
        state = self.restore(state_path)
        state["accepted"][1]["sha256"] = digest
        retain(state_path, state)
        with self.assertRaisesRegex(PROOF.source.ImportFailure, "Partial feed batch cursor differs from its final row"):
            self.run_proof()

    def test_checks_every_part_against_the_accepted_manifest(self):
        path = self.producer / f"batch-{'2' * 32}" / "part-0001.json"
        part = self.restore(path)
        part["rows"][0]["title"] = "Changed after acknowledgement"
        retain(path, part)
        with self.assertRaisesRegex(PROOF.source.ImportFailure, "part digest"):
            self.run_proof()

    def test_refuses_a_candidate_from_a_different_build(self):
        path = self.receipts / f"batch-{'4' * 32}-candidate.json"
        marker = self.restore(path)
        marker["buildIdentity"] = "f" * 64
        retain(path, marker)
        with self.assertRaisesRegex(PROOF.source.ImportFailure, "another API build"):
            self.run_proof()

    def test_refuses_normalized_candidate_bytes_outside_the_acceptance_marker(self):
        candidate = self.restore(self.candidate)
        candidate["jobs"][0]["title"] = "Another normalized candidate"
        retain(self.candidate, candidate)
        with self.assertRaisesRegex(PROOF.source.ImportFailure, "differs from its acceptance marker"):
            self.run_proof()

    def test_requires_the_final_posting_evidence_to_match_the_exact_source_cutoff(self):
        candidate = self.restore(self.candidate)
        job = next(item for item in candidate["jobs"] if item["id"] == fixtures.JOB_B)
        job["evidence"]["metadataFetchedAt"] = "2026-10-31T16:01:20.654999Z"
        path = self.receipts / f"batch-{'4' * 32}-candidate.json"
        marker = self.restore(path)
        marker["candidateSha256"] = retain(self.candidate, candidate)
        retain(path, marker)
        with self.assertRaisesRegex(PROOF.source.ImportFailure, "does not support the observed public posting"):
            self.run_proof()

    def test_every_complete_application_import_in_the_window_needs_a_source_receipt(self):
        backup = self.database.with_name("extra-generation.sqlite")
        self.addCleanup(backup.unlink)
        with closing(sqlite3.connect(self.database)) as source, closing(sqlite3.connect(backup)) as db:
            source.backup(db)
            with db:
                db.execute("UPDATE justup_imports SET rowid=3 WHERE rowid=2")
                db.execute("""
                    INSERT INTO justup_imports(rowid, generation, snapshot_at, verified_at, imported_count, selection_json, unknown_count)
                    SELECT 2, 'unrelated-import', snapshot_at, verified_at, imported_count, selection_json, unknown_count
                    FROM justup_imports WHERE rowid=1
                """)
        backup.chmod(0o600)
        with self.assertRaisesRegex(PROOF.source.ImportFailure, "committed generation differs"):
            PROOF.verify(self.browser, self.producer, self.receipts, backup, self.candidate)

    def test_command_rejects_a_posting_digest_mismatch_without_disclosing_inputs(self):
        report = self.restore(self.browser)
        report["liveArrival"]["sourcePostingSha256"] = "f" * 64
        retain(self.browser, report)
        result = subprocess.run([sys.executable, str(SCRIPT), "--browser", str(self.browser), "--producer", str(self.producer),
                                 "--receipts", str(self.receipts), "--database", str(self.database),
                                 "--candidate", str(self.candidate)], capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertIn("absent or ambiguous", result.stderr)
        self.assertNotIn(str(self.browser), result.stderr)

    def test_does_not_open_a_database_with_live_sidecars(self):
        wal = self.database.with_name(self.database.name + "-wal")
        wal.touch()
        self.addCleanup(wal.unlink)
        with self.assertRaisesRegex(PROOF.source.ImportFailure, "standalone preview database backup"):
            self.run_proof()

    def test_rejects_a_named_pipe_without_waiting_for_a_writer(self):
        fifo = self.browser.with_name("browser-fifo")
        os.mkfifo(fifo, 0o600)
        self.addCleanup(fifo.unlink)
        result = subprocess.run([sys.executable, str(SCRIPT), "--browser", str(fifo), "--producer", str(self.producer),
                                 "--receipts", str(self.receipts), "--database", str(self.database),
                                 "--candidate", str(self.candidate)], capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 1)
        self.assertIn("private and regular", result.stderr)
