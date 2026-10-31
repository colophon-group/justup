---
summary: Export and refresh a bounded public Jobseek snapshot for the isolated Justup demo.
read_when: Preparing demo job evidence, investigating freshness, or reviewing the public import boundary.
---

# Import public demo jobs

The explicit operator command `scripts/import-demo-jobs.py` copies public listing metadata and normalized description text into a private JSON export. It never connects to a database, writes to Jobseek, changes a crawler configuration or schedules work. No job content belongs in Git, issues, PRs, test fixtures or application logs. The feed exposes structured fields and the original source link; normalized description text remains server-side evidence for matching.

1. Choose a fixed UTC snapshot time and a private output directory outside every Git checkout. Protect the directory with mode `0700`. The command requires the directory to exist, creates the export with mode `0600`, and replaces the destination atomically.
2. Obtain the public bootstrap metadata from [the Jobseek public search key endpoint](https://jseek.co/api/typesense-key). Independently approve the public Typesense hostname before supplying it to `--typesense-host`; do not copy the scoped key into a command, file or log. The command fetches its own transient public scoped key, checks that the returned host exactly matches this argument, requires HTTPS on port 443 and refuses redirects. The approved hostname is an explicit network boundary, not an automatically trusted bootstrap suggestion.
3. Run an initial bounded export, replacing the illustrative hostname, time and output path:

   ```sh
   python3 scripts/import-demo-jobs.py \
     --snapshot 2026-10-31T16:00:00Z \
     --typesense-host approved-public-search.example \
     --max-jobs 500 \
     --output /private/demo-data/snapshot.json
   ```

4. Review the printed counts and the export's `selection` metadata. Verify sampled original source links using the intended browser environment. Transfer the export through the preview's approved private data path and use the isolated demo store's import operation. The import command does not deploy or transfer files.
5. For a refresh, use a new fixed snapshot time, `--previous /private/demo-data/snapshot.json` and a different output filename. This performs a new bounded sample and independently checks all known IDs from the previous export. Keep the previous file until the new import is accepted; remove superseded exports under the preview's retention policy.

No real import is run by the default test suite. Run focused deterministic checks with `python3 -m unittest discover -s scripts -p 'test_import_demo_jobs.py'`. These tests own the public-source and normalization boundary, use only synthetic documents and fake HTTP results, and take less than one second locally. API and store tests own eligibility, cursors, closure visibility and access control.

## Selection and source identity

The initial request uses Typesense `POST /multi_search`, collection `job_posting`, query `*`, `query_by:title` and descending `first_seen_at`. It filters `is_active:=true`, `has_content:=true`, `tdm_reserved:!=true`, and source discovery timestamps from exactly 14 days before the fixed snapshot through the snapshot. First it requests one representative per `company_id`; then it samples bounded remote, hybrid, German and French strata and fills remaining capacity with newest listings. Each query requests at most 250 documents. The complete initial selection reads at most 1,000 returned documents, exports at most the requested 1–1,000 jobs, and may honestly return fewer after duplicate or invalid evidence is removed. The default ceiling is 500 exported jobs. Previous exports and completed output files are each bounded to 64 MiB; an oversized output fails atomically and preserves the prior destination. These are representative imported records, not a complete Jobseek export.

The final export orders source discovery time descending with posting ID as the stable tie breaker. IDs are deduplicated. `firstObserved` is the source `first_seen_at` Unix timestamp converted to UTC; the import never substitutes the snapshot or import time. `lastObserved` likewise comes from `last_seen_at`, where present. The file records the fixed `snapshotAt`, final `verifiedAt`, cutoff, requested ceiling, returned-document count, query count, selected job/company counts and known-ID refresh count. Per-job `metadataFetchedAt` and `bodyFetchedAt` record their own observations; a final export timestamp must not refresh an unverified record.

The source field allowlist is exactly:

```text
id company_id company_name company_slug title source_url is_active has_content
 tdm_reserved first_seen_at last_seen_at locales location_direct_ids location_names
 location_types location_geo_types employment_type seniority_id seniority_name
 salary_min salary_max salary_currency salary_period experience_min_years
 experience_max_years
```

New source fields cannot enter the export implicitly. Company identities use only imported names, IDs and slugs. The importer does not infer an official company website from a job or applicant-tracking-system URL, expose crawler board configuration, or claim that Justup monitors these companies. Catalogue coverage is `imported_snapshot`; missing history and monitoring evidence are unavailable.

Location arrays are paired by their original position. A missing workplace value is `unknown`; only explicit `onsite`, `remote` or `hybrid` values become those workplace types. A location label alone makes no claim about cross-border remote eligibility. Employment values are limited to `full_time`, `part_time`, `contract`, `temporary`, `volunteer` and `full_or_part`. Missing or negative experience is unknown; a maximum of 99 is represented as open ended. Other unknown fields remain null or empty rather than guessed.

## Description evidence

For an accepted listing, the importer chooses the first valid non-`__none` locale, or `en`, and fetches the public asset at `https://jobseek-assets.colophon-group.org/job/{id}/{locale}/latest.html` with a Mozilla-compatible User-Agent. Each response is bounded to 512 KiB and must be valid UTF-8. It derives plain text deterministically, excludes script/style/template content and explicit hidden elements, removes controls and normalizes whitespace. No HTML is retained or sent to the browser. This parser does not execute page scripts or evaluate external stylesheets; it is bounded source-text normalization, not a browser rendering claim.

`evidence` records the public source label, metadata/body observation times, mutable body URL, SHA-256 of received bytes and normalized text, normalization version 1, received byte count, truncation/error flags and AI eligibility. A mutable `latest.html` URL is not an evidence version; hashes bind the observed version. Failed, invalid, oversized or deeply malformed content is unavailable to matching. A successful normalized description needs at least 200 characters for `aiEligible:true`; a shorter body can still have a structured listing. An oversized response is rejected, not silently clipped into apparently complete evidence. Across one import, retained normalized text is capped at 48 MiB measured as UTF-8 bytes. A body that cannot fit is marked `body_budget_exceeded`, with null text/hash and AI eligibility false; structured metadata remains usable. Once that budget is exhausted, later bodies are not fetched. The JSON exporter streams its encoding and refuses a file above 64 MiB. No provider credentials, private users, crawler settings or internal traces are requested.

## Refresh and removal

Known IDs are refreshed in batches of at most 250, with an ID-only filter and no active/freshness filter. A source result explicitly reporting inactive produces an observation with `active:false` and `observedAt`. That timestamp is when the closure was observed; it is not an invented employer closure date. A reserved record produces `reserved:true` and is excluded from results and AI even when still active. Missing results, malformed records and failed refresh batches become `unknownIds`, never fabricated closures. New valid metadata and body evidence may refresh a known record; absent evidence does not acquire a new verification time.

The store rechecks independent rolling 14-day expiry and bounded verification age on every page. Visitors receive only eligible jobs 48 hours to 14 days old; signed-in preview accounts receive eligible jobs within 14 days. Refresh does not restart these source discovery clocks. The API's configured verification TTL suppresses stale or unverified evidence until a positive refresh. A new import invalidates prior feed cursors. A coverage gap remains an honest empty result, not evidence that no matching jobs exist worldwide.
