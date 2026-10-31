---
summary: Integrate the temporary Justup preview with its minimal API and confirmed data boundaries.
read_when: Connecting the browser, implementing a backend module or reviewing preview privacy and release evidence.
---

# Demo API contract

Status: implementation contract; not a claim that endpoints are deployed.

The demo serves a bounded copy of real Jobseek listings, real preview accounts, validated search interpretation, optional last-resort matching and company identity requests. Billing, production mail, crawler writes and production schedules are disabled. Follow the [development guide](development-process.md); ordinary implementation targets `dev`, and runtime changes cannot enter `main` before the real release gate passes.

## Runtime and resource boundary

Use Node.js 24 LTS ES modules, built-in HTTP/crypto/SQLite and one bounded runner. The isolated SQLite database and task state belong only to the preview. This is a small demo allocation, not a change to the longer-term production database decision. No additional database service or auth vendor is needed.

The existing ARM64 host is in Nuremberg. Keep its production Lightpanda renderer intact. The aggregate preview ceiling is half a CPU, 1 GiB RAM, 2 GiB disk and 96 tasks, with at most one model task in flight. Verify and enforce these limits before deployment. Builds run off-host. A resource outside the authorized host/free Cloudflare allowance needs a separately approved resource request.

The browser application lives in `web/` and deploys its compiled React/Vite artifact. Build committed inputs and the lockfile in an unprivileged off-host builder, then upload the retained bytes. The API/runner package contains only backend runtime files. Record the frontend artifact identity alongside compatible API and runner identities; do not deploy source files or compile on the bounded host.

## HTTP rules

All browser calls use same-origin `/api/v1` routes. Bodies and responses are JSON except health text if needed. Times are ISO 8601 UTC; job discovery timestamps always retain their source value. IDs come from the server. Private records derive ownership from the session, never a supplied account ID.

Set `Cache-Control: private, no-store` for session, account, search, task and request responses. Do not send hidden job IDs, titles, bodies or URLs and rely on browser blur for access control. Mutation requests require the session cookie, an allowed `Origin` and `X-CSRF-Token`. Authentication uses a host-only, HttpOnly, Secure, SameSite=Lax opaque session cookie. Local test HTTP is a separately explicit configuration.

Errors use the following shape, with safe messages and no provider output or secrets:

```json
{"error":{"code":"revision_conflict","message":"This search changed. Reload it and try again.","requestId":"request-id"}}
```

Use 400 for malformed input, 401 for a missing/expired session, 403 for denied access, 409 for stale revisions/previews, 422 for unsupported requirements, 429 for a usage limit and 503 for an unavailable dependency. Include `Retry-After` where a retry is appropriate.

## Session and preview accounts

The login provider is Justup itself: invite-only username/password accounts. There are no email addresses, external identity providers, Google OAuth scopes, payment identities, trial activation or legacy-credit claims in this preview. Passwords use salted scrypt; the store retains only hashes of passwords and random session tokens. Registration is capped at 30 accounts initially. Sessions expire after seven days and logout revokes them.

Keep registration and login disabled until the static Privacy and Usage pages have been reviewed. Deploy the approved HTTPS page URLs and policy version with the API. The pages are frontend-owned; there is no policy JSON endpoint.

| Route | Input or result |
| --- | --- |
| `GET /session` | Viewer or null, server time, access rules, CSRF token, authentication availability, capabilities, policy URLs/version and import freshness. |
| `POST /auth/register` | `{username,password,inviteCode}` → account/session; unavailable until policy approval and invite configuration. |
| `POST /auth/login` | `{username,password}` → account/session; same policy gate. |
| `POST /session/logout` | Revoke the current session and clear its cookie. |
| `DELETE /account` | `{password}` → confirmed deletion of the account, sessions and its private searches, requests, tasks and cached model decisions. |

Session example:

