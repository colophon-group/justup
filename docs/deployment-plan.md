---
summary: Deploy the same Justup product through a restricted preview and verified wider release.
read_when: Reviewing runtime placement, changing deployment settings or preparing release and recovery evidence.
---

# Justup deployment plan

The application has one API, durable SQLite store, leased background queue and private model broker. Cloudflare delivers the compiled frontend and forwards same-origin API requests to Hetzner. Preview is an isolated deployment of this product. Invitations, temporary origins, resource/provider ceilings, disabled production schedules and noindex are deployment settings. Accepted first-release features must work before first invited activation; widening access does not replace the runtime, database or account system.

Use the [development process](development-process.md) for protected `dev` integration, frozen release candidates, exact-source checks and explicit production promotion. [Operations](operations.md) owns host preparation, credentials, configuration, import, backup, restore and rollback. [Frontend delivery](frontend-delivery.md) owns immutable frontend bytes, runtime routing, `deploymentMode` and deployed browser evidence. [Backend design](backend-design.md) defines accepted product behavior.

## Runtime placement and identities

| Component | Current boundary |
| --- | --- |
| Frontend | React/TypeScript/Vite builds off-host from an exact committed snapshot and lockfile. Retain compiled assets and worker bytes; no frontend compiler, source or npm install belongs on the application host. |
| API | Node 24.22.2 built-in HTTP/crypto/SQLite, loopback port 8787, dedicated unprivileged API UID. It owns sessions and access-filtered HTTP/SSE state, and receives no model or JEV credentials. |
| Product state | Durable SQLite account, search, request, task and edition state. API/queue share only the explicit state group. Account expiry is optional new-account configuration; sessions expire separately. A new PostgreSQL service is not required by the implemented runtime. |
| Queue | One fixed `runner-adapter.mjs` and `composition.mjs`, durable leases and safe retries. Interactive work has priority over weekly editorial tasks; scheduled work enters this queue rather than another persistent agent service. |
| Models | Separate model UID and root-created Unix socket; queue is the sole client. Subscription auth is private to that UID. Fresh per-invocation homes, fixed task policies and bounded native tools require candidate-specific qualification. |
| Job transfer | Canonical `scripts/import-jobs.py` reads only approved public Jobseek fields; its completed snapshots import through the same application store. Refresh, source history and stale/closure behavior must be verified before scheduling. |
| Recovery/accounting | Live deletion generation remains outside snapshots. Private deletion purges/invalidate backups. Restores invalidate all sessions and prepare a separate database. The cumulative provider ledger and crash locks stay outside database backups and are never reset by restore. |

The immutable backend artifact contains runtime modules, canonical importer, exact required schemas/catalogues, pinned Node/Codex native bytes and complete hashes. Build once off-host from an exact Git commit/tree. Source, build, frontend artifact, deployed mode, runner heartbeat, schema and import generation must agree. A changed source or artifact needs new proof. A backend process check cannot establish that the full product is ready.

## Current restricted allocation

The existing reviewed former Murmur Linux ARM64 host and Cloudflare Free allowance are the only accepted deployment allocation. Application services and public routing are off. Model subscription auth exists in its dedicated private home; a code update must preserve it and the existing data/identity boundary. Host identities and proofs stay in protected operator records.

The aggregate temporary controls are exactly half a CPU (`CPUQuota=50%`, `CPUWeight=10`), `MemoryHigh=768M`, `MemoryMax=1G`, no swap, 96 tasks, a physically preallocated 2 GiB filesystem and an 8 GiB root reserve. At most one model task runs. All API, queue, model, tunnel and maintenance work shares the slice. These are allocation controls, not intrinsic product limits. Preserve the production Lightpanda renderer, its port 9443, existing containers/services and `/mnt/murmur`; a Justup failure must not affect Jobseek.

Systemd derives hierarchical slice paths. For `justup-preview.slice`, the aggregate parent is under `justup.slice`; read the live `ControlGroup` or resolve `/proc/self/cgroup`. Do not assume a root-level `/justup-preview.slice`. Kernel values, allocated blocks, namespaces, networking and credential denial must be proved on the actual candidate/host; unit syntax and local fakes do not establish isolation.

The current installation accepts only the reviewed scripts-only `upgrade-ops` transition with unchanged units, paths, UIDs, native pins and resource plan. Bind both complete plans and old installed hashes. Preserve the image, database, deletion generation, auth, ledger, immutable releases, old receipt and private update history. A failed or interrupted update blocks runtime adoption until reconciled. Changed hashes never authorize adoption of a historical installed plan or staged artifact. No reinstall, data reset, edited receipt, cap increase or forced mount cleanup is an upgrade mechanism.

## Deployment configuration and production transition

