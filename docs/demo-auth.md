---
summary: Integrate invite-only demo accounts, protect sessions and delete an account's private data.
read_when: Wiring the demo API, reviewing its stored account data or verifying account deletion.
---

# Demo accounts

The demo uses local username/password authentication implemented by
[`server/auth.mjs`](../server/auth.mjs). It uses Node 24's built-in `node:crypto`
and `node:sqlite`; it has no external login provider, Google scopes, email
collection, billing integration, trial or legacy entitlement. A valid session
grants demo access only. An invite code is required to create an account, and
the default limit is 30 accounts in the database.

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
days. Both must be positive safe integers. `now` defaults to `Date.now` and can
be replaced with a fixed clock in tests. The server must use a trusted clock.

| Method | Result and behavior |
| --- | --- |
| `await register({ username, password, inviteCode })` | Creates the account and one session atomically; returns `{ account: { id, username }, token, expiresAt }`. |
| `await login({ username, password })` | Verifies the password and issues a new session; returns the same shape as registration. |
| `session(token)` | Returns `{ account, expiresAt, access }`, or `null` for a missing, invalid, revoked or expired token. |
| `logout(token)` | Revokes that session immediately; repeated or malformed-token requests are harmless. Returns no value. |
| `await deleteAccount(token, password)` | Requires a currently valid session and the current password; returns `{ deleted: true }` after atomic removal. |

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
session. Sign-out deletes its session row immediately. Other active sessions
remain valid until their own sign-out, expiry or account deletion.

Account deletion hashes the supplied password outside the database transaction,
then rechecks that the session is still valid. A short `BEGIN IMMEDIATE`
transaction revokes all sessions, calls `deleteAccountData(accountId)` and
deletes the account. The callback must synchronously remove all account-owned
private rows on the same connection, without opening a transaction, doing
network/file work, awaiting or returning a promise. Any exception rolls back
the callback's SQL changes, revoked sessions and account deletion together.
The API must return a server error on callback failure and keep the account
recoverable for retry. Every private-data module must be included in this
callback before the deletion route is exposed.

The deletion removes current database rows; SQLite files, write-ahead logs and
backups can retain earlier bytes. Preview operations must define and publish
backup retention and final database cleanup separately. Public job records do
not belong to a tester and are not deleted with that account.

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
module's account and session contract; it takes about 10–20 seconds locally and
uses a fresh in-memory database and fixed clock for each case. It verifies
registration, case folding, login denial, session expiry, sign-out, invitation
denial, concurrent account limits, password-confirmed deletion, callback
rollback and sign-out/deletion races. It makes no provider, model or network
calls. The shared CI impact map must register this suite as an authentication
dependency. HTTP cookie/origin behavior and private-data visibility require the
API integration suite; this module test does not verify a deployed preview.
