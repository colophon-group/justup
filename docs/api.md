---
summary: Integrate the Justup API with durable accounts and explicit service availability.
read_when: Connecting the browser, implementing a backend module or reviewing product privacy and release evidence.
---

# Justup API contract

Status: implementation contract; not a claim that endpoints are deployed.

The runtime composes attributable Jobseek imports, durable local accounts, validated search interpretation, optional residual matching, reading preferences, live result delivery, company identity requests, public company reports and Hiring Wire editions. Invitation restrictions and temporary account lifetimes are deployment policy. Billing, mail and crawler writes are not implemented; accepted product features still missing are launch requirements, not preview exemptions. Follow the [development guide](development-process.md); ordinary implementation targets `dev`, and runtime changes cannot enter `main` before the real release gate passes.

## Runtime and resource boundary

Use Node.js 24 LTS ES modules, built-in HTTP/crypto/SQLite and one bounded runner. SQLite stores durable application identity, searches, requests and task state. The first restricted deployment uses isolated storage with the same schema and runtime. No additional database service or auth vendor is needed.

The [deployment plan](deployment-plan.md) and [operations guide](operations.md) define the current temporary host allocation, resource controls and Jobseek isolation. These deployment limits do not define product capacity or account lifetime. Builds run off-host; new resource allocation needs separate explicit approval.

The browser application lives in `web/` and deploys its compiled React/Vite artifact. Build committed inputs and the lockfile in an unprivileged off-host builder, then upload the retained bytes. The API/runner package contains only backend runtime files. Record the frontend artifact identity alongside compatible API and runner identities; do not deploy source files or compile on the bounded host.

## HTTP rules

All browser calls use same-origin `/api/v1` routes. Bodies and responses are JSON except the workspace event streams, which use `text/event-stream`. Times are ISO 8601 UTC; job discovery timestamps always retain their source value. IDs come from the server. Private records derive ownership from the session, never a supplied account ID.

API responses use `Cache-Control: private, no-store` and `X-Robots-Tag: noindex` in both preview and production frontend modes. Do not send hidden job IDs, titles, bodies or URLs and rely on browser blur for access control. Mutation requests require the session cookie, an allowed `Origin` and `X-CSRF-Token`. Authentication uses a host-only, HttpOnly, Secure, SameSite=Lax opaque session cookie. Local test HTTP is a separately explicit configuration.

Errors use the following shape, with safe messages and no provider output or secrets:

```json
{"error":{"code":"revision_conflict","message":"This search changed. Reload it and try again.","requestId":"request-id"}}
```

Use 400 for malformed input, 401 for a missing/expired session, 403 for denied access, 409 for stale revisions/previews, 422 for unsupported requirements, 429 for a usage limit and 503 for an unavailable dependency. Include `Retry-After` where a retry is appropriate.

## Accounts, admission and sessions

The implemented login provider is Justup itself: local username/password accounts. `JUSTUP_REQUIRES_INVITATION` defaults true; setting it false permits public registration without an invitation, still subject to backend admission, policy and security checks. The safe default account cap is 30 and can be configured explicitly. Accounts are durable by default. Optional `JUSTUP_ACCOUNT_TTL_MS` or `JUSTUP_ACCOUNT_EXPIRES_AT` assign new temporary accounts a stored deadline; later policy changes do not alter existing accounts. Sessions expire independently after seven days by default. There is no external identity, payment identity, free-period activation, recovery or legacy entitlement in the current runtime. See [account contracts](auth.md) and the `account-access` launch criteria.

Keep registration, login and private processing disabled until the exact effective-language Privacy and Usage pages have been reviewed. The [processing admission guide](processing-admission.md) defines fixed-locale approval, explicit fallback, session metadata and the shared account/visitor queue proof. The pages are frontend-owned; there is no policy JSON endpoint.

