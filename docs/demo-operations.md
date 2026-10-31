---
summary: Prepare the bounded demo API host, verify fixed bytes and recover without restoring deleted private data.
read_when: Reviewing the demo installer, configuring runtime access, deploying an exact candidate or stopping the preview.
---

# Demo operations

This is a prepared deployment contract, not evidence that a preview is running. The host allocation, actual namespace/cgroup proofs, credential delivery, model isolation, public routing and browser release verification remain required. Runtime promotion to `main` stays blocked by the existing release policy.

The implementation is limited to the approved former Murmur ARM64 machine and Cloudflare free allowance. It preserves the production `jobseek-lightpanda-renderer`, TCP 9443, existing containers, services, provider labels and `/mnt/murmur`. Renderer relocation is not a dependency and is not authorized by this runbook. Do not reclaim its capacity. Use the private host audit to select the one target; public reports contain no host IP or credential values.

## Review before applying

The installer binds its plan to the reviewed host's SHA256 of `/etc/machine-id`, exact hostname, script/unit bytes and fixed paths. The expected fingerprint is private operational input, not a discovered alternative host. An edited script or unit changes the plan digest and requires a new review. Root performs a short installation step; the API and any model execution remain unprivileged.

1. Read [the development process](development-process.md) and [credential guide](secrets.md). Review `scripts/preview-host.py`, `scripts/preview-artifact.py`, `scripts/preview-run.py`, `scripts/preview-recovery.py`, `scripts/preview-verify.py` and [the unit files](../deploy/justup-preview/README.md).
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

These are the concrete root commands for the reviewed files. They have not been applied. Use the documented SSH deploy identity and strict host-key checking; keep the target address in the private operator environment.

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

The first command installs only the new slice. The second must observe that slice's real kernel controls before allocating anything. It refuses existing image, mount, UID or unit paths. It exclusively creates `/var/lib/justup-preview.disk`, preallocates exactly 2 GiB, formats only that newly created regular file and mounts it at `/srv/justup_preview`. It requires at least 8 GiB free on root after allocation. It creates the dedicated API UID with no login shell or supplementary groups, installs immutable operational scripts and seeds the live UUID deletion generation. It starts no API, runner or tunnel and enables no timer.

| Resource | Aggregate boundary and proof |
| --- | --- |
| CPU | `CPUQuota=50%`, `CPUWeight=10`; read back `cpu.max` and `cpu.weight` in the parent slice. |
| Memory | `MemoryHigh=768M`, `MemoryMax=1G`, `MemorySwapMax=0`; read back kernel values. |
| Processes | `TasksMax=96` including threads; API UID additionally has `LimitNPROC=64`. |
| Disk | New preallocated 2 GiB loop filesystem; verify exact backing file/mount/options and rejected over-limit allocation. |
| Reserve | Root retains at least 8 GiB; preview retains at least 64 MiB. Refuse work and stop preview units if a minute guard fails. |
| Work | `/srv/justup_preview/state/work` at most 512 MiB, included in the hard 2 GiB total. |
| Diagnostics | Seven days; API at most 8 MiB per day, aggregate preview diagnostics at most 128 MiB, included in the image. |
| Model use | One task in flight; model runner/tool/credential isolation must be reviewed separately before activation. |

Run the independent proof under the same slice and save its JSON privately:

```sh
systemd-run --unit=justup-preview-proof --collect --wait --pipe \
  --slice=justup-preview.slice \
  /usr/bin/python3 /srv/justup_preview/ops/preview-host.py prove
```

Check the installed units with target-host `systemd-analyze verify` and inspect effective sandbox properties. The metadata checks do not establish that unsupported kernel/systemd features work. Verify the API UID cannot open Docker sockets, administrator/renderer paths or write application bytes. Prove that all preview child processes remain in the one slice. Record the protected renderer's health before and after this work. If installation fails partway, stop and inspect only the newly created paths; the installer deliberately does not overwrite or format them on retry.

## Build and stage fixed bytes

Download the official Node archive off-host from the URL in [runtime.json](../deploy/justup-preview/runtime.json). The builder rejects a different SHA256; it does not compile Node or install packages. Build from a full commit OID containing the complete API/auth modules:

```sh
python3 scripts/preview-artifact.py build \
  --source-root /candidate/checkout --commit "$JUSTUP_PREVIEW_COMMIT" \
  --node-archive /private/artifacts/node-v24.22.2-linux-arm64.tar.xz \
  --output /private/artifacts/justup-preview.tar
```

Save the output's source commit/tree, `buildIdentity` and `bundleSha256`. The manifest covers every application/runtime file; `buildIdentity` hashes the canonical manifest inventory. Copy the already tested bundle to the reviewed host, then stage it inside the capped slice:

```sh
systemd-run --unit=justup-preview-stage --collect --wait --pipe \
  --slice=justup-preview.slice \
  /usr/bin/python3 /srv/justup_preview/ops/preview-host.py stage \
  --bundle /private/staging/justup-preview.tar --sha256 "$JUSTUP_PREVIEW_BUNDLE_SHA"
```

Staging verifies the bundle digest, safe regular-file inventory, exact Node version/platform and all file hashes. It creates a root-owned read-only `releases/<buildIdentity>` directory without starting it. Keep at most two release directories. It refuses another candidate if those slots or quota headroom are unavailable; review cleanup of a specifically identified inactive build instead of deleting broadly.

## Deliver scoped API configuration