The runtime uses `JUSTUP_*` configuration. `JUSTUP_REQUIRES_INVITATION` defaults true and can become false after reviewed admission/security verification. `JUSTUP_MAX_ACCOUNTS` defaults to 30; positive integers or `none` explicitly select the ceiling. Accounts are durable by default. Optional `JUSTUP_ACCOUNT_TTL_MS` or `JUSTUP_ACCOUNT_EXPIRES_AT` are recorded only when a new account is created; changing deployment settings never rewrites existing lifetime. `JUSTUP_SESSION_TTL_MS` is independent and defaults to seven days.

Frontend runtime configuration defaults to `deploymentMode:preview`, with noindex. Production publication is an explicit release action and binds `deploymentMode:production` into its identity; mode is not approval and cannot bypass the release gate. Same frontend assets can use approved runtime routing without rebuilding different bytes. API responses remain private/no-store/noindex in either mode. `/__release/version` is the identity endpoint; obsolete preview aliases are absent.

Keep preview payment capture, production mail and production schedules disabled. Verify free-period/subscription transitions, replay safety, entitlement changes and failure behavior in safe test mode before activation. Review the exact policies for the actual recipients/retention before enabling registration; `product-draft-4` remains unreviewed. Enabling a schedule or provider must be a bounded configuration transition with current qualification, never implicit startup work.

The same state and recovery interfaces continue through wider release. A capacity or unit migration needs a concrete reviewed plan that preserves durable identities and deletion/accounting barriers. It does not justify replacing the product implementation or discarding invited users.

## Ongoing operation and first-release gates

A recurring job feed must preserve posting identity and first observation, refresh known IDs, mark closures/staleness honestly and retain attributable source history. The current importer exposes fixed-snapshot and `--previous` inputs; one initial import is not ongoing operation. Qualify the authoritative read-only producer, transfer cadence, generation/replay behavior and monitoring. The `source-coverage-history` producer must prove scope/revision and uninterrupted intervals before comparative Hiring Wire publication. A current snapshot or recent successful check cannot prove fourteen days of continuity.

Hiring Wire uses the existing queue, an idempotent completed-week period and one ephemeral Sol session with its fixed read/fact tools. Persist the underlying snapshot, aggregates, selections and execution policy with each edition. Qualify the actual source adapter and provider protocol, replay and interrupted coverage before activating its weekly schedule. Shell helpers, another permanent service or fabricated aggregate fixtures do not establish publication readiness.

Operations needs reviewed backup cadence/recovery objectives, successful restore and rollback rehearsal, freshness/queue/task/provider/resource/backup-age observations, numeric alert thresholds and a response owner. Existing metadata logs and the resource guard provide part of this evidence; missing alert delivery or instrumentation remains a launch gap. Restrict preview work to its existing ceilings; approve new resources before allocation.

The first invited candidate must pass all accepted journeys: visitor/search/sign-in, editable saved searches and honest model warnings, residual matching, durable account/follow/viewed state, entitlement transitions, resumable live SSE results, company discovery/request/coverage progression, attributable company hiring reports, persisted posting-language preferences, fresh source-attributed jobs, factual weekly Hiring Wire, reviewed policies and deletion-safe recovery. A missing accepted feature blocks activation and cannot become a preview exception by wording alone.

## Exact-artifact release

Build and retain compatible frontend/API/runner bytes once from a frozen candidate. Record candidate SHA, current `main` base OID, tree, immutable frontend URL/deployment identity, artifact digests, explicit mode, schema/import generation and runner identity. Deploy to isolated state and nonproduction credentials. Verify process readiness, full product capabilities, safe entitlement/provider failures, resource/load/latency/cost observations, backup/restore and real browser journeys through the fixed HTTPS route. Preview remains protected and non-indexed.

Local unit/contract tests and `preview-verify.py` are bounded evidence. The verifier always reports `completeReleaseGate:false` and `shareable:false`; the full trusted deployed `Preview / verified` gate and release-owner review remain required. Stop on a hold, missing result, identity mismatch, failed cleanup or unqualified dependency. Rerun affected evidence after any candidate/base/artifact/policy change.

Release requires the current protected checks and exact reviewed head/base. The merged `main` tree must equal the tested candidate before tagging. Production is an explicit action with retained identical artifact bytes and approved runtime configuration, followed by smoke checks and a defined observation window. Automatic production builds on every push are incompatible with this release contract. Retain the prior deployable artifact and compatible deletion-safe recovery path; do not restore old sessions or overwrite the current deletion generation during rollback.

## Resource authorization

Use existing approved capacity before proposing another rental. This architecture, a passing test or available credentials does not authorize a new external service, paid tier or spend. A separate blocked resource request must record purpose, alternatives, owner, environment, data/access scope, current estimate, spending ceiling and cleanup. A human must approve that concrete scope and ceiling before provisioning; changed scope/cost requires renewed approval. Keep quotes and live inventory in the dated resource evidence, not an expiring price table in this guide.
