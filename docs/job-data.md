---
summary: Export and refresh a bounded public Jobseek snapshot for Justup.
read_when: Preparing imported job evidence, investigating freshness, or reviewing the public import boundary.
---

# Import and refresh public jobs

The explicit operator command `scripts/import-jobs.py` copies public listing metadata and normalized description text into a private JSON export. It never connects to a database, writes to Jobseek, changes a crawler configuration or schedules work. No job content belongs in Git, issues, PRs, test fixtures or application logs. The feed exposes structured fields and the original source link; normalized description text remains server-side evidence for matching.

1. Choose a fixed UTC snapshot time and a private output directory outside every Git checkout. Protect the directory with mode `0700`. The command requires the directory to exist, creates the export with mode `0600`, and replaces the destination atomically.
2. Obtain the public bootstrap metadata from [the Jobseek public search key endpoint](https://jseek.co/api/typesense-key). Independently approve the public Typesense hostname before supplying it to `--typesense-host`; do not copy the scoped key into a command, file or log. The command fetches its own transient public scoped key, checks that the returned host exactly matches this argument, requires HTTPS on port 443 and refuses redirects. The approved hostname is an explicit network boundary, not an automatically trusted bootstrap suggestion.
3. Run an initial bounded export, replacing the illustrative hostname, time and output path:

   ```sh
   python3 scripts/import-jobs.py \
     --snapshot 2026-10-31T16:00:00Z \
     --typesense-host approved-public-search.example \
     --max-jobs 500 \
     --output /private/job-data/snapshot.json
   ```

4. Review the printed counts and the export's `selection` metadata. Verify sampled original source links using the intended browser environment. Transfer the export through the deployment's approved private data path and use the application store's import operation. The import command does not deploy or transfer files.
5. For a refresh, use a new fixed snapshot time, `--previous /private/job-data/snapshot.json` and a different output filename. This performs a new bounded sample and independently checks all known IDs from the previous export. Keep the previous file until the new import is accepted; remove superseded exports under the deployment's export retention policy.

No real import is run by the default test suite. Run focused deterministic checks with `python3 -m unittest discover -s scripts -p 'test_import_jobs.py'`. These tests own the public-source and normalization boundary, use only synthetic documents and fake HTTP results, and take less than one second locally. API and store tests own eligibility, cursors, closure visibility and access control.

## Selection and source identity

The initial request uses Typesense `POST /multi_search`, collection `job_posting`, query `*`, `query_by:title` and descending `first_seen_at`. It filters `is_active:=true`, `has_content:=true`, `tdm_reserved:!=true`, and source discovery timestamps from exactly 14 days before the fixed snapshot through the snapshot. Before any general newest-first fill, it reserves one quarter of slots for jobs 48 hours to 14 days old (guest-visible) and one quarter for jobs under 48 hours old (full-access accounts), one eighth for representatives grouped by `company_id`, and one quarter distributed across remote, hybrid, German, French and the title queries `engineer`, `sales` and `care`. These title keywords are sample strata, not inferred occupations or a completeness claim. At a 128-job limit the budgets are 32 guest, 32 recent, 16 company representatives and 32 diversity slots; only the remainder or unfilled slots go to the newest-first fill. Duplicate records do not consume additional output slots. Integer rounding keeps every allocation bounded; a one-job sample requests the guest age window first. Diversity queries use the same active, content, reservation and 14-day filters, with `query_by:title` for the three role keywords. Each query requests at most 250 documents. The complete initial selection reads at most 1,000 returned documents, exports at most the requested 1–1,000 jobs, and may honestly return fewer after duplicate or invalid evidence is removed. The default ceiling is 500 exported jobs. Previous exports and completed output files are each bounded to 64 MiB; an oversized output fails atomically and preserves the prior destination. These are representative imported records, not a complete Jobseek export.

The final export orders source discovery time descending with posting ID as the stable tie breaker. IDs are deduplicated. `firstObserved` is the source `first_seen_at` Unix timestamp converted to UTC; the import never substitutes the snapshot or import time. `lastObserved` likewise comes from `last_seen_at`, where present. The file records the fixed `snapshotAt`, final `verifiedAt`, cutoff, requested ceiling, returned-document count, query count, selected job/company counts and known-ID refresh count. Per-job `metadataFetchedAt` and `bodyFetchedAt` record their own observations; a final export timestamp must not refresh an unverified record.

The source field allowlist is exactly:

```text
id company_id company_name company_slug title source_url is_active has_content
 tdm_reserved first_seen_at last_seen_at locales location_direct_ids location_names
 location_types location_geo_types employment_type seniority_id seniority_name
 salary_min salary_max salary_currency salary_period occupation_id occupation_name experience_min_years
 experience_max_years
```

New source fields cannot enter the export implicitly. Company identities use only imported names, IDs and slugs. A syntactically validated slug can link to the public Jobseek company profile at `/en/company/{slug}`; this is source attribution, not an inferred official company website. The importer does not infer an official company website from a job or applicant-tracking-system URL, expose crawler board configuration, or claim that Justup monitors these companies. Catalogue coverage is `imported_snapshot`; missing history and monitoring evidence are unavailable.

Location arrays are paired by their original position. Positive int32 GeoNames IDs from `location_direct_ids` become canonical decimal strings; booleans, fractions, zero, negative and out-of-range numbers remain unknown. Existing opaque string IDs remain compatible. IDs are never inferred from location labels. A missing workplace value is `unknown`; only explicit `onsite`, `remote` or `hybrid` values become those workplace types. A location label alone makes no claim about cross-border remote eligibility. Employment values are limited to `full_time`, `part_time`, `contract`, `temporary`, `volunteer` and `full_or_part`. Missing or negative experience is unknown; a maximum of 99 is represented as open ended. Other unknown fields remain null or empty rather than guessed.

The importer also makes at most four public `company` collection lookups of 250 distinct selected company IDs, requesting only `id,website` from the same approved Typesense host. The explicit source `website` field supplies a validated HTTPS official hostname for optional `companyIdentities:[{companyId,officialDomain}]`; missing, duplicate, invalid, ATS or failed results omit that metadata. No name, slug, posting URL, parent-domain guess or `www` rewrite creates identity proof. The store accepts at most 1,000 unique source company IDs already in its immutable source registry. This metadata stays bound to the exact source ID: sharing a host cannot merge separate source companies or bind one to an earlier requested company. A later conflicting domain rejects the whole import. Source posting/company IDs and discovery times remain unchanged. Existing persisted alias mappings are retained without being re-inferred or repaired by host lookup; any older cross-ID mapping requires review before activation. There is no automatic identity-link approval path. The [reading-state guide](reading-preferences.md) describes this boundary; the [report guide](company-hiring-reports.md) records the audited public source fields and remaining real-data qualification.

Positive int32 `occupation_id` plus a nonempty source `occupation_name` become the optional structured occupation label used by company reports. Missing or malformed occupation evidence stays null. The report does not infer roles from title sampling queries or call another classifier.

## Description evidence

For an accepted listing, the importer chooses the first valid non-`__none` locale, or `en`, and fetches the public asset at `https://jobseek-assets.colophon-group.org/job/{id}/{locale}/latest.html` with a Mozilla-compatible User-Agent. Each response is bounded to 512 KiB and must be valid UTF-8. It derives plain text deterministically, excludes script/style/template content and explicit hidden elements, removes controls and normalizes whitespace. No HTML is retained or sent to the browser. This parser does not execute page scripts or evaluate external stylesheets; it is bounded source-text normalization, not a browser rendering claim.

`evidence` records the public source label, metadata/body observation times, mutable body URL, SHA-256 of received bytes and normalized text, normalization version 1, received byte count, truncation/error flags and AI eligibility. A mutable `latest.html` URL is not an evidence version; hashes bind the observed version. Failed, invalid, oversized or deeply malformed content is unavailable to matching. A successful normalized description needs at least 200 characters for `aiEligible:true`; a shorter body can still have a structured listing. An oversized response is rejected, not silently clipped into apparently complete evidence. Across one import, retained normalized text is capped at 48 MiB measured as UTF-8 bytes. A body that cannot fit is marked `body_budget_exceeded`, with null text/hash and AI eligibility false; structured metadata remains usable. Once that budget is exhausted, later bodies are not fetched. The JSON exporter streams its encoding and refuses a file above 64 MiB. No provider credentials, private users, crawler settings or internal traces are requested.

## Refresh and removal

Known IDs are refreshed in batches of at most 250, with an ID-only filter and no active/freshness filter. A source result explicitly reporting inactive produces an observation with `active:false` and `observedAt`. That timestamp is when the closure was observed; it is not an invented employer closure date. A reserved record produces `reserved:true` and is excluded from results and AI even when still active. Missing results, malformed records and failed refresh batches become `unknownIds`, never fabricated closures. New valid metadata and body evidence may refresh a known record; absent evidence does not acquire a new verification time.

The store rechecks independent rolling 14-day expiry and bounded verification age on every page. Visitors receive only eligible jobs 48 hours to 14 days old; full-access accounts receive eligible jobs within 14 days. Refresh does not restart these source discovery clocks. The API's configured verification TTL suppresses stale or unverified evidence until a positive refresh. Missing or stale imported evidence yields an empty paused page, a five-second retry interval and `import_unavailable` coverage explaining that listings need verification. It never reports a completed zero-result search. Existing cursors are validated before pausing; a new import invalidates prior feed cursors. With fresh evidence, a genuinely empty eligible slice can complete normally.


## Durable import and refresh contract

`store.importSnapshot` is an atomic, repeatable local ingestion boundary. A refreshed export changes the generation and invalidates old result cursors; public job identity and source discovery time remain stable. The store preserves `id`, source company ID and first discovery time in `job_source_identities` even after rolling evidence pruning. A changed company identity or discovery time for a known source ID rejects the whole import. Imports never reset account/search/request state.

The final export timestamp cannot replace a record's observation time. An older record observation cannot overwrite newer content, undo a reservation or reopen a known closure. Equal-time active evidence also cannot reverse closure/reservation. A newer positive observation can reopen it. Unknown/missing IDs preserve earlier evidence until its own verification lifetime expires.

The store retains at most 1,000 job bodies/metadata and 32 import summaries, prunes evidence older than 30 days, and enforces the existing 1 GiB SQLite page ceiling. The small identity registry persists independently of result eligibility; it retains latest activity/reservation observation but no bodies or account data. Future volume still requires resource review. These bounds are deployment capacity, not a reason to recreate accounts or replace the runtime when access widens.

The current command does **not** schedule refreshes. The `fresh-job-feed` work, described in [operations](operations.md), still needs the authorized source/scheduler contract, monitored execution and failure recovery before a fresh-feed launch claim. The minimal integration is one operator-owned writer that chooses a fixed snapshot, passes the previous export for known-ID refresh, imports the completed bounded snapshot atomically, and retains the previous export until acceptance. It must report last successful verification and refresh failures; an API read cannot refresh evidence or invent success. No external source integration, recurrent network execution or host change is authorized by this guide.
