---
summary: Configure isolated test billing, reconcile paid access and terminate payment activity before account deletion.
read_when: Wiring account billing, reviewing provider isolation or preparing test-mode release evidence.
---

# Account billing

The existing API and shared queue support isolated **ordinary Stripe TEST
Checkout**. Billing defaults off. This does not qualify the intended first paid
web release, which targets Stripe Managed Payments only if Stripe confirms
Justup's eligibility. No live key, price, charge, country, tax arrangement or fee
allowance is approved by this implementation. Follow the `account-provider-resources`
decision and the [release guide](development-process.md) before real activation.

## Connect the account interface

All user routes require an authenticated session. Mutations retain the normal
exact Origin, CSRF and locale-policy checks. They accept no provider IDs, customer
email, return URL, account override or arbitrary Stripe fields.

| Route | Body and result |
| --- | --- |
| `GET /api/v1/account/billing` | `{billing:{available,mode,offers,closing,canCheckout,canManage,operation,termination}}`. `mode` is `test` or null. Offers contain `{plan,currency,amount,interval}` from approved test configuration, in currency minor units. `operation` recovers the latest checkout/portal operation; `termination` reports deletion progress. |
| `POST /api/v1/account/billing/checkout` | Exactly `{plan:"weekly"|"monthly",requestKey}`; returns `202 {operation}`. The queue checks the actual approved test price before creating one hosted subscription checkout. |
| `POST /api/v1/account/billing/manage` | Exactly `{requestKey}`; returns `202 {operation}` for the approved isolated hosted portal. The portal configuration must forbid subscription/price changes and allow cancellation at period end. |
| `POST /api/v1/account/billing/reconcile` | Exactly `{requestKey}`; returns `202 {operation}`. Use after returning from hosted payment/management or when payment status needs a fresh check. Then reread `/session`. A redirect alone grants no access. |
| `GET /api/v1/account/billing/operations/:id` | Only the current owner's operation. Unknown/other-owner IDs return 404. |

An operation is `{id,kind,status,url,expiresAt,retryAfterMs,error}`. Kinds are
`checkout`, `portal`, `reconcile` and `terminate`; status is `pending`, `ready` or
`failed`. Only a ready checkout/portal can disclose its approved HTTPS hosted URL.
The URL is credential-like private state, never a generic task result or log
field. Exact creation retries reuse the same operation. Use a new request key for
a deliberate fresh reconciliation. A failed or pending operation never proves a
payment, completed cancellation or account deletion. A hosted URL deadline alone
does not resolve a checkout: `billing_pending` requires the existing reconcile
action until the provider confirms its subscription or that the session expired
without one. The current checkout reference remains private ownership evidence
through ordinary cleanup and restart. Recovery can resolve a conclusively
unstarted checkout without a mutation. A lost hosted-session response remains
paused unless the original bounded task recovers its exact resource; after its
deadline it requires operator reconciliation. A known customer's current complete
provider lists can still establish safe account termination.

`/session.capabilities.billing` and `access.billingEnabled` require enabled API
configuration, current locale policy and a fresh exact-build queue heartbeat.
Unavailable model capabilities do not disable a correctly configured billing
queue. Authoritative access remains the existing entitlement ledger.

## Deliver only role-specific configuration

The API keeps its loopback-only network boundary. It holds a webhook verification
secret, not an outbound provider key. Its protected environment accepts:

- `JUSTUP_STRIPE_TEST_BILLING_ENABLED=true`
- `JUSTUP_STRIPE_TEST_ACCOUNT_ID`
- `JUSTUP_STRIPE_TEST_OFFERS`, JSON with `weekly` and `monthly`, each exactly
  `{priceId,currency,amount}`
- `JUSTUP_STRIPE_TEST_PORTAL_CONFIGURATION_ID`
- `JUSTUP_STRIPE_TEST_WEBHOOK_SECRET`

The queue's optional `stripeBilling` is absent, `{enabled:false}`, or exactly
`{enabled:true,accountId,offers,portalConfigurationId,origin,apiKey}`. The origin
and offers must match the API's approved configuration; the payload binds their
canonical hash. Only an explicitly scoped `rk_test_` runtime key is accepted.
The current administrative setup key is not a runtime credential. Doppler is the
durable source; never inject `justup-admin` into runtime or CI. See
[credential setup](secrets.md). Missing key, offer or portal fixtures leave billing
unavailable; source code never provisions them.

