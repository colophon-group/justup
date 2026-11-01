---
summary: Inspect bounded private journey metadata and curate reviewed evaluation cases without sampling user text.
read_when: Reporting invited-use evidence, investigating missing measurements or comparing reviewed model cases.
---

# Read product evidence

The composed API stores a small private collection in the existing SQLite database. It adds no external analytics recipient, public telemetry endpoint, browser identifier or provider execution. Run the local operator command with existing authorized filesystem access:

```sh
node server/product-records-cli.mjs --db /private/justup.sqlite
```

The default JSON report contains aggregate event counts, access/locale cohort sizes, observed return use and execution summaries. It exports no owner, task, search, company or posting identifiers. A cohort is the number of **retained owner records observed in that access segment**, not people or all visitors. An owner can appear in several segments. Visitor handoff moves the same observations to the verified account without changing their original segment. Distinct visitor cookies can belong to one person; multiple visitors can merge into one account. No unique-person count or conversion rate is inferred.

Read missing-data warnings with every report. Seven-day retention, deletion, row eviction and optional collection failures remove observations. Public reads without an existing signed-in account are unmeasured and allocate no owner or cookies. Browser rendering, unreported outbound navigation, company-candidate rejection and actual application/hire outcomes are unmeasured. Access to the local command requires the same private database access as the application; there is no browser export or remote operator API. Keep explicit exports in private operator storage and remove them when their review is finished.

## Interpret events

Each event has a server timestamp, private owner, hashed event key, fixed event/outcome, original access segment and interface locale (`en`, `de`, `fr`, `it`, `es`). Optional values are bounded integers; optional references are opaque internal search/request identifiers used only for deletion. Records contain no raw query, draft, description, URL, posting ID/content, IP, email, username, credential, provider header, trace or exception string.

| Event | Recorded fact and duplicate scope | Denominator and interpretation |
| --- | --- | --- |
| `search_submitted` | A new admitted search task was accepted, once per task. Exact submission retries reuse the task and emit nothing. | Retained admitted submissions, including edits. A rejected HTTP request is not a submission. |
| `search_completed` | A current owned search task finished with succeeded/warning/failed, once per task. | Retained submissions with completion evidence; missing completions remain missing. Warning does not establish usable results. |
| `results_served` | An authorized results response was produced: usable items, honest fresh exhausted zero, or pending/paused work. Once per search revision/outcome. | Revisions for which a response was requested. Repeated pages do not count as additional successes; a revision may move from paused to usable. Server delivery is not proof of browser display or usefulness. |
| `search_use` | At least one owned results response was requested on a UTC day. | Owners observed on more than one retained search-use day. This is a bounded return-use observation, not a retention rate. |
| `source_open_reported` | The existing authorized `/viewed` write reports an explicit outbound activation for an eligible posting. Once per retained owner/posting key; the key is hashed. | Owners/submissions with reported opening evidence. It is a client report, not proof that the destination loaded or an application occurred. No extra action flag is added. |
| `account_registered` | The registration response acknowledged a committed new account. Once per account. | Acknowledged new accounts; direct internal registration without this HTTP acknowledgement is missing. It is separate from verification or free activation. |
| `free_activated` | The entitlement transaction created a verified standard or legacy free period. Once at creation, never on repeated activation requests. | Retained activation facts. Original segment distinguishes free and legacy; no eligibility is inferred from registration. |
| `subscription_transition` | An authoritative reconciled billing event changed subscription state. Once per applied verified event; replay emits nothing. | Recorded verified transitions only. The default billing adapter remains unavailable; this collection does not enable payment or prove a paid conversion. |
| `company_accepted` | The exact company preview was newly accepted. Once per request acceptance transaction. | Retained accepted requests. Publication does not prove active monitoring. |
| `company_progress` | An owned company-request list response contained the recorded pending/candidate/clarification/unresolved/accepted status. Once per request/status/preview revision. | Inspected owned requests, not all background progress. Coverage-active onboarding is not implemented here. |
| `report_served`, `coverage_served` | A signed-in account received a public company report or catalogue response. Once per owner/event/UTC day, with no company identity. | Observed signed-in responses only. These do not prove client inspection, coverage trust or anonymous audience size. |

Segments are visitor, registered limited access, standard free, legacy free, paid, expired or unknown. Cancelled/past-due accounts with remaining full paid access stay in paid; exact billing transition outcomes remain separate. A change of segment never rewrites prior events. These are application access categories, not demographic segments.

## Bound private records and deletion

Journey rows have a seven-day age limit and 10,000-row global cap. Execution rows have the same age limit and a 5,000-row global cap. Expired rows and oldest excess rows are pruned through the private deletion barrier while the composed API runs; its normal maintenance retries each minute. A suspended host cannot perform cleanup. The runner cannot bypass a missing deletion barrier to evict private rows: at the cap, optional collection can stop until composed API maintenance succeeds. Collection failure never blocks a search, source opening or entitlement transaction. Reports are incomplete when collection fails.

