#!/usr/bin/env python3
"""Join a browser arrival with protected Jobseek and Justup import evidence."""

import argparse
from contextlib import closing
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import subprocess
import sys


spec = importlib.util.spec_from_file_location("job_import", Path(__file__).with_name("import-jobs.py"))
source = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source)
SHA = re.compile(r"[a-f0-9]{64}")
BATCH = re.compile(r"batch-[a-f0-9]{32}/manifest\.json")
ZERO_UUID = "00000000-0000-0000-0000-000000000000"
EPOCH = datetime.fromtimestamp(0, timezone.utc)
BROWSER_FIELDS = {
    "baselineGeneration", "baselineAsOf", "arrivalGeneration", "firstObserved",
    "sourcePostingSha256", "observedAfterMs", "readerPreserved", "sourceCommit",
    "frontendArtifactSha256", "apiBuildIdentity", "runnerIdentity",
}


def require(condition, reason):
    if not condition:
        raise source.ImportFailure(reason)


def read_json(path, limit):
    return source._feed_json(source._private_file(path, limit))


def milliseconds(value):
    return (value - EPOCH) // timedelta(milliseconds=1)


def arrival_observation(path):
    report = read_json(path, 8192)
    observation = report.get("liveArrival") if isinstance(report, dict) and set(report) == {"liveArrival"} else None
    require(isinstance(observation, dict) and set(observation) == BROWSER_FIELDS
            and observation["readerPreserved"] is True
            and type(observation["observedAfterMs"]) is int and 0 <= observation["observedAfterMs"] <= 150_000
            and all(isinstance(observation[key], str) for key in BROWSER_FIELDS - {"readerPreserved", "observedAfterMs"}),
            "Expected one successful deployed-browser arrival record.")
    require(all(SHA.fullmatch(observation[key]) for key in ("sourcePostingSha256", "apiBuildIdentity", "frontendArtifactSha256"))
            and re.fullmatch(r"[a-f0-9]{40}", observation["sourceCommit"])
            and re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", observation["runnerIdentity"])
            and observation["baselineGeneration"] != observation["arrivalGeneration"],
            "Browser candidate or import identity is invalid.")
    first = source.utc(observation["firstObserved"])
    baseline = source.utc(observation["baselineAsOf"])
    require(source.iso(first) == observation["firstObserved"] and source.iso(baseline) == observation["baselineAsOf"]
            and first > baseline, "The browser record does not establish a new observation.")
    return observation


def import_records(path, baseline, arrival):
    # Use a retained, consistent backup. Immutable read mode never opens the
    # live WAL or creates shared-memory files. Query only import metadata.
    require(path.is_absolute() and path.resolve(strict=True) == path
            and not any(path.with_name(path.name + suffix).exists() or path.with_name(path.name + suffix).is_symlink()
                        for suffix in ("-wal", "-shm", "-journal")),
            "Supply a canonical standalone preview database backup.")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as handle:
        info = os.fstat(handle.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1
                and info.st_mode & 0o077 == 0 and handle.read(16) == b"SQLite format 3\0",
                "The preview database backup must be private and regular.")
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True)) as database:
        rows = database.execute("""
            SELECT generation, snapshot_at, verified_at, imported_count,
                   CASE WHEN length(selection_json) <= 16384 THEN selection_json END
            FROM justup_imports
            WHERE rowid BETWEEN (SELECT rowid FROM justup_imports WHERE generation=?)
                          AND (SELECT rowid FROM justup_imports WHERE generation=?)
            ORDER BY rowid LIMIT 33
        """, (baseline, arrival)).fetchall()
    require(2 <= len(rows) <= 32 and rows[0][0] == baseline and rows[-1][0] == arrival,
            "The backup does not contain the complete observed import interval.")
    imports = []
    for _, snapshot, verified, count, raw in rows:
        require(isinstance(raw, str), "Invalid observed import metadata.")
        selection = source._feed_json(raw.encode("utf-8"))
        feed = selection.get("feed") if isinstance(selection, dict) else None
        require(isinstance(feed, dict) and selection.get("source") == "jobseek_feed_v1"
                and isinstance(feed.get("manifestSha256"), str) and SHA.fullmatch(feed["manifestSha256"])
                and feed.get("complete") is True and type(count) is int and 0 <= count <= source.MAX_JOBS,
                "An observed generation is not a complete private Jobseek import.")
        imports.append((snapshot, verified, count, selection))
    return imports