All provider requests use the fixed Stripe API origin, pinned API version,
five-second request bounds, a 32 KiB response ceiling and rejected redirects.
The client checks the exact sandbox account before resource access. Mutations
use stable private operation idempotency keys. Hosted checkout expires after
30–31 minutes, uses the canonical frontend root for both return paths and
explicitly disables Managed Payments for this ordinary test profile.

## Receive and reconcile provider events

Only `POST /api/v1/billing/stripe/webhook` bypasses browser Origin/CSRF. It accepts
one `Stripe-Signature` header and at most 256 KiB of raw JSON bytes, verifies the
exact bytes, five-minute signature recency and test mode before using the event.
Its snapshot API version must match the pinned client. Browser Origin is rejected.
The edge must preserve this header and the raw body only for that exact route.
Other mutations retain their normal checks.

A signed event selects a minimal resource reference for a locally known billing
customer or settled charge. It never establishes ownership or access from
metadata, event creation time or a success redirect. Unknown late events after
deletion create no owner, operation or provider binding. Each newly accepted event
atomically advances existing entitlement versions and pauses the paid projection,
so a provider snapshot already in flight cannot clear that pause. Exact pending
duplicates reuse their operation; failed or lost tasks can retry after a short
cooldown. Already applied event receipts remain idempotent after operation history
expires and do not pause settled access again.

The queue uses the existing entitlement reservation/version transaction. It
checks the current subscription, approved recurring price, actual invoice service
line, successful invoice payment, PaymentIntent and current Charge. A paid invoice
alone cannot prove an unrefunded, undisputed paid period. Invoice aggregate dates
do not establish service duration. A failed renewal cannot extend a previously
settled period. Unavailable, contradictory, refunded or disputed evidence stays
fail-closed; this code invents no refund or grace policy. Current owner, lease,
session where applicable, policy and billing closure are checked again at commit.
A private current-checkout reference anchors replacement subscriptions; a late
event for a canceled subscription cannot reclaim ownership from its replacement.
The previous subscription remains bound until current provider evidence proves
the replacement, and a new checkout fences earlier entitlement reservations.

## Delete only after provider termination

Correct password verification occurs before billing closure. The API durably
closes billing and queues termination outside SQL; checkout/portal admission and
URL disclosure stop immediately. The account and its private data remain until
current provider termination is confirmed. `billing_termination_pending` (409) or
`billing_termination_unavailable` (503) never means `deleted:true`. Read the
termination operation, then retry the ordinary password-confirmed account delete.
Retries inspect the actual queue task, preserve a live lease and reuse the same
termination operation and provider idempotency keys after an exhausted or missing
task, with a five-second cooldown. One owner-bound termination reservation is
separate from ordinary operation history limits. A full shared task queue leaves
billing durably closed with that pending reservation; a later password-confirmed
retry can enqueue it when capacity returns. The queue keeps 96 active tasks
separate from 2,048 ordinary retained receipts and a default reserve of 16 billing
termination receipts (hard maximum 96). Ordinary completed history does not spend
active capacity or evict earlier request-key receipts.

After the generic runner observes terminal completion, billing records the
outcome in its existing private operation. A bounded startup/before-claim check
recovers completion-observation crash gaps. This queue-side observation removes
no receipt. API maintenance and password-confirmed retries release only fully
absorbed receipts, together with their task pointer, inside the existing private
deletion transaction and backup-generation barrier. Failed outcomes may be
absorbed while all original uncertainty, provider idempotency keys and mutation
times remain in canonical owner storage; absorption never proves deletion.
Unknown or mismatched task evidence is retained beyond ordinary receipt expiry.
This lets delayed final deletion reuse the bounded reserve without early
ordinary receipt eviction or a new queue, service or outbox.

