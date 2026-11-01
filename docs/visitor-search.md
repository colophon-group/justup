---
summary: Cookie-owned visitor searches, confirmed hidden counts and atomic account handoff.
read_when: Wiring signed-out search, draft persistence, viewed actions or current-access checks.
---

# Visitor search and sign-in

The API gives a visitor a separate temporary principal. It never gives that principal an account, session token, or full access. Its fixed lifetime is 24 hours from durable creation. `GET /api/v1/session` supplies the independent guest CSRF cookie and a stateless `__Host-justup_visitor` ownership hint, with HttpOnly, Secure, SameSite=Lax and Path=/; explicitly enabled loopback HTTP uses `justup_visitor`. The hint is a domain-separated server HMAC of the prior guest CSRF seed. Session reads allocate zero durable visitors and report `visitor:null` until the first admitted search. Unsent text remains in browser memory before that submission. After Origin, CSRF, current policy/deletion checks and input admission, `POST /visitor/searches` allocates the exact pre-established ownership token. A lost entire first response therefore leaves enough prior-cookie state to retry the same request key against the same owner, search and task. Unknown supplied cookie values cannot choose a stored principal. A spent sign-in receipt requires a new stateless binding from session; it never recreates transferred data. Invalid or unavailable submissions retain no empty visitor. The private database stores only a hash of the opaque ownership token. No token or internal visitor ID appears in JSON.

The session adds `visitor: {expiresAt: string} | null` and `capabilities.visitorSearch`. Account sessions have `visitor:null`. Visitor search opens only with approved policy configuration and an available private-deletion barrier. Unreviewed `product-draft-4` is not authorization to enable it. Interpretation still requires the exact same-build runner heartbeat; the API has no provider credentials and runs no inference. Each mutation requires the exact Origin, a session-derived CSRF token, bounded JSON and the existing peer limits. Company requests and other account operations remain account-only.

Existing visitor reads and mutations also check current policy, deletion and maintenance availability. A restart with unreviewed policies revokes processing of persisted work before routes open. API composition publishes one non-secret SQLite admission proof bound to its source/build, reviewed policy version and current private generation. Startup first disables prior proof. Successful maintenance refreshes it every minute; active authority checks refresh at most once per 30 seconds unless its state changes. The independent queue rejects absent, disabled, wrong-build, future or at-least-90-second-old proof, and rechecks it before inference and before committing. Thus API loss has a bounded 90-second fail-closed window; this is not a claim of instantaneous propagation from periodic refresh. Queue reads also require the current private-generation file to be regular, stable and free of a pending deletion marker. Its default is `private-generation` beside the database; unreadable or missing state denies visitor work. The queue never clears a marker. Explicit authenticated-cookie deletion and expired-state cleanup remain available independently of processing admission, subject to the real deletion barrier.

## Browser routes

All paths below have `/api/v1` before them. Queries and drafts belong only in JSON bodies; do not put them in URLs, localStorage or sessionStorage. Hold the current field text in memory and persist it through the workspace API. URLs carry only opaque resource IDs, revision numbers, limits and cursors.

| Method and path | Body / response |
| --- | --- |
| `GET /visitor/searches` | `{items: Search[]}`; only this visitor's searches. |
| `POST /visitor/searches` | `{query,requestKey}` → 202 `{search,task}`. |
| `PATCH /visitor/searches/:id` | `{query,requestKey,expectedRevision}` → 202 `{search,task}`. |
| `POST /visitor/searches/:id/confirm` | `{proposalId,expectedRevision}` → `{search}`; explicit acceptance of a partial proposal. |
| `DELETE /visitor/searches/:id` | `{}` → `{deleted:true}`; revokes queued effects and deletes private search state. |
| `GET /visitor/searches/:id/results?revision=N&limit=N&cursor=…` | The ordinary results page plus `hiddenMatches`; `revision` is required, limit defaults to 12 and is 1–50. |
| `GET /visitor/tasks/:id` | Ordinary redacted task envelope; no raw provider output, hidden postings or queued payload. |
| `GET /visitor/workspace` | Workspace snapshot below. |
| `PATCH /visitor/workspace` | Workspace compare-and-set body below. |
| `POST /visitor/viewed` | `{jobId}` → `{viewed:true}`; record only an outbound company-posting activation, not an impression. |
| `DELETE /visitor/session` | `{}` → `{deleted:true}`; deletes all temporary state. The next admitted search creates fresh ownership. |