def accepted_window(directory, baseline_sha, arrival_sha):
    state = read_json(directory / "state.json", 1024 * 1024)
    accepted = state.get("accepted") if isinstance(state, dict) and state.get("schemaVersion") == 1 else None
    require(isinstance(accepted, list) and 2 <= len(accepted) <= 4096, "Invalid accepted Jobseek producer history.")
    for entry in accepted:
        require(isinstance(entry, dict) and set(entry) == {"manifest", "sha256", "acceptedAt", "backupVerifiedAt"}
                and isinstance(entry["manifest"], str) and BATCH.fullmatch(entry["manifest"])
                and isinstance(entry["sha256"], str) and SHA.fullmatch(entry["sha256"]),
                "Invalid accepted Jobseek producer entry.")
    digests = [entry["sha256"] for entry in accepted]
    require(len(set(digests)) == len(digests) and len({entry["manifest"] for entry in accepted}) == len(accepted)
            and baseline_sha in digests and arrival_sha in digests and digests.index(baseline_sha) < digests.index(arrival_sha),
            "The producer history does not acknowledge the two observed imports in order.")
    return accepted[digests.index(baseline_sha):digests.index(arrival_sha) + 1]


def candidate_posting(path, marker, observation, arrival):
    data = source._private_file(path, source.EXPORT_LIMIT)
    require(hashlib.sha256(data).hexdigest() == marker, "The retained normalized candidate differs from its acceptance marker.")
    output = source._feed_json(data)
    require(isinstance(output, dict) and output.get("schemaVersion") == 1 and output.get("selection") == arrival[3]
            and milliseconds(source.utc(output.get("snapshotAt"))) == arrival[0]
            and milliseconds(source.utc(output.get("verifiedAt"))) == arrival[1]
            and isinstance(output.get("jobs"), list) and len(output["jobs"]) == arrival[2],
            "The normalized candidate does not match the observed database import.")
    # The API uses WHATWG URL serialization. Use the same runtime for the
    # already-imported public tuple and pass no titles or bodies to it.
    jobs = []
    for row in output["jobs"]:
        if row.get("firstObserved") == observation["firstObserved"]:
            require(all(isinstance(row.get(key), str) and len(row[key]) <= 2048
                        for key in ("id", "sourceUrl", "companyId")), "Invalid normalized public posting.")
            jobs.append([row["id"], row["sourceUrl"], row["firstObserved"], row["companyId"]])
    node = shutil.which("node")
    require(node is not None, "Use the reviewed preview Node runtime.")
    match = subprocess.run(
        [node, "--input-type=module", "--eval", """
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const { jobs, expected } = JSON.parse(readFileSync(0, 'utf8'));
const found = jobs.filter(([id, url, first]) =>
  createHash('sha256').update(JSON.stringify([id, new URL(url).href, first])).digest('hex') === expected);
process.stdout.write(JSON.stringify(found.length === 1 ? found[0] : null));
"""],
        input=json.dumps({"jobs": jobs, "expected": observation["sourcePostingSha256"]}),
        encoding="utf-8", capture_output=True, timeout=10, check=True, env={},
    )
    target = json.loads(match.stdout)
    require(target is not None, "The arrived posting is absent or ambiguous in the accepted normalized candidate.")
    return target


def batch_marker(receipts, batch_name, digest):
    marker = read_json(receipts / f"{batch_name}-candidate.json", 1024)
    require(isinstance(marker, dict) and set(marker) == {"schemaVersion", "manifestSha256", "candidateSha256", "buildIdentity"}
            and marker["schemaVersion"] == 1 and marker["manifestSha256"] == digest
            and all(isinstance(marker[key], str) and SHA.fullmatch(marker[key]) for key in ("candidateSha256", "buildIdentity")),
            "Invalid Justup candidate acceptance marker.")
    return marker


