---
summary: Prepare the bounded demo API host, verify fixed bytes and recover without restoring deleted private data.
read_when: Reviewing the demo installer, configuring runtime access, deploying an exact candidate or stopping the preview.
---

# Demo operations

The empty resource boundary has been allocated on the approved host; application services remain inactive. Review the current storage proof and any pending correction in [operations issue 35](https://github.com/colophon-group/justup/issues/35#issuecomment-6547490289) before applying commands. This runbook does not establish a running preview: actual namespace/tool proof, credentials, model readiness, public routing and browser release verification remain required. Runtime promotion to `main` stays blocked by the existing release policy.

The implementation is limited to the approved former Murmur ARM64 machine and Cloudflare free allowance. It preserves the production `jobseek-lightpanda-renderer`, TCP 9443, existing containers, services, provider labels and `/mnt/murmur`. Renderer relocation is not a dependency and is not authorized by this runbook. Do not reclaim its capacity. Use the private host audit to select the one target; public reports contain no host IP or credential values.

## Review before applying

The installer binds its plan to the reviewed host's SHA256 of `/etc/machine-id`, exact hostname, script/unit bytes and fixed paths. The expected fingerprint is private operational input, not a discovered alternative host. Render the plan from the final integrated candidate, including the queue/ledger units and launchers; only that exact reviewed digest is valid. An edited script or unit changes it and requires a new review. Root performs a short installation step; the API and any model execution remain unprivileged.

1. Read [the development process](development-process.md) and [credential guide](secrets.md). Review `scripts/preview-host.py`, `scripts/preview-artifact.py`, `scripts/preview-run.py`, `scripts/preview-queue-run.py`, `scripts/preview-model-run.py`, `scripts/preview-recovery.py`, `scripts/preview-verify.py` and [the unit files](../deploy/justup-preview/README.md).
2. Run `PYTHONDONTWRITEBYTECODE=1 python3 scripts/preview-operations.test.py` off-host. Build/test the complete candidate against the current `dev` base; the core API and auth module must both exist in that exact commit.
3. Read the private host identity and capacity evidence. Recheck root free space, available RAM, CPU headroom, port 8787 availability and protected renderer health. Stop if this identifies a different machine or an operator hold.
4. Render the plan locally, recording the machine fingerprint and resulting plan digest in the private review evidence:

   ```sh
   python3 scripts/preview-host.py plan --source-root /reviewed/checkout --host-machine-sha "$JUSTUP_PREVIEW_MACHINE_SHA"
   ```

   `JUSTUP_PREVIEW_MACHINE_SHA` and `JUSTUP_PREVIEW_PLAN_SHA` below are non-secret review identities. Set them from that reviewed record. They are not provider tokens.

5. After the concrete plan is reviewed, stage those exact files in a protected temporary directory on the one host. Keep staging below 384 MiB and remove its bytes after verification; application files and data ultimately live inside the 2 GiB image. No compilation, npm install, browser or Docker socket is used there.

Do not run installation while credentials or policy approval are being improvised. Preparation can proceed with account access disabled. Actual public sharing requires reviewed policy URLs/version, a scoped runtime configuration, the bounded runner and the fixed frontend route.

## Apply the resource boundary

These are the concrete root commands for an absent installation using the exact reviewed files. Do not rerun them over an allocated installation; use its current evidence and the explicitly reviewed cleanup/reinstall path below. Use the documented SSH deploy identity and strict host-key checking; keep the target address in the private operator environment.

```sh
python3 /reviewed/checkout/scripts/preview-host.py install-slice \
  --source-root /reviewed/checkout \
  --host-machine-sha "$JUSTUP_PREVIEW_MACHINE_SHA" \
  --reviewed-plan-sha "$JUSTUP_PREVIEW_PLAN_SHA"

systemd-run --unit=justup-preview-install --collect --wait --pipe \
  --slice=justup-preview.slice \
  /usr/bin/python3 /reviewed/checkout/scripts/preview-host.py install \
  --source-root /reviewed/checkout \
  --host-machine-sha "$JUSTUP_PREVIEW_MACHINE_SHA" \
  --reviewed-plan-sha "$JUSTUP_PREVIEW_PLAN_SHA"
```

The first command installs only the new slice. The second must observe that slice's real kernel controls before allocating anything. It refuses existing image, mount, UID or unit paths. It exclusively creates `/var/lib/justup-preview.disk`, preallocates exactly 2 GiB, formats only that newly created regular file with `mkfs.ext4 -E nodiscard`, verifies physical allocation remains at least its logical size and mounts it at `/srv/justup_preview` with online discard disabled. It requires at least 8 GiB free on root after allocation. It creates dedicated API, queue and model UIDs with no login shells. Only API and queue join `justup-preview-state`; only queue joins `justup-preview-model-client`; model joins neither. It prepares root-controlled broker/config directories, queue-private work and empty budget directories, installs immutable operational scripts and seeds the live UUID deletion generation. It creates no budget header, secrets, broker attestation or subscription authentication. It starts no API, runner or tunnel and enables no timer.

| Resource | Aggregate boundary and proof |
| --- | --- |
| CPU | `CPUQuota=50%`, `CPUWeight=10`; read back `cpu.max` and `cpu.weight` in the parent slice. |
| Memory | `MemoryHigh=768M`, `MemoryMax=1G`, `MemorySwapMax=0`; read back kernel values. |
| Processes | `TasksMax=96` including threads; API UID additionally has `LimitNPROC=64`. |
| Disk | New physically preallocated 2 GiB loop filesystem: `st_blocks * 512 >= st_size == 2147483648`. Format/mount with discard disabled; verify backing/mount/options and rejected over-limit allocation. |
| Reserve | Root retains at least 8 GiB; preview retains at least 64 MiB. Refuse work and stop preview units if a minute guard fails. |
| Work | API work, queue work and model invocation/auth-refresh directories together at most 512 MiB, included in the hard 2 GiB total. |
| Diagnostics | Seven days; API at most 8 MiB per day, aggregate preview diagnostics at most 128 MiB, included in the image. |
| Model use | One task in flight; model runner/tool/credential isolation must be reviewed separately before activation. |

Run the independent proof under the same slice and save its JSON privately:

```sh
systemd-run --unit=justup-preview-proof --collect --wait --pipe \
  --slice=justup-preview.slice \
  /usr/bin/python3 /srv/justup_preview/ops/preview-host.py prove
```

Every storage/guard check verifies actual allocated blocks, not only logical file size. External trim/hole-punching stops the preview; tooling never reallocates automatically. The existing host trim timer was inspected read-only: its first nonempty fstab list excludes this systemd-only preview mount. Do not change global trim services or add a preview fstab entry without reviewing that behavior. Manual trimming of the preview filesystem can release its physical reservation even with online discard disabled.

Check the installed units with target-host `systemd-analyze verify` and inspect effective sandbox properties. The metadata checks do not establish that unsupported kernel/systemd features work. Verify the API UID cannot open Docker sockets, administrator/renderer paths or write application bytes. Prove that all preview child processes remain in the one slice. Record the protected renderer's health before and after this work. If installation fails partway, stop and inspect only the newly created paths; the installer deliberately does not overwrite or format them on retry.

## Recreate an empty boundary after a failed storage proof

This is an explicit operator recovery, not an automatic retry. It requires a newly reviewed corrected source/plan and readback that the old installation contains only the generated deletion seed, known operational scripts and installation marker. Database, backups, current/previous links, releases, API/queue/model configuration, authentication, attestation, ledger/locks and invocation work must all be absent. Verify the old marker, installed script/unit hashes, exact loop backing and host identity against its private approved record; confirm application/timer/socket units inactive, dedicated UIDs have no processes and the protected renderer/Murmur mount are unchanged. Preserve the failed physical-allocation evidence.

Stage the corrected plan files outside the image in a new protected root directory and verify every digest before cleanup. Use the **installed old tool** for the owned empty-install teardown; do not replace its marker or force the corrected installer over existing paths:

```sh
systemd-run --unit=justup-preview-teardown --collect --wait --pipe \
  --slice=justup-preview.slice \
  /usr/bin/python3 /srv/justup_preview/ops/preview-host.py teardown --erase-data \
  --reviewed-plan-sha "$JUSTUP_PREVIEW_INSTALLED_PLAN_SHA"
```

After this exits, require absent image/mountpoint, dedicated UIDs/groups and preview unit files except the retained slice. Check the exact slice file digest against both reviewed plans, actual kernel ceilings and an empty cgroup. Verify the renderer, prior services and Murmur mount again. If any readback fails, stop for review; do not delete unexpected resources or silently repair them.

The retained slice is deliberately unchanged. Skip `install-slice`, then run the corrected `install` from its staged source in a new capped transient unit with the **new** plan digest. Its existing-path checks remain intact. Repeat independent resource/physical-block/ENOSPC proof, unit syntax, disabled-service/empty-input checks and protected-workload readback. Remove only the verified staging files afterwards. A successful resource reinstall authorizes no runtime/data/model activation.

## Build and stage fixed bytes

Download the official Node archive and exact npm native Codex 0.143.0 Linux ARM64 archive off-host from the URLs in [runtime.json](../deploy/justup-preview/runtime.json). The builder checks their SHA256 pins and Codex's registry SHA512 integrity; it does not compile Node/Codex or install packages. Build from a full commit OID containing the complete backend modules and checked-in official Codex license:

```sh
python3 scripts/preview-artifact.py build \
  --source-root /candidate/checkout --commit "$JUSTUP_PREVIEW_COMMIT" \
  --node-archive /private/artifacts/node-v24.22.2-linux-arm64.tar.xz \
  --codex-archive /private/artifacts/codex-0.143.0-linux-arm64.tgz \
  --output /private/artifacts/justup-preview.tar
```

Save the output's source commit/tree, `buildIdentity` and `bundleSha256`. The manifest covers every application/runtime file; `buildIdentity` hashes the canonical manifest inventory. Copy the already tested bundle to the reviewed host, then stage it inside the capped slice:

```sh
systemd-run --unit=justup-preview-stage --collect --wait --pipe \
  --slice=justup-preview.slice \
  /usr/bin/python3 /srv/justup_preview/ops/preview-host.py stage \
  --bundle /private/staging/justup-preview.tar --sha256 "$JUSTUP_PREVIEW_BUNDLE_SHA"
```

Staging streams the uncompressed bundle and individual file hashes with bounded buffers, verifying the complete inventory and exact Node/Codex version/platform/pins. It does not load the large native executable or whole bundle into host memory. It creates a root-owned read-only `releases/<buildIdentity>` directory without starting it. Keep at most two release directories. It refuses another candidate if those slots or quota headroom are unavailable; review cleanup of a specifically identified inactive build instead of deleting broadly.

This is a backend artifact only: server modules, their checked-in model schemas, the public-data importer, Node and the pinned native Codex distribution. It rejects frontend source, built assets, application package manifests, `node_modules` and frontend build tools. The frontend owner separately builds the exact same commit's `web/` React application using `scripts/frontend-prepare.mjs` in an unprivileged, credential-free builder, retaining `assets/`, `worker.mjs` and `release.json`. Deploy those bytes through the frontend tool; do not run npm, TypeScript, Vite or browser tests on the capped host. Save both manifests together. The HTTP preview verifier requires the retained frontend's source/tree to match the backend, then checks `/__preview/version` for its compiled asset/worker/artifact identities. The frontend's own smoke suite additionally verifies every deployed asset byte.

## Deliver scoped API configuration

Use a separate read-only service token for the chosen preview configuration in `justup-runtime`, with an explicit key allowlist and Doppler `--no-fallback`. Available operator access does not establish the preview's key selection or protected delivery. Do not copy broad production env files or administration/quarantine configuration into a process. The human explicitly approved reuse of the existing Jobseek TypeSafe key under its existing monthly allowance; deliver only that one approved value to the queue, without creating a key or topping up the account. No API or Codex broker receives it. A fresh dedicated model-UID device-auth login is required for Codex; never copy local operator or Jobseek production auth to the host.

Provision `/srv/justup_preview/config/api.json` as a regular mode-0600 file owned by the API UID. Protect its transfer and do not print its contents. The launcher rejects any key outside this list:

| Setting | Purpose |
| --- | --- |
| `JUSTUP_DEMO_ORIGIN` | Exact frontend HTTPS origin; browser calls stay same-origin `/api/v1`. |
| `JUSTUP_DEMO_CSRF_SECRET`, `JUSTUP_DEMO_CURSOR_SECRET` | Separate stable random preview secrets of at least 32 bytes. |
| `JUSTUP_DEMO_INVITE_CODE` | Optional preview-only invite; omit until registration is approved. |
| `JUSTUP_DEMO_POLICIES_REVIEWED` | Defaults to `false`; only `true` after approval of the actual pages. |
| `JUSTUP_DEMO_PRIVACY_URL`, `JUSTUP_DEMO_USAGE_URL`, `JUSTUP_DEMO_POLICY_VERSION` | Approved static HTTPS page identities/version. |
| `JUSTUP_DEMO_SERVICES_ENABLED` | Defaults to `false`; `true` selects the fixed reviewed intent/company/matching composition, never an arbitrary module path. |

The launcher fixes port 8787, shared SQLite mode, heartbeat/work/backup/generation paths, source commit and build identity itself. API and queue use `UMask=0007` and the core's explicit shared-state mode for group-0660 SQLite/WAL/SHM; operations never races with chmod of live database files. It discards inherited operator environment variables. The API receives no Doppler access token, JEV/model credential, socket access, Docker access or administrator environment. Do not put secrets into the artifact or browser bundle.

The package prepares disabled `justup-preview-runner.service`, `justup-preview-model.socket` and `justup-preview-model.service` units, not a configured agent or tunnel. Root creates the mode-0660 socket under `/srv/justup_preview/broker` (root:justup-preview-model-client mode 0750). The broker inherits fd3 through an exec-preserving launcher, with no permission to bind/unlink that path. Only the trusted queue UID may connect; API is excluded. The model UID has no DB/API/JEV group; its unit hides state, API/queue configuration, private host paths and Docker sockets, denies loopback/private IP ranges except the host DNS stub, and permits writes only to bounded per-invocation/auth-refresh directories.

A root-owned read-only `model/config/broker.json` selects the reviewed immutable broker/Codex program and fixed configuration. `model/config/isolation-reviewed.json` is deliberately absent; its actual UID/tool/filesystem/credential/trace-retention attestation must be reviewed with the broker code before socket activation. A sanitized matching copy at `broker/isolation-reviewed.json` is root-owned, read-only and readable only by the queue client group. The installer seeds no model auth and starts no socket/service. The queue uses the bounded JSON-only protocol (intent/company schema, at most 24 KiB prompt, at most 60 seconds, one invocation globally), without forwarding raw provider traces. Its binaries, auth state, logs, work and tunnel must fit inside the same disk and aggregate slice ceilings. At most one model task may run. Subscription auth provisioning waits for actual host isolation proof, then uses the dedicated model UID's fresh device-auth flow. Do not run the agent as the API UID or root.

The artifact pins the official npm Linux ARM64 Codex 0.143.0 archive, its SHA512 registry integrity and each selected file digest. It retains the ELF64 little-endian AArch64 `bin/codex`, sandbox helper `codex-resources/bwrap`, native/package metadata and the exact official Apache license. The helper keeps its upstream relative layout. Disabled code-mode host, ripgrep and bundled zsh are omitted. Only `releases/<buildIdentity>/runtime/codex/bin/codex` may be selected by `broker.json`; the launcher rejects another root-owned executable or alternate auth/invocation/task directory. Full inventory hashing verifies its pinned bytes before startup. Actual credential-free Linux `--version`/`exec --help`, omitted-helper compatibility, strict-config/tool-catalogue, kernel/network and retention proofs remain activation gates. No on-host npm install, binary upgrade or operator-auth copy is a substitute.

## Configure the queue and cumulative matching allowance

Deliver `queue/config/runner.json` as root:justup-preview-runner mode 0640 beneath root-owned mode-0750 `queue/` and `queue/config/`. The queue UID cannot edit its configuration. It contains only the fixed adapter's JSON keys: `dbPath`, `sharedState`, `sourceCommit`, `buildIdentity`, `runnerStatusPath`, optional `verificationTtlMs`, `model`, `jev` and `matching`. Bind `dbPath` to `/srv/justup_preview/state/preview.sqlite`, `sharedState` to `true`, heartbeat to `state/runner-status.json` and identity to the active manifest. Model configuration may select only the fixed socket and queue-readable attestation paths above. Keep providers disabled until their real proofs pass. The launcher has a minimal environment and rejects caller-selected commands, modules or storage/model paths. No raw queue/provider output is retained.

Only `jev` contains the approved shared token. Confirm the actual account's model price and credit eligibility privately before enabling it; never publish its balance. The reviewed client requires `jev-1.14.0`, confirmed input price 42 nanodollars/token and output price zero, with a versioned pricing record and bounded account/project limits. Its `cumulativeBudget` must contain:

```json
{
  "path": "/srv/justup_preview/queue/budget/jev.jsonl",
  "excludedDirectories": ["/srv/justup_preview/state", "/srv/justup_preview/state/backups"],
  "approval": {
    "approved": true,
    "resourceId": "https://github.com/colophon-group/justup/issues/49",
    "resourceSlug": "demo-jev-evaluation-budget",
    "approvalId": "operator-user-turn:VERIFIED-HUMAN-TURN-UUID",
    "ledgerId": "REVIEWED-LEDGER-UUID",
    "capNanodollars": 500000000
  }
}
```

This example is deliberately incomplete and cannot activate JEV. Use the already verified human authorization record and a new ledger UUID; no new key/spending approval is requested. The operator prepares the exact compact approval header using the reviewed `unapprovedJevBudgetTemplate()` field set from `server/jev-budget.mjs`, filling its matching approval, model, confirmed pricing/version and cap. The header has no `approved` field; that flag belongs only in configuration. The first line is compact JSON with a single final newline. It contains anonymous approval/accounting metadata, never tokens, queries, job evidence or user IDs.

After reviewing that exact header and its digest, create the fixed ledger **exclusively** under the existing queue-owned mode-0700 `queue/budget/`, using `O_CREAT|O_EXCL|O_NOFOLLOW`, mode 0600, queue UID ownership, then fsync the file and directory. Refuse any existing ledger, hard link, symlink, lock or unexpected directory contents; never use an overwriting copy or initialization on service startup. Do this as a separate protected operator step, not during installation. The queue launcher's storage check and the client's complete header/hash-chain validation must both pass before any request. No script here initializes, resets or reconciles the ledger.

The initial cumulative allowance is at most $0.50, shared across all Justup users, process restarts and database restores. Every HTTP attempt—including retry or ambiguous failure—durably reserves the full 64,000-input-token ceiling first and never refunds it. Corruption, missing configuration, a retained crash lock, exhaustion or provider usage overrun disables matching. Preserve the ledger and any crash lock when restarting, restoring, rolling back or deleting an account; no automated stale-lock removal is permitted. Database backups contain only SQLite, never `queue/budget/`. Before final ledger/image disposal, remove Justup's token delivery and stop the queue; **do not revoke the shared Jobseek key**. The ledger itself contains no user state and does not follow account deletion or seven-day model-cache cleanup.

Frontend-owned Cloudflare routing must use the approved free allowance, fixed candidate frontend deployment and an exact API route to loopback 8787 through a bounded tunnel. Do not expose the host port publicly or touch the renderer's ingress. A temporary quick-tunnel address must be reported as temporary and fixed for the tested candidate; SSE stays unavailable. Missing tunnel configuration or unproven runner/provider readiness blocks the complete preview, and does not justify a paid substitute.

## Select and verify a candidate

After storage proof, approved configuration and compatible data/schema review, select the exact staged build. This stops only preview units and changes root-owned symlinks. It does not start public traffic:

```sh
systemd-run --unit=justup-preview-switch --collect --wait --pipe \
  --slice=justup-preview.slice \
  /usr/bin/python3 /srv/justup_preview/ops/preview-host.py switch \
  --build-identity "$JUSTUP_PREVIEW_BUILD_ID"
```

Import the reviewed public snapshot explicitly using the core's import command under the same API identity, allowlisted preview environment and resource slice. Do not inject a broad Doppler environment or reimplement the import. Its input stays inside the preview quota, is at most 64 MiB and contains only approved public fields. There is no production source write, automatic refresh schedule, billing or mail. Record its actual generation, verification time and sample source-link checks. The core suppresses old, stale and inactive listings; refresh/removal is an explicit reviewed operation.

Only after readiness/configuration review, enable the preview guard timer and start the API service. Do not mark it ready for public sharing yet. `/health` separates process state from runner readiness. `/version` must return the manifest's exact source commit, schema version and build identity, actual runner identity/readiness and import generation.

```sh
python3 scripts/preview-verify.py --base-url http://127.0.0.1:8787 \
  --manifest /private/evidence/manifest.json --mode process \
  --report /private/evidence/process-check.json

python3 scripts/preview-verify.py --base-url "$JUSTUP_PREVIEW_FIXED_ORIGIN" \
  --manifest /private/evidence/manifest.json --mode preview \
  --expected-runner-identity "$JUSTUP_PREVIEW_RUNNER_ID" \
  --expected-import-generation "$JUSTUP_PREVIEW_IMPORT_GENERATION" \
  --approved-policy-version "$JUSTUP_PREVIEW_POLICY_VERSION" \
  --frontend-release /private/artifacts/frontend/release.json \
  --report /private/evidence/http-preview-check.json
```

The first command is process evidence only. The second fails for mismatched builds, absent/unready runner, wrong import, unreviewed policies, stale coverage, missing required capabilities, cached/private guest responses, incorrect guest freshness or missing noindex. Neither is a green replacement for the complete release gate: reports always say `completeReleaseGate:false` and `shareable:false`. Frontend-owned deployed browser journeys, bounded real-provider/failure/rate-limit checks, resource observations and release-owner approval are still required. Record the retained compiled frontend release identity and API/runner digests together; mismatched source/tree or deployed frontend artifact hashes fail verification. A changed candidate or base needs new verification.

## Backups, deletion and restoration

The API's account retention/cleanup belongs to auth: sessions at most seven days and private accounts/state at most 30 days. Failed cleanup closes authentication availability. Model decisions need their own implemented seven-day cleanup. These settings must be verified against the actual integrated modules before policy approval.

Operations maintains at most two complete SQLite snapshots, each at most 256 MiB and at most seven days old; all are inside the same disk quota. Backups are explicit operator work, not a production schedule. Run recovery commands under the preview slice. Use the actual active manifest identity:

```sh
python3 /srv/justup_preview/ops/preview-recovery.py backup \
  --database /srv/justup_preview/state/preview.sqlite \
  --backup-dir /srv/justup_preview/state/backups \
  --generation /srv/justup_preview/state/private-generation \
  --source-commit "$JUSTUP_PREVIEW_COMMIT" --build-identity "$JUSTUP_PREVIEW_BUILD_ID"
```

SQLite's online backup API creates a consistent snapshot; copying the live WAL database with filesystem `cp` is not supported. A 30-second/page budget, integrity check, digest and before/after stable generation checks with an absent transaction-pending marker precede publication. Generation change discards the snapshot. Snapshots/metadata are flat regular files only, private and fsynced; oversized/expired/corrupt snapshots fail closed. Pruning runs after a successful backup or by the explicit `prune --backup-dir` command. Verify and prune before leaving a preview unattended; the guard does not silently create snapshots.

The core owns the transaction-aware deletion barrier. Before rotating the generation, it must exclusively create and fsync `state/private-generation.pending`, then rotate/fsync `state/private-generation` and purge/fsync all backup files. The pending marker must remain through the actual SQLite COMMIT or ROLLBACK; only the transaction owner clears and fsyncs it afterwards. Two UUID reads alone are insufficient: a concurrent SQLite reader can see old committed records after the UUID rotates but before deletion commits. Operations therefore reads generation, checks pending absence, rereads the same generation before starting a snapshot, and repeats that stable check afterwards. A retained marker after a crash blocks backup and restore until verified recovery; tooling never clears it automatically. This cross-module pending-marker protocol is a required core integration and activation blocker. Barrier failure rolls back private SQL deletion; a later SQL rollback may invalidate extra backups safely. Keep the live generation independent of backups. Missing/mismatched generations always block restoration. Never replace it with a value from a snapshot.

For a rehearsal or real recovery, stop API/runner writers, preserve the current generation and validate an exact snapshot with `check-restore`. Restore to a new `state/restored-<reviewed-name>.sqlite`; the CLI refuses an existing destination, unknown paths, running writers or arbitrary preparation commands:

```sh
python3 /srv/justup_preview/ops/preview-recovery.py restore \
  --snapshot /srv/justup_preview/state/backups/backup-EXACT-REVIEWED-NAME.sqlite \
  --generation /srv/justup_preview/state/private-generation \
  --destination /srv/justup_preview/state/restored-rehearsal.sqlite
```

The command uses the verified current artifact's `server/main.mjs --prepare-restored-db`. That calls the auth-owned synchronous session revocation helper and must return the schema/session-invalidated/zero-remaining-sessions receipt. Recovery tooling checks the live generation before and after preparation. It never guesses auth table names. Restore prepares a separate file and does not activate it. Rehearse that a pre-deletion backup is rejected, a valid snapshot restores private state, all old sessions are rejected and account/request deletion still works. Stop on a missing helper, receipt, incompatible schema or generation change. Moving a prepared database into the live path, clearing only the stopped preview's WAL sidecars and restarting is an explicit reviewed operator step; no live database is overwritten automatically.

Backup expiry is physical cleanup; private deletion additionally invalidates and purges snapshots immediately. On teardown, erase the preview image after the reviewed recovery/retention decision. Do not promise provider zero-retention: actual OpenAI/JEV configuration and recipients still require the privacy inventory.

## Observe, rollback and stop

The CLI API logs only request ID, category, status and duration. The launcher accepts bounded JSON and drops other/raw output. It preserves only allowlisted categories, HTTP status, bounded numbers and generated request IDs. It never stores query/body/password/token/IP/provider output. Logs are mode 0600, at most 8 MiB/day for seven days; the minute guard prunes expired files and enforces the aggregate budget. Global journald settings remain unchanged. Record source verification age, queue depth, model latency/cost, pauses/failures, and Cloudflare/host usage from the actual integrated instrumentation; absent instrumentation is a verification gap, not a zero metric.

A guard failure stops only the explicitly named preview API, runner, tunnel, model socket and model service units. Investigate the actual kernel limits, root reserve and preview quota. Do not clear unrelated caches, resize the quota, restart the renderer or increase the allocation as an automatic recovery action. The operator owns incident contact and policy review; those names/addresses remain missing until explicitly supplied.

For code rollback, retain the verified previous build and a usable deletion-safe backup. Stop preview writers, compare schema versions, select the exact retained build with `switch --build-identity`, then repeat readiness/identity/data/browser checks before reopening routing. A schema difference blocks the switch and requires separately reviewed recovery. Never restore an old snapshot merely to make old code start, overwrite the live deletion barrier or reactivate old sessions. A failed switch leaves the API stopped for inspection.

For teardown, use `--reviewed-plan-sha` with the exact installed marker identity. Remove the frontend candidate route with its owner, remove Justup's scoped runtime/model/tunnel access (do not revoke the shared Jobseek JEV key), preserve/reconcile its cumulative ledger until matching is stopped and access is removed, then run `preview-host.py teardown` in the slice. It disables the preview guard timer, stops only the named preview units and uses a normal unmount. It retains the mode-0600 image by default for an explicit recovery/retention decision. `teardown --erase-data` removes only the owned image, empty mountpoint, dedicated preview UIDs/groups and preview mount/service/socket/timer files after marker/backing validation. It refuses a busy unmount, mismatched/unsafe root-owned marker, nonprivate or aliased image, incorrect backing/mount/filesystem/options or unexpected mountpoint content. Only teardown's internal cleanup validation permits lost physical reservation so an owned sparse image can be normally unmounted and removed; proof, guard, install, stage and switch retain the strict allocation check. There is no general bypass flag. It never uses forced/lazy unmount or wildcard cleanup. The small slice file is retained so the teardown process stays bounded; after it exits, the operator may stop/remove that specifically reviewed slice and reload systemd. Confirm released disk space and unchanged protected-renderer health.

No service in this package sends production mail, accepts billing, starts crawler onboarding or changes production schedules. Keep the complete runtime-to-`main` block until the real fixed frontend/API/runner release gate passes.

References: [systemd aggregate resource controls](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html), [systemd execution sandbox](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html), [official pinned Node checksums](https://nodejs.org/download/release/v24.22.2/SHASUMS256.txt), [OpenAI CLI installation guide](https://learn.chatgpt.com/docs/codex/cli), [pinned official Codex license](https://github.com/openai/codex/blob/rust-v0.143.0/LICENSE).