The signed-in equivalents remain `/searches`, `/tasks/:id`, `/workspace` and `/viewed`. Both result paths return the same hidden-count states. A signed-in browser cannot dispatch through `/visitor/*`. An unauthenticated browser cannot use private `/searches`, `/workspace`, company requests or account operations.

Search and task shapes reuse the accepted interpretation contract. Submitted criteria change only when a valid result or explicitly confirmed proposal advances the search revision. Invalid interpretation retains the accepted criteria and the submitted draft. Searching/editing uses a fresh request key; an identical retry returns its existing task, and a changed body with that key conflicts. Cross-owner IDs return 404. Expired or deleted visitor ownership returns 401. Quota exhaustion returns 429 `task_limit`; admission/peer limits return 429 `rate_limit`. Unapproved policy returns 503 `policy_unavailable`, and an unavailable interpreter returns 503 `dependency_unavailable`.

After successful search deletion, the service reclaims a visitor only when it has no remaining search, task, model state, viewed record, recovered draft, nonempty workspace draft or other persisted owner-scoped work. Empty workspace bookkeeping may be removed with the principal. The final emptiness check and deletion share the existing private-deletion transaction and barrier; a concurrent save prevents reclamation. This frees capacity after a create/delete/discard-cookie cycle without evicting active users. It never resets a monetary ledger or creates identity/redemption tombstones. A retained draft or viewed observation keeps its owner and cookie usable. The next admitted search can allocate fresh durable ownership from the stateless hint when an empty principal has been reclaimed.

## Drafts, active tab and viewed state

A workspace snapshot is:

```json
{"revision":0,"state":{"activeSearchId":null,"drafts":{}},"viewed":[],"recoveredDrafts":[]}
```

`viewed` contains `{jobId,firstViewedAt}`. It records only eligible public postings and uses the first timestamp for repeated clicks. Hidden posting IDs cannot be probed through this route. The returned viewed list is filtered by current access and source eligibility; a paid account's previously viewed latest IDs stay private after expiry. The same state follows a posting across searches. Account data is returned only to that account and is deleted with it.

PATCH sends the complete workspace draft map, not a partial merge:

```json
{"expectedRevision":0,"activeSearchId":"own-search-id","drafts":{"own-search-id":"Unsubmitted refinement","new":"First-search draft"}}
```

`activeSearchId` must be null or an owned search; each draft key must be an owned search ID or `new`. Each string is at most 4,000 characters, at most 100 keys are accepted, and the state is at most 60,000 bytes. Only workspace PATCH accepts up to 64 KiB of JSON; other routes retain the ordinary 16 KiB body ceiling. The server advances the workspace revision and returns the new snapshot. A stale revision returns 409 `revision_conflict`; refetch and reconcile the local unsent text explicitly before retrying. Concurrent tabs cannot silently overwrite each other. Viewed writes do not advance the workspace draft revision.

`recoveredDrafts` is a top-level array of `{id,text,createdAt}` retained separately from autosaved state. PATCH cannot alter or remove it. `POST /workspace/recovered-drafts/:id` (or `/visitor/workspace/recovered-drafts/:id`) accepts `{expectedRevision,action:"use"|"discard"}` and returns a full workspace with an advanced revision. `use` puts that text in `drafts.new`, selects the new-search field, and swaps a different nonempty existing `drafts.new` into the same recovery record. If the existing field is empty or identical, it consumes the selected recovery record. `discard` explicitly deletes it. Both actions enforce ownership, compare-and-set and the private deletion barrier. A concurrent autosave must refetch after an action conflict.

Before submitting credentials, await the latest debounced workspace save (including the active search and unsent field text). Resolve a compare-and-set conflict before signing in. Keep the in-memory draft while doing so. A draft still only in browser memory cannot be transferred by the server.

## Confirmed hidden matches

Every search result page has one of:

- `{status:"exact",count:N}`: every relevant posting in the current latest cohort has a confirmed decision; N includes all primary filters and any residual AI condition.
- `{status:"lower_bound",count:N}`: at least N are confirmed; pending work or insufficient evidence prevents a final total.
- `{status:"pending",count:null}`: the residual work has no confirmed count yet.
- `{status:"unavailable",count:null}`: verification or matching dependencies cannot support a count.