def verify(browser, producer, receipts, database, candidate):
    observation = arrival_observation(browser)
    imports = import_records(database, observation["baselineGeneration"], observation["arrivalGeneration"])
    baseline_sha = imports[0][3]["feed"]["manifestSha256"]
    arrival_sha = imports[-1][3]["feed"]["manifestSha256"]
    window = accepted_window(producer, baseline_sha, arrival_sha)
    arrival_batch = Path(window[-1]["manifest"]).parent.name
    final_marker = batch_marker(receipts, arrival_batch, arrival_sha)
    require(final_marker["buildIdentity"] == observation["apiBuildIdentity"],
            "The arrived import belongs to another API build.")
    target_id, target_url, target_first, target_company = candidate_posting(candidate, final_marker["candidateSha256"], observation, imports[-1])
    scope = imports[0][3]["feed"].get("scope")
    limit = imports[0][3]["feed"].get("limit")
    full_at = source.utc(imports[0][3]["feed"].get("fullSnapshotAt"))
    baseline_time = source.utc(observation["baselineAsOf"])
    previous = None
    justified_by = None
    imported = 0
    for entry in window:
        path = producer / entry["manifest"]
        manifest, rows, digest = source.read_feed_bundle(path)
        batch = path.parent.name
        cutoff = source.utc(manifest["cutoffAt"])
        require(entry["sha256"] == digest and source.utc(entry["acceptedAt"]) >= cutoff
                and read_json(receipts / f"{batch}.json", 512) == {"schemaVersion": 1, "manifestSha256": digest},
                "An exact producer manifest or durable consumer receipt is missing.")
        if previous is not None and digest != arrival_sha:
            require(batch_marker(receipts, batch, digest)["buildIdentity"] == observation["apiBuildIdentity"],
                    "A scheduled batch belongs to another API build.")
        require(manifest["scope"] == scope and (previous is None or (
            source._feed_cursor(manifest["toCursor"]) > source._feed_cursor(previous["toCursor"])
            and cutoff >= source.utc(previous["cutoffAt"])
            and (manifest["fromCursor"] == previous["toCursor"] if manifest["kind"] == "changes"
                 else previous["complete"] and manifest["fromCursor"] is None))),
                "The accepted source history changes scope or breaks the cursor chain.")
        end = source._feed_cursor(manifest["toCursor"])
        require((manifest["complete"] and end == (cutoff, ZERO_UUID))
                or (not manifest["complete"] and manifest["kind"] == "changes" and end[0] < cutoff),
                "Source completion and cursor cutoff disagree.")
        if manifest["kind"] == "snapshot":
            full_at = cutoff
            justified_by = None
        if manifest["complete"]:
            require(imported < len(imports), "A complete source batch is missing from the observed database history.")
            snapshot, verified, _, selection = imports[imported]
            feed = selection["feed"]
            require(feed["manifestSha256"] == digest and feed.get("cursor") == manifest["toCursor"]
                    and feed.get("scope") == scope and feed.get("limit") == limit
                    and feed.get("fullSnapshotAt") == source.iso(full_at)
                    and selection.get("sourceScopeRowCount") == manifest["sourceScopeRowCount"]
                    and snapshot == verified == milliseconds(cutoff)
                    and full_at <= cutoff < full_at + timedelta(days=1)
                    and (imported != 0 or cutoff <= baseline_time < full_at + timedelta(days=1)),
                    "A committed generation differs from the accepted complete source selection.")
            imported += 1
        found = False
        for row in rows:
            if row.get("id") != target_id:
                continue
            require(not found, "The source batch repeats the arrived posting.")
            found = True
            first, _ = source._feed_row(row, cutoff)
            require(previous is not None, "The arrived posting already appears in the baseline source batch.")
            if (row["active"] and not row["reserved"] and row["hasContent"] and row["companyId"] == target_company
                    and row["sourceUrl"] == target_url and source.iso(first) == target_first
                    and baseline_time < first <= cutoff):
                justified_by = justified_by or digest
            else:
                justified_by = None
        require(not (manifest["complete"] and digest != arrival_sha and justified_by is not None),
                "An earlier complete batch makes the posting's arrival generation ambiguous.")
        previous = manifest
    require(imported == len(imports) and justified_by is not None,
            "The complete import interval does not support the observed public posting.")
    return {"schemaVersion": 1, "scope": "scheduled_feed_arrival", "passed": True, "completeReleaseGate": False,
            "sourceCommit": observation["sourceCommit"], "frontendArtifactSha256": observation["frontendArtifactSha256"],
            "apiBuildIdentity": observation["apiBuildIdentity"], "runnerIdentity": observation["runnerIdentity"],
            "baselineGeneration": observation["baselineGeneration"], "arrivalGeneration": observation["arrivalGeneration"],
            "baselineManifestSha256": baseline_sha, "arrivalManifestSha256": arrival_sha,
            "postingSourceManifestSha256": justified_by, "sourcePostingSha256": observation["sourcePostingSha256"],
            "acceptedBatches": len(window), "completeImports": imported}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for field in ("browser", "producer", "receipts", "database", "candidate"):
        parser.add_argument(f"--{field}", type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(verify(**vars(args)), sort_keys=True))
    except source.ImportFailure as error:
        print(error, file=sys.stderr)
        return 1
    except (OSError, ValueError, KeyError, TypeError, AttributeError, OverflowError, RecursionError,
            sqlite3.Error, subprocess.SubprocessError):
        print("Could not verify the protected feed arrival evidence.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
