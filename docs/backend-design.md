---
summary: User-facing backend boundaries for Justup search, accounts, companies and Hiring Wire.
read_when: Changing a user-facing backend contract or locating its implementation guide.
---

# Backend design: user-facing Justup features

This design supports the [current product experience](product-design.md). It starts from that experience and the available job data, with fresh application boundaries. Crawler implementation and operation are outside its scope.

The accepted [deployment plan](deployment-plan.md) uses Cloudflare for frontend delivery and caching, and existing Hetzner capacity for the backend and Codex execution.

The public repository is [colophon-group/justup](https://github.com/colophon-group/justup), and the product domain is `justup.work`. The repository implements a Node HTTP API, durable SQLite account/search/request state, a leased runner and isolated model broker; [operations](operations.md) records its current deployment and recovery controls. Full product journeys and the deployed release gate still require verification. The [development and release guide](development-process.md) governs integration, verification and resource approval.

This guide defines one product architecture. The `product-release-readiness` criteria require the accepted product paths before first invited activation. A restricted preview is a deployment state: invitation admission, account caps/optional new-account deadlines, bounded provider spend, schedules, temporary URL, frontend mode and isolated resources can change through reviewed configuration. They do not authorize a disposable account system or a smaller release contract. [Accounts](auth.md), [API](api.md), [job ingestion](job-data.md) and [matching](matching.md) describe implemented boundaries. Subscription transitions, continuous source refresh, resumable live delivery over SSE, attributable company hiring reports, posting-language preferences, monitored-coverage progress and factual weekly Hiring Wire remain first-release requirements until their end-to-end contracts pass. Missing report history or preference persistence is a launch gap, rather than an optional later phase. Missing source continuity suppresses unsupported editorial comparisons; a latest-success timestamp is insufficient.

Current private processing uses one [account/visitor admission proof](processing-admission.md) bound to source/build, exact locale policy identity and deletion generation. The API checks current policy and maintenance before sensitive writes; queue tasks repeat that check before providers and commits. Provider outages preserve appropriate stored reads and account cleanup. The five `product-draft-5` policy pairs remain unreviewed and the global activation switch stays off.

## 1. Minimal application shape

The application has one Node HTTP API, one shared background runner and SQLite product state. Job retrieval sits behind a search adapter so its source can evolve without changing account or result contracts. [The API guide](api.md), [model guide](models.md) and [operations guide](operations.md) own the implementation and deployment details.

The API owns five modules. They are code boundaries and can be deployed together initially.

| Module | Responsibilities |
| --- | --- |
| Account and workspace | Identity, access and subscription state; relevant profile context; search tabs, drafts, revisions and undo; follows, viewed positions, language and display preferences. |
| Search planning | Luna interpretation, validated configurations and edits, internal criteria descriptions, tab titles, warnings and company-request prefills. |
| Search delivery | Primary filtering, optional AI filtering, ordered continuations, access enforcement and live SSE delivery. |
| Companies and requests | Public catalogue and coverage status, catalogue lookup, Luna identity previews, candidate acceptance, deduplication, request scope, priority and progress. |
| Hiring Wire | Published edition reads and a weekly Codex Sol task producing the next edition. |

A database-backed job table supports durable background work. Use a thin shared Codex execution wrapper with task-specific instructions, tools, structured results, traces and execution limits. Give interactive work priority over editorial and background counting work.

## 2. Account and workspace

Persist submitted search text, canonical configuration, generated title and description, warnings, revision and undo state together. Accounts have no automatic expiry by default. An explicitly temporary deployment may assign a stored account deadline on creation; session expiry and account deletion remain separate. Changes to invitation admission cannot change existing identity or stored account lifetime. Keep unsubmitted drafts distinct. Tab switching, pagination and undo reuse saved state without another interpretation call. Changing the followed-company scope invalidates affected result continuations while preserving the query draft.

Viewed positions belong to an account and stable posting identity across searches. Record outbound actions idempotently without delaying navigation. Preserve visitor searches and viewed state through sign-in, merge them into the account, and isolate account state on shared browsers. Persist follows independently of company requests.

The implemented [reading-state contract](reading-preferences.md) stores account follows and explicit unfollows, per-search followed-only and posting-language options, and a separate interface-locale override. Its supported interface set is English, German, French, Italian and Spanish; ordered browser preferences match regional tags to a supported base with English fallback. These SQLite/API paths are tested; the complete translated browser journeys and real multilingual interpretation quality still need release qualification. Account deletion removes these private records in the existing transaction and recovery boundary.

Access is authoritative on the backend. Own free-period activation, legacy eligibility, paid-through dates and premium request priority here. Process billing updates idempotently. Expiry preserves searches and changes both ordinary reads and open streams. Account deletion and query-data retention apply to these records and their associated traces.

## 3. Search planning with Luna

### Input and capabilities

For each submission, supply Luna with the user's complete edited query, previous submitted query, active configuration and revision, relevant profile context, and a concise capability description. Explicit text and removed requirements take precedence over profile defaults.

Capabilities describe supported filters and operators, normalization rules, available posting evidence, and the AI filter's supported conditions and current availability. The current configuration includes any AI condition; Luna must preserve, change or remove it consistently with the edited text.

Explicit posting-language sets and followed-company scope remain separate saved search options. Empty language selection means any; a nonempty set uses OR and excludes unknown evidence. The server intersects these options with the query-derived compiler filters before residual AI, including hidden-match evaluation. Conflicting text and selected languages produce zero matches without dropping either requirement. Options are model context, with bounded examples and full count/hash for large selections, never permission to omit a text requirement. Changing options or follows invalidates incompatible revisions, scans and queued results without another interpretation call while preserving query drafts. Presentation locale controls generated titles and reason wording only; source text and user queries are never rewritten.

Account access, freshness policy and newest-first ordering remain application rules.

### Minimal tools and repair loop

| Tool | Contract |
| --- | --- |
| `compile_search` | Normalize and validate a proposed configuration or allowed diff. Return canonical values and precise diagnostics for invalid fields, failed normalizations, conflicts and unsupported requirements. Include field paths, requirement references and useful canonical alternatives. |
| `lookup_companies` | Find catalogue identities and requested coverage, including companies already being added. Return existing matches or enough information to prefill a company request. |

The loop is **propose → compile → repair if needed → finalize**. Start with one bounded repair attempt. Enforce execution and tool budgets in the wrapper; a failed normalization must reach Luna as feedback rather than disappearing in an application log. The model works with the typed search contract, without generating database queries.

Each requirement must be accounted for as a primary filter, residual AI condition, nonbinding preference, or unsatisfied requirement with a reason. Preserve alternatives and exclusions. A valid zero-match query is distinct from a compilation failure and does not authorize loosening requirements.

### Final response and application

Return the accepted canonical configuration, internal description, concise tab title, warnings or clarification, and optional company-request prefills. The description records what will actually be applied, including nonbinding preferences and any AI condition; it cannot claim evidence the system lacks. The browser displays the user's search text, generated tab title and actionable warnings. It does not render the description as a search summary or offer an expandable filter editor.

An unresolved hard requirement produces an explicit warning or clarification before applying a partial search. Keep the previous valid search until the user resolves the issue or accepts the partial configuration. A prefill prepares the company-request flow; submission follows its normal confirmation and sign-in rules.

Validate the final response and apply configuration, text, description, title and warnings atomically against the expected revision. A stale response cannot overwrite a newer edit. Timeouts and failed validation preserve the previous results and the user's draft.

Codex provides [schema-constrained final output and JSON event traces](https://learn.chatgpt.com/docs/non-interactive-mode). The shared wrapper supplies allowed tools, repair limits and task budgets.

## 4. Search delivery and AI filtering

### One matching path

```text
Listing eligibility → primary filters → residual AI filter
                    → access-controlled results → continuation / SSE
```

Eligibility enforces direct employer sources, the 14-day first-observed window, known closure and source-availability rules. Primary filters include the normalized query and followed-company scope. Apply these before AI evaluation.

Use the same path for initial results, continuation and live arrivals. Ordering is always descending first-observed time with stable posting identity as the tie-breaker. Recheck current eligibility and access before delivery, including for cached decisions and old cursors.

### Residual AI contract

Use JEV or another inexpensive, sufficiently accurate System One classifier behind a replaceable contract. Luna configures it only for requirements that primary filters cannot express. It can narrow candidates; it cannot change primary constraints or ordering.

Provide the residual condition and sufficient posting evidence. Return a decision by posting identity: `accept`, `reject`, or `insufficient_evidence`. Provider failures and unfinished evaluations are separate states. Insufficient evidence cannot satisfy a hard requirement unless the user explicitly chose an applicable unknown-data policy.

Expose both capability and availability to Luna. Retain active AI conditions through temporary outages and communicate pending, paused or failed evaluation honestly. Never substitute unevaluated candidates for accepted matches.

Reuse decisions by canonical condition, posting evidence version and classifier/prompt version. Deduplicate concurrent evaluations. Changes invalidate only decisions whose inputs changed. Keep access decisions outside the reusable classification cache.

### Responsive continuation

The small ready-match buffer in the [motion design](motion-design.md) is independent of candidate batch size. Evaluate enough candidates to refill it despite high rejection rates.

- Estimate candidate demand using observed acceptance rate.
- Size batches by evidence tokens and measured model latency; use bounded parallelism.
- Refill before the ready buffer empties and prioritize an active reader's visible results.
- Bound speculative work and reduce refilling when the reader leaves the continuation area or backgrounds the page.

At 5% acceptance, six ready matches require approximately 120 candidate evaluations. At the proposed 450 ms reveal cadence, sustaining consumption requires approximately 44 candidate decisions per second. A nominal 200 ms latency does not establish whole-batch throughput. Measure latency under batching, accepted matches per second, buffer starvation and cost per delivered match.

Continuation state includes search revision and scan position. An empty accepted batch continues scanning within its work budget. Preserve a resolved chronological prefix: accepted older candidates wait for unresolved newer candidates. A failed evaluation eventually pauses with a retry action and saved position; it cannot silently become a rejection or exhaustion.

Exhaustion requires finishing all remaining eligible candidates and pending evaluations and draining the ready buffer. A budget pause has its own truthful state and next action.

### Access and live delivery

Prioritize AI work needed for visible results. Count recent hidden matches with lower-priority work so they cannot block visible continuation. Count only confirmed accepted matches, report an incomplete count as a lower bound, and never expose hidden posting identities or content.

Use one SSE connection per open workspace, carrying search revision and event identity. Deliver only accepted, eligible results. Support authoritative refresh and deduplication on reconnect. Reconcile closures, expiration, access changes and postings crossing the preview cutoff even when no new posting arrives. A superseded revision cannot repopulate a changed or deleted search.

The implemented [live-results transport](live-results.md) polls a shared SQLite change fingerprint and the canonical search snapshot with bounded connections, heartbeat, lifetime and backpressure. Deliverable prefixes and authoritative retained-ID membership have separate meanings, so newer pending AI work cannot remove older accepted rows. Cookie authority and policy/deletion protections are rechecked throughout delivery. Reconnect always obtains a fresh canonical projection; bounded opaque resume metadata carries no posting payload. Local contracts do not replace the required deployed edge and browser verification.

## 5. Companies and requests

Serve the public catalogue, coverage projection and requested-company view from the companies module. Coverage information is an input to this backend. Company identity, requested coverage scope and setup progress remain separate records.

Optimize interactive resolution around the correct identity:

1. Search existing catalogue identities and cached resolutions, including pending companies.
2. Supply Luna at low reasoning with the name/domain, optional career-page link and requested scope.
3. Research the unresolved identity with bounded tools and official-source evidence. Ask a short clarification for material ambiguity.
4. Return a supported candidate promptly. Optional assets and metadata can complete afterward without delaying identity confirmation.

Keep the original lookup available after rejection. Acceptance references the exact preview shown, reuses an existing company when possible, publishes the catalogue entry, attaches the requester and records the requested scope. Automatically follow a newly accepted request while preserving an explicit later unfollow.

The acceptance transaction publishes/reuses a canonical catalogue ID, establishes its shared setup and performs this automatic follow once. Imported IDs remain canonical; newly discovered identities share a public record by validated official domain, with requested coverage and no invented monitoring history. Exact-preview candidate IDs remain separate from catalogue IDs. Explicit unfollow survives retries and later scope requests. A published row can receive an idempotent priority action without research when the current requester has premium access. Ordinary free requests remain accepted. Each private request reports only its own requester's current priority; aggregate ordering belongs to the private operator projection.

Public catalogue pages use bounded signed continuations, independent of account/private request/follow state. The private `/account/companies` catalogue returns the same canonical rows for follows or accepted requests, with owner, view, filter, membership and catalogue-bound continuations. Unconfirmed previews never become requested catalogue membership. The [company report projection](company-hiring-reports.md) combines eligible public structured role/salary samples with the existing published frozen source history. It records the actual sample window and separate observation/generation/publication timestamps, preserves unknown or interrupted counts, and exposes no underlying restricted listing identities. Only attributable source scopes supply historical monitoring-start evidence. Exact-ID public company website metadata can preserve accepted catalogue identities across a later source import. Real source-history and deployed browser qualification remain first-release requirements.

Distinct users share one setup record, with safe queued/in-progress/blocked progress, fixed reason and next-action codes, and a private operator compare-and-set handoff. Public companies expose this safe progress without account identities, requested scopes or priority. The [setup checklist](../scripts/company-requests/README.md) uses current server premium access for aggregate queue ordering and retains free requests. Its local commands run no model and perform no crawler configuration. No live monitoring receipt producer is integrated; an operator boolean, imported posting, ATS URL or frozen weekly snapshot cannot make coverage active. Implementing and qualifying the approved current-source receipt producer and requester notification remains a first-release gap, alongside the actual configuration workflow.

## 6. Weekly Hiring Wire

The weekly edition uses a fixed comparable-source snapshot and deterministic listing-activity facts. Sol may choose companies and supported angles, while application code validates and renders all public claims. The edition, source evidence and execution identity persist together; retries use the same period. [Hiring Wire](hiring-wire.md) owns the factual/public contract, [integration](hiring-wire-integration.md) owns queue scheduling, and [subscription runtime](hiring-wire-runtime.md) owns native Sol qualification.

## 7. Collections for tuning and measurement

Start with three task-specific evaluation collections and one shared execution log, stored alongside ordinary product data and exportable for evaluation.

| Collection | Inputs and reviewed expected outcomes |
| --- | --- |
| Search interpretation | Query, relevant context, previous configuration and edits → normalized requirements, AI routing, warnings, internal criteria description and company-request prefills. Include failed normalizations, alternatives, exclusions, removed requirements, ambiguity and unavailable AI. |
| AI matching | Residual condition plus posting evidence → accept/reject/insufficient-evidence judgment. Sample primary-filter survivors, including difficult rejected cases, rather than only displayed results. |
| Company resolution | Name/domain/scope hints and catalogue context → correct identity or required clarification, with supporting evidence. Include ambiguous names, subsidiaries, renamed companies and existing pending requests. |
| Execution log | Task/model/prompt/tool versions, compilation feedback, repair attempts, latency, tokens, candidate yield, buffer starvation, failures and cost per completed task. |

User corrections and company rejections feed a review queue for evaluation cases. Distinguish corrections from intentional refinements; clicks and acceptance alone do not establish correctness. Maintain a held-out set when comparing changes.

Tune interpretation for preserved intent and description accuracy; AI filtering for false acceptance/rejection, throughput and cost; company resolution for identity accuracy, ambiguity handling, latency and tool/token use. Choose the least expensive configuration that meets task quality targets. Versioned Wire editions provide its editorial history and factual audit trail.

Minimize retained personal context and raw query content. Define debugging retention separately from longer-lived reviewed evaluation cases.

## 8. Implementation decisions still to measure

The module boundaries, Luna planning and discovery, last-resort AI filtering, SSE, weekly Sol Wire task, tuning collections and Cloudflare/Hetzner deployment split are accepted. The current runtime uses Node built-in HTTP/SQLite, local accounts, pinned Codex and bounded JEV matching, as described in the [API](api.md), [model](models.md) and [matching](matching.md) guides. Payment integration, authoritative source evidence, actual provider availability and numerical quality/latency/cost thresholds still need their reviewed implementation or qualification. Accepted company reports and posting-language preferences must also pass their complete data, account and browser contracts before first invited activation.

## 9. Verify changes

Use the [development and release guide](development-process.md) for branches, PR checks, test creation and the exact deployed release gate. Update the owning feature guide when its contract changes: [accounts](auth.md), [API](api.md), [job ingestion](job-data.md), [models](models.md), [matching](matching.md), [companies](company-hiring-reports.md), or [Hiring Wire](hiring-wire.md).

Backend verification should cover the boundary a change can break: search compilation and revisions; access-filtered ordered results and live reconnection; database migration and concurrent writes; runner leases and cleanup; company identity and request idempotence; and versioned model/factual evaluation cases. Use deterministic local fixtures for ordinary PRs. Real provider, source-history and deployed browser evidence belong to the release gate. A new external service or infrastructure spend still requires its own approved resource issue.
