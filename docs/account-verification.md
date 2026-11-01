---
summary: Verify mailbox ownership with a bounded one-time code delivered by the existing queue.
read_when: Wiring account verification, reviewing provider data, configuring email or verifying deletion and restore.
---

# Verify account ownership

The API keeps username/password sign-in and uses Resend only to deliver a one-time mailbox ownership code. Verification marks an account ready for its ordinary free period; the person must still choose the existing `POST /access/activate` action. A mailbox is not proof of a unique person or former Jobseek membership. No matching name, email or invitation grants the welcome month. Former Jobseek eligibility closes when Jobseek account creation ends at retirement, before Justup opens. The authoritative former-user proof source remains unconfigured and must be established before Jobseek authentication is retired; no matching email alone grants the welcome month.

## Browser contract

All paths below are under `/api/v1` and require the current signed-in session. Writes use the existing exact Origin, session-bound CSRF and `X-Justup-Locale` admission. Email adds no edge header or public callback.

| Request | Response |
| --- | --- |
| `GET /account/verification` | `200 {verification}`; a stored read remains available during a processing pause. No query parameters. |
| `POST /account/verification` with exactly `{email,requestKey}` | `202 {verification}`; queues one send. Repeating the same key, normalized email and original session returns the same challenge. Changed input conflicts. |
| `POST /account/verification/confirm` with exactly `{challengeId,code}` | `200 {verification}` in verified state. `code` is an eight-digit string. Read `/session` afterward for current access. |

`verification` is `{state,challengeId,challengeLocale,expiresAt,retryAfterMs}`. State is `unavailable`, `unverified`, `pending`, `sent`, `failed` or `verified`. Challenge ID, original `challengeLocale` (`en`, `de`, `fr`, `it` or `es`) and ISO expiry exist only for an unexpired challenge belonging to this login session; otherwise they are null. Retry delay is a nonnegative number of milliseconds for that challenge, otherwise null. Email, code, keyed subject, session hash and provider response never enter this projection. A failed delivery requires a new request key after the cooldown.

Changing the interface language does not change an existing challenge's policy binding. Read its status, then send confirmation with `X-Justup-Locale` set to that response's `challengeLocale`; this is a request-only override and does not change the saved preference. A different current locale cannot confirm the code. The original locale must still have the exact reviewed policy binding: revocation, changed policy or expired/session-invalid proof continues to fail closed. The locale field neither approves a policy nor justifies resending a code automatically.

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

The [ordinary Stripe test adapter](account-billing.md) already composes restricted test credentials, fixed current-state reconciliation, the raw-body signed webhook route, test Checkout and provider termination before deletion. Its source integration is separate from real sandbox/hosted-UI proof. It does not qualify the conditional Managed Payments target, live pricing, tax, refunds or any live charge.

Before activation, review the actual served policy statements, free quota allocation, protected key delivery, exact API/queue artifacts and live fake-account email journey. Qualify provider timeouts/retries and deletion/restore under the real service identities. Source tests do not approve these operations.


## Run one bounded operator mailbox proof

`scripts/account-test-journey.mjs` is the reusable HTTP journey. Its adjacent
`server/account-test-journey.test.mjs` uses real HTTP/auth/SQLite, the existing
leased runner and the actual fixed Resend client with synthetic transport and
mailbox input. This source proof sends no real message. Its receipt explicitly
reports `emailControl:synthetic_code` and `stripeTestMode:not_run`.

The current approved notice source is `2026-11-01.1`. That version describes the
registration acceptance record; its ten reviewed page hashes are owned by the
[policy release record](policies.md). The operator packet must explicitly supply
that version and exact deployed proof; this helper has no policy-version default
and cannot approve or update runtime proof.

