---
summary: Verify mailbox ownership with a bounded one-time code delivered by the existing queue.
read_when: Wiring account verification, reviewing provider data, configuring email or verifying deletion and restore.
---

# Verify account ownership

The API keeps username/password sign-in and uses Resend only to deliver a one-time mailbox ownership code. Verification marks an account ready for its ordinary free period; the person must still choose the existing `POST /access/activate` action. A mailbox is not proof of a unique person or former Jobseek membership. No matching name, email or invitation grants the welcome month. The authoritative former-user source remains unconfigured.

## Browser contract

All paths below are under `/api/v1` and require the current signed-in session. Writes use the existing exact Origin, session-bound CSRF and `X-Justup-Locale` admission. Email adds no edge header or public callback.

| Request | Response |
| --- | --- |
| `GET /account/verification` | `200 {verification}`; a stored read remains available during a processing pause. No query parameters. |
| `POST /account/verification` with exactly `{email,requestKey}` | `202 {verification}`; queues one send. Repeating the same key, normalized email and original session returns the same challenge. Changed input conflicts. |
| `POST /account/verification/confirm` with exactly `{challengeId,code}` | `200 {verification}` in verified state. `code` is an eight-digit string. Read `/session` afterward for current access. |

`verification` is `{state,challengeId,expiresAt,retryAfterMs}`. State is `unavailable`, `unverified`, `pending`, `sent`, `failed` or `verified`. Challenge ID and ISO expiry exist only for an unexpired challenge belonging to this login session. Retry delay is a nonnegative number of milliseconds for that challenge, otherwise null. Email, code, keyed subject, session hash and provider response never enter this projection. A failed delivery requires a new request key after the cooldown.

One challenge exists per account, lasts ten minutes and permits five code attempts. A new send has a sixty-second cooldown. A second login session for the same account cannot confirm the first session's challenge. Sign-out, session expiry, account deletion and restore invalidate outstanding proof. An already consumed code cannot grant another proof or period.

Safe errors include `verification_unavailable` (503), `verification_invalid` (400), `verification_pending` (409), `verification_locked` (429), `verification_conflict` (409), `rate_limit` (429), `idempotency_conflict` (409), and the existing auth/policy errors. An expired row is removed and its code becomes invalid. Generic task inspection exposes only ordinary status and a null result.

## Runtime and limits

The API has no outbound provider key or internet egress. `JUSTUP_EMAIL_VERIFICATION_ENABLED=true` enables new send requests only when the exact-build, recent queue heartbeat also reports `emailVerification:true`. An absent flag is disabled. An already delivered code remains confirmable during queue/model unavailability; current API enablement, locale policy, private-generation and original-session checks still apply. The capability describes new-send availability, so a browser should preserve a `sent` challenge even when that capability becomes false. Queue delivery rechecks its current processing proof, lease and original live session before and after the provider wait; the existing processing proof has a bounded revocation window described in [processing admission](processing-admission.md).

The existing protected queue JSON accepts an optional `emailVerification` object. It is absent, exactly `{enabled:false}`, or exactly `{enabled:true,apiKey,verificationKey,maxDaily,maxMonthly}`. The API launcher accepts only its boolean enable flag and rejects provider keys. Enabled queue configuration requires the two fixed modules `email-verification.mjs` and `account-provider-clients.mjs` in the exact artifact.

Deliver the domain-restricted `RESEND_API_KEY` from Doppler `justup-runtime/dev` into `apiKey` through the protected operator path. The full-access Resend and Stripe setup credentials in `justup-admin/admin` are administration-only. Never load the admin configuration, bootstrap copy, Doppler token or provider keys into API, browser, model broker or CI.

`verificationKey` is a separate stable, high-entropy, printable ASCII secret of 32–512 bytes delivered only to the queue. It derives codes and pseudonymous mailbox subjects with distinct HMAC purposes. Its nonsecret SHA-256 fingerprint is pinned in storage; changing the key refuses startup instead of silently creating another identity namespace. Key rotation or replacing this pin requires a separately reviewed identity migration. Preserve it through backup/restore; it is global configuration evidence, not a personal redemption tombstone.