| Route | Input or result |
| --- | --- |
| `GET /session` | Viewer or null, server time, access rules, CSRF token, authentication availability, capabilities, policy URLs/version and import freshness. |
| `POST /auth/register` | `{username,password,inviteCode?}` → account/session; invitation required only when backend admission says so. |
| `POST /auth/login` | `{username,password}` → account/session; same policy gate. |
| `POST /session/logout` | Revoke the current session and clear its cookie. |
| `DELETE /account` | `{password}` → confirmed deletion of the account, sessions and its private searches, requests, tasks and cached model decisions. |
| `GET /follows` | `{accountId,revision,items:[{companyId,followedAt}],invalidatedSearchIds:[]}`. |
| `PATCH /follows/:companyId` | `{followed,expectedRevision}` → current owner-bound follow snapshot; canonical catalogue ID required. |
| `GET /preferences?languages=de-CH,fr,en` | Saved interface override, supported locales and resolution against the ordered browser list. |
| `PATCH /preferences` | `{expectedRevision,interfaceLocale}` → saved owner-bound preference snapshot. |

Session example:

```json
{
  "serverTime":"2026-10-31T16:00:00Z",
  "user":{"id":"account-id","username":"tester","expiresAt":null},
  "expiresAt":"2026-11-07T16:00:00Z",
  "access":{"kind":"account","fullAccess":true,"legacy":false,"billingEnabled":false,"until":null},
  "authentication":{"method":"username_password","loginEnabled":true,"registrationEnabled":true,"requiresInvitation":true,"reason":null,"registrationReason":null},
  "csrfToken":"opaque-token",
  "capabilities":{"search":true,"aiMatching":true,"companyRequests":true,"sse":false,"follows":true,"viewed":true,"preferences":true,"hiddenMatchCounts":true},
  "policies":{"privacyUrl":"https://preview.justup.work/privacy.html","usageUrl":"https://preview.justup.work/usage.html","version":"reviewed-version","reviewed":true,"locale":"en","reviewedLocale":"en","fallback":false},
  "coverage":{"kind":"imported_snapshot","verifiedAt":"2026-10-31T15:00:00Z","stale":false}
}
```

The URLs and enabled flags above are illustrative. Return the deployed configuration and actual provider availability. A visitor has `user:null`, `access.kind:"guest"` and `fullAccess:false`. With reviewed policies and the composed visitor service, signed-out visitors can submit and refine cookie-owned searches through `/visitor/searches`, read only eligible older matches and confirmed hidden counts, and persist unsent drafts through `/visitor/workspace`. The public `/jobs` feed remains separate. See the [visitor-search contract](visitor-search.md) for temporary retention, Origin/CSRF checks, exact workspace compare-and-set, viewed actions, durable draft recovery and atomic verified sign-in handoff. Account routes retain their existing account requirement.

Choose signed-out workspace scope from `user:null` plus `capabilities.visitorSearch:true`, even while `visitor:null`. Session and fresh workspace/search hydration remain stateless. A valid current ownership hint reads the empty revision-zero workspace and `{items:[]}` without allocating. The first meaningful `PATCH /visitor/workspace` atomically saves a `drafts.new` string and temporary owner, without a model or task. Empty bootstrap writes allocate nothing; ordinary compare-and-set recovery handles a lost save response. Storage admission is independent of `capabilities.search`. See the visitor contract for exact bootstrap, clearing and cookie-revocation behavior.

`authentication.reason` is null or `policy_unavailable`, `deletion_unavailable`, `dependency_unavailable`. Login requires reviewed configured policies and working retention/deletion protections. Registration additionally requires backend registration availability and remaining configured account capacity. Invitation configuration is required only in invitation mode. The response always reports the authoritative boolean `requiresInvitation`; clients conservatively treat an absent value as true. Stable cookies are `__Host-justup_session` and `__Host-justup_csrf`, with explicit localhost-only variants. The `product-draft-5` policies are unapproved; this illustrative reviewed example does not authorize activation. Model availability is separate from login and account deletion. A wrong deletion password returns `invalid_credentials` while preserving the valid session; an expired session returns `unauthenticated`.

Accounts with `access.fullAccess:true` can read eligible imported jobs first observed within 14 days. Visitors can read only jobs first observed 48 hours to 14 days ago. A signed-in account without full access receives the same withheld-job protection as a visitor. The current account access is not a paid-plan or free-trial claim. Access is rechecked on every result page.

