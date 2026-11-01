---
summary: Application database epoch, offline product-name migration and forward recovery.
read_when: Changing durable SQL names, selecting a release or restoring existing state.
---

# Preserve application state across releases

The application SQLite schema epoch is **2**. `PRAGMA user_version`, the immutable application manifest, `/api/v1/version.schemaVersion` and the auth-owned restore receipt report this same epoch. A new empty database initializes epoch 2. An existing epoch-1 database requires the explicit offline migration below; startup never silently renames it. A populated database with epoch 0, mixed old/new names, unknown old objects, incompatible columns, broken foreign keys or failed integrity checks is rejected.

Import snapshots, accepted search configurations, runner heartbeat messages, source-coverage snapshots, model catalogues and the external JEV approval ledger have independent format versions. Their `schemaVersion:1` values remain unchanged.

## Upgrade an existing epoch-1 database

Use the current reviewed protected operator scripts. Keep these scripts installed independently of the selected immutable application release: selecting an older application must not select older launch or recovery tools. First complete the scripts-only operator update and stage the exact epoch-2 target artifact as described in [operations](operations.md). Review the target source commit/build, available backup capacity and the live independent deletion generation before running:

```sh
systemd-run --unit=justup-preview-schema-migrate --collect --wait --pipe \
  --slice=justup-preview.slice \
  /usr/bin/python3 /srv/justup_preview/ops/preview-recovery.py migrate \
  --database /srv/justup_preview/state/preview.sqlite \
  --backup-dir /srv/justup_preview/state/backups \
  --generation /srv/justup_preview/state/private-generation \
  --build-identity "$JUSTUP_PREVIEW_BUILD_ID"
```

The command requires root, the current epoch-1 artifact and the exact retained epoch-2 target. It creates and fsyncs `.preview-schema-migration.lock`, which blocks protected API/queue launches. It stops the named preview services and guard, then checks the kernel identities of all processes to prove that the dedicated API, queue and model users have no remaining processes. SQLite's write lock does not establish this service quiescence: WAL readers can survive `BEGIN IMMEDIATE` or `BEGIN EXCLUSIVE`.

With those identities idle, it takes an online SQLite backup under the unchanged live deletion generation. No backup or migration proceeds while `private-generation.pending` exists. The target artifact's fixed migration command runs as the API identity with the shared state group and a minimal credential-free environment. One SQLite transaction validates the reviewed old schema, renames tables, replaces the seven explicitly named indexes and commits epoch 2. It preserves rows, row IDs, foreign-key relationships, task leases/retries/payloads/receipts, import history, source first-seen identity and closure tombstones, cursors, matching decisions and SQL spend. JSON and task-kind values are not rewritten. No compatibility views or parallel SQL stores are created.

The protected command independently checks its bounded receipt, resulting epoch/integrity and unchanged deletion generation before removing its own maintenance lock. It leaves every writer stopped. Select the staged epoch-2 build through the ordinary `switch` operation and repeat the complete identity/readiness/data/browser checks before reopening routing. A fresh empty deployment needs no migration.

A failure leaves the lock and stopped services for review. Do not automatically clear or age out the lock. Reconcile the exact target identity, database integrity and epoch, backup digest, pending deletion state and stopped process identities before a reviewed operator removes that exact maintenance marker and resumes the appropriate forward recovery. Transaction interruption leaves the previous complete schema or the committed new schema; an unknown outcome must be inspected. Never use a global service restart to resolve it.

For an isolated local database, after independently stopping every writer and retaining a deletion-safe backup, the same fixed primitive is `JUSTUP_DB_PATH=/absolute/private/application.sqlite node server/main.mjs --migrate-db`. It does not prove host quiescence or replace the protected host operation.

## Restore forward; do not downgrade

There is **no epoch-2 to epoch-1 downgrade**. A retained epoch-1 application is unsupported against epoch-2 data. Current protected API/queue launchers inspect SQLite read-only against the selected manifest before executing application code. The host switch compares the actual database epoch with its target after stopping services; mismatches leave the existing links unchanged and writers stopped.

