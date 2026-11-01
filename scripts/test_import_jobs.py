"""Focused fake-network tests for the explicit public job import command."""

from datetime import datetime, timedelta, timezone
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

MODULE_PATH = Path(__file__).with_name("import-jobs.py")
SPEC = importlib.util.spec_from_file_location("job_import", MODULE_PATH)
IMPORT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IMPORT)
NOW = datetime(2026, 10, 31, 16, tzinfo=timezone.utc)
SNAPSHOT = "2026-10-31T16:00:00Z"
COMPANY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
COMPANY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
COMPANY_OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"


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
    def __init__(self, initial=(), refresh=(), body=b"<p>Public role details.</p>", refresh_failure=False, companies=()):
        self.initial = list(initial)
        self.refresh = list(refresh)
        self.body_data = body
        self.refresh_failure = refresh_failure
        self.companies = list(companies)
        self.searches = []
        self.body_calls = []

    def search(self, query):
        self.searches.append(query)
        if query["collection"] == "company":
            return {"hits": [{"document": row} for row in self.companies]}
        if query["filter_by"].startswith("id:=["):
            if self.refresh_failure:
                raise IMPORT.ImportFailure("source failed with private response")
            rows = self.refresh
        else:
            start = (query.get("page", 1) - 1) * query["per_page"]
            rows = self.initial[start:start + query["per_page"]]
        return {"hits": [{"document": row} for row in rows]}

    def body(self, identifier, locale):
        self.body_calls.append((identifier, locale))
        if isinstance(self.body_data, Exception):
            raise self.body_data
        return self.body_data


class FakePublicHttp:
    """Exercise PublicClient request encoding and bounds without network access."""

    def __init__(self, respond):
        self.respond = respond
        self.searches = []
        self.body_calls = []
        self.client = IMPORT.PublicClient("public-search.example")
        self.client.opener = self

    def open(self, request, timeout):
        if request.full_url == IMPORT.BOOTSTRAP_URL:
            result = {"apiKey": "synthetic-scoped-key", "host": "public-search.example", "protocol": "https", "port": 443}
        elif request.full_url == "https://public-search.example/multi_search":
            query, = json.loads(request.data)["searches"]
            self.searches.append(query)
            result = {"results": [self.respond(query)]}
        elif request.full_url.startswith(IMPORT.ASSET_ORIGIN + "/job/"):
            self.body_calls.append(request.full_url.split("/job/")[1].split("/")[0])
            return io.BytesIO(b"<p>Synthetic public description.</p>")
        else:
            raise AssertionError("Unexpected public client destination")
        return io.BytesIO(json.dumps(result).encode("utf-8"))