[Reading state and language preferences](reading-preferences.md) defines the full follow, option and locale contract. Follows and explicit unfollows survive sessions and are removed with the account. A follow change invalidates affected followed-only search revisions; reload the returned `invalidatedSearchIds`. The interface preference DTO is `{accountId,revision,interfaceLocale,supportedInterfaceLocales:["en","de","fr","it","es"],defaultInterfaceLocale:"en",resolvedInterfaceLocale}`. Null means ordered browser matching with regional-to-base normalization and English fallback; an explicit supported locale wins. Browser lists are not stored. Posting languages are independent of this interface choice.

## Searches, tasks and results

| Route | Input or result |
| --- | --- |
| `GET /jobs?cursor=…&limit=12` | Access-controlled imported feed; works without an account. |
| `GET /searches` | Account-owned saved searches. |
| `GET /search-options` | Available imported posting-language `{id,name}` values and explicit any/OR/intersection semantics. |
| `POST /searches` | `{query,requestKey,options?,presentationLocale?}` → new search and bounded interpretation task. |
| `PATCH /searches/:id` | `{query,expectedRevision,requestKey,presentationLocale?}` → interpretation task; preserve the last accepted revision until validation succeeds. |
| `PATCH /searches/:id/options` | `{expectedRevision,followedOnly,postingLanguages}` → updated `{search}` without inference. |
| `POST /searches/:id/confirm` | `{proposalId,expectedRevision}` → explicitly accept a warned partial configuration; never apply one silently. |
| `DELETE /searches/:id` | Delete that search and invalidate its tasks/cursors. |
| `GET /tasks/:id` | Owner-only pending/running/succeeded/warning/failed task result. |
| `GET /searches/:id/results?revision=…&cursor=…&limit=12` | Confirmed eligible matches and truthful scan status. |
| `GET /workspace/events?searchId=…&revision=…` | Cookie-authorized active-search SSE snapshots with opaque resume identity. Visitors use `/visitor/workspace/events` with the same required parameters. |

The [live-results contract](live-results.md) defines prefix arrivals separately from complete retained-ID reconciliation. A partial or pending prefix cannot erase older displayed rows. Close and reopen on active-tab changes: inactive tabs cannot enqueue scans or classification work through a stream. The transport rechecks current cookie authority and protection gates throughout the connection, reconciles access/closure/expiry, and refreshes authoritatively on reconnect. It does not advance ordinary result cursors or delivery offsets. Events are limited to 1 MiB. Deployed edge delivery and browser reader stability remain release-gate evidence.

Long work returns `202` with `{search,task:{id,status:"pending"}}` or `{request,task:{id,status:"pending"}}`. Poll the owner-only task with bounded backoff. Its completed result contains the accepted search/request or a warning/clarification. `requestKey` makes retried submissions idempotent. The runner stores leases, uses execution/time/output limits and recovers interrupted work without duplicating acceptance.

The full public task shape is `{id,kind,status,createdAt,updatedAt,result,error}`. Pending/running tasks have null result/error. A succeeded task returns `result:{search}` or `result:{request}`. A warned search returns `result:{proposal:{proposalId,searchId,expectedRevision,query,title,description,configuration,requirements,warnings}}`; company clarification returns `result:{request}` with its clarification state. A failed task has null result and safe `error:{code,message,retryable}`. Internal payload, output, lease and raw provider diagnostics never serialize.

`POST`/`PATCH` search submissions return the full public task alongside the search. A first pending search has revision zero; an edit preserves its last accepted revision plus its draft. Confirmation returns `200 {search}`. `GET /searches` and `GET /company-requests` return `{items:[...]}`; deleting one returns `200 {deleted:true}`.

New-search creation atomically associates a matching saved new-tab draft with the exact new search ID while enqueuing its task. Comparison trims only leading/trailing whitespace and moves the raw saved text unchanged. With no saved new draft and no other active tab, it associates raw direct-submission text instead. It preserves newer text and another active tab. Search deletion removes only its associated workspace key and selection inside the deletion transaction. The response stays `{search,task}`: re-read workspace after creation, and recover a lost response through workspace/search hydration and the same request key. An idempotent retry never associates another draft. No additional pending-create table or token is used.