```json
{
  "serverTime":"2026-10-31T16:00:00Z",
  "user":{"id":"account-id","username":"tester"},
  "access":{"kind":"demo","fullAccess":true,"legacy":false,"billingEnabled":false,"until":null},
  "authentication":{"method":"username_password","loginEnabled":true,"registrationEnabled":true,"reason":null},
  "csrfToken":"opaque-token",
  "capabilities":{"search":true,"aiMatching":true,"companyRequests":true,"sse":false,"follows":false,"viewed":false,"preferences":false,"hiddenMatchCounts":false},
  "policies":{"privacyUrl":"https://preview.justup.work/privacy","usageUrl":"https://preview.justup.work/usage","version":"reviewed-version","reviewed":true},
  "coverage":{"kind":"imported_snapshot","verifiedAt":"2026-10-31T15:00:00Z","stale":false}
}
```

The URLs and enabled flags above are illustrative. Return the deployed configuration and actual provider availability. A visitor has `user:null`, `access.kind:"guest"` and `fullAccess:false`. Anonymous visitors can read the public feed; creating or editing a model-backed search requires sign-in. The browser may preserve an unsubmitted visitor draft in memory, without inventing a saved account search.

`authentication.reason` is null or `policy_unavailable`, `deletion_unavailable`, `dependency_unavailable`. Login requires reviewed configured policies and working retention/deletion protections. Registration additionally requires an invite configuration and remaining account capacity. Model availability is separate from login and account deletion. A wrong deletion password returns `invalid_credentials` while preserving the valid session; an expired session returns `unauthenticated`.

Preview accounts can read eligible imported jobs first observed within 14 days. Visitors can read only jobs first observed 48 hours to 14 days ago. These are explicit demo access rules, not a paid-plan or free-trial entitlement. Access is rechecked on every result page.

## Searches, tasks and results

| Route | Input or result |
| --- | --- |
| `GET /jobs?cursor=…&limit=12` | Access-controlled imported feed; works without an account. |
| `GET /searches` | Account-owned saved searches. |
| `POST /searches` | `{query,requestKey}` → new search and bounded interpretation task. |
| `PATCH /searches/:id` | `{query,expectedRevision,requestKey}` → interpretation task; preserve the last accepted revision until validation succeeds. |
| `POST /searches/:id/confirm` | `{proposalId,expectedRevision}` → explicitly accept a warned partial configuration; never apply one silently. |
| `DELETE /searches/:id` | Delete that search and invalidate its tasks/cursors. |
| `GET /tasks/:id` | Owner-only pending/running/succeeded/warning/failed task result. |
| `GET /searches/:id/results?revision=…&cursor=…&limit=12` | Confirmed eligible matches and truthful scan status. |

Long work returns `202` with `{search,task:{id,status:"pending"}}` or `{request,task:{id,status:"pending"}}`. Poll the owner-only task with bounded backoff. Its completed result contains the accepted search/request or a warning/clarification. `requestKey` makes retried submissions idempotent. The runner stores leases, uses execution/time/output limits and recovers interrupted work without duplicating acceptance.

The full public task shape is `{id,kind,status,createdAt,updatedAt,result,error}`. Pending/running tasks have null result/error. A succeeded task returns `result:{search}` or `result:{request}`. A warned search returns `result:{proposal:{proposalId,searchId,expectedRevision,query,title,description,configuration,requirements,warnings}}`; company clarification returns `result:{request}` with its clarification state. A failed task has null result and safe `error:{code,message,retryable}`. Internal payload, output, lease and raw provider diagnostics never serialize.

`POST`/`PATCH` search submissions return the full public task alongside the search. A first pending search has revision zero; an edit preserves its last accepted revision plus its draft. Confirmation returns `200 {search}`. `GET /searches` and `GET /company-requests` return `{items:[...]}`; deleting one returns `200 {deleted:true}`.

An accepted search has `{id,revision,query,title,description,configuration,requirements,warnings,status:"ready"}`. The browser shows the user's query, generated tab title and warnings; the collapsed description is accepted metadata, not a separate visible criteria summary. Keep drafts/proposals distinct from this accepted state. A timeout, failed normalization, unresolved hard requirement or stale response cannot overwrite it. A warned proposal has a server-issued `proposalId`, expected revision and explicit unmet-requirement reasons.

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

SSE, follows, viewed state, preferences, hidden-match counts and Hiring Wire are explicitly unavailable in this first demo contract. Capability flags keep the UI honest. They remain in the broader design and can be added when their end-to-end contracts are ready.