Account deletion and configured account expiry delete all owned events, execution rows and pending review references in the existing auth transaction. Visitor expiry/session deletion does the same. Deleting a search/request removes its referenced evidence. Metadata alone is excluded from the empty-visitor check and is erased when the last substantive visitor state is reclaimed. Handoff moves bounded private rows in the same transaction; late work must still find the same task attempt and current owner before writing. No deleted-account tombstone or redemption identity is added. Recovery follows the existing backup-generation barrier; this does not promise secure erasure of SQLite/WAL/filesystem remnants or provider copies.

## Read execution evidence

The three existing task handlers share one bounded execution collection. The task/attempt key suppresses retries; deleted, handed-off or expired task ownership cannot create a late row. Entries contain task kind, observed model (or `unobserved`), prompt implementation SHA256, tool-policy identity, safe outcome, elapsed task milliseconds, optional input/output token totals, compilation failure and repair counts, and matching evaluation/cache/insufficient-evidence counts. The records reuse the model wrapper's numeric `onMetric` callback. They retain no compiler diagnostic text, tool arguments or provider traces. Missing provider token evidence stays null.

Codex subscription inference has no confirmed per-call price in this collection; monetary cost is null. Matching records use numeric JEV cost only for completed attempts with known usage and no ambiguous attempt. Unknown cost is never zero. Aggregate known cost is accompanied by an unknown-cost run count. Whole-task latency includes repairs; it is local evidence and does not qualify real provider availability or latency. Prompt/tool identities identify the implementation/configuration, not an observed native tool catalogue. Hiring Wire retains its existing independent edition audit and is unchanged.

## Curate reviewed cases

The existing compiler fixture remains in `server/evals/intent-heldout.json`. The small companion `server/evals/reviewed-cases.json` adds explicit task, version, input, expected outcome, provenance, review status and tuning/held-out split for search normalization, residual matching and company identity. They are synthetic provider-free contracts, not measured live model scores.

Import only an explicitly reviewed synthetic or operator-redacted bundle. User activity is never copied automatically. The operator asserts `source:synthetic` with `consent:not_applicable`, or `source:operator_redacted` with `consent:reviewed`; code validates the schema and bounds, but cannot prove that arbitrary supplied text is anonymous or that consent is sufficient. Review and remove personal data before curation. Provenance is a bounded review/fixture slug, never an account ID, URL or raw source. No owner-derived text is retained in these longer-lived cases.

```sh
node server/product-records-cli.mjs --db /private/justup.sqlite cases-import /private/reviewed-cases.json
node server/product-records-cli.mjs --db /private/justup.sqlite cases-export
```

Cases are immutable per ID/version; changing expected outcomes or status requires a new increasing version. A case's task and tuning/held-out split cannot change across versions. A case bundle has `version:1` and `cases:[...]`. At most 200 total versions are stored, each at most 16 KiB, with a 180-day retention limit. Export includes only reviewed, unexpired versions, including their explicitly curated input and expected output. CLI inputs/outputs are capped at 4 MiB. No provider or native evaluation is run.

The private review queue contains at most 200 references for seven days. A search edit stages only owner, search reference, revision, task and `edit_requires_review`; it may be an intentional refinement and is never labelled a model error. The collector supports an internal `candidate_rejected` reference reason, but there is no current server rejection action, so browser rejections are not collected. Deletion erases these references and invalidates access to their source. Queue counts appear in the aggregate report; no raw private-source export or automatic promotion exists. Operators investigate through already authorized product state and create a separate reviewed synthetic/redacted case when appropriate.

## Compare supplied observations

```sh
node server/product-records-cli.mjs --db /private/justup.sqlite compare /private/baseline.json /private/candidate.json
```

Each observation array contains `id`, `version`, `failed`, `output`, `durationMs`, `inputTokens`, `outputTokens` and `costNanodollars`; unknown measurements are explicitly null. Successful output must follow the case's task schema. The tool compares output against the reviewed expectation deterministically, excludes tuning cases, retains failures and missing cases in the held-out denominator, and reports p95 latency plus unknown cost. A missing case/latency/cost produces `insufficient_evidence`. A complete set produces `comparison_only`, never model approval. Accuracy here is exact agreement with the curated output, not model self-reported correctness, clicks or acceptance. Thresholds, representative launch segments, stochastic/provider evidence and numerical go/no-go decisions remain the release owner's `release-verification` work; this collection alone is no additional first-preview approval gate.

The adjacent `product-records.test.mjs` suite owns storage, retry/retention/allowlist/export/comparison contracts; `visitor.test.mjs` owns the composed HTTP lifecycle and source-opening path. Both use real SQLite, fixed clocks and fake models, run in the ordinary server lane, and normally finish in a few seconds without external calls.