An accepted search has `{id,revision,query,title,description,configuration,requirements,warnings,options,status:"ready"}`. `options` defaults to `{followedOnly:false,postingLanguages:[]}`. An empty language set means any; a selected set uses OR and excludes unknown posting language. Its intersection with query-derived requirements and follows runs before residual AI and hidden-match evaluation. Conflicting language requirements produce zero matches without loosening either side. There is no arbitrary selected-language count cap; identifiers come from the validated finite imported catalogue and requests use the existing body bound. Visitor language options use `/visitor/search-options` and `/visitor/searches/:id/options`; followed-only requires an account. The browser shows the user's query, generated tab title and warnings; the collapsed description is accepted metadata, not a separate visible criteria summary. Keep drafts/proposals distinct from this accepted state. A timeout, failed normalization, unresolved hard requirement or stale response cannot overwrite it. A warned proposal has a server-issued `proposalId`, expected revision and explicit unmet-requirement reasons.

Options persist per search through text edits and sign-in transfer. Actual changes increment the search revision, cancel incompatible pending work and invalidate old scans, proposals and cursors, preserving accepted query and draft text. A cancelled submitted draft reports `taskId:null,status:"interrupted"`. Explicit settings changes do not invoke the model. Optional `presentationLocale` is limited to the supported interface set and must match the resolved request locale. One `X-Justup-Locale` header selects an explicit route language before saved or browser preferences, without persisting it or bypassing policy approval. Native EventSource uses the equivalent optional `locale` query field on the two workspace event routes. The selected context governs generated title/reason wording only. Neither queries nor source content are translated or rewritten.

A compiler-generated `company_not_found` warning may include `companyRequestPrefill:{input,scope}`. `input` is a plain company name of at most 200 characters; non-null `scope` has the same limit. Strings must be nonempty after trimming and contain no controls. Offer this only for a stated positive company requirement that the full imported catalogue cannot resolve; known aliases, ambiguity, exclusions and unrelated mentions must not generate a hint. Strip the model's internal company-reference fields from public requirements. Ignore malformed optional prefill metadata while retaining the ordinary warning. An explicit warning action can prefill the existing company form; only the user's form submission creates a request.

Search configuration version 1 supports only evidence-backed primary filters: company inclusion/exclusion, title terms, required/excluded body terms, location labels, workplace type, employment type, posting language and available seniority. Define exact operators and canonical values in the compiler's capabilities response. Missing evidence is unknown. Location labels alone do not prove cross-border remote eligibility. Do not invent salary or visa normalization from unavailable fields.

Luna receives the request, prior accepted query/configuration when edited, current capabilities and AI availability. The compiler returns field-level normalization and conflict diagnostics for one bounded repair. Every requirement is accounted for as primary, residual AI, nonbinding preference or unsatisfied with a reason. The final collapsed description describes the applied configuration. A valid zero-result search is distinct from failed compilation.

Results example:

```json
{
  "searchId":"search-id",
  "revision":2,
  "asOf":"2026-10-31T16:00:00Z",
  "items":[{
    "id":"source-posting-id",
    "title":"Backend engineer",
    "company":{"id":"source-company-id","name":"Example","logoUrl":null},
    "sourceUrl":"https://employer.example/careers/role",
    "firstObserved":"2026-10-29T10:00:00Z",
    "locations":[{"name":"Zurich, Switzerland","workplace":"onsite"}],
    "employmentTypes":["full_time"],
    "postingLanguages":["en"],
    "seniority":null,
    "salary":null
  }],
  "continuation":{"cursor":"opaque","state":"open","retryAfterMs":null},
  "ai":{"status":"not_required"},
  "coverage":{"verifiedAt":"2026-10-31T15:00:00Z","stale":false}
}
```

Use continuation states `open`, `pending`, `paused`, `exhausted`, `failed`. Empty pending/open batches are not exhaustion. Cursors bind revision, scan position, access mode and imported evidence generation; stale cursors return 409. Ordering is descending source first-observed time with stable posting ID as tie-breaker.