`maxDaily` is 1–10 and `maxMonthly` is 1–100. Both must be explicit and within the operator's available free allowance. The queue atomically reserves a send against UTC day/month counters before calling Resend. An uncertain provider outcome still spends the reservation. The same challenge's crash retry reuses its reservation, derived code and provider idempotency key. There is no automatic new challenge, paid fallback or allowance expansion. Account deletion removes personal proof but does not reduce aggregate send counts.

The fixed client sends a plain-text template from `Justup <accounts@notify.justup.work>` to exactly one recipient at `https://api.resend.com/emails`. It rejects redirects, bounds response bytes to 32 KiB and each HTTP attempt to five seconds, and redacts errors. Resend's [documented idempotency header](https://resend.com/docs/dashboard/emails/idempotency-keys) retains a key for 24 hours; a challenge expires within that window. Cancellation or deletion during a started network request cannot recall an email already accepted by Resend; the late response cannot recreate a challenge, identity or access grant.

## Private data and lifecycle

Delivery uses fixed, code-only templates in the admitted request locale: English, German, French, Italian or Spanish (`en`, `de`, `fr`, `it`, `es`). No translation model or provider-authored message is involved.

| Data | Storage and removal |
| --- | --- |
| Recipient email | Dedicated challenge row only; normalized by ASCII validation and case folding, without collapsing plus/dot aliases. Removed by API cleanup after delivery/failure or at challenge expiry, and on account deletion/restore. |
| Code | Derived only in queue memory and sent to Resend. No task payload or stored plaintext. A salted challenge/code digest remains until consumption, expiry or deletion. |
| Challenge metadata | Random ID, account and original session hash, keyed request fingerprint, keyed subject, locale/policy binding, counters, task/key and expiry. At most 100 rows; removed on consumption, expiry, dead session, disabled API or account deletion. |
| Verified identity | Existing entitlement ledger stores its hash of a keyed mailbox subject. It prevents overlapping active-account claims. Deletion erases it and the free-period record; fresh registration can qualify again. No recipient or redemption tombstone remains. |
| Queue task | Challenge ID, locale and policy key only; no recipient/code/subject/provider response. Existing owner deletion and bounded 30-day task retention apply. |
| Usage and key identity | Aggregate attempted-send day/month counters, plus one global key fingerprint. Neither identifies a mailbox or proves a former claim. Counters are bounded by routine queue cleanup. |

API cleanup runs at startup, ordinary verification reads/writes and the existing one-minute maintenance tick. Recipient scrubbing, proof consumption and personal row deletion use the existing deletion barrier so old backups cannot restore removed bytes. Physical removal has no elapsed-time guarantee while the API is stopped. Restore preparation clears all outstanding challenges as it invalidates every session; it preserves verified account identity and existing period deadlines in the deletion-safe restored database.

Resend receives recipient, fixed subject and code-bearing message. Its Ireland sending region does not change US storage of message content and logs. Provider retention and any legally required records must be accurately disclosed before real use; local deletion cannot claim to erase a delivered message or undisclosed provider storage.

## Verification and remaining gates

`server/email-verification.test.mjs` exercises real SQLite/auth/queue/HTTP with fake delivery: retry, original session, attempt budget, explicit activation, overlap, deletion/re-registration, deletion and policy pause during a provider wait, restore invalidation and send ceilings. `account-provider-clients.test.mjs` covers fixed requests, response bounds/redaction and preparatory Stripe test signatures/account isolation. No provider is contacted.

The shared Stripe primitives pin [the current documented version](https://docs.stripe.com/api/versioning), `2026-10-28.endive`, accept only restricted test credentials and verify exact raw webhook bytes using the [documented v1 signature protocol](https://docs.stripe.com/webhooks#verify-manually). They are preparatory; no webhook route, checkout, billing configuration or runtime Stripe credential is enabled here. A scoped test runtime key, approved test prices and signed current-state lifecycle integration remain separate work. Live price, tax registration, country, refunds and paid resource decisions remain unapproved.

Before activation, review the actual served policy statements, free quota allocation, protected key delivery, exact API/queue artifacts and live fake-account email journey. Qualify provider timeouts/retries and deletion/restore under the real service identities. Source tests do not approve these operations.