Before the operator entrypoint is run, review one concrete private test packet
under `account-provider-resources` (#79). The release owner supplies the exact
recipient authorization and nonsecret provider facts; a coding agent does not
read provider keys or perform setup to fill this packet. Required facts are:

1. Exact compatible frontend/API/queue source and build identities, isolated test
   database, active deletion-generation/backup barrier, admitted notice version
   and locale with exact retained asset/page hashes. Live-profile registration
   remains disabled. The helper checks API `/version` and current locale policy;
   the existing policy verifier owns actual served-byte and frontend/queue proof.
2. Existing Resend Free team capacity and shared allowance, verified
   `notify.justup.work` sender, the fixed `Justup <accounts@notify.justup.work>`
   sender and queue-only domain-restricted sending key. Pin the separate stable
   verification-key fingerprint. Reserve at most **one send** for this run,
   with explicit `maxDaily:1,maxMonthly:1` in its isolated queue configuration
   and no paid fallback. Capacity on a shared team must be checked separately.
3. One exact, operator-controlled recipient address, affirmative permission to
   send that single verification message, selected locale, and the operator who
   will read the actual mailbox. Keep the address and permission receipt in
   protected notes. A provider acceptance response is not mailbox control.
4. Reviewed run/cleanup scope: one generated disposable account, one email,
   code confirmation, one explicit ordinary-week activation, replay rejection
   and password-confirmed account deletion. No checkout, provider setup, OAuth,
   former-user cohort import, promotional subscription, paid conversion, live
   charge or new resource is part of this command.

The operator prepares a mode-0600 JSON file outside Git with exactly these
fields (and `inviteCode` only if the approved test profile requires it):

| Field | Value |
| --- | --- |
| `apiBase` | Exact approved HTTPS same-origin API base ending `/api/v1`; loopback HTTP is supported only for isolated tests. |
| `origin` | Exact approved browser origin used by Origin/CSRF checks. |
| `sourceCommit`, `buildIdentity` | Exact expected API candidate, never a moving branch alias. |
| `policyVersion`, `locale` | Explicit current admitted version `2026-11-01.1` and one `en/de/fr/it/es` request locale, bound to the approved deployed bytes. |
| `recipient` | The single privately authorized mailbox. |
| `mode` | Exactly `operator-mailbox`; synthetic mode is import-only. |

After that exact packet and recipient scope are reviewed, the authorized
operator runs the reviewed source with Node 24.22.2:

```sh
node scripts/account-test-journey.mjs \
  --approved-packet /absolute/private/account-proof-packet.json \
  --private-recovery /absolute/private/account-proof-recovery.json
```

This is an explicit operator mutation command, never a CI check or automatic
post-merge action. It supplies no provider key and changes no capability/review
flag. The already configured isolated API/queue own the send. The command does
not retry or resend email. It polls delivery at most ten times, then accepts an
eight-digit code through hidden terminal input with a two-minute bound. Never
supply a code from provider logs or a synthetic callback as real mailbox proof.
The resulting fixed-field receipt distinguishes `delivery:queue_sent` from
`emailControl:operator_mailbox_code`. Queue `sent` proves only that the selected
transport accepted the request; it does not prove inbox delivery until the
operator reads and confirms the code. Record the separately reviewed runtime
adapter identity with the receipt. Provider message contents, codes, cookies,
tokens, credentials and recipient never enter its output.

The helper writes and syncs a mode-0600 recovery file **before** registration.
The file contains only this generated account's credentials and target identity;
never attach it to a PR or issue. Its `finally` path recovers a lost registration
reply through that account's login, deletes only that account, verifies guest
state and rejected subsequent login, then removes the recovery file. A network,
policy, billing or deletion outage can prevent confirmed cleanup. Such a run
fails `cleanup_unconfirmed`, retains the protected recovery file and cannot
produce a passing receipt. Reconcile that exact account with the existing
password-confirmed deletion path before another run; do not infer deletion from
session expiry or remove the recovery file early. Account deletion does not
recall a delivered message or establish deletion of Resend's provider copy.

Keep #29 and #79 open until real-adapter/mailbox and the separate actual Stripe
sandbox journeys are evidenced. For Stripe, first review actual nonsecret
sandbox identity, restricted test runtime scope, approved test offer and portal
configuration IDs, webhook route/secret delivery, fixed account/API version and
zero-spend scope. Through the existing [billing routes](account-billing.md),
complete one hosted **test-mode** checkout using provider test payment details,
verify a genuinely signed test webhook/current-state reconciliation, cancellation,
failed renewal, restore invalidation and provider-terminated final deletion.
Synthetic signed events prove protocol behavior only. Ordinary sandbox success
is not Managed Payments eligibility or live merchant/tax qualification. Record
that evidence separately; this mailbox helper never calls Stripe.