Missing or stale imported evidence returns an empty `paused` page with `retryAfterMs:5000`, never a completed zero-result search. Coverage has `stale:true`, an `import_unavailable` state and a short description explaining that imported listings need verification; `verifiedAt` can be null. Preserve cursor ownership, revision and generation validation before returning the pause. Do not run matching against unavailable evidence. Residual AI reports `dependency_unavailable`; a search without residual AI retains `not_required`. Show the source reason with the existing manual retry action. Fresh data with no eligible matches can return `exhausted`.

Residual matching runs only after freshness and primary filters. JEV returns accept/reject/insufficient-evidence; provider failure is separate. Cached decisions bind condition, evidence hash and classifier version, scoped for account deletion. Batch enough candidates for low acceptance rates within bounded concurrency/work budgets. Deliver a resolved newest-first prefix; never substitute unevaluated candidates. Pauses and outages retain scan position and active AI requirements.

The composed runtime implements follows, viewed observations, interface preferences, posting-language options and confirmed hidden-match counts. Their complete browser and deployed journeys remain release gates. Resumable SSE and attributable company hiring reports remain first-release requirements. Capability flags describe implemented availability; they cannot defer an accepted release requirement. The Hiring Wire API and worker are being integrated under their own bounded contract.

## Companies and identity requests

| Route | Input or result |
| --- | --- |
| `GET /companies?q=…&limit=20&cursor=…` | Public catalogue page `{items,coverage,nextCursor}` of imported identities and accepted company-request identities. |
| `GET /companies/:id` | Public canonical identity/source evidence; absent history remains unavailable. |
| `GET /companies/:id/report` | Public deterministic report with historical provenance, unknown/partial periods, guest-eligible role labels and reported salary samples. No query parameters or generation side effects. |
| `GET /account/companies?view=followed\|requested&q=…&limit=20&cursor=…` | Private bounded catalogue `{accountId,view,items,coverage,nextCursor}` using the same canonical company rows. |
| `POST /account/companies/:id/priority` | `{requestKey}` → `200 {request}` for a published canonical company; current premium access required. Reuses or creates a confirmed private request without research. |
| `GET /company-requests` | Account-owned requests and current state. |
| `POST /company-requests` | `{input,domain?,careerUrl?,scope?,requestKey}` → known candidate or bounded identity-resolution task. |
| `POST /company-requests/:id/accept` | `{candidateId,previewRevision}` and `Idempotency-Key` → atomically publish/reuse canonical company identity and follow once, preserving explicit unfollow. |
| `DELETE /company-requests/:id` | Remove the account's request, preview and associated task data. |

A request contains `{id,input,scope,status,candidate,companyId,setup,previewRevision,clarification,taskId,createdAt}`. Status is pending/candidate/clarification/unresolved/accepted. A candidate contains `{id,companyId,name,domain,websiteUrl,evidenceUrls,coverage}`. Its exact-preview ID differs from the canonical catalogue `companyId`, which is null until known or accepted. A confirmed known catalogue ID is reused directly; imported IDs remain unchanged. Newly researched requests receive a separate identity with `coverage.state:"requested"`. A host or name cannot bind it to an imported source company. An already occupied requested domain is reused only for an equal normalized name and exact website URL; a different candidate returns `409 preview_conflict` without publication. Public identity/evidence has no requester ID and survives private request/account deletion. Material ambiguity returns a short clarification with candidate null. Search known identities before invoking Codex Luna. Treat provided pages as untrusted evidence, restrict tools and validate output URLs and sizes.

