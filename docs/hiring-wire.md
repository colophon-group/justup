---
summary: Generate truthful weekly Hiring Wire editions from immutable comparable-source history using bounded Sol tools.
read_when: Integrating the weekly source, editorial execution, public API, scheduler or release gate.
---

# Hiring Wire

Hiring Wire is a first-release feature. `server/hiring-wire.mjs` provides the complete consumer and publication transaction. It never manufactures an edition when source history or the separately qualified Sol runtime is unavailable. This module ships no published fixture. Preview is a deployment state, and the invited preview still needs a real, verified source and subscription execution path.

## Integrate and verify an edition

1. Compose `createHiringWireApi({db,now})` from `server/hiring-wire-integration.mjs` in the API. Dispatch its `publicRoute(ctx)` only for public GET reads and include its actual `capabilities().hiringWire` value. No provider, source or account credentials belong in API composition.
2. Await the integration helper's `createHiringWireRunner` in the existing queue with its protected source/model configuration and independently trusted build/host identity. Register `hiring_wire: wire.runTask` and `beforeClaim: wire.beforeClaim`. Keep one global lease and claim every non-Wire kind first. Running editorial work cooperatively aborts when foreground work arrives; only confirmed cleanup permits a lease-token compare-and-set pause of the same task. The service checks the live task lease and abort signal again in the publication transaction.
3. The shared runner's fixed Monday 00:00 UTC tick records one durable period and queues the fixed internal owner `__hiring_wire__`; no HTTP request creates an editorial task. Dependency unavailability receives at most three scheduled attempts, with 15-minute and two-hour backoff. Factual and quality failures receive no automatic retry. [The enqueue command](../scripts/hiring-wire/README.md) remains an explicit operator entry point using the same `enqueuePeriod(periodEnd)` helper, rather than a separate scheduler. That helper is idempotent while a task is pending, running or successful; a reviewed terminal retry may use a new task identity against the existing frozen period and snapshot, up to eight identities per period.
4. Verify a real edition using the authoritative producer, the qualified subscription CLI profile, the isolated preview API and the public browser read. Verify failure with unavailable history and an unavailable provider. A green deterministic suite alone does not establish either external contract.

`periodEnd` is Monday at 00:00 UTC. The current half-open week is `[periodEnd - 7 days, periodEnd)`; the preceding week is `[periodEnd - 14 days, periodEnd - 7 days)`. A task can publish within 48 hours after its period ends. The trusted configuration can set `publicationLagMs` between one and seven days and `retainedEditions` between eight and 52; defaults are 48 hours and 52 editions. A retry cannot silently switch snapshots, facts or previous editions. A newer published edition prevents an older pending period from publishing out of order.

The integration uses the fixed 48-hour window and 52-edition defaults. See [the
integration contract](hiring-wire-integration.md) for exact queue-only configuration,
restart behavior and priority. Wire is disabled by default, and enabling it does
not qualify a native runtime or establish authoritative historical coverage.
If native cancellation reports `cleanup_unproven`, a bounded singleton SQLite
guard leaves the task held, stops all claims/recovery/scheduler actions across
restart and marks runner readiness unavailable. Recovery requires a stopped runner,
reviewed native/broker idle and cleanup proof, then one reviewed transaction to
terminate the held task and remove the guard. No public or automatic clear exists;
ordinary stored-feed/account access remains independent of runner availability.

## Authoritative source contract

The injected adapter is `{authoritative:true, version, readSnapshot({periodEnd,signal})}`. `version` must exactly match the returned `sourceVersion`. It is a reviewed producer binding, not a boolean accepted from a browser or editorial model. The return value has exactly these keys:

```text
{
  schemaVersion: 1,
  sourceVersion: <bounded version token>,
  snapshotId: <bounded immutable token>,
  asOf: <periodEnd>,
  generatedAt: <canonical UTC ISO timestamp>,
  companies: [{id, name, url}],
  scopes: [{id, companyId, revision, trackedSince, lastVerifiedAt,
            coverage: [{start, end, state: "complete" | "interrupted" | "unknown"}]}],
  postings: [{id, scopeId, firstObserved}]
}
```

All objects reject unknown keys. Timestamps use UTC with three fractional digits. Company links are canonical public HTTPS homepages without credentials, ports, queries or fragments. The producer owns official identity verification and must not use model-proposed company links as evidence. Company IDs are catalogue identities; posting and scope identities stay internal. The projection has no posting text, crawler configuration, account data or queries. It covers every distinct newly observed posting in the interval, including postings that later closed. Filtering to currently active listings would produce false counts and is forbidden.

