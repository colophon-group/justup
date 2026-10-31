---
summary: Integrate demo accounts, enforce 30-day retention and invalidate sessions after a restore.
read_when: Wiring demo authentication, account cleanup or protected database restore.
---

# Demo accounts

The demo uses local username/password authentication implemented by
[`server/auth.mjs`](../server/auth.mjs). It uses Node 24's built-in `node:crypto`
and `node:sqlite`; it has no external login provider, Google scopes, email
collection, billing integration, trial or legacy entitlement. A valid session
grants demo access only. An invite code is required to create an account, and
the default limit is 30 accounts in the database. Accounts have a hard retention
deadline of 30 days from creation, which sign-in and session reads cannot extend.

## Integrate the module

Open one SQLite `DatabaseSync` connection and pass it to the module. It creates
its own `auth_accounts` and `auth_sessions` tables and indexes idempotently.
The caller owns database file permissions, backups, availability and HTTP
protections. Keep preview configuration isolated from production credentials.

```js
import { createAuth } from './server/auth.mjs';

const auth = createAuth({
  db,
  config: { inviteCode, maxAccounts: 30 },
  deleteAccountData(accountId) {
    // Run every private-data delete synchronously on this same db connection.
    // The auth module has already started the transaction.
    // Complete the core-owned filesystem privacy barrier before private SQL.
    privateSearches.deleteForAccount(accountId);
  },
});
```

Supply the invitation through protected runtime configuration. This module does
not read environment variables or write configuration. An absent or empty
`config.inviteCode` closes registration; invalid configuration fails at startup.
Invitations must be nonempty strings of at most 256 UTF-8 bytes. Their comparison
uses constant-time equality of fixed-size SHA-256 digests. No invitation is
stored in SQLite or included in errors.

`config.maxAccounts` defaults to `30`; `config.sessionTtlMs` defaults to seven
days. `config.accountTtlMs` defaults to 30 days and can be shortened, but cannot
exceed 30 days. These settings must be positive safe integers. `now` defaults
to `Date.now` and can be replaced with a fixed clock in tests. The server must
use a trusted clock.

| Method | Result and behavior |
| --- | --- |
| `await register({ username, password, inviteCode })` | Creates the account and one session atomically; returns `{ account: { id, username }, token, expiresAt }`. |
| `await login({ username, password })` | Verifies the password and issues a new session; returns the same shape as registration. |
| `session(token)` | Returns `{ account, expiresAt, access }`, or `null` for a missing, invalid, revoked or expired token. |
| `logout(token)` | Revokes that session immediately; repeated or malformed-token requests are harmless. Returns no value. |
| `await deleteAccount(token, password)` | Requires a currently valid session and the current password; returns `{ deleted: true }` after atomic removal. |
| `cleanup()` | Synchronously removes expired accounts through the deletion callback and purges expired sessions in one transaction; returns only `{ accountsDeleted, sessionsDeleted }`. |
| `invalidateAllSessions()` | Synchronously revokes every session and returns only `{ sessionsDeleted }`; reserved for a protected restore operation. |
| `registrationState()` | Returns only `{ enabled, reason }`; reason is `null`, `registration_closed` or `account_limit`. It reveals no secret or account count. |

`expiresAt` is Unix time in milliseconds. `access` is exactly
`{ kind: 'demo', fullAccess: true, legacy: false, billingEnabled: false, until: null }`.
The API must check `session(token)` before returning private or restricted data;
an unauthenticated visitor must never receive hidden rows in a response. The
browser must show actual demo limits and cannot establish access with local
storage or a submitted account ID.

Usernames are trimmed and lowercased, contain 3–32 ASCII letters, digits,
underscores or hyphens, and start with a letter or digit. Passwords are preserved
exactly, require at least 12 Unicode characters and occupy at most 256 UTF-8
bytes. There is no password reset or email recovery flow in this module.

## Protect the HTTP boundary

The module returns a raw session token only to its server caller. The API must
set it in a host-only `HttpOnly; Secure; SameSite=Lax; Path=/` cookie over HTTPS,
with an expiry matching `expiresAt`. Do not return the token in response JSON,
place it in URLs or browser storage, or log it. Clear the cookie after sign-out,
account deletion and an expired or invalid session. Local HTTP development needs
an explicit development-only cookie policy; published previews require HTTPS.
A wrong deletion password returns `invalid_credentials` (401) and leaves the
valid session intact; that error must not be treated as a missing session.

Validate the request `Origin` against the configured preview origin for every
state-changing route, including registration, login, sign-out and account
deletion. Reject missing or mismatched origins for those browser requests.
`SameSite=Lax` supplements this check. Restrict CORS to the intended origin,
allow credentials only where required, enforce JSON and bounded request bodies,
and reject unsupported methods. Do not trust forwarded origin headers unless a
known proxy establishes them.