Provider bindings and operation reservations exist **before** the first external
mutation. Their foreign keys use `ON DELETE RESTRICT`, so an older or unaware
epoch-2 API cannot erase ownership while leaving a possible renewal. Closure
fences queued and in-flight checkout. The queue expires open hosted sessions,
cancels owned subscriptions and verifies complete current lists against the
same closure revision. Incomplete bounded lists require reconciliation rather
than a false completion.

An unknown customer-creation outcome is replayed with its original provider
idempotency key only within a conservative 23-hour window. This applies to
checkout task recovery as well as termination. Expired checkout admission cannot
create a fresh customer, and a recovered unknown mutation outside the window
retains its ambiguous operation and operator-reconciliation status. Passing a checkout
expiry cannot settle unknown ownership. An unresolved outcome outside that
window remains operator-reconciliation pending. No hidden deletion outbox or
redemption tombstone is created.
The termination operation then reports `billing_operator_reconciliation_required`
with `retryable:false`; ordinary retry cannot manufacture the missing evidence.

Only fresh termination proof and no remaining owned termination receipt allow
the existing atomic local deletion to erase
all owned billing, ordinary/welcome redemption, identity and private application
rows. Session is rechecked after waits and during final SQL. Temporary accounts
with a persisted non-null deadline cannot start checkout, avoiding a network
dependency during ordinary account expiry. Restore invalidation removes hosted
URLs and invalidates termination proof; it cannot revive payment authority.

## Inventory private state and qualification

The application retains an owner mapping, random billing reference, minimal
customer/subscription/current settled invoice/charge IDs, locale/policy context
and closure proof while that account exists. Bounded private operations retain
request fingerprints, task/resource references, safe status and short-lived
hosted URLs. Ordinary operation history has a global cap of 128 and per-account cap of 32,
plus at most one reusable termination record per existing owner binding. Ordinary
completed/failed operations are removed after 24 hours; the current checkout
reference, unresolved outcomes and termination remain until resolved, superseded
by a safely admitted checkout, or account deletion. Adding the current-checkout
field to older epoch-2 storage automatically anchors only an unambiguous single
checkout and still requires provider confirmation. Competing generations or
missing history stay held for operator reconciliation; local or provider event
timestamps never select ownership. URL expiry is enforced
on reads and cleanup scrubs expired URLs while the composed API runs. Neither a
logical expiry nor deletion promises immediate physical removal from SQLite/WAL
or provider copies.

Generic task payloads carry operation ID, locale and policy key only, and outputs
are null. The application does not retain raw webhook bodies, provider traces,
email, billing address or card information from Stripe. Hosted payment pages can
collect those fields at Stripe; exact provider retention and processing remain
part of reviewed notices and real qualification. No new analytics recipient,
daemon, database epoch or package dependency is introduced.

Adjacent suites use real SQLite/auth/task/HTTP boundaries and fake providers.
They prove signature tampering/replay closure, duplicate/order behavior, refunds,
current-state access, pending deletion, ambiguous customer creation, closure
races, temporary-account denial, restore and old/unaware deletion rollback. The
operator suite compares Python launchers with actual Node configuration. These
checks do not qualify real payment delivery, account isolation, hosted UI,
provider data handling or live release readiness.

## Qualify the Managed Payments target separately

[Stripe's eligibility review](https://docs.stripe.com/payments/managed-payments/eligibility)
must confirm the account and product, including an eligible product tax code.
[Managed Checkout](https://docs.stripe.com/payments/managed-payments/update-checkout)
requires `managed_payments[enabled]=true` for a new subscription and forbids the
ordinary profile's `automatic_tax` and `payment_method_types` parameters.
Adaptive Pricing and tax mean a base-price amount/currency equality check cannot
be reused as its settlement validator.

The minimum separate profile needs tax/presentment-aware paid-service fixtures,
delayed-payment failure and cancellation/refund tests, a confirmed account/product
receipt, required/forbidden request-field checks and matching Link disclosures.
[Link handles transaction emails and management](https://docs.stripe.com/payments/managed-payments/how-it-works);
Customer Portal remains optional. [Sandbox purchases do not appear in Link](https://docs.stripe.com/payments/managed-payments/set-up),
so a live Link test must not be claimed under test-only authorization. No live
Managed Payments route or self-certified eligibility is enabled here.