The explicit `jobseek-coverage-v2` source uses `schemaVersion:2` and adds required
`publicLink:null|{url,status:"approved",provenance,approvedAt}` to each scope.
The [source consumer guide](source-coverage.md) defines the exact approval and
URL checks. V1 snapshots and generic schema-1 injected adapter versions remain
valid. Link metadata does not change facts, comparisons, tool versions or hashes
of existing snapshots.

Each opaque scope identifies the same career-page scope and revision for both weeks. A scope change resets `trackedSince`; history from a different revision cannot establish continuity. Scope tracking and verification metadata may reach the snapshot's `generatedAt`, including a reset after the period end. Such a reset suppresses that scope instead of invalidating the snapshot. Non-null verification cannot precede its current tracking start. The producer must derive complete intervals from its durable observation/ingestion ledger, including missed refreshes, failures and freshness policy. A successful latest refresh cannot retrospectively mark an earlier unknown interval complete. For a comparable scope, intervals must tile exactly the full fourteen days in order without gaps or overlaps, `trackedSince` must precede the comparison window and `lastVerifiedAt` must reach the period end. A source capture must be generated after the period end, within the following 24 hours, and at most 24 hours old when first accepted.

New, stale, interrupted, unknown and sparse scopes are suppressed independently. The compiler counts distinct posting identities across only the remaining comparable scopes for each company. Duplicate observations do not add activity; contradictory identity/company/first-observed data reject the entire projection. A zero preceding baseline produces `percentageChange:null` and explicit before/after counts. These measure listing activity, never hires, headcount or a business cause.

The consumer accepts at most 500 companies, 2,000 scopes, 128 coverage intervals per scope and 100,000 posting observations. The parser ceiling is 16 MiB, while persisted evidence is capped at 4 MiB; an oversized edition fails closed. The producer must use an approved bounded scope set rather than silently truncate observations. Facts are compiled for all eligible companies. Editorial receives a deterministic shortlist of at most 64, ranked by absolute count change, then current activity, then company identity, plus up to eight prior public editions.

The existing imported jobs snapshot is insufficient for this interface. `server/store.mjs` imports recent active listings, while Jobseek's `apps/crawler/src/exporter.py` projects `first_seen_at`, `last_seen_at` and current activity without a fourteen-day scope-coverage ledger. `apps/crawler/src/queries/monitor.py` updates latest success/failure state. Those current-state fields cannot prove uninterrupted history or recover closed first observations omitted from the public snapshot. A producer with durable interval evidence is a required integration gate; no backfill may infer that evidence from listing presence or absence.

## Sol and its maintained tools

`server/hiring-wire-editorial.mjs` exports the versioned `WIRE_TOOLS` JSON schemas, `WIRE_SELECTION_SCHEMA`, `WIRE_PROFILE_DESCRIPTOR`, and `createHiringWireToolSession(input,{executionId,signal})`. A separately qualified subscription CLI runtime can call the pure tool session through ephemeral stdio or its existing broker. The session takes only `{snapshot:{id,sha256,asOf,factsVersion},facts,previousEditions,workspace}`. The `workspace` callbacks stay in the trusted worker; the model receives no database handle or filesystem path.

| Tool | Exact arguments | Effect |
| --- | --- | --- |
| `read_facts` | `{}` | Read fixed aggregate facts. |
| `read_prior_editions` | `{}` | Read up to eight previous published editions. |
| `read_selection_script` | `{}` | Read recipe, revision and content hash. |
| `replace_selection_script` | `{expectedRevision,script}` | Compare-and-set a bounded declarative recipe. |
| `preview_selection` | `{}` | Execute the current recipe on fixed facts and previous selections. |

The recipe is `{version:1,minCurrent:0..100000,maxItems:1..6,sort:"largest_change"|"most_activity",excludeRecent:boolean}`. It materially changes the selected candidates, ordering, maximum size and avoidance of companies featured in the prior two editions. This is the durable script/tool workspace Sol can maintain. It cannot run arbitrary code, read files, launch a process, install tools or change source evidence. At most four replacements and twelve total calls are allowed during a 90-second session. Each tool result is at most 64 KiB; the combined aggregate context and tool transcript is at most 256 KiB. Abort, timeout, unknown arguments, unknown tools and excessive output stop the session.

The final output is exactly `{snapshotId,items:[{factId,angle}]}` with one to six distinct companies. The angle is the truthful `increase`, `decrease`, `steady` or `new_activity` for that fact, or `counts` to choose a before/after headline. Sol selects companies and supported headline templates. Application code renders all prose, numbers and links from validated facts; a free-form headline or a model-supplied count/link rejects the output.