## Companies and identity requests

| Route | Input or result |
| --- | --- |
| `GET /companies?q=…` | Bounded catalogue using only imported public evidence. |
| `GET /companies/:id` | Imported identity/available source evidence; absent history remains unavailable. |
| `GET /company-requests` | Account-owned requests and current state. |
| `POST /company-requests` | `{input,domain?,careerUrl?,scope?,requestKey}` → known candidate or bounded identity-resolution task. |
| `POST /company-requests/:id/accept` | `{candidateId,previewRevision}` and `Idempotency-Key` → record that exact accepted identity/scope once. |
| `DELETE /company-requests/:id` | Remove the account's request, preview and associated task data. |

A request contains `{id,input,scope,status,candidate,previewRevision,clarification,taskId,createdAt}`. Status is pending/candidate/clarification/unresolved/accepted. A candidate contains `{id,name,domain,websiteUrl,evidenceUrls,coverage}`. Material ambiguity returns a short clarification with candidate null. Search known identities before invoking Codex Luna. Treat provided pages as untrusted evidence, restrict tools and validate output URLs and sizes.

A known immediate identity returns `201 {request}`; queued resolution returns `202 {request,task}`. Acceptance returns `200 {request}` with status accepted and references the exact server-held candidate and preview revision. Requirements use `{id,text,handling,reason}` and warnings use `{code,message,requirementIds}`; `handling` is primary/ai/preference/unsatisfied.

Imported companies have `coverage.state:"imported_snapshot"`; an accepted new identity has `coverage.state:"requested"`. Neither claims that a board has been configured or that Justup currently monitors it. Do not fabricate a company website from an applicant-tracking-system job URL, or expose private crawler board configuration. Request acceptance does not write to Jobseek or start crawler onboarding.

## Health and fixed build identity

`GET /health` proves process readiness without secrets. `GET /version` returns the API source commit, schema version, immutable build identity, runner identity/readiness and import generation. The release report also records the frontend deployment identity and exact tested versions. A missing required dependency is an explicit capability/readiness state, not a fake successful result.

## Data flow and retention to verify before sharing

| Data | Purpose and recipients | Preview retention/deletion contract |
| --- | --- | --- |
| Username, password hash, session-token hash | Local account authentication on the isolated Nuremberg host. No external login provider/scopes or email. | Sessions at most seven days; accounts and private state at most 30 days; immediate logical removal on verified account deletion. |
| Search text, accepted configurations and revisions | Local saved searches; request/prior query/configuration and selected posting-language context sent to OpenAI through bounded Luna execution. No account IDs, usernames or billing data in model prompts. | Account lifetime, at most 30 days; account/search deletion purges associated private task/decision data. |
| Residual AI condition and public job evidence | JEV provider for matching after ordinary filters. | Local decisions keyed by exact versions, at most seven days and removed with account data. Provider handling must be documented from actual configuration. |
| Company name/domain/link/scope and public evidence | Local request tracking and bounded OpenAI/Codex identity research. | Account lifetime, at most 30 days; removable request and account paths. |
| Imported public listing fields and normalized description text | Read-only Jobseek public search/asset export into the isolated preview. No user records, credentials, private crawler configuration or internal traces. | Rolling 14-day result eligibility, bounded snapshot age and repeatable refresh/removal. Keep source first-observed times, hashes and verification time. |
| Operational diagnostics | Route category, status, request ID, duration, token/cost counts and redacted diagnostic codes; no raw query/body, password, token or IP in application logs. | Bounded local retention, initially seven days, with implemented cleanup and restore/deletion behavior recorded before policy approval. |

These are implementation requirements. The privacy inventory and static policy pages must be updated to actual observed settings and provider recipients before approval; do not promise provider zero retention. Company research may use public web evidence. Prevent model tools from accessing runtime secrets, private host paths or production services. No model request or raw trace is published in GitHub or browser errors.

Use deterministic tests and isolated accounts/data by default, then bounded real-provider checks and full deployed browser journeys. Record the exact candidate and deployed builds, failure recovery, resource use, deletion and restore results before sharing the temporary preview.