Use a separate read-only service token for the chosen preview configuration in `justup-runtime`, with an explicit key allowlist and Doppler `--no-fallback`. No usable local Doppler token or model subscription identity was found during preparation. The operator must establish the intended source; do not copy production env files, owner/admin/dormant/quarantine values or another person's Codex authentication.

Provision `/srv/justup_preview/config/api.json` as a regular mode-0600 file owned by the API UID. Protect its transfer and do not print its contents. The launcher rejects any key outside this list:

| Setting | Purpose |
| --- | --- |
| `JUSTUP_DEMO_ORIGIN` | Exact frontend HTTPS origin; browser calls stay same-origin `/api/v1`. |
| `JUSTUP_DEMO_CSRF_SECRET`, `JUSTUP_DEMO_CURSOR_SECRET` | Separate stable random preview secrets of at least 32 bytes. |
| `JUSTUP_DEMO_INVITE_CODE` | Optional preview-only invite; omit until registration is approved. |
| `JUSTUP_DEMO_POLICIES_REVIEWED` | Defaults to `false`; only `true` after approval of the actual pages. |
| `JUSTUP_DEMO_PRIVACY_URL`, `JUSTUP_DEMO_USAGE_URL`, `JUSTUP_DEMO_POLICY_VERSION` | Approved static HTTPS page identities/version. |

The launcher fixes port 8787, preview SQLite/work/backup/generation paths, source commit and build identity itself. It discards inherited operator environment variables. The API receives no Doppler access token, model credential, Docker access or administrator environment. Do not put secrets into the artifact or browser bundle.

This package does not install a model agent or a tunnel. A runner must use a different unprivileged identity and a reviewed projected workspace/IPC boundary so its tools cannot read the API database, API secrets, private host paths or production services. Its binaries, auth state, logs, work and tunnel must fit inside the same disk and aggregate slice ceilings. At most one model task may run. Subscription auth provisioning waits for review of that isolation and its credential source. Do not run the agent as the API UID or root.

Frontend-owned Cloudflare routing must use the approved free allowance, fixed candidate frontend deployment and an exact API route to loopback 8787 through a bounded tunnel. Do not expose the host port publicly or touch the renderer's ingress. A temporary quick-tunnel address must be reported as temporary and fixed for the tested candidate; SSE stays unavailable. Missing tunnel/runner implementation blocks the complete preview, and does not justify a paid substitute.

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
  --report /private/evidence/http-preview-check.json
```

The first command is process evidence only. The second fails for mismatched builds, absent/unready runner, wrong import, unreviewed policies, stale coverage, missing required capabilities, cached/private guest responses, incorrect guest freshness or missing noindex. Neither is a green replacement for the complete release gate: reports always say `completeReleaseGate:false` and `shareable:false`. Frontend-owned deployed browser journeys, bounded real-provider/failure/rate-limit checks, resource observations and release-owner approval are still required. Record frontend deployment/asset identity and API/runner digests together. A changed candidate or base needs new verification.

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

SQLite's online backup API creates a consistent snapshot; copying the live WAL database with filesystem `cp` is not supported. A 30-second/page budget, integrity check, digest and before/after live generation checks precede publication. Generation change discards the snapshot. Snapshots/metadata are flat regular files only, private and fsynced; oversized/expired/corrupt snapshots fail closed. Pruning runs after a successful backup or by the explicit `prune --backup-dir` command. Verify and prune before leaving a preview unattended; the guard does not silently create snapshots.

The core owns the synchronous deletion barrier. Before an account/search/request deletion commits, it rotates/fsyncs `state/private-generation` and purges/fsyncs all backup files. Barrier failure rolls back the private SQL deletion; a later SQL rollback may invalidate extra backups safely. Keep this live generation independent of backups. Missing/mismatched generations always block restoration. Never replace it with a value from a snapshot.

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

A guard failure stops only `justup-preview-api.service`, `justup-preview-runner.service` and `justup-preview-tunnel.service`. Investigate the actual kernel limits, root reserve and preview quota. Do not clear unrelated caches, resize the quota, restart the renderer or increase the allocation as an automatic recovery action. The operator owns incident contact and policy review; those names/addresses remain missing until explicitly supplied.

For code rollback, retain the verified previous build and a usable deletion-safe backup. Stop preview writers, compare schema versions, select the exact retained build with `switch --build-identity`, then repeat readiness/identity/data/browser checks before reopening routing. A schema difference blocks the switch and requires separately reviewed recovery. Never restore an old snapshot merely to make old code start, overwrite the live deletion barrier or reactivate old sessions. A failed switch leaves the API stopped for inspection.

For teardown, remove the frontend candidate route with its owner, revoke only preview-scoped runtime/model/tunnel access, then run `preview-host.py teardown` in the slice. It disables the preview guard timer, stops only the named preview units and uses a normal unmount. It retains the mode-0600 image by default for an explicit recovery/retention decision. `teardown --erase-data` removes only the owned image, empty mountpoint, dedicated API UID and preview mount/service/timer files after marker/backing validation. It refuses a busy unmount, ambiguous marker or unexpected mountpoint content. It never uses forced/lazy unmount or wildcard cleanup. The small slice file is retained so the teardown process stays bounded; after it exits, the operator may stop/remove that specifically reviewed slice and reload systemd. Confirm released disk space and unchanged protected-renderer health.

No service in this package sends production mail, accepts billing, starts crawler onboarding or changes production schedules. Keep the complete runtime-to-`main` block until the real fixed frontend/API/runner release gate passes.

References: [systemd aggregate resource controls](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html), [systemd execution sandbox](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html), [official pinned Node checksums](https://nodejs.org/download/release/v24.22.2/SHASUMS256.txt).