The tool session's `finish(data)` produces `{data,execution}`. The execution receipt contains exactly `executionId`, `model`, `profile`, `promptVersion`, `toolVersion`, `toolSchemaSha256`, `elapsedMs`, `toolCalls`, `workspaceRevision` and `workspaceSha256`. The fixed model/profile are `gpt-6.1-sol` / `hiring_wire`. The receipt is generated by the trusted dispatcher and is not model output. It records execution; it does not replace runtime qualification.

`createHiringWireEditorial({transport})` is the bounded step-transport adapter. A transport implements `qualified(WIRE_PROFILE_DESCRIPTOR)`, `executionId()` and async `step(request,{signal})`. Its response is exactly `{type:"tools",calls:[{id,name,arguments}]}` or `{type:"final",data}`. Requests contain the descriptor, execution identity, safe context, allowed tools, prior tool results and editorial instructions. One execution identity spans the entire session. The adapter always calls an optional `cancel(executionId)` cleanup hook when it finishes or fails, including while a native tool request is paused. The real transport must close that process and enforce its own global deadline. The adapter also aborts an unresponsive step at the remaining session deadline.

The real runtime must prove the pinned subscription CLI version, supported Sol model, complete allowed tool catalogue, immutable build/host identity, environment allowlist, dedicated process/resource boundary, denied private paths, trace retention and abort behavior before `qualified` returns true. Existing Luna intent/company qualification cannot authorize Sol or its tools. No Anthropic/API key path, generic shell, home directory, authentication material, Docker, account database or production source access is part of this profile. Native/provider execution is intentionally absent from tests and is not activated by these modules.

## Public reads, persistence and retention

`GET /api/v1/hiring-wire` returns `{state:"published"|"unavailable",edition:null|edition}`. A current edition expires exactly at `period.end + 7 days`, independently of its publication/retry time. At that instant the current read and capability become unavailable. `GET /api/v1/hiring-wire/editions/YYYY-MM-DD` uses the same envelope and returns an already published retained edition as historical content even after expiry. The public edition has `id`, `title`, `period:{start,end,previousStart}`, `snapshotAt`, `publishedAt`, `expiresAt`, `methodology`, and `items`. Each item is `{company:{id,name,url},headline,activity:{current,previous,change,percentageChange},scope:"Comparable career pages"}`. The frontend must hide a current edition at its declared expiry, including after a visibility resume, and refetch within a bounded interval. Company names are at most 200 characters, company URLs at most 2,048, deterministic headlines at most 320, and items at most six. There is no generation, draft, raw fact, workspace or execution HTTP endpoint. Internal task output contains only `{editionId}` and is not exposed through account task polling.

The service creates three additive strict SQLite tables: `hiring_wire_editions`, `hiring_wire_executions` and `hiring_wire_tool_versions`. An edition stores its period, immutable as-of projection/hash, compiler version/facts/suppression evidence, prior-edition continuity, selections, recipe, execution receipt and publication outcome. Database triggers reject updates to a frozen snapshot and to a published edition. Publication and task completion share one transaction; an expired/cancelled lease cannot publish. A partial editorial or publication failure leaves the frozen evidence available for an explicit same-period retry.

The newest 52 published editions and their immutable evidence remain by default. Older complete editions are removed only by retention after a new publication; the configured minimum is eight. Pending rows and execution attempts expire after 30 days, attempts are additionally capped at 256, and working recipes at 32 revisions. Each retained edition stores its exact used recipe independently of working-history cleanup. Public content is at most 16 KiB per edition. Wire stores no account-owned state, so account deletion neither deletes public news nor leaves private account references in it. Ordinary application backup/deletion barriers still govern the shared database.

Rollback stops new enqueueing/dispatch while retaining already published reads. The additive tables require no existing row rewrite. Removing a provider or history binding closes generation without creating replacement facts. Operations must preserve the same database/artifact identity and the shared runner resource boundary.

## Verification

Run `node --test server/hiring-wire*.test.mjs`, then the existing recursive server suite. The Wire owner maintains deterministic fact, protocol, SQLite/runner, publication and CLI contracts in the server CI lane; the focused budget is under two seconds, without network or provider calls. `server/hiring-wire-evals-v1.json` versions reviewed and held-out cases with exact factual acceptance 100%, unsafe acceptance 0%, deterministic evaluation under one second and zero provider calls. This evaluates factual/claim constraints; real Sol selection quality, latency and subscription availability remain part of the separately qualified runtime/preview proof.