A retained epoch-1 snapshot is only a forward-recovery input. Restore it to a new separate file with an explicit epoch-2 target and `--migrate-v1`:

```sh
python3 /srv/justup_preview/ops/preview-recovery.py restore \
  --snapshot /srv/justup_preview/state/backups/backup-EXACT-REVIEWED-NAME.sqlite \
  --generation /srv/justup_preview/state/private-generation \
  --destination /srv/justup_preview/state/restored-forward.sqlite \
  --build-identity "$JUSTUP_PREVIEW_BUILD_ID" --migrate-v1
```

The target's auth-owned helper migrates the separate epoch-1 file to epoch 2 before revoking every restored session. Without the explicit flag, an epoch-1 snapshot is rejected. Epoch-2 snapshots use ordinary same-epoch restoration without that flag. Both paths require the current live deletion generation, stopped dedicated identities, an absent deletion-pending marker and a successful schema/session-invalidation receipt. They never activate or overwrite the live database. Review ownership, live-path replacement and stopped WAL sidecar cleanup separately as described in [operations](operations.md).

Recovery preserves `job_source_identities` and the complete SQL JEV usage/reservation state. The cumulative JEV ledger and any crash lock remain outside SQLite backups. Its resource ID, historical `demo-jev-evaluation-budget` slug, approval header, prefix/hash chain and bytes must remain unchanged. Never restore, replace or relabel that ledger to reset spend. The live private deletion generation is also independent of snapshots and must never be replaced by a backed-up value.

## Exact naming inventory

The reviewed table map changes only the prefix for these 19 names:

| Epoch 1 | Epoch 2 |
| --- | --- |
| `demo_imports` | `justup_imports` |
| `demo_jobs` | `justup_jobs` |
| `demo_tasks` | `justup_tasks` |
| `demo_company_requests` | `justup_company_requests` |
| `demo_company_request_keys` | `justup_company_request_keys` |
| `demo_company_request_tasks` | `justup_company_request_tasks` |
| `demo_company_evidence` | `justup_company_evidence` |
| `demo_searches` | `justup_searches` |
| `demo_search_submissions` | `justup_search_submissions` |
| `demo_search_proposals` | `justup_search_proposals` |
| `demo_search_cursors` | `justup_search_cursors` |
| `demo_search_delegate_cursors` | `justup_search_delegate_cursors` |
| `demo_match_scans` | `justup_match_scans` |
| `demo_match_jobs` | `justup_match_jobs` |
| `demo_match_cursors` | `justup_match_cursors` |
| `demo_match_cache` | `justup_match_cache` |
| `demo_match_cache_links` | `justup_match_cache_links` |
| `demo_jev_usage` | `justup_jev_usage` |
| `demo_jev_reservations` | `justup_jev_reservations` |

The seven explicitly named indexes use the same prefix map: `demo_jobs_order`, `demo_jobs_company`, `demo_tasks_owner`, `demo_tasks_queue`, `demo_company_requests_owner`, `demo_searches_owner` and `demo_match_cache_owner`. Each is recreated transactionally with its original columns and ordering. SQLite manages primary/unique index identity and updates foreign-key references during table rename. No demo-named triggers or stored task-kind values require migration.

Existing stable `auth_*`, `access_*`, `job_source_identities`, `hiring_wire_*` and other `justup_*` names stay unchanged. In particular, preserve `justup_processing_admission` rows and exact locale `policy_scope`, interface locales, aliases, positive and negative follows, viewed records, recovered drafts, Wire cleanup halts, frozen editions, executions and selection recipes.

Product configuration already uses `JUSTUP_*`; no `JUSTUP_DEMO_*` aliases are accepted by protected launchers. Runtime modules/imports and `import-jobs.py` already use stable names. The `preview-*` scripts, units and `/srv/justup_preview` paths still describe the temporary deployment boundary. Historical private `.demo/` storage stays ignored so it cannot enter Git. Legacy names remain only in this migration contract/fixtures, explicit rejection tests and the protected external ledger identity.

SQLite semantics: [table rename and references](https://sqlite.org/lang_altertable.html), [transaction locking in WAL mode](https://www.sqlite.org/lang_transaction.html).
