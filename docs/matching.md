---
summary: Integrate and verify bounded residual matching for Justup.
read_when: Wiring the search runner, reviewing matching privacy or approving a real-provider benchmark.
---

# Residual matching

`server/matching.mjs` evaluates only the accepted search configuration's
`residualAi.condition`. The intent service first applies freshness, account access
and every primary filter. It passes only that narrowed internal candidate list to
matching. Neither provider failure nor insufficient evidence removes a requirement
or substitutes unprocessed jobs. `feed.publicJob` supplies the final public
projection; raw bodies, evidence hashes, scan counts and task output stay private.

The default provider is disabled. Existing-key use is authorized in
[resource issue 49](https://github.com/colophon-group/justup/issues/49), with the
initial Justup cumulative guard still mandatory. Isolation review, confirmed
account pricing, protected key delivery, ledger initialization and a completed
real benchmark remain pending. No
real provider request or infrastructure allocation is part of the test suite.

## Compose the service

Create `createMatchingService({db,feed,tasks,config,now})`, then pass the instance
to the intent service as `matching`. Register
`ai_match: (task, options) => matching.runTask(task, options)` with the shared
runner. That runner must claim one global model task at a time and heartbeat its
lease. Its 90-second task bound contains matching's 60-second work deadline.
Matching performs decision writes and the final task completion with live lease
checks; `committed:true` means the runner must not complete the task again.

The API process must not receive a JEV key or provider broker access. Compose its
instance with `readOnlyProvider:true` and
`availability:() => trustedFreshSameBuildHeartbeat.aiMatching === true`. Only this
queue/read role uses the callback: `available()`, capabilities and readiness
reflect that trusted heartbeat, and page reads can enqueue work and deliver exact
cached decisions without a local provider credential. A missing or throwing
callback closes availability. The worker role ignores this callback and requires
its actual provider to be configured. Independently, `runTask` always refuses
provider execution in the API role, even if a provider was accidentally injected;
it pauses unresolved work with `dependency_unavailable` and makes no request.
The default keyless API client still owns the accounting tables and synchronous
private cleanup. No fake successful provider is substituted for the heartbeat.

The page interface is:

```js
matching.page({ownerId,searchId,revision,configuration,jobs,viewer,cursor,limit,
  coverage,generation,now})
```

It returns the complete results envelope with `searchId`, `revision`, `asOf`,
allowlisted `items`, `continuation`, `ai` and `coverage`. Ownership comes from the
validated session. `available()` and `capabilities().aiMatching` report the
role's actual worker or trusted queue readiness. Do not set a separate optimistic
capability flag. The
module's `taskResult` deliberately returns no raw task output to the browser.

Register `deleteAccountData(ownerId)` with the auth deletion transaction. The
intent service calls `deleteSearchData(ownerId,searchId)` from its deletion
transaction after the shared private-deletion barrier. These synchronous hooks
open no nested transaction. They remove matching tasks, scans, cursors, linked
cache entries and owner accounting. Aggregated project spend remains without an
account identity, so deletion does not replenish the project budget.

Run `cleanup()` at startup and at least once per minute to enforce idle retention;
page reads and provider requests also invoke cleanup. The service exposes this
hook but does not start another scheduler. The isolated database's backup and
restore generation barrier is owned by the core/auth composition.

## Provider readiness and bounds

The worker's `config.jev` must supply all of the following before provider
execution is available:

- `enabled:true`, `authorizationApproved:true`, the approved existing `token` through queue-only delivery and a
  bounded non-secret `projectId`.
- `model:'jev-1.14.0'` (or omit the field to use that pinned version).
- `pricing:{confirmed:true,model:'jev-1.14.0',version,inputNanodollarsPerToken:42,
  outputNanodollarsPerToken:0}`. The operator confirms actual account pricing;
  a public price page alone does not approve a spend ceiling.
- `budgets:{account,project}` with each containing positive safe integers
  `calls`, `inputTokens`, `outputTokens`, `costNanodollars`. These apply to fixed
  UTC-aligned daily windows by default (`windowMs` can lower the window to at
  least one minute). Values are intentionally absent by default.
- `cumulativeBudget` binding a protected queue-only ledger to the exact approved
  resource/slug, human approval record, ledger identity, confirmed pricing and a cap
  no greater than 500,000,000 nanodollars ($0.50). The protected operator steps
  below are required; an agent-authored flag or template is not approval.

Use protected queue-only delivery described in [secrets](secrets.md). Only the
existing shared key explicitly authorized by `jev-evaluation-budget` may be used;
do not load Jobseek runtime configurations or unrelated legacy, dormant,
administration or quarantine credentials.
Never put a key in a browser, fixture, command argument, issue or log.

Every attempt reserves daily call/token/cost capacity and then durably reserves
the full verified 64k-input-token maximum in the separate cumulative ledger
before network access. Output pricing must be confirmed zero. Cumulative
reservations are never refunded, including success, timeout, malformed reply,
crash before a request and ambiguous failure. Each retry needs another full
reservation. Daily SQLite accounting separately reconciles successful measured
usage; it retains conservative capacity for ambiguous attempts. The default is
one retry, with a 15-second per-attempt timeout and
bounded exponential backoff respecting short `Retry-After` values. Long provider
backoff pauses the scan for a later task instead of holding the runner. An actual
usage overrun pauses without returning decisions. A response claiming more than
64k input tokens also appends a durable halt to the cumulative ledger and blocks
future requests pending operator reconciliation. This is conservative local
accounting under verified provider price/context limits, not exactly-once billing
or an independently verified provider-account spending control.

Daily SQLite limits remain abuse controls: deleting/recreating accounts or
restoring an older database can reset those counters. It cannot replenish the
separate cumulative ledger, which contains no account IDs, queries, job evidence,
provider keys or other private account data. Account deletion never changes it.
The runtime never creates, truncates, resets, refunds or restores that ledger.

## Prepare the cumulative ledger after isolation review

No active ledger or real key is initialized by this change. The operator must:

1. Verify the recorded human authorization in
   [`jev-evaluation-budget`](https://github.com/colophon-group/justup/issues/49) and complete
   the queue/API/model identity and logging review in the
   [operations guide](demo-operations.md).
   Confirm actual account input pricing, free output and the supported per-request
   input maximum privately. Do not publish account balances or key values.
2. Create a dedicated queue-owned mode-0700 directory outside the preview database
   directory and backups, such as `/srv/justup_preview/queue`. The API and isolated
   model identities must have no access. Use canonical absolute paths without
   symlinks. Root creates this directory; the runtime does not create it.
3. For a genuinely new ledger, use a separate protected operator action to
   exclusively create a mode-0600 regular file with no symlink following,
   then fsync the header and its directory. The file must be
   owned by the queue UID, with one compact UTF-8 JSON header plus a final newline.
   Its fields are the pure `unapprovedJevBudgetTemplate()` result in
   `server/jev-budget.mjs`, with the actual human `approvalId`, actual confirmed
   pricing version/values and approved cap filled only after the technical review. The
   template itself has null approval/pricing and is unusable. New headers use
   `JEV_BUDGET_SLUG` (`jev-evaluation-budget`) and retain the existing version-1
   field set. Keep the unique `ledgerId`; no runtime or unapproved initializer
   creates an approved ledger. Never create a replacement to replenish an
   existing allowance. `approvalId` accepts an approval comment URL on the fixed
   `JEV_BUDGET_RESOURCE`, `operator-user-turn:UUID`
   or `operator-approval:UUID` referencing the protected operator's verified human
   authorization record. These syntactic bindings do not verify or grant approval
   themselves. Do not publish private chat contents or account billing state.
4. Supply protected queue-only configuration:

   ```js
   import { JEV_BUDGET_RESOURCE, JEV_BUDGET_SLUG, JEV_BUDGET_IDENTITY_PROFILE,
     JEV_CUMULATIVE_CAP_NANO } from './server/jev-budget.mjs';

   const cumulativeBudget = {
     path: '/srv/justup_preview/queue/budget-ledger.jsonl',
     excludedDirectories: [previewDataDirectory, previewBackupDirectory],
     identityProfile: JEV_BUDGET_IDENTITY_PROFILE, // canonical-v1; also the default
     approval: {
       approved: false, // remains false until the protected human-approved step
       resourceId: JEV_BUDGET_RESOURCE,
       resourceSlug: JEV_BUDGET_SLUG,
       approvalId: null, ledgerId: null, capNanodollars: JEV_CUMULATIVE_CAP_NANO
     }
   };
   ```

   The approved configuration and header must match exactly, including the
   pinned model and confirmed `config.jev.pricing`. The current transport accepts
   42 nanodollars/input token and zero output charge; that catalog rate has not
   been verified for the actual account. A different actual rate needs a reviewed
   transport/pricing update before activation. Do not give this configuration,
   ledger path or the JEV key to the API or model process.
   The profile is configuration only; it is not a new on-disk header field.
5. Exclude the ledger from preview SQLite backups, restores and deletion/retention
   jobs. Preserve it across restarts and account deletion. A missing file,
   mismatched approval/price/cap, unsafe permissions/ownership, symlink, hard link,
   corruption or partial final record fails closed. Each append takes an exclusive
   lock and fsyncs the full irreversible reservation before any request. Concurrent
   callers cannot reserve beyond the cap. The file is bounded at 4 MiB/10,000
   lines and validates sequence numbers, cumulative totals and a hash chain.
6. A retained `.lock`, damaged ledger or durable halt requires explicit operator
   reconciliation. The runtime never removes a retained crash lock. Preserve all
   known reservations conservatively; do not roll back a valid ledger prefix,
   replay an older copy or reset the cap to resume. Loss of the ledger closes
   execution. Remove Justup's protected access to the approved existing key before
   disposing of the ledger during teardown. The key may serve Jobseek too: do not
   revoke it without the owning operator's coordinated approval. Any increased
   Justup allowance requires new explicit approval.

### Bind an existing historical ledger

An existing version-1 ledger whose header contains `resourceSlug:
'demo-jev-evaluation-budget'` retains that exact field value. The slug is part of
the hashed approval history; renaming it would invalidate the first reservation's
hash link. Preserve every existing byte, including the header, ledger UUID,
human approval, cap, model, pricing and all reservations. Do not initialize,
rewrite, truncate, replace or refund it when updating the product identity.

Before upgrading a consumer of this historical format, the protected operator
must review that the header belongs to the known approved `jev-evaluation-budget`
resource and supply `identityProfile: JEV_BUDGET_LEGACY_IDENTITY_PROFILE`
(`legacy-v1`) with `approval.resourceSlug: JEV_BUDGET_LEGACY_SLUG`. These
constants are exported by `server/jev-budget.mjs`. Keep the fixed
`JEV_BUDGET_RESOURCE` and every approval, model and pricing value matched exactly
to that header. This explicit binding permits continued append-only reservations
under the original cap; the profile and approval syntax grant no human approval.

The default `canonical-v1` profile accepts only `jev-evaluation-budget` headers.
The explicit `legacy-v1` profile accepts only the known historical slug.
Unknown profiles, resources or slugs and mixed canonical/historical configuration
and headers fail closed. The runtime never infers a profile from a file or
migrates a header. The historical format remains supported while an authorized
ledger needs its approval and spend history retained; its name is persisted
accounting metadata, not a separate product or renewed budget.

At the unverified catalog rate of 42 nanodollars/token, each full reservation is
2,688,000 nanodollars ($0.002688); a $0.50 cap admits at most 186 attempts, including
retries. This is a conditional arithmetic example, not an approved price, billing
balance or promised evaluation count. The monotonic guarantee relies on keeping
the queue ledger outside database restoration and on the protected operator never
rewinding/replacing it. It does not protect against privileged filesystem tampering
or incorrect provider pricing/usage; unexpected usage halts further execution.

## Provider data and request limits

Requests go only to `https://api.typesafe.ai/v1/systemone`, with redirects denied.
They contain the residual condition plus each selected public posting's title,
company name and complete normalized body text. Owner, search and source job IDs,
usernames, source URLs and private task metadata are omitted. Response parsing
requires the pinned model, exactly the requested opaque keys, complete three-way
probability distributions, valid confidence and bounded integer usage. Replies
are limited to 64 KiB and timeouts cover body reads. No heuristic classifier is
used when JEV is unavailable.

`jev-1.14.0` is the current model verified on 2026-10-31. Official TypeSafe
[models](https://docs.typesafe.ai/models) list 64k tokens per request, 32k per
question and $0.042 per million input tokens, with free output. The service leaves
long context disabled. The [Choice reference](https://docs.typesafe.ai/primitives/choice)
supports named options and probabilities; the exact three options are
`accepted`, `rejected`, `insufficient_evidence`. The
[API reference](https://docs.typesafe.ai/api/system-one) specifies the response
envelope. [Request rules](https://docs.typesafe.ai/api/errors) additionally set a
32 MiB HTTP body limit. Organization request/token rate limits and any negotiated
pricing must be checked with the approved account before benchmarking.

The local planner is stricter: at most 24 candidates, 28,000 UTF-8 request bytes,
14,000 bytes for one question with shared state and a reservation of twice the
request bytes plus 1,024 input tokens. This is a conservative estimate, not an
official tokenizer or measured usage. It stays below the documented default
context limits under the estimator; the real benchmark must validate its margin.
Missing, weak, truncated and oversized evidence resolves to insufficient evidence
without a confident acceptance. Evidence is never cut down silently to fit.
An answer needs at least 0.9 selected-option probability and 0.85 confidence for
accept/reject; otherwise it becomes insufficient evidence. This provisional
policy is versioned and has not been calibrated on real model output.

## Ordering, recovery and retention

The stored scan contains at most 1,000 primary-filtered candidates in descending
source first-observed time, then source ID order. At most 24 candidates form a
request and at most four requests run in one work task. Adaptive byte/token
planning can reduce the actual count. The ready threshold is 48 accepted rows;
one batch can exceed that threshold by at most 23, with one request in flight.
A page read schedules refill when that buffer is below its threshold. Zero-yield
batches continue within the task's remaining work budget and then resume on a
later poll. Pending cache hits also resolve before another network request.

Only a resolved newest-first prefix can be delivered: an older accepted row waits
behind any newer unresolved row. Exhaustion requires the full candidate scan to
be resolved and its accepted buffer to be drained. Empty open/pending pages are
not exhaustion. Provider or budget pauses retain the condition and scan position.
Current access, primary membership and evidence are rechecked before delivery.

Random database-backed cursors reveal no job identifiers. They bind owner,
search/revision, exact configuration, access mode, import generation and classifier
version, expire after ten minutes and return 409 on stale state. Each scan keeps
at most 64 live cursors. A new revision/import/classifier read cancels older scan
tasks. The service caps scans at 96 globally and 16 per account.

Cache identity includes owner, canonical condition, model-visible semantic
evidence hash and classifier/prompt version. Identical evidence deduplicates
within a batch and across searches; freshness timestamps alone do not invalidate
unchanged semantic evidence. Cache and scan lifetimes are at most seven days,
with 4,096 cache rows/account and 32,768 total. Requests, cache links and budget
reservations are private. The provider's actual retention terms and account
settings remain a release inventory requirement: this implementation does not
claim zero retention. See TypeSafe's [legal reference](https://docs.typesafe.ai/legal).

## Verification and remaining release work

Run Node.js 24.22.2:

```sh
node --test server/jev-budget.test.mjs server/jev.test.mjs server/matching.test.mjs
```

The focused suite uses fixed clocks, in-memory SQLite and fake network responses.
It proves primary candidate narrowing, uncertainty, provider outages, strict
reply parsing, spend reservations and retries, chronological blocking,
zero-yield resumption, stale/expired/access-bound cursors, evidence/version cache
invalidation, deduplication, cancellation and private deletion.
API-role tests also prove trusted-heartbeat queueing without credentials, an
independent execution denial with no HTTP, and deletion of provider-private
SQLite rows by the keyless API client while the anonymous cumulative ledger
survives. Ledger tests cover restart/old-database restoration/account recreation,
crash reservations, two-process reservation races at the cap, retry charging,
corruption/partial writes, unsafe paths, unapproved configuration and durable
usage-overrun halts. A separate local
composition smoke exercised the actual core store/feed/tasks together with
matching and a fake TypeSafe transport, including atomic lease completion and
cleanup inside the core transaction. It did not run an HTTP server or deployment.

The manually reviewed synthetic development/held-out cases are in
`server/evals/matching-cases-v1.json`. They include explicit positive, explicit
negative, missing-evidence and embedded-instruction examples. Tests feed their
expected labels through the fake protocol. They verify the harness and policy,
and do not measure model accuracy.

A deterministic scan with 120 candidates and the final 12 accepted measured:

| Maximum candidates/request | Fake provider calls | Work cycles | Empty pages after work |
| --- | ---: | ---: | ---: |
| 5 | 24 | 6 | 5 |
| 12 | 10 | 3 | 2 |
| 24 | 5 | 2 | 1 |

This supports a provisional 24-candidate default under the local byte/token
limits. No real-provider latency, token cost, acceptance rate or accuracy has
been measured. Before public sharing, reviewed queue-only delivery of the approved
existing key, verified pricing and the initialized cumulative ledger must enable
a bounded benchmark on the actual eligible job slice. Repeat
the reviewed held-out cases at least three times, require no false acceptance on
ambiguous cases and perfect acceptance precision in this small gate, and report
variance plus sample size. Also measure actual-slice acceptance, throughput,
p50/p95 latency, priced usage, ready-buffer starvation and failure recovery.
Agree numeric responsiveness and spending ceilings from that evidence. A model
or prompt change requires a version change and rerunning those evaluations.
