"""Focused fake-network tests for the explicit public demo import command."""

from datetime import datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

MODULE_PATH = Path(__file__).with_name("import-demo-jobs.py")
SPEC = importlib.util.spec_from_file_location("demo_import", MODULE_PATH)
IMPORT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IMPORT)
NOW = datetime(2026, 10, 31, 16, tzinfo=timezone.utc)
SNAPSHOT = "2026-10-31T16:00:00Z"


def posting(identifier="job-1", **changes):
    return {
        "id": identifier, "company_id": "company-1", "company_name": "Example",
        "company_slug": "example", "title": "Engineer", "source_url": "https://employer.example/jobs/1",
        "is_active": True, "has_content": True, "tdm_reserved": False,
        "first_seen_at": int(NOW.timestamp()) - 3 * 86400,
        "last_seen_at": int(NOW.timestamp()), "locales": ["__none", "de", "en"],
        "location_direct_ids": ["zurich", "remote"], "location_names": ["Zurich", "Europe"],
        "location_types": ["onsite"], "location_geo_types": ["city", "region"],
        "employment_type": ["full_time", "made_up"], "experience_min_years": -1,
        "experience_max_years": 99, "private_trace": "never-export-this", **changes,
    }


class FakeSource:
    def __init__(self, initial=(), refresh=(), body=b"<p>Public role details.</p>", refresh_failure=False):
        self.initial = list(initial)
        self.refresh = list(refresh)
        self.body_data = body
        self.refresh_failure = refresh_failure
        self.searches = []
        self.body_calls = []

    def search(self, query):
        self.searches.append(query)
        if query["filter_by"].startswith("id:=["):
            if self.refresh_failure:
                raise IMPORT.ImportFailure("source failed with private response")
            rows = self.refresh
        else:
            rows = self.initial[:query["per_page"]]
        return {"hits": [{"document": row} for row in rows]}

    def body(self, identifier, locale):
        self.body_calls.append((identifier, locale))
        if isinstance(self.body_data, Exception):
            raise self.body_data
        return self.body_data