Rate-limit authentication and deletion attempts before calling this module,
using both source and normalized account where appropriate. Bound the rate
limiter's own state and pending requests. The module runs at most two scrypt
operations at a time across all auth instances in one process; its queue relies
on those HTTP admission limits. Set request timeouts and never log request
passwords, invitations, cookies or authorization headers.

## Stored data and deletion

| Table | Stored fields |
| --- | --- |
| `auth_accounts` | Random account ID, normalized username, 16-byte random salt, 64-byte scrypt password hash and creation time. |
| `auth_sessions` | SHA-256 hash of a random 32-byte opaque session token, account ID, creation time and fixed expiry time. |

Passwords use asynchronous scrypt with `N=32768`, `r=8`, `p=3` and a 64 MiB
memory ceiling per operation. Each account has a separate random salt. Login
for an unknown username performs the same scrypt work as a wrong password and
uses the same fixed error response; this does not replace rate limits or claim
that total network response time is constant. Malformed credentials fail before
hashing. SQLite never stores raw passwords or session tokens. The username
remains account data even though no email address is collected.

Session expiry is fixed rather than extended by reads. Expired sessions cannot
authenticate and are pruned when a successful registration or login creates a
session or maintenance calls `cleanup()`. A session's deadline is capped at the
account's retention deadline. Sign-out deletes its session row immediately.
Other active sessions remain valid until their own sign-out, expiry, account
expiry, restore invalidation or account deletion.

Account expiry uses the original `created_at` and `accountTtlMs`; it is not a
sliding activity window. At the exact deadline, login returns the same generic
`invalid_credentials` error and `session(token)` returns `null`, even if periodic
cleanup has not run or an older stored token has a later expiry. The core must
call `cleanup()` at startup and periodically, monitor failures and enforce the
30-day private-state retention policy. Expired rows still consume the account
cap until cleanup removes them; `registrationState()` reflects that actual cap.

Account deletion hashes the supplied password outside the database transaction,
then rechecks that the session is still valid. A short `BEGIN IMMEDIATE`
transaction revokes all sessions, calls `deleteAccountData(accountId)` and
deletes the account. The callback must synchronously remove all account-owned
private rows on the same connection, without opening a transaction, doing
network work, awaiting or returning a promise. The core-owned, synchronous
filesystem privacy barrier must complete before private SQL deletes. It can
throw to abort SQL deletion. Filesystem changes are not rolled back by SQLite;
their failure/retry handling belongs to that barrier. Any exception rolls back
the callback's SQL changes, revoked sessions and account deletion together.
The API must return a server error on callback failure and keep the account
recoverable for retry. Every private-data module must be included in this
callback before the deletion route is exposed.

`cleanup()` captures one clock value and, in a short `BEGIN IMMEDIATE`
transaction, purges expired sessions and removes each expired account through
the same callback. If any barrier or callback fails, the entire cleanup's SQL
changes roll back, including earlier accounts and expired-session purges. It
returns counts only after commit and can be safely retried.

After a database restore, call `invalidateAllSessions()` before allowing
requests to authenticate. It removes all restored token hashes while preserving
accounts, so testers must sign in again. This maintenance method must not be
exposed as a public route. It does not replace account cleanup or the core's
restore privacy controls.

The deletion removes current database rows; SQLite files, write-ahead logs and
backups can retain earlier bytes. The core's privacy barrier and preview
operations must enforce the same maximum retention for private files/backups
and publish final database cleanup and restore handling. The auth module alone
does not erase those files. Public job records do not belong to a tester and
are not deleted with that account.

## Errors and verification

Errors expose stable `code` and HTTP `status` properties. Their messages are
fixed and never include submitted values.

| Code | Status | Condition |
| --- | --- | --- |
| `invalid_input` | 400 | Invalid registration input. |
| `invalid_credentials` | 401 | Failed login, wrong invitation or wrong deletion password. |
| `registration_closed` | 403 | No configured invitation. |
| `account_limit` | 403 | The configured number of accounts already exists. |
| `username_taken` | 409 | The normalized registration username exists. |
| `unauthenticated` | 401 | Account deletion has no valid session, including expiry or concurrent sign-out. |

Unexpected database or callback errors remain server errors. The HTTP layer
must use a sanitized response and log no sensitive inputs. Login always uses
the same `invalid_credentials` response for an unknown username, wrong password
or malformed input.

Run `node --test server/auth.test.mjs` with Node 24. The adjacent suite owns this
module's account and session contract; it takes about 10–25 seconds locally and
uses a fresh in-memory database and fixed clock for each case. It verifies
registration, case folding, login denial, session expiry, sign-out, invitation
denial, concurrent account limits, password-confirmed deletion, callback
rollback, hard account-expiry boundaries, cleanup rollback, restore invalidation,
registration availability and sign-out/deletion races. It makes no provider,
model or network calls. The shared CI impact map must register this suite as an authentication
dependency. HTTP cookie/origin behavior and private-data visibility require the
API integration suite; this module test does not verify a deployed preview.