Every public company row has safe shared `setup:{state,reason,nextAction,updatedAt}`. Accepted private requests additionally expose `setup:{companyId,revision,state,reason,nextAction,updatedAt,priority}`; other requests have `setup:null`. Private priority is `premium` only while that requester's current persisted access has `premium:true`, otherwise `standard`; it is neither a queued entitlement nor another requester's status. Shared progress is `queued`, `in_progress` or `blocked`. The reserved `monitoring` state is unavailable: this runtime has no current authoritative monitoring receipt producer. Initial accepted setup is `queued/operator_handoff_pending/await_setup`; operator work uses `in_progress/source_validation_pending/await_validation`; blocked work uses `source_validation_pending/await_validation` or `source_evidence_unavailable/retry_later`. Companies without a shared setup record report `blocked/source_evidence_unavailable/await_validation` with `updatedAt:null`. Other update times are ISO timestamps. Publication and imported listings remain separate from working monitoring. Public setup never includes priority, requester identity or private requested scopes.

Known-company priority uses the exact row's canonical ID and the existing acceptance/follow transaction. An exact key retry returns the same relationship; a new key reuses an existing accepted request for that company and owner. Explicit unfollow survives. Keys reused for a different company or operation return `409 idempotency_conflict`; malformed bodies return 400, unknown company IDs return 404, and absent current premium returns `403 access_denied`, including retries after downgrade. Origin, CSRF, current locale policy and account admission still apply. Free ordinary preview acceptance remains available; priority does not change job-result order. Request and key limits remain 32 and 128 per owner by default, with no automatic request expiry before request/account deletion. The [operator handoff](../scripts/company-requests/README.md) defines bounded pending reads, queue ordering, safe progress updates and the missing monitoring producer.

The public catalogue accepts only `q`, `limit` and `cursor`, once each. `q` is at most 100 characters; matching trims it and ignores letter case. `limit` defaults to 20 and accepts integers 1–50. Public catalogue reads never depend on cookies or a viewer. Ordering is company name in English collation, then canonical company ID. Preserve `q` on continuation links. `nextCursor:null` means the filtered catalogue is exhausted. Signed ten-minute cursors bind public scope, normalized filter, imported generation and published catalogue content. Malformed, tampered or wrong-scope cursors return `400 invalid_cursor`; expired cursors or changed catalogue/filter return `409 stale_cursor` and require restarting without a cursor. Invalid limits return `400 invalid_limit`; unknown, repeated or private-scope parameters return `400 invalid_query`. Coverage remains the current import freshness projection even when stale; a catalogue identity alone does not establish monitored hiring activity.

The private catalogue requires exactly one `view=followed` or `view=requested`, with the same optional `q`, `limit` and `cursor` bounds and ordering. Its owner comes only from the current authenticated session. Requested membership means an accepted request with a canonical company ID; pending resolution, ambiguous previews and unconfirmed candidates do not create rows. Followed membership respects explicit unfollows and verified source aliases. Ten-minute private cursors additionally bind the owner, view and canonical membership set. A different owner/view or a public/private cursor crossover returns `400 invalid_cursor`; a changed filter, membership, catalogue or import generation returns `409 stale_cursor`. Stored private catalogue reads remain available during a policy pause through the validated session. Clients bind responses to `accountId`, preserve view/filter on continuations and restart after stale cursors; they need no global catalogue traversal or per-ID requests.

A known immediate identity returns `201 {request}`; queued resolution returns `202 {request,task}`. Acceptance returns `200 {request}` with status accepted and references the exact server-held candidate and preview revision. Requirements use `{id,text,handling,reason}` and warnings use `{code,message,requirementIds}`; `handling` is primary/ai/preference/unsatisfied.

The importer can obtain validated official-host metadata through bounded exact-ID reads of Jobseek's public `company.website`. This metadata stays with the exact source company ID; a shared host never aliases distinct source companies or an earlier requested identity. Reports, follows, priority and search filters therefore remain separate until a separately reviewed identity link exists. Existing persisted aliases are retained without new host-based inference, and older cross-ID rows require review before activation. Stored source posting identities remain immutable. See [source identity integration](reading-preferences.md).