class PublicImportTests(unittest.TestCase):
    def test_allowlist_preserves_source_identity_and_normalizes_body_without_executable_html(self):
        body = ("<head><title>Hidden metadata</title></head><script>secret()</script><div hidden><div>Nested hidden</div>Still hidden</div><p>Useful &amp; public role.</p><p>" + "Evidence " * 30 + "</p>").encode()
        source = FakeSource([posting()], body=body)
        result = IMPORT.import_snapshot(source, SNAPSHOT, max_jobs=1, now=NOW)
        job = result["jobs"][0]
        self.assertEqual(job["firstObserved"], "2026-10-28T16:00:00.000Z")
        self.assertEqual(source.body_calls, [("job-1", "de")])
        self.assertEqual(job["locations"], [
            {"id": "zurich", "name": "Zurich", "workplace": "onsite", "geoType": "city"},
            {"id": "remote", "name": "Europe", "workplace": "unknown", "geoType": "region"},
        ])
        self.assertEqual(job["employmentTypes"], ["full_time"])
        self.assertEqual(job["experience"], {"min": None, "max": None, "openEnded": True})
        self.assertNotIn("private_trace", json.dumps(result))
        self.assertNotIn("secret", job["bodyText"])
        self.assertNotIn("hidden", job["bodyText"])
        self.assertNotIn("<", job["bodyText"])
        self.assertTrue(job["evidence"]["aiEligible"])
        self.assertEqual(job["evidence"]["bodySha256"], IMPORT.hashlib.sha256(body).hexdigest())
        self.assertEqual(job["evidence"]["normalizationVersion"], 1)

    def test_observation_times_follow_actual_query_and_body_completion(self):
        ticks = iter(NOW + timedelta(seconds=second) for second in range(4))
        result = IMPORT.import_snapshot(FakeSource([posting()], body=b""), SNAPSHOT, max_jobs=1, now=lambda: next(ticks))
        job = result["jobs"][0]
        self.assertEqual(job["evidence"]["metadataFetchedAt"], "2026-10-31T16:00:01.000Z")
        self.assertEqual(job["evidence"]["bodyFetchedAt"], "2026-10-31T16:00:02.000Z")
        self.assertEqual(result["verifiedAt"], "2026-10-31T16:00:03.000Z")
        self.assertIsNone(job["bodyText"])
        self.assertIsNone(job["evidence"]["textSha256"])
        self.assertFalse(job["evidence"]["aiEligible"])

    def test_closed_reserved_missing_and_failed_refresh_have_different_observations(self):
        previous = {"jobs": [{"id": value} for value in ("closed", "reserved", "missing")]}
        source = FakeSource(refresh=[posting("closed", is_active=False), posting("reserved", tdm_reserved=True)])
        result = IMPORT.import_snapshot(source, SNAPSHOT, max_jobs=1, previous=previous, now=NOW)
        self.assertEqual(result["unknownIds"], ["missing"])
        self.assertEqual(result["observations"], [
            {"id": "closed", "active": False, "reserved": False, "observedAt": "2026-10-31T16:00:00.000Z"},
            {"id": "reserved", "active": True, "reserved": True, "observedAt": "2026-10-31T16:00:00.000Z"},
        ])
        refresh = source.searches[-1]
        self.assertTrue(refresh["filter_by"].startswith("id:=["))
        self.assertNotIn("is_active", refresh["filter_by"])
        self.assertNotIn("first_seen_at", refresh["filter_by"])
        failed = IMPORT.import_snapshot(FakeSource(refresh_failure=True), SNAPSHOT, max_jobs=1, previous=previous, now=NOW)
        self.assertEqual(failed["unknownIds"], ["closed", "missing", "reserved"])
        self.assertEqual(failed["observations"], [])

    def test_duplicate_and_out_of_window_source_rows_never_reset_discovery_time(self):
        source = FakeSource([posting("old", first_seen_at=int(NOW.timestamp()) - 15 * 86400), posting("future", first_seen_at=int(NOW.timestamp()) + 1), posting("job-1"), posting("job-1")])
        result = IMPORT.import_snapshot(source, SNAPSHOT, max_jobs=4, now=NOW)
        self.assertEqual([row["id"] for row in result["jobs"]], ["job-1"])
        self.assertLessEqual(result["selection"]["initialReturnedDocuments"], 1000)
        query = source.searches[0]
        self.assertEqual(query["group_by"], "company_id")
        self.assertEqual(query["group_limit"], 1)
        self.assertEqual(set(query["include_fields"].split(",")), set(IMPORT.SOURCE_FIELDS))
        self.assertIn("tdm_reserved:!=true", query["filter_by"])

    def test_body_failures_do_not_fabricate_ai_evidence(self):
        cases = ((b"x" * (IMPORT.BODY_LIMIT + 1), "body_too_large", True), (b"\xff", "body_invalid_utf8", False), (b"<p>Short</p>", None, False))
        for body, error, truncated in cases:
            with self.subTest(error=error):
                result = IMPORT.import_snapshot(FakeSource([posting()], body=body), SNAPSHOT, max_jobs=1, now=NOW)
                evidence = result["jobs"][0]["evidence"]
                self.assertEqual(evidence["bodyError"], error)
                self.assertEqual(evidence["truncated"], truncated)
                self.assertFalse(evidence["aiEligible"])

    def test_invalid_source_identity_and_dangerous_source_url_are_dropped(self):
        source = FakeSource([posting("../escape"), posting("url", source_url="javascript:alert(1)"), posting("reserved", tdm_reserved=True), posting("unknown-reservation", tdm_reserved=None)])
        result = IMPORT.import_snapshot(source, SNAPSHOT, max_jobs=4, now=NOW)
        self.assertEqual(result["jobs"], [])
        self.assertEqual(source.body_calls, [])

    def test_refresh_batches_at_250_and_returns_unknown_without_false_closures(self):
        previous = {"jobs": [{"id": f"known-{index}"} for index in range(251)]}
        source = FakeSource()
        result = IMPORT.import_snapshot(source, SNAPSHOT, max_jobs=1, previous=previous, now=NOW)
        refresh = [query for query in source.searches if query["filter_by"].startswith("id:=[")]
        self.assertEqual(len(refresh), 2)
        self.assertTrue(all(query["per_page"] <= 250 for query in refresh))
        self.assertEqual(len(result["unknownIds"]), 251)
        self.assertEqual(result["observations"], [])

    def test_network_target_must_match_approved_https_host_and_redirects_are_refused(self):
        client = IMPORT.PublicClient("public-search.example")
        for response in (
            {"apiKey": "not-a-real-key", "host": "127.0.0.1", "protocol": "https", "port": 443},
            {"apiKey": "not-a-real-key", "host": "public-search.example", "protocol": "http", "port": 443},
        ):
            with patch.object(client, "json", return_value=response):
                with self.assertRaisesRegex(IMPORT.ImportFailure, "approved HTTPS host"):
                    client.search({})
        with self.assertRaises(IMPORT.ImportFailure):
            client.fetch("https://private.example/secret")
        with self.assertRaises(IMPORT.ImportFailure):
            IMPORT.NoRedirect().redirect_request(None, None, 302, "", {}, "https://private.example")

    def test_aggregate_body_and_file_limits_keep_metadata_and_preserve_prior_export(self):
        body = ("<p>" + "é" * 200 + "</p>").encode()
        source = FakeSource([posting("first"), posting("second")], body=body)
        with patch.object(IMPORT, "BODY_BUDGET_LIMIT", 400):
            result = IMPORT.import_snapshot(source, SNAPSHOT, max_jobs=2, now=NOW)
        self.assertEqual(len(result["jobs"]), 2)
        self.assertEqual(result["selection"]["bodyTextRetainedBytes"], 400)
        second = result["jobs"][1]
        self.assertIsNone(second["bodyText"])
        self.assertIsNone(second["evidence"]["textSha256"])
        self.assertFalse(second["evidence"]["aiEligible"])
        self.assertEqual(second["evidence"]["bodyError"], "body_budget_exceeded")
        self.assertFalse(second["evidence"]["truncated"])
        self.assertEqual(len(source.body_calls), 1)
        with tempfile.TemporaryDirectory() as root:
            output = Path(root) / "prior.json"
            output.write_text('{"prior":true}')
            with patch.object(IMPORT, "EXPORT_LIMIT", 8):
                with self.assertRaises(IMPORT.ImportFailure):
                    IMPORT.export_snapshot(result, output, checkout=Path(root) / "checkout")
                with self.assertRaises(IMPORT.ImportFailure):
                    IMPORT.read_previous(output)
            self.assertEqual(output.read_text(), '{"prior":true}')
            self.assertEqual(list(Path(root).glob(".justup-import-*")), [])

    def test_exports_are_private_atomic_files_outside_checkout(self):
        with tempfile.TemporaryDirectory() as root:
            checkout = Path(root) / "checkout"
            checkout.mkdir()
            with self.assertRaisesRegex(IMPORT.ImportFailure, "outside"):
                IMPORT.export_snapshot({"jobs": []}, checkout / "public.json", checkout=checkout)
            output = Path(root) / "private.json"
            IMPORT.export_snapshot({"jobs": []}, output, checkout=checkout)
            self.assertEqual(json.loads(output.read_text()), {"jobs": []})
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            self.assertEqual(list(Path(root).glob(".justup-import-*")), [])


if __name__ == "__main__":
    unittest.main()