class PublicImportTests(unittest.TestCase):
    def test_company_selector_requires_bounded_unique_canonical_uuids_and_exact_schema(self):
        maximum = [f"00000000-0000-4000-8000-{index:012x}" for index in range(100)]
        invalid = [
            {}, {"schemaVersion": True, "companyIds": [COMPANY_A]},
            {"schemaVersion": 2, "companyIds": [COMPANY_A]},
            {"schemaVersion": 1, "companyIds": [COMPANY_A], "filter": "*"},
            *({"schemaVersion": 1, "companyIds": values} for values in (
                [], maximum + [COMPANY_A], [COMPANY_A, COMPANY_A],
                [COMPANY_A.upper()], [" " + COMPANY_A], [COMPANY_A + "`,other`"],
                ["company-1"], [None], [{}], COMPANY_A,
            )),
        ]
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "selector.json"
            for values in ([COMPANY_B, COMPANY_A], maximum):
                path.write_text(json.dumps({"schemaVersion": 1, "companyIds": values}))
                self.assertEqual(IMPORT.read_company_ids(path), sorted(values))
            for value in invalid:
                with self.subTest(value=value):
                    path.write_text(json.dumps(value))
                    with self.assertRaises(IMPORT.ImportFailure):
                        IMPORT.read_company_ids(path)
            for data in (b"{", b"\xff", b"[" * 1100, b" " * (IMPORT.COMPANY_SELECTOR_LIMIT + 1),
                         ('{"schemaVersion":1,"companyIds":[],"companyIds":["' + COMPANY_A + '"]}').encode()):
                path.write_bytes(data)
                with self.assertRaises(IMPORT.ImportFailure):
                    IMPORT.read_company_ids(path)
            path.write_text(json.dumps({"schemaVersion": 1, "companyIds": [COMPANY_A + "`,private-value`"]}))
            with patch.object(IMPORT, "PublicClient") as client, patch("sys.stderr", new_callable=io.StringIO) as errors:
                self.assertEqual(IMPORT.main(["--snapshot", SNAPSHOT, "--typesense-host", "public-search.example",
                                              "--output", str(Path(root) / "jobs.json"), "--company-ids-file", str(path)]), 1)
                client.assert_not_called()
                self.assertNotIn("private-value", errors.getvalue())

    def test_pinned_public_http_queries_escape_exact_ids_and_reject_out_of_scope_rows_before_body_fetch(self):
        def respond(query):
            if query["collection"] == "company":
                return {"hits": [{"document": {"id": COMPANY_A, "website": "https://employer.example/"}}]}
            rows = [posting("selected", company_id=COMPANY_A), posting("foreign", company_id=COMPANY_OTHER),
                    posting("malformed", company_id={"id": COMPANY_A})]
            return {"hits": [{"document": row} for row in rows[:query["per_page"]]]}

        source = FakePublicHttp(respond)
        result = IMPORT.import_snapshot(source.client, SNAPSHOT, max_jobs=12, company_ids=[COMPANY_B, COMPANY_A], now=NOW)
        self.assertEqual([job["id"] for job in result["jobs"]], ["selected"])
        self.assertEqual(result["jobs"][0]["firstObserved"], "2026-10-28T16:00:00.000Z")
        self.assertEqual(source.body_calls, ["selected"])
        membership = f"company_id:=[`{COMPANY_A}`,`{COMPANY_B}`]"
        job_queries = [query for query in source.searches if query["collection"] == "job_posting"]
        for query in job_queries:
            self.assertIn(" && " + membership, query["filter_by"])
            for required in ("is_active:=true", "has_content:=true", "tdm_reserved:!=true", "first_seen_at:>=", "first_seen_at:<="):
                self.assertIn(required, query["filter_by"])
        lookup = source.searches[-1]
        self.assertEqual(lookup["collection"], "company")
        self.assertEqual(lookup["filter_by"], f"id:=[`{COMPANY_A}`]")
        self.assertEqual(lookup["include_fields"], "id,website")
        self.assertEqual(result["companyIdentities"], [{"companyId": COMPANY_A, "officialDomain": "employer.example"}])
        self.assertEqual(result["selection"]["companySelection"], {
            "schemaVersion": 1, "requestedCount": 2, "missingCount": 1,
            "requestedSetSha256": IMPORT.hashlib.sha256(json.dumps([COMPANY_A, COMPANY_B], separators=(",", ":")).encode()).hexdigest(),
        })
        self.assertLess(len(json.dumps(result["selection"]).encode()), 8192)

    def test_pinned_empty_source_reports_missing_companies_without_global_fallback(self):
        source = FakePublicHttp(lambda query: {"hits": []})
        result = IMPORT.import_snapshot(source.client, SNAPSHOT, max_jobs=8, company_ids=[COMPANY_A, COMPANY_B], now=NOW)
        self.assertEqual(result["jobs"], [])
        self.assertEqual(result["companyIdentities"], [])
        self.assertEqual(result["selection"]["selectedCompanies"], 0)
        self.assertEqual(result["selection"]["companySelection"]["missingCount"], 2)
        self.assertTrue(source.searches)
        self.assertTrue(all("company_id:=[" in query["filter_by"] for query in source.searches))
        self.assertEqual(result["selection"]["initialReturnedDocuments"], 0)
        self.assertEqual(source.body_calls, [])

    def test_pinned_previous_ids_still_check_closures_and_unknowns_without_readding_foreign_active_jobs(self):
        def respond(query):
            rows = []
            if query["collection"] == "company":
                rows = [{"id": COMPANY_A, "website": "https://employer.example/"}]
            elif query["filter_by"].startswith("id:=["):
                rows = [posting("closed", company_id=COMPANY_OTHER, is_active=False),
                        posting("reserved", company_id=COMPANY_OTHER, tdm_reserved=True),
                        posting("foreign-active", company_id=COMPANY_OTHER),
                        posting("malformed", company_id=[]), posting("selected", company_id=COMPANY_A)]
            return {"hits": [{"document": row} for row in rows]}

        previous = {"jobs": [{"id": identifier} for identifier in ("closed", "reserved", "foreign-active", "malformed", "selected", "missing")]}
        source = FakePublicHttp(respond)
        result = IMPORT.import_snapshot(source.client, SNAPSHOT, max_jobs=8, previous=previous, company_ids=[COMPANY_A], now=NOW)
        self.assertEqual([job["id"] for job in result["jobs"]], ["selected"])
        self.assertEqual([row["id"] for row in result["observations"]], ["closed", "reserved"])
        self.assertEqual(result["unknownIds"], ["malformed", "missing"])
        self.assertEqual(source.body_calls, ["selected"])
        refresh, = [query for query in source.searches if query["collection"] == "job_posting" and query["filter_by"].startswith("id:=[")]
        self.assertNotIn("company_id", refresh["filter_by"])
        self.assertNotIn("is_active", refresh["filter_by"])
        self.assertNotIn("first_seen_at", refresh["filter_by"])
        self.assertIn("`foreign-active`", refresh["filter_by"])
        failed = IMPORT.import_snapshot(FakeSource(refresh_failure=True), SNAPSHOT, max_jobs=1,
                                        previous=previous, company_ids=[COMPANY_A], now=NOW)
        self.assertEqual(failed["unknownIds"], sorted(job["id"] for job in previous["jobs"]))
        self.assertEqual(failed["observations"], [])

    def test_pinned_public_http_pagination_keeps_existing_document_and_job_limits(self):
        def respond(query):
            if query["collection"] == "company":
                return {"hits": []}
            page, limit = query.get("page", 1), query["per_page"]
            if page == 1 and (query.get("group_by") or "location_types:=" in query["filter_by"] or "locales:=" in query["filter_by"] or query["q"] != "*" or query["filter_by"].count("first_seen_at:") > 2):
                indexes = [0]
            else:
                indexes = range((page - 1) * limit, page * limit)
            return {"hits": [{"document": posting(f"job-{index}", company_id=COMPANY_A if index % 2 else COMPANY_B)} for index in indexes]}

        source = FakePublicHttp(respond)
        result = IMPORT.import_snapshot(source.client, SNAPSHOT, max_jobs=800, company_ids=[COMPANY_A, COMPANY_B], now=NOW)
        queries = [query for query in source.searches if query["collection"] == "job_posting"]
        self.assertTrue(any(query.get("page") == 2 for query in queries))
        self.assertTrue(all(query["per_page"] <= 250 and "company_id:=[" in query["filter_by"] for query in queries))
        self.assertLessEqual(result["selection"]["initialReturnedDocuments"], 1000)
        self.assertLessEqual(len(result["jobs"]), 800)
        self.assertEqual(len({job["id"] for job in result["jobs"]}), len(result["jobs"]))
        self.assertEqual({job["companyId"] for job in result["jobs"]}, {COMPANY_A, COMPANY_B})

    def test_company_selector_cli_exports_selection_receipt_and_observed_languages(self):
        def respond(query):
            return {"hits": [] if query["collection"] == "company" else [{"document": posting(company_id=COMPANY_A)}]}

        source = FakePublicHttp(respond)
        original_import = IMPORT.import_snapshot
        with tempfile.TemporaryDirectory() as root:
            selector, output = Path(root) / "companies.json", Path(root) / "snapshot.json"
            selector.write_text(json.dumps({"schemaVersion": 1, "companyIds": [COMPANY_A, COMPANY_B]}))
            with patch.object(IMPORT, "PublicClient", return_value=source.client), patch.object(IMPORT, "import_snapshot", side_effect=lambda *args, **kwargs: original_import(*args, **kwargs, now=NOW)), patch("sys.stdout", new_callable=io.StringIO) as stdout:
                self.assertEqual(IMPORT.main(["--snapshot", SNAPSHOT, "--typesense-host", "public-search.example",
                                              "--output", str(output), "--max-jobs", "1", "--company-ids-file", str(selector)]), 0)
            snapshot, receipt = json.loads(output.read_text()), json.loads(stdout.getvalue())
            self.assertEqual(receipt["companySelection"], snapshot["selection"]["companySelection"])
            self.assertEqual(receipt["companySelection"]["missingCount"], 1)
            self.assertEqual(receipt["observedLocales"], ["de", "en"])
            self.assertNotIn("companyIds", snapshot["selection"]["companySelection"])

    def test_exact_public_company_website_supplies_domain_once_without_inferring_from_job_links(self):
        source = FakeSource([posting("one", occupation_id=23, occupation_name="Software developer"), posting("two")],
                            companies=[{"id": "company-1", "website": "https://Employer.Example/careers", "private_config": "omitted"}])
        result = IMPORT.import_snapshot(source, SNAPSHOT, max_jobs=2, now=NOW)
        self.assertNotIn("companySelection", result["selection"])
        self.assertEqual(result["companyIdentities"], [{"companyId": "company-1", "officialDomain": "employer.example"}])
        self.assertEqual(result["jobs"][0]["occupation"], {"id": "23", "name": "Software developer"})
        lookup = [query for query in source.searches if query["collection"] == "company"]
        self.assertEqual(len(lookup), 1)
        self.assertEqual(lookup[0]["include_fields"], "id,website")
        self.assertEqual(lookup[0]["filter_by"], "id:=[`company-1`]")
        self.assertNotIn("private_config", json.dumps(result))

    def test_missing_invalid_ats_ambiguous_and_failed_company_metadata_never_create_domain_aliases(self):
        for website in [None, "http://employer.example/", "https://127.0.0.1/", "https://jobs.lever.co/acme", "https://private.internal/", "https://u:p@employer.example", "https://employer.example:invalid", "https://localhost.example/"]:
            with self.subTest(website=website):
                source = FakeSource([posting()], companies=[{"id": "company-1", "website": website}])
                result = IMPORT.import_snapshot(source, SNAPSHOT, max_jobs=1, now=NOW)
                self.assertEqual(result["companyIdentities"], [])
        source = FakeSource([posting()], companies=[{"id": "company-1", "website": "https://employer.example/"}] * 2)
        self.assertEqual(IMPORT.import_snapshot(source, SNAPSHOT, max_jobs=1, now=NOW)["companyIdentities"], [])
        class Unavailable(FakeSource):
            def search(self, query):
                if query["collection"] == "company":
                    raise IMPORT.ImportFailure("private upstream failure")
                return super().search(query)
        result = IMPORT.import_snapshot(Unavailable([posting()]), SNAPSHOT, max_jobs=1, now=NOW)
        self.assertEqual(result["companyIdentities"], [])
        self.assertEqual(len(result["jobs"]), 1)

    def test_company_lookup_batches_only_deduplicated_selected_ids_within_existing_bound(self):
        class Bounded(FakeSource):
            def search(self, query):
                self.searches.append(query)
                return {"hits": []}
        source = Bounded()
        self.assertEqual(IMPORT.company_identities(source, [{"companyId": f"company-{i}"} for i in range(251)] * 2), [])
        self.assertEqual([query["per_page"] for query in source.searches], [250, 1])

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

    def test_numeric_location_ids_preserve_positive_int32_identity_without_guessing_malformed_ids(self):
        identifiers = [2657896, 2147483647, 1, 0, -1, 2147483648, True, 1.0,
                       None, {}, [], "+02657896", "0", "-1", "2147483648", "1.5", "zurich"]
        names = [f"Observed label {position}" for position in range(len(identifiers))]
        source = FakeSource([posting(location_direct_ids=identifiers, location_names=names)])
        job = IMPORT.import_snapshot(source, SNAPSHOT, max_jobs=1, now=NOW)["jobs"][0]
        self.assertEqual([location["id"] for location in job["locations"]],
                         ["2657896", "2147483647", "1", None, None, None, None, None,
                          None, None, None, "2657896", None, None, None, None, "zurich"])
        self.assertEqual([location["name"] for location in job["locations"]], names)

    def test_closed_reserved_missing_and_failed_refresh_have_different_observations(self):
        previous = {"jobs": [{"id": value} for value in ("closed", "reserved", "missing")]}
        source = FakeSource(refresh=[posting("closed", is_active=False), posting("reserved", tdm_reserved=True)])
        result = IMPORT.import_snapshot(source, SNAPSHOT, max_jobs=1, previous=previous, now=NOW)
        self.assertEqual(result["unknownIds"], ["missing"])
        self.assertEqual(result["observations"], [
            {"id": "closed", "active": False, "reserved": False, "observedAt": "2026-10-31T16:00:00.000Z"},
            {"id": "reserved", "active": True, "reserved": True, "observedAt": "2026-10-31T16:00:00.000Z"},
        ])
        refresh = [query for query in source.searches if query["collection"] == "job_posting"][-1]
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
        self.assertIn("first_seen_at:<=", query["filter_by"])
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

    def test_128_slots_reserve_both_age_windows_and_diversity_before_abundant_companies(self):
        boundary = int((NOW - timedelta(hours=48)).timestamp())

        class RepresentativeSource(FakeSource):
            def search(self, query):
                self.searches.append(query)
                first = int(NOW.timestamp()) - 3600
                if query.get("group_by") == "company_id":
                    prefix = "company"
                elif f"first_seen_at:<={boundary}" in query["filter_by"]:
                    prefix, first = "guest", boundary - 86400
                elif f"first_seen_at:>{boundary}" in query["filter_by"]:
                    prefix = "recent"
                elif "location_types:=" in query["filter_by"]:
                    prefix = "workplace-" + query["filter_by"].split("location_types:=")[1]
                elif "locales:=" in query["filter_by"]:
                    prefix = "language-" + query["filter_by"].split("locales:=")[1]
                elif query["q"] != "*":
                    prefix = "role-" + query["q"]
                else:
                    prefix = "newest"
                rows = [posting(f"{prefix}-{index}", company_id=f"{prefix}-company-{index}", first_seen_at=first) for index in range(query["per_page"])]
                return {"hits": [{"document": row} for row in rows]}

        source = RepresentativeSource()
        result = IMPORT.import_snapshot(source, SNAPSHOT, max_jobs=128, now=NOW)
        self.assertEqual(len(result["jobs"]), 128)
        self.assertTrue(any(IMPORT.utc(job["firstObserved"]).timestamp() <= boundary for job in result["jobs"]))
        self.assertTrue(any(IMPORT.utc(job["firstObserved"]).timestamp() > boundary for job in result["jobs"]))
        self.assertTrue(any(f"first_seen_at:<={boundary}" in query["filter_by"] for query in source.searches))
        self.assertTrue(any(f"first_seen_at:>{boundary}" in query["filter_by"] for query in source.searches))
        for value in ("location_types:=remote", "location_types:=hybrid", "locales:=de", "locales:=fr"):
            self.assertTrue(any(value in query["filter_by"] for query in source.searches), value)
        self.assertTrue({"engineer", "sales", "care"}.issubset({query["q"] for query in source.searches}))
        representative = next(query for query in source.searches if query.get("group_by") == "company_id")
        self.assertEqual(representative["per_page"], 16)
        self.assertEqual(representative["group_limit"], 1)
        self.assertTrue(all(query["per_page"] <= 250 for query in source.searches))
        self.assertLessEqual(result["selection"]["initialReturnedDocuments"], 1000)
        self.assertEqual(len({job["id"] for job in result["jobs"]}), 128)

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
