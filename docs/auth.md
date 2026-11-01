---
summary: Integrate durable local accounts, admission controls, session security and deletion.
read_when: Wiring authentication, changing deployment admission policy or preparing a database restore.
---

# Accounts and sessions

Justup implements local username/password accounts in [`server/auth.mjs`](../server/auth.mjs), using Node 24 built-in crypto and SQLite. Accounts are durable by default. Sign-out and session expiry revoke authentication without deleting the account, its saved searches or its company requests. New accounts have limited access. A trusted ownership proof makes the free period ready; a separate deliberate activation starts seven days, or one calendar month when authoritative former-Jobseek eligibility is proved. The [email verification adapter](account-verification.md) provides mailbox ownership proof through the existing queue. It does not establish former-Jobseek eligibility or automatically activate access. The [isolated test billing adapter](account-billing.md) signs no browser grants: it verifies provider notifications and reconciles current paid state through the existing queue. Billing defaults disabled; ordinary test Checkout does not qualify the conditional Managed Payments live target. Password recovery and the authoritative former-user proof source are not implemented.

## Configure admission and lifetime

Open one SQLite `DatabaseSync` connection and call `createAuth({db,config,now,deleteAccountData})`. The core composes this with every feature deletion hook. `now` defaults to `Date.now`; tests inject a trusted fixed clock. The module itself reads no environment variables.

| Config | Default | Behavior |
| --- | --- | --- |
| `requiresInvitation` | `true` | With `true`, a protected nonempty `inviteCode` is required. With `false`, public registration needs no invite. |
| `inviteCode` | absent | Empty/absent closes invite-only registration. It never closes explicitly public registration. |
| `maxAccounts` | `30` | Positive safe integer admission cap; explicit `null` removes this application cap. Deployment resource limits still apply. |
| `sessionTtlMs` | seven days | Positive fixed session lifetime. Reads do not extend it. |
| `accountTtlMs` | `null` | Optional positive lifetime for **new** temporary accounts. No automatic account age deletion when null. |
| `accountExpiresAt` | `null` | Optional Unix-millisecond deployment deadline for **new** temporary accounts. The earlier of this and the relative lifetime wins. |

Main maps these to `JUSTUP_REQUIRES_INVITATION`, `JUSTUP_INVITE_CODE`, `JUSTUP_MAX_ACCOUNTS`, `JUSTUP_SESSION_TTL_MS`, `JUSTUP_ACCOUNT_TTL_MS` and `JUSTUP_ACCOUNT_EXPIRES_AT`. Nullable environment settings accept `none`. Booleans accept only `true` or `false`; malformed values stop startup without printing their contents. A restricted preview can keep invitation admission and the 30-account cap while using the same durable account system.

Registration stores the resolved account deadline once. Changing or removing deployment policy never invents, extends or removes existing account deadlines. Existing databases receive an additive nullable `account_expires_at` column; existing accounts retain identity, credentials and sessions and acquire no automatic deadline. A passed absolute deployment deadline closes new registration. Invitation checking, account capacity and the final account deadline are enforced on the server, including after password hashing finishes.

Invitations occupy at most 256 UTF-8 bytes and compare fixed-size SHA-256 digests in constant time. No invitation is stored or included in errors. Usernames are trimmed/lowercased 3–32 ASCII letters, digits, underscores or hyphens, starting with a letter or digit. Passwords remain exact, need at least 12 Unicode characters and occupy at most 256 UTF-8 bytes.

## Session and HTTP contract

`register({username,password,inviteCode?})` and `login({username,password})` return `{account,token,expiresAt}` to the server. `account` is `{id,username,expiresAt}`, where its expiry is an ISO UTC string or `null`; the outer `expiresAt` is the session's Unix-millisecond deadline. `session(token)` returns `{account,expiresAt,access}` or null. Access is a current server-owned projection: limited, ready, free, paid, cancelled, past_due, pending or expired. It includes `fullAccess`, `legacy`, `premium`, `billingEnabled`, nullable `until`, `canActivateFreePeriod` and a safe description. Only a live verified grant or settled paid period provides full access; an invitation or an authenticated session does not. Sessions are capped at a temporary account's stored deadline.