The [company report contract](company-hiring-reports.md) defines `{companyId,asOf,provenance,scope,freshness,monitoringSince,sourceChecks,hiringHistory,hiringRoles,reportedSalaries,methodology}`. Current facts use only the fresh active unreserved 48-hour–14-day public listing sample, with explicit label/salary sample coverage and `completeCompanyCoverage:false`. Historical facts use the latest published frozen `jobseek-coverage-v1` or `jobseek-coverage-v2` snapshot and its own observation/generation/publication times. `sourceChecks:{state,items:[{publicLink,trackedSince,lastVerifiedAt}]}` exposes only approved v2 career links; v1 or missing approvals remain null. Its state describes link availability, not live health or complete history. Missing or interrupted periods yield unknown counts; no current snapshot can establish monitoring start or historical zeros. Currency and salary period remain separate. Public projections contain no raw source scope or posting identities, bodies, private request/follow/search state or provider configuration.

Imported companies have `coverage.state:"imported_snapshot"`; an accepted new identity has `coverage.state:"requested"`. Neither claims that a board has been configured or that Justup currently monitors it. Do not fabricate a company website from an applicant-tracking-system job URL, or expose private crawler board configuration. Request acceptance does not write to Jobseek or start crawler onboarding.

## Health and fixed build identity

`GET /health` proves process readiness without secrets. `GET /version` returns the API source commit, application database schema epoch `2`, immutable build identity, runner identity/readiness and import generation. The [schema guide](schema.md) defines migration and forward recovery; independent import/search/heartbeat/source/ledger format versions remain unchanged. The release report also records the frontend deployment identity and exact tested versions. A missing required dependency is an explicit capability/readiness state, not a fake successful result.

## Data flow and retention

| Data | Purpose and recipients | Product retention/deletion contract |
| --- | --- | --- |
| Username, password hash, session-token hash | Local account authentication on the isolated Nuremberg host. No external login provider/scopes or email. | Sessions default seven days; account identity persists until verified deletion or an explicitly stored temporary-account deadline. |
| Search text, accepted configurations and revisions | Local saved searches; request/prior query/configuration and selected posting-language context sent to OpenAI through bounded Luna execution. No account IDs, usernames or billing data in model prompts. | Account lifetime; account/search deletion purges associated private task/decision data. Terminal queue records expire after 30 days; matching cache/scans after seven. |
| Residual AI condition and public job evidence | JEV provider for matching after ordinary filters. | Local decisions keyed by exact versions, at most seven days and removed with account data. Provider handling must be documented from actual configuration. |
| Company name/domain/link/scope and public evidence | Local request tracking and bounded OpenAI/Codex identity research. | Account lifetime; removable request and account paths. |
| Imported public listing fields and normalized description text | Read-only Jobseek public search/asset import. No user records, credentials, private crawler configuration or internal traces. | Rolling 14-day eligibility and 24-hour verification ceiling; bodies/metadata pruned after 30 days and to 1,000 jobs. Minimal source identity keys and latest activity/reservation observations persist to prevent reassignment or stale reopening; import summaries retain 32 generations. |
| Operational diagnostics | Route category, status, request ID, duration, token/cost counts and redacted diagnostic codes; no raw query/body, password, token or IP in application logs. | Bounded local retention, initially seven days, with implemented cleanup and restore/deletion behavior recorded before policy approval. |

These are implementation requirements. The privacy inventory and static policy pages must be updated to actual observed settings and provider recipients before approval; do not promise provider zero retention. Company research may use public web evidence. Prevent model tools from accessing runtime secrets, private host paths or production services. No model request or raw trace is published in GitHub or browser errors.

The composed [private evidence collection](product-evidence.md) adds only fixed metadata and explicit reviewed evaluation cases. New journey/execution observations and review references require current locale processing admission; task evidence also matches the task's exact policy key. A policy pause preserves stored reads, owner transfer and deletion while suppressing new private analytics. Setup observations deduplicate by request/status/preview/setup revision and contain no company name, domain, requested scope or another owner's priority. Workspace association callbacks share the search transaction; optional observations run after that commit and cannot block first-draft allocation, retry, handoff or empty-owner reclamation.

Use deterministic tests and isolated accounts/data by default, then bounded real-provider checks and full deployed browser journeys. Record exact candidate and deployed builds, failure recovery, resource use, deletion and restore results before first invited activation. Subscription, continuous-feed, monitored-company transition and live-delivery gaps must be resolved or explicitly changed by an accepted product decision.
