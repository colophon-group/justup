---
summary: Compose published Hiring Wire reads and bounded weekly work in the existing API and queue.
read_when: Reviewing Wire configuration, weekly scheduling, foreground priority or release evidence.
---

# Hiring Wire integration

`server/hiring-wire-integration.mjs` owns fixed composition for the existing API
and runner. It starts no listener, process, timer or external request. The API
uses `createHiringWireApi({db,now})`, which exposes only published GET reads and
published-edition availability. It receives no task queue, source directory,
attestation, model socket or private runner configuration.

The queue awaits `createHiringWireRunner({db,tasks,now,hiringWire,sourceCoverage,
buildIdentity,hostPlanSha256})`. Its `runTask` handles the private `hiring_wire`
kind; its `beforeClaim` is the existing runner's maintenance hook. The fixed
source reader and Sol transport are imported only inside queue composition.
The factories argument is an isolated-test seam; protected operator JSON cannot
select factories, modules, commands, models, provider paths or schemas.

## Protected configuration

Wire defaults to disabled. The optional queue/broker `hiringWire` configuration
retains the fixed model-broker contract: absent, `{enabled:false}`, or exactly
`{enabled:true,attestationPath,providerCatalogueSha256,modelUid,socketPath}`.
Enabling it still requires the independent immutable Wire attestation checked
by `createHiringWireCodexTransport`. Luna qualification does not qualify Sol.
The trusted launcher supplies build and host-plan identity independently;
operator JSON cannot override either identity.

The optional queue-only `sourceCoverage` is exactly
`{directory,sourceVersion:"jobseek-coverage-v1"}`. The version must equal the
reader's exported `SOURCE_COVERAGE_VERSION`. The directory is an absolute,
normalized protected source-input path, separate from writable shared state.
The fixed reader chooses the UTC period's artifact name. No request or editorial
tool chooses an artifact path. Read the source reader's contract before preparing
an export. Configuration does not provision this directory or prove historical
coverage. Omitted source input leaves publication unavailable and makes no model
call. No actual producer or complete 14-day history is assumed by this integration.

## Weekly admission and failures

Before claiming work, the runner computes the most recent Monday at 00:00 UTC.
Within the consumer's fixed two-day publication window it records one durable
schedule row and enqueues the same period through `enqueuePeriod`. The system
owner is `__hiring_wire__`; ordinary owners cannot enqueue this kind, and its
task cannot produce a public task envelope. There is no public generation route.

The schedule persists across restarts and retains 52 weeks of small metadata.
If a process exits between task insertion and schedule-reference update, the
idempotent period lookup rediscovers that same task. Polls do not create new
tasks. Dependency-unavailable failures retry after 15 minutes and then two hours,
with at most three scheduled attempts in the week. Queue-capacity admission
uses the same bounded backoff. Factual, quality, cancellation, timeout and exhausted
preemption failures require a decision and receive no automatic lucky retry.
Missing input or qualification never produces a fabricated edition.

The queue atomically claims every non-Wire kind before Wire, while preserving
its one global lease and existing task/account/resource ceilings. If foreground
work arrives during Wire, the runner checks within at most 250 milliseconds,
aborts the editorial signal and awaits the handler's cancellation cleanup before
performing a lease-token compare-and-set pause. The same task and frozen period
resume after foreground work. At most three claims are allowed before interruption
becomes terminal. A completed, cancelled, deleted, expired or replaced lease
cannot be resurrected by a late pause. Publication checks the abort signal and
live lease before committing, so a preempted attempt publishes nothing.

Native shared-slot cleanup requires the Sol protocol's cancellation acknowledgement;
queue-only fake cleanup tests do not establish that native boundary. Release must
include that transport contract and its fake native-protocol tests before claiming
running-turn preemption is fully qualified. No scheduler is activated by this PR.

## Verification and release boundary

The integration suite uses real SQLite with a deterministic synthetic source and
fake editorial transport. It verifies enabled weekly publication, restart and
crash-gap idempotence, default disabled behavior, zero editorial calls without
source/qualification, bounded retries, factual/quality failure closure, private
configuration separation, expiry/archive behavior and cleanup-gated preemption.
Tasks and runner suites independently verify owner isolation, atomic priority,
one global lease, cancellation and bounded pause behavior.

These tests do not establish a live historical producer, complete source history,
provider catalogue observation, independently reviewed Sol qualification or a
deployed candidate. Those remain separate release evidence. This code performs
no native model calls, scheduler activation, host changes, secret access, spend
or infrastructure provisioning.