The HTTP `/session` response publishes `user` with nullable account expiry, an ISO `expiresAt` session deadline (null for guests), and `authentication.requiresInvitation`. The backend's `registrationState()` supplies `{enabled,reason}` with `registration_closed`, `account_limit` or null. HTTP also checks reviewed policies, working deletion protections and successful maintenance. The browser cannot authorize registration or infer it from an invite input. A missing `requiresInvitation` must be treated conservatively by clients.

Both login and registration remain unavailable until the operator configures genuinely reviewed HTTPS Privacy/Usage URLs and a reviewed policy version. The server default `product-draft-5` is unreviewed. Approved `2026-11-01` public pages still require exact deployed proof and deletion readiness before activation. Model availability is independent of account login and deletion.

Only the HTTP server receives a raw 32-byte session token. It sets `__Host-justup_session` with `HttpOnly; Secure; SameSite=Lax; Path=/` and no Domain. The guest anti-forgery cookie is `__Host-justup_csrf`. Explicit localhost HTTP uses `justup_session` and `justup_csrf`; it cannot enable insecure cookies for a public origin. Tokens never enter response JSON, URLs, browser storage or logs. Every mutation checks the exact allowed Origin, a session-bound or guest-bound CSRF token, bounded JSON, admission rate limits and timeouts before feature code. Public registration retains all these checks.

Passwords use asynchronous scrypt (`N=32768,r=8,p=3,maxmem=64 MiB`) with independent 16-byte salts and 64-byte hashes. Unknown-user login pays the same hashing work and fixed failure as a wrong password. Malformed credentials fail before hashing. At most two hashes run per process; the HTTP admission limit bounds their queue. This is not a claim of constant total network response time.

## Deletion and recovery

`logout(token)` revokes only that session and is harmless when repeated. `deleteAccount(token,password)` requires a live session and the current password. A wrong password returns `invalid_credentials` without revoking the valid session. After hashing, it checks any asynchronous provider-termination precondition outside SQL. Pending/unavailable billing termination preserves the account and offers an explicit retry path. Once ready, it rechecks the session inside a short `BEGIN IMMEDIATE` transaction, revokes all account sessions, runs every synchronous private-data deletion hook and removes the account. Network work, promises and nested transactions are forbidden in these hooks.

The core's durable filesystem barrier completes before private SQL deletion and remains pending until commit or rollback. SQL hook failure rolls back the account, its sessions and private changes together. Filesystem rotation cannot be rolled back; unsafe recovery state closes authentication until repaired. [The API guide](api.md) describes the generation barrier and protected restore contract.

`cleanup()` removes expired sessions and only accounts with an explicit stored deadline, using the same atomic deletion hooks. Failure rolls back the entire cleanup, including earlier deletions. The core runs it at startup and once per minute; a maintenance failure closes authentication until a successful retry. Expired temporary rows still consume the admission cap until cleanup succeeds. Durable accounts have no inactivity/age deletion in this module.

`invalidateAllSessions()` is a protected restore helper, never a public route. It deletes restored token hashes, clears one-time email challenges and hosted billing URLs, and invalidates billing-termination proof while preserving accounts and their stored deadlines. The explicit main restore-preparation command invokes it on a separate database without feature cleanup. Backups and WAL can contain earlier bytes; the deployment recovery barrier, backup expiry and protected restore workflow remain required. Logical deletion alone does not erase every historical file. Imported public job evidence is not account-owned.

## Errors and verification

Errors expose only stable codes and fixed messages: invalid registration input (400), `invalid_credentials` (401), `registration_closed` or `account_limit` (403), `username_taken` (409), and `unauthenticated` (401). Database and callback failures use the HTTP layer's sanitized server error. No submitted values reach diagnostics.

Run `node --test server/auth.test.mjs server/http.test.mjs server/main.test.mjs`. The account suite uses isolated SQLite and fixed clocks; real scrypt takes roughly 10–25 seconds. It covers durable accounts across maintenance/reopen, additive migration, explicit temporary expiry, public/invite registration, capacity races, session expiry, deletion rollback, restore invalidation and concurrent sign-out/deletion. HTTP contracts verify cookies, Origin, CSRF, policy/deletion gates and server-owned registration. No test calls a provider or a deployed service.
