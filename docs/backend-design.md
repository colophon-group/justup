---
summary: Plan the minimal backend for Justup search, accounts, company requests and Hiring Wire.
read_when: Implementing a user-facing backend contract or choosing its verification and deployment boundary.
---

# Backend design: user-facing Justup features

Status: accepted product architecture with implementation gaps tracked for launch

This design supports the [current product experience](product-design.md). It starts from that experience and the available job data, with fresh application boundaries. Crawler implementation and operation are outside its scope.

The accepted [deployment plan](deployment-plan.md) uses Cloudflare for frontend delivery and caching, and existing Hetzner capacity for the backend and Codex execution.

The public repository is [colophon-group/justup](https://github.com/colophon-group/justup), and the product domain is `justup.work`. The repository implements a small HTTP API, durable SQLite account/search/request state, a leased runner and isolated model broker. Full product journeys and the deployed release gate still require verification. The [development and release guide](https://github.com/colophon-group/justup/blob/main/docs/development-process.md) governs integration, verification and resource approval.

This guide defines one product architecture. [Product release readiness](https://github.com/colophon-group/justup/issues/26) requires the accepted product paths before first invited activation. A restricted preview is a deployment state: invitation admission, bounded provider spend, temporary URL and isolated resources can change through reviewed configuration. They do not authorize a disposable account system or a smaller release contract. [Accounts](auth.md), [API](api.md), [job ingestion](job-data.md) and [matching](matching.md) describe implemented boundaries. Subscription transitions, continuous source refresh, live delivery and monitored-coverage progress remain concrete launch gaps until their end-to-end contracts pass.

## 1. Minimal application shape

Start with one application API, one shared background runner, and a database for product state. Keep job retrieval behind a small search adapter so its storage implementation can evolve independently. Select frameworks and providers during implementation.

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

Access is authoritative on the backend. Own free-period activation, legacy eligibility, paid-through dates and premium request priority here. Process billing updates idempotently. Expiry preserves searches and changes both ordinary reads and open streams. Account deletion and query-data retention apply to these records and their associated traces.

## 3. Search planning with Luna

### Input and capabilities

For each submission, supply Luna with the user's complete edited query, previous submitted query, active configuration and revision, relevant profile context, and a concise capability description. Explicit text and removed requirements take precedence over profile defaults.

Capabilities describe supported filters and operators, normalization rules, available posting evidence, and the AI filter's supported conditions and current availability. The current configuration includes any AI condition; Luna must preserve, change or remove it consistently with the edited text.

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

## 5. Companies and requests

Serve the public catalogue, coverage projection and requested-company view from the companies module. Coverage information is an input to this backend. Company identity, requested coverage scope and setup progress remain separate records.

Optimize interactive resolution around the correct identity:

1. Search existing catalogue identities and cached resolutions, including pending companies.
2. Supply Luna at low reasoning with the name/domain, optional career-page link and requested scope.
3. Research the unresolved identity with bounded tools and official-source evidence. Ask a short clarification for material ambiguity.
4. Return a supported candidate promptly. Optional assets and metadata can complete afterward without delaying identity confirmation.

Keep the original lookup available after rejection. Acceptance references the exact preview shown, reuses an existing company when possible, publishes the catalogue entry, attaches the requester and records the requested scope. Automatically follow a newly accepted request while preserving an explicit later unfollow.

Repeated submissions and priority requests are idempotent. Distinct users share identity and setup progress. Subscription entitlement controls priority, while free requests remain accepted and visible. Show separate catalogue-publication and coverage-active milestones, with a reason and next action for blocked work. The actual configuration work is outside this design.

## 6. Weekly Hiring Wire

Run a scheduled Codex Sol session once a week. Give it read tools for aggregate data, prior editions, and a durable versioned directory of scripts/tools it can maintain. Persist the edition rather than depending on conversation history for continuity.

Code computes deterministic comparisons at a fixed snapshot: distinct first observations in the last seven days versus the preceding seven days, using comparable continuously tracked scope. Suppress signals with interrupted coverage or insufficient history. Use before/after counts when the baseline is zero. These describe listing activity.

Sol selects companies, angles and short headlines from those facts, considering prior selections. Validate figures, links and headline claims before publication. Save the snapshot, supporting aggregates, selections and execution/tool version with each edition. Public items expose aggregates rather than restricted posting content.

The API serves the published weekly edition. Retries reuse the same edition period to avoid duplicate publication.

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

The module boundaries, Luna planning and discovery, last-resort AI filtering, SSE, weekly Sol Wire task, tuning collections and Cloudflare/Hetzner deployment split are accepted. Frameworks, authentication/payment and inference providers, concrete tool schemas, evidence policies, execution budgets, batch sizes, concurrency and numerical quality/latency/cost thresholds remain implementation decisions to validate against representative cases.

## 9. Implementation and verification

Start ordinary implementation from `dev` on `work/<semantic-slug>` and open its PR into `dev`. Follow the development guide's issue, commit and PR conventions, including a brief Applied/N/A explanation for each quality and test guideline. Keep these design contracts current as implementation decisions are made.

The always-running `CI / decision` selects the full runtime lane for backend/application changes: build/typechecking, web/deployment contracts, server tests, offline Python contracts and browser journeys. The server suite recursively discovers adjacent `.test.mjs` files; the Python lane discovers `test_*.py` files. Extend their ownership and selection alongside changed contracts through `scripts/ci.py`. An unfamiliar path must select the full available suite or fail visibly; it cannot silently omit backend checks. Ordinary checks verify the proposed merge result with current `dev`.

Use the cheapest suite that proves each observable contract. Focus integration coverage on boundaries that pure logic tests cannot establish:

- Search compilation diagnostics, preserved requirements, revisions and stale results; primary-filter ordering, classifier decisions, continuations, access changes and SSE reconnects.
- Database migrations and concurrent updates; runner leasing, bounded execution, recovery and safe retries.
- Billing callbacks, company acceptance and duplicate requests taking effect once.
- Versioned AI cases and a held-out set for interpretation, matching, company identity and Wire facts. Define quality, latency and cost thresholds before release, and rerun relevant evaluations when models, prompts, tools or routing change.

Give each suite an owner, purpose and runtime budget. Use deterministic fixtures and isolated data by default; bounded real-provider checks belong in explicit integration or preview runs. Extend existing paths and remove superseded ones instead of maintaining parallel implementations.

The first live release depends on a real full-suite and isolated preview gate covering compatible frontend, API and runner artifacts. That gate is not implemented yet; product runtime changes cannot enter `main` before it exists and passes. The deployment plan defines the required environment boundaries, artifact identity and recovery provisions. Planning and code preparation may proceed while resource approvals are pending; a new external service or infrastructure spend requires its own approved `resource-request` issue before provisioning.