A full-access account has an exact zero hidden cohort. Limited accounts and visitors share the latest 48-hour restriction. The exact 48-hour boundary belongs to visible results; hidden postings are newer than that boundary. All cohorts apply the same active/reservation, 14-day age and source verification rules. Source staleness pauses results and makes the count unavailable; it is distinct from a fresh, exhausted zero.

Visible work precedes hidden counting. A residual candidate is never counted before the classifier accepts its current evidence. A rejection does not count; insufficient evidence is a lower bound, never a fabricated zero total. The response contains no hidden identities, titles, bodies, URLs, cursors or model explanations. Render counts and pending/unavailable states honestly. Continue polling the accepted revision when hidden work is pending even if visible pagination is exhausted. A count becoming exact does not reorder results or authorize latest postings.

## Verified sign-in handoff

The HTTP boundary passes a trusted synchronous `afterAuthenticated({db,accountId,phase})` hook to register/login. Auth invokes it after verified credentials and insertion of the account/session, before committing that same SQLite transaction. A failure rolls back the account/session and the entire handoff. The deletion marker stays active until the outer auth transaction ends. Client-provided account IDs never authorize a move.

The handoff appends visitor searches with unchanged IDs and accepted revisions/configuration, preserves warnings and pending query text, merges first-viewed records, and selects the visitor's active search. It preserves the account's existing searches and keyed drafts. No ID mapping is needed. If both sides have an unsent `new` draft, the account draft remains and the visitor draft is stored durably in `recoveredDrafts` for explicit reconciliation, including after a lost credential response. At most 100 recovery records and 128,000 bytes of recovery text belong to an account; exceeding this bound rolls back the whole sign-in transaction and preserves both owners' state. At most 100 total searches may be retained by a handoff; exceeding this bound fails the whole sign-in transaction with `task_limit`, leaving the visitor state intact.

Successful login/register retains the ordinary session body and adds `visitorHandoff:{status:"complete"|"none",recoveredDraftId?:string}`. The visitor cookie is cleared. Repeating a spent cookie against the same verified account is idempotent; it cannot attach to another account. Queued anonymous tasks, cursors, scans and leases are revoked before transfer. Current classifier decisions move with the verified search under new account-owned cache keys, so already evaluated evidence does not require another model call. Cached decisions remain subject to current access and source eligibility. Unfinished query text stays as a draft with `taskId:null,status:"interrupted"`; sign-in does not start new inference. Unconfirmed warning responses are retained as an optional `Search.proposal` value with the same proposal ID and expected revision. Reload the account's searches/workspace after the response, including its durable recovery list. Discard old browser request generations on sign-in, sign-out and deletion so a late response cannot repopulate another workspace.

Logout clears account, visitor and CSRF cookies. The next session read begins a fresh empty visitor, with none of the previous account's state. Account deletion removes its searches, workspace, viewed state and handoff receipts inside the existing deletion barrier. Expired visitor records, queries, tasks and viewed state are purged by composed maintenance and session opening. A fixed expiry is not renewed by requests.

## Bounds and queued authority

Defaults admit at most 200 retained visitor principals (including spent receipts until expiry), three searches, eight interpretation submissions and 32 residual task admissions per visitor lifetime. Source evidence remains capped at 1,000 postings. Task leases, bounded attempts, per-task batches/time, global/per-owner queue limits and JEV's existing cumulative approval and spend guards still apply. Invalid provider outputs do not erase an accepted search. Quotas are server-owned and replay cannot reset them.

API and runner instantiate the same owner resolver. For an account it calls `createAccessReader({db,now})` from `entitlements.mjs` (the API delegates through `auth.accessForAccount`); for a visitor it reloads the unexpired, unspent database principal. Missing authority fails closed. Candidate selection, page/cursor reads, each task batch and the commit after any provider wait recheck live access, import generation and accepted search revision. Paid/trial expiry, ownership transfer, deletion, cancellation or restore revocation cannot be bypassed by copying an old full-access flag or reusing a classifier cache decision.

The feature has local deterministic API/queue tests. It does not claim a deployed preview or a real-provider evaluation. Activation still requires the integrated exact-candidate preview gate and reviewed policies.
