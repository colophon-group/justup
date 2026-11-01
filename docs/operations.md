---
summary: Configure the Justup runtime, verify a candidate and recover durable state within the reviewed deployment boundary.
read_when: Reviewing host changes, configuring access or schedules, verifying a release, backing up or recovering the service.
---

# Justup operations

Justup uses one product API, queue and data model through preview and wider release. [Accounts](auth.md), [API](api.md), [job ingestion](job-data.md), [models](models.md) and [matching](matching.md) define its runtime contracts. Invitation admission, account caps, optional account deadlines, schedules, provider budgets and frontend deployment mode are explicit settings; changing audience does not replace the application or reset stored identity.

Before first invited activation, prove native tool/UID/network/retention boundaries, reviewed policies, representative load, real source history and the complete deployed release gate on the exact candidate. Local tests establish contracts only. Subscription authentication belongs solely in the dedicated model UID’s private home; do not copy, inspect or reinstall it during a code update. Current service status, approval identities and host receipts belong in protected operator notes.

The fixed deployment preserves the production Jobseek renderer, its network endpoint, existing containers/services/provider labels and protected mounts. The exact incumbent names and paths belong in the private host review. All host actions require the reviewed host identity and current installation record. This guide supplies no provider or host authorization. Follow the [development and release guide](development-process.md), [deployment plan](deployment-plan.md) and [frontend delivery guide](frontend-delivery.md).

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

These are the concrete root commands for an absent installation using the exact reviewed files. Do not rerun them over an allocated installation; use its current evidence and the scripts-only upgrade procedure below. Use the documented SSH deploy identity and strict host-key checking; keep the target address in the private operator environment.

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

The current private-auth-bearing installation must use `upgrade-ops`; these install commands apply only to a genuinely absent allocation after a separate review. The first command installs only the new slice. The second must observe that slice's real kernel controls before allocating anything. It refuses existing image, mount, UID or unit paths. It exclusively creates `/var/lib/justup-preview.disk`, preallocates exactly 2 GiB, formats only that newly created regular file with `mkfs.ext4 -E nodiscard,lazy_itable_init=0,lazy_journal_init=0`, verifies physical allocation remains at least its logical size and mounts it at `/srv/justup_preview` with online discard disabled. It requires at least 8 GiB free on root after allocation. It creates dedicated API, queue and model UIDs with no login shells. Only API and queue join `justup-preview-state`; only queue joins `justup-preview-model-client`; model joins neither. It prepares root-controlled broker/config directories, queue-private work and empty budget directories, installs immutable operational scripts and seeds the live UUID deletion generation. It creates no budget header, secrets, broker attestation or subscription authentication. It starts no API, runner or tunnel and enables no timer.

| Resource | Aggregate boundary and proof |
| --- | --- |
| CPU | `CPUQuota=50%`, `CPUWeight=10`; read back `cpu.max` and `cpu.weight` in the parent slice. |
| Memory | `MemoryHigh=768M`, `MemoryMax=1G`, `MemorySwapMax=0`; read back kernel values. |
| Processes | `TasksMax=96` including threads; API UID additionally has `LimitNPROC=64`. |
| Disk | New physically preallocated 2 GiB loop filesystem: `st_blocks * 512 >= st_size == 2147483648`. Finish inode-table/journal initialization before mount and disable discard; verify backing/mount/options and rejected over-limit allocation. |
| Reserve | Root retains at least 8 GiB; preview retains at least 64 MiB. Refuse work and stop preview units if a minute guard fails. |
| Work | API work, queue work and model invocation/auth-refresh directories together at most 512 MiB, included in the hard 2 GiB total. |
| Diagnostics | Seven days; API at most 8 MiB per day, aggregate preview diagnostics at most 128 MiB, included in the image. |
| Model use | One task in flight; model runner/tool/credential isolation must be reviewed separately before activation. |

Systemd slice names are hierarchical: resolve the live `ControlGroup` (or `/proc/self/cgroup`) rather than hardcoding `/justup-preview.slice`; the current parent is `/justup.slice/justup-preview.slice`. Run the independent proof under that same aggregate slice and save its JSON privately:

```sh
systemd-run --unit=justup-preview-proof --collect --wait --pipe \
  --slice=justup-preview.slice \
  /usr/bin/python3 /srv/justup_preview/ops/preview-host.py prove
```

After the mount and independent proof, record allocated blocks immediately and around 30, 60 and 120 seconds after mount, including after the proof file is created/unlinked and units are verified. Every sample must retain allocated bytes at least equal to the logical 2 GiB size; use bounded waits of at most 60 seconds and preserve timestamps. An immediate pass alone is insufficient. Every storage/guard check verifies actual allocated blocks, not only logical file size. Formatting completes inode-table and journal zeroing synchronously; late zero/unmap work must not reduce the reservation. External trim/hole-punching stops the preview; tooling never reallocates automatically. The existing host trim timer was inspected read-only: its first nonempty fstab list excludes this systemd-only preview mount. Do not change global trim services or add a preview fstab entry without reviewing that behavior. Manual trimming of the preview filesystem can release its physical reservation even with online discard disabled.

Check the installed units with target-host `systemd-analyze verify` and inspect effective sandbox properties. The metadata checks do not establish that unsupported kernel/systemd features work. Verify the API UID cannot open Docker sockets, administrator/renderer paths or write application bytes. Prove that all preview child processes remain in the one slice. Record the protected renderer's health before and after this work. If installation fails partway, stop and inspect only the newly created paths; the installer deliberately does not overwrite or format them on retry.

## Update installed operator scripts without replacing the boundary

Use `upgrade-ops` only for reviewed changes to the existing `preview-*.py` script set. It preserves the image, mount, caps, unit definitions, UIDs, application releases, current/previous links, database, deletion generation, configuration, authentication and cumulative ledger. It cannot add operator paths, change units or native pins, or widen the resource plan. A change to those boundaries needs a separately reviewed procedure. Do not use empty-boundary teardown/reinstallation after private state or authentication exists.

Retain the complete previous plan JSON from the approved source, and render the new plan from the exact integrated source using the same private machine fingerprint. Review both digests and the full changed script bytes. Stage the new plan's files and the previous JSON in a canonical root-owned protected directory. The command requires the old receipt and every old installed script/unit hash to match; a familiar plan label alone is insufficient. Run the **new reviewed source tool**, with both explicit plan identities, inside the existing slice:

```sh
systemd-run --unit=justup-preview-upgrade-ops --collect --wait --pipe \
  --slice=justup-preview.slice --setenv=PYTHONDONTWRITEBYTECODE=1 \
  /usr/bin/python3 /reviewed/new-source/scripts/preview-host.py upgrade-ops \
  --source-root /reviewed/new-source \
  --previous-plan /private/review/previous-plan.json \
  --previous-plan-sha "$JUSTUP_PREVIEW_INSTALLED_PLAN_SHA" \
  --reviewed-plan-sha "$JUSTUP_PREVIEW_PLAN_SHA" \
  --host-machine-sha "$JUSTUP_PREVIEW_MACHINE_SHA"
```

The update stops only named preview services and its guard timer/service, then refuses any remaining process under the three dedicated UIDs. It prepares a complete replacement directory and retains the old plans, receipt and operator directory beneath root-private `.preview-ops-updates/`. Before moving any installed script, it withdraws the live receipt. It swaps complete directories, verifies all new script hashes/read-only modes and unchanged unit hashes, checks storage/caps again, then exclusively publishes the new receipt. The pending lock blocks the common runtime reader and other operator mutations until qualification finishes. No unit is started or enabled.

Ordinary failure restores the complete verified old directory before restoring the old receipt. A crash, failed rollback or conflicting receipt leaves adoption blocked by an absent receipt or retained pending lock; tooling never overwrites another receipt or clears a stale lock automatically. Preserve the transaction directory and stop for an explicit recovery review. Reconcile exact old/new hashes, unit states, caps and backing image before restoring a receipt or clearing the owned lock. Never use an edited receipt, reinstall or credential deletion to make the check pass.

After success, record the new plan identity, re-read every installed hash and actual unit restrictions, and repeat affected native/UID/catalogue/retention checks. Existing attestations bound to the previous plan cannot authorize the updated candidate. Releases containing `model-runner.mjs` now require immutable `server/model-catalogue.json`; older model artifacts without it are rejected and are not deployable rollback candidates. Build the compatible new artifact before selecting or starting anything.

## Build and stage fixed bytes

Download the official Node archive and exact npm native Codex 0.159.2 Linux ARM64 archive off-host from the URLs in [runtime.json](../deploy/justup-preview/runtime.json). The builder checks their SHA256 pins and Codex's registry SHA512 integrity; it does not compile Node/Codex or install packages. Build from a full commit OID containing the complete backend modules and checked-in official Codex license:

```sh
python3 scripts/preview-artifact.py build \
  --source-root /candidate/checkout --commit "$JUSTUP_PREVIEW_COMMIT" \
  --node-archive /private/artifacts/node-v24.22.2-linux-arm64.tar.xz \
  --codex-archive /private/artifacts/codex-0.159.2-linux-arm64.tgz \
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

This is a backend artifact only: server modules, the required immutable `server/model-catalogue.json`, their checked-in model schemas (intent, final company and private company discovery), the canonical `scripts/import-jobs.py`, `server/composition.mjs` and `server/runner-adapter.mjs`, Node and the pinned native Codex distribution. The catalogue follows the same root-owned mode-0444, complete-inventory and digest checks as other non-executable assets; a model runtime missing that exact asset fails verification. It rejects frontend source, built assets, application package manifests, `node_modules` and frontend build tools. The frontend owner separately builds the exact same commit's `web/` React application using `scripts/frontend-prepare.mjs` in an unprivileged, credential-free builder, retaining `assets/`, `worker.mjs` and `release.json`. Deploy those bytes through the frontend tool; do not run npm, TypeScript, Vite or browser tests on the capped host. Save both manifests together. The HTTP preview verifier requires the retained frontend's source/tree to match the backend, then checks `/__release/version` for its compiled asset/worker/artifact identities, explicit `deploymentMode:preview`, `/api/v1` prefix and exact runtime configuration digest. The environment-neutral `release.json` has no mode; retain the separately generated `wrangler.json` and pass both files to the verifier. The frontend's own smoke suite additionally verifies every deployed asset byte.

## Deliver scoped API configuration

Use a separate read-only service token for the chosen preview configuration in `justup-runtime`, with an explicit key allowlist and Doppler `--no-fallback`. Available operator access does not establish the preview's key selection or protected delivery. Do not copy broad production env files or administration/quarantine configuration into a process. The human explicitly approved reuse of the existing Jobseek TypeSafe key under its existing monthly allowance; deliver only that one approved value to the queue, without creating a key or topping up the account. No API or Codex broker receives it. A fresh dedicated model-UID device-auth login is required for Codex; never copy local operator or Jobseek production auth to the host.

Provision `/srv/justup_preview/config/api.json` as a regular mode-0600 file owned by the API UID. Protect its transfer and do not print its contents. The launcher rejects any key outside this list:

| Setting | Purpose |
| --- | --- |
| `JUSTUP_ORIGIN` | Exact frontend HTTPS origin; browser calls stay same-origin `/api/v1`. |
| `JUSTUP_CSRF_SECRET`, `JUSTUP_CURSOR_SECRET` | Separate stable random preview secrets of at least 32 bytes. |
| `JUSTUP_REQUIRES_INVITATION`, `JUSTUP_INVITE_CODE` | Admission defaults to invitation required. Set `false` for reviewed public registration; this does not change existing accounts. |
| `JUSTUP_MAX_ACCOUNTS` | Safe default 30; a positive integer or `none` for an explicitly unbounded deployment. |
| `JUSTUP_SESSION_TTL_MS` | Positive milliseconds; seven days by default, independent of account lifetime. |
| `JUSTUP_ACCOUNT_TTL_MS`, `JUSTUP_ACCOUNT_EXPIRES_AT` | Optional positive milliseconds (duration/UTC epoch) or `none`. Stored only on new accounts; omission leaves accounts durable. |
| `JUSTUP_POLICIES_REVIEWED` | Defaults to `false`; only `true` after approval of the actual pages. |
| `JUSTUP_PRIVACY_URL`, `JUSTUP_USAGE_URL`, `JUSTUP_POLICY_VERSION` | Legacy English-only approved static HTTPS page identities/version on the frontend origin. |
| `JUSTUP_POLICY_LOCALES`, `JUSTUP_POLICY_FALLBACKS`, `JUSTUP_POLICY_ASSET_PROOF` | Exact fixed-locale identities, explicit fallbacks and operator-reviewed retained page hashes bound to origin/candidate; see [processing admission](processing-admission.md). Non-English admission needs its asset proof plus the independent global and per-locale review flags. |
| `JUSTUP_SERVICES_ENABLED` | Defaults to `false`; `true` selects the fixed reviewed intent/company/matching composition, never an arbitrary module path. |

The launcher fixes port 8787, shared SQLite mode, heartbeat/work/backup/generation paths, source commit and build identity itself. API and queue use `UMask=0007` and the core's explicit shared-state mode for group-0660 SQLite/WAL/SHM; operations never races with chmod of live database files. It discards inherited operator environment variables. The API receives no Doppler access token, JEV/model credential, socket access, Docker access or administrator environment. Do not put secrets into the artifact or browser bundle.

The package prepares disabled `justup-preview-runner.service`, `justup-preview-model.socket` and `justup-preview-model.service` units, not a configured agent or tunnel. Root creates the mode-0660 socket under `/srv/justup_preview/broker` (root:justup-preview-model-client mode 0750). The broker inherits fd3 through an exec-preserving launcher, with no permission to bind/unlink that path. Only the trusted queue UID may connect; API is excluded. The model UID has no DB/API/JEV group; its unit hides state, API/queue configuration, private host paths and Docker sockets, denies loopback/private IP ranges except the host DNS stub, and permits writes only to bounded per-invocation/auth-refresh directories.

A root-owned read-only `model/config/broker.json` selects `enabled`, the pinned `cliVersion`, immutable `codexPath`, `protectedAuthHome`, `invocationRoot`, empty `taskCwd` and optional fixed `hiringWire` configuration below. All paths are fixed by the launcher. Root-reviewed `model/config/isolation-reviewed.json` and its queue-readable sanitized copy at `broker/isolation-reviewed.json` must bind the current `buildIdentity` and installed `hostPlanSha256`. No attestation is created by installation. Startup derives `JUSTUP_SOURCE_COMMIT`, `JUSTUP_BUILD_ID` and `JUSTUP_HOST_PLAN_SHA256` from the verified manifest/root receipt; operator JSON cannot override them.

The Luna task profiles qualify independently. `search_intent` has no native tools. `company_resolution` permits bounded native `web.run` discovery followed by trusted official-page grounding. Each configured/attested profile binds its own `toolPolicySha256` and the immutable catalogue digest; company research also requires `companyResearchVerified:true`. Evidence identifies either `supported_static_policy` with `actualWireObserved:false` and the pinned Codex source, or separately reviewed `actual_wire` with `actualWireObserved:true`, exact native tool names and observed catalogue digest. Static policy evidence must not claim a capture. The empty intent catalogue cannot qualify company web access. See [model qualification](models.md) for the exact profile hashes, schemas and native tool-start accounting.

Codex stays pinned to official 0.159.2 Linux ARM64 and Node to 24.22.2. The complete manifest retains the exact executables, sandbox helper, metadata and license; disabled code-mode, ripgrep and bundled zsh are omitted. Builds and dependency installation run off-host. Target Linux version/help, omitted-helper compatibility, supported configuration, actual UID/filesystem/network boundaries and trace cleanup must pass for the exact integrated artifact. The model UID gets only its fresh scoped subscription authentication; API/queue/operator auth is never copied. Each invocation gets an auth-only temporary home and empty task directory. Wire requires proved native exit before auth-refresh copyback, disposal and shared-slot release. Broker startup rejects any nonempty invocation root for Luna and Wire; it preserves private recovery bytes instead of automatically deleting them. The fixed aggregate limit is one model task, including editorial work. Weekly Sol reuses this bounded runner and private execution boundary without another persistent agent service.

The fixed API composes only published Wire reads from its database and clock. The queue composes the protected source reader, editorial dispatcher and independently qualified Sol transport. Optional `hiringWire` is absent, exactly `{enabled:false}`, or exactly `{enabled:true,attestationPath,providerCatalogueSha256,modelUid,socketPath}`. The private proof is `/srv/justup_preview/model/config/hiring-wire-reviewed.json`; its queue-readable sanitized copy is `/srv/justup_preview/broker/hiring-wire-reviewed.json`. The socket remains `/srv/justup_preview/broker/model.sock`, and `modelUid` must name the existing dedicated model UID. Enabled configuration requires the complete Wire graph, integration/source modules and pinned Sol catalogue in the exact artifact. Both launchers require an independent root-owned immutable bounded proof with protected root-owned ancestors, matching this build/host, actual observed provider catalogue, fixed tools/descriptor and reviewed isolation, retention, quality and shared-slot evidence. A Luna proof or an enabled flag cannot qualify Wire; see [the runtime contract](hiring-wire-runtime.md).

Optional queue-only `sourceCoverage` is exactly `{directory,sourceVersion}`, explicitly selecting `jobseek-coverage-v1` or `jobseek-coverage-v2`; [source version and public-link validation](source-coverage.md) never fall back to another version. The normalized absolute directory must be outside shared state and backups, in dedicated root-owned non-group-writable storage readable by the queue (directory `0750`, immutable per-period artifact `0640`). The fixed reader validates all ancestors and chooses the Monday period's artifact itself. No API or model receives this source path. The concrete directory and its provisioning remain separate review work; no path, source artifact, credential or service is created here. Omitted source or missing qualification leaves Wire unavailable and makes no native call. A producer and provable complete fourteen-day history remain required; this code supplies neither inferred continuity nor a fabricated edition.

The existing runner owns the Monday 00:00 UTC tick, durable period identity and bounded dependency retry. Every non-Wire kind claims first, and foreground arrival cooperatively aborts in-flight editorial work. Only a proved cleanup acknowledgement allows lease-token pause/requeue. `cleanup_unproven` retains the private invocation/busy slot and inserts a singleton durable queue halt; readiness becomes unavailable and no claim, recovery or tick proceeds across restart or lease expiry. Stop the runner and broker, obtain reviewed native-idle and invocation-cleanup proof, handle retained refresh state privately and promptly clean retained files within the approved retention boundary, then use one reviewed transaction to fail the held task with `task_interrupted` and delete the guard before restart. No public or automatic clear exists. Never copy retained private bytes into logs, worktrees or review artifacts. See [the integration/recovery contract](hiring-wire-integration.md).

## Configure the queue and cumulative matching allowance

Deliver `queue/config/runner.json` as root:justup-preview-runner mode 0640 beneath root-owned mode-0750 `queue/` and `queue/config/`. The queue UID cannot edit its configuration. It contains only the fixed adapter's JSON keys: `dbPath`, `sharedState`, `runnerStatusPath`, optional `verificationTtlMs`, `model`, `jev`, `matching`, `hiringWire` and `sourceCoverage`. Bind `dbPath` to `/srv/justup_preview/state/preview.sqlite`, `sharedState` to `true` and heartbeat to `state/runner-status.json`. Source/build/host-plan identities come only from the trusted startup environment; top-level or nested identity fields in this JSON are rejected. Model configuration may select only the fixed socket and queue-readable attestation paths above. Keep providers disabled until their real proofs pass. The launcher has a minimal environment and rejects caller-selected commands, modules or provider paths. No raw queue/provider output is retained.

Only `jev` contains the approved shared token. Confirm the actual account's model price and credit eligibility privately before enabling it; never publish its balance. The reviewed client requires `jev-1.14.0`, confirmed input price 42 nanodollars/token and output price zero, with a versioned pricing record and bounded account/project limits. Its `cumulativeBudget` must contain:

Use the exact `cumulativeBudget` shape in [matching operations](matching.md), with fixed ledger path `/srv/justup_preview/queue/budget/jev.jsonl` and excluded directories `/srv/justup_preview/state` and `/srv/justup_preview/state/backups`. New configuration defaults to `identityProfile:canonical-v1`, selecting `resourceSlug:jev-evaluation-budget`. An existing historical ledger requires explicit `identityProfile:legacy-v1` and its exact `resourceSlug:demo-jev-evaluation-budget`. Both bind the same fixed resource record and unchanged approval, ledger UUID, model, confirmed pricing and $0.50 ceiling. The launcher checks the selected configuration identity and reads the existing first header without modifying it; the runtime validates the full original header and reservation chain. Never relabel or rewrite an existing ledger prefix, mix a canonical configuration with a legacy header, or replace the ledger to resume spending.

Use the verified human authorization record. For an existing ledger, preserve its UUID and every reservation; do not initialize a replacement ledger. The operator prepares the exact compact approval header using the reviewed `unapprovedJevBudgetTemplate()` field set from `server/jev-budget.mjs`, filling its matching approval, model, confirmed pricing/version and cap. The header has no `approved` field; that flag belongs only in configuration. The first line is compact JSON with a single final newline. It contains anonymous approval/accounting metadata, never tokens, queries, job evidence or user IDs.

After reviewing that exact header and its digest, create the fixed ledger **exclusively** under the existing queue-owned mode-0700 `queue/budget/`, using `O_CREAT|O_EXCL|O_NOFOLLOW`, mode 0600, queue UID ownership, then fsync the file and directory. Refuse any existing ledger, hard link, symlink, lock or unexpected directory contents; never use an overwriting copy or initialization on service startup. Do this as a separate protected operator step, not during installation. The queue launcher's storage check and the client's complete header/hash-chain validation must both pass before any request. No script here initializes, resets or reconciles the ledger.

The initial cumulative allowance is at most $0.50, shared across all Justup users, process restarts and database restores. Every HTTP attempt—including retry or ambiguous failure—durably reserves the full 64,000-input-token ceiling first and never refunds it. Corruption, missing configuration, a retained crash lock, exhaustion or provider usage overrun disables matching. Preserve the ledger and any crash lock when restarting, restoring, rolling back or deleting an account; no automated stale-lock removal is permitted. Database backups contain only SQLite, never `queue/budget/`. Before final ledger/image disposal, remove Justup's token delivery and stop the queue; **do not revoke the shared Jobseek key**. The ledger itself contains no user state and does not follow account deletion or seven-day model-cache cleanup.

Frontend-owned Cloudflare routing must use the approved free allowance, fixed candidate frontend deployment and an exact API route to loopback 8787 through a bounded tunnel. Do not expose the host port publicly or touch the renderer's ingress. The selected transport must support SSE. Accountless Cloudflare Quick Tunnels do not support SSE and cannot serve the first-release transport contract. Any temporary candidate origin still needs fixed routing and actual SSE header, first-event/reconnect latency, access and buffering evidence. Changing tunnel/provider configuration requires its own reviewed action; this guide activates none. Missing tunnel configuration or unproven runner/provider readiness blocks the complete preview, and does not justify a paid substitute.

## Select and verify a candidate

The application database and artifact epoch is 2. Fresh empty storage initializes it directly. Existing epoch-1 storage requires the explicit stopped-writer [schema migration](schema.md) against the exact staged target before selecting it. Keep current protected operator tools installed independently of the selected application release; API/queue launchers inspect the actual database epoch before executing application code.

After storage proof, approved configuration and compatible data/schema review, select the exact staged build. This stops only preview units and changes root-owned symlinks. It does not start public traffic:

```sh
systemd-run --unit=justup-preview-switch --collect --wait --pipe \
  --slice=justup-preview.slice \
  /usr/bin/python3 /srv/justup_preview/ops/preview-host.py switch \
  --build-identity "$JUSTUP_PREVIEW_BUILD_ID"
```

Import the reviewed public snapshot explicitly using the core's import command under the same API identity, allowlisted preview environment and resource slice. Do not inject a broad Doppler environment or reimplement the import. Its input stays inside the preview quota, is at most 64 MiB and contains only approved public fields. Record its actual generation, verification time and sample source-link checks. The core suppresses old, stale and inactive listings. Refresh is the same importer with `--previous` plus explicit import of the completed new snapshot; a failed transfer must preserve prior state and surface stale coverage. A one-time import is insufficient for release; see the schedule and observation contract below.

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
  --frontend-config /private/artifacts/frontend/wrangler.json \
  --policy-asset-proof /private/evidence/reviewed-policy-assets.json \
  --report /private/evidence/http-preview-check.json
```

The first command is process evidence only. The second fails for mismatched builds, absent/unready runner, wrong import, unreviewed policies, stale coverage, missing required capabilities, cached/private guest responses, incorrect guest freshness or missing noindex. Neither is a green replacement for the complete release gate: reports always say `completeReleaseGate:false` and `shareable:false`. Frontend-owned deployed browser journeys, bounded real-provider/failure/rate-limit checks, resource observations and release-owner approval are still required. Record the retained compiled frontend release identity and API/runner digests together; mismatched source/tree or deployed frontend artifact hashes fail verification. A changed candidate or base needs new verification.

## Private job-feed handoff

The repository prepares a private file handoff from the retained Jobseek crawler data to Justup, but the existing host does not have its socket or restricted SSH command installed. The `fresh-job-feed-host-upgrade` work must first extend the protected host plan for the new script and two units. The current scripts-only `upgrade-ops` correctly refuses new inventory paths and changed units; do not copy units into place or change the SSH key command outside that reviewed operation.

The prepared transport has one narrow route. A sender streams a versioned manifest and declared parts with `preview-feed.py send`; the SSH identity relays bytes to a mode-0600 Unix socket and cannot parse or store job bodies. A service inside `justup-preview.slice` validates each part's name and SHA-256, enforces a 128 MiB stage limit and 64 MiB filesystem free floor, and fsyncs a private directory on the existing 2 GiB mount. Raw receipt of bytes never acknowledges the source cursor.

An explicit root operator runs `preview-feed.py import --batch-id <32-lowercase-hex> --manifest-sha256 <64-lowercase-hex>` inside the same slice. The digest must come independently from the protected source producer's receipt, never from the SSH relay's output; a transfer key alone cannot authorize new job data. The command verifies the staged bundle and active immutable backend artifact, runs that artifact's importer as the API UID, and keeps the previous accepted export until the new one is durable. A root-owned marker binds each prepared export to that exact immutable build; switching builds before acknowledgement refuses reuse and requires reviewed recovery. A partial change page receives an acknowledgement only after its non-importable state is durably staged. A complete page or full snapshot receives an acknowledgement only after `server/main.mjs --import` succeeds for the exact export and the database's latest import records that manifest digest. The operator copies the small `preview-feed.py receipt --batch-id <id> --manifest-sha256 <source digest>` JSON to the source producer's protected `ack` command; it contains only `schemaVersion` and `manifestSha256`. An interrupted transfer or failed import retains the batch for exact replay and produces no acknowledgement. No feed transfer, import schedule or endpoint retirement is active yet.

The host stage cap is deliberately lower than the producer's global 512 MiB batch ceiling. Qualify the selected company cohort against that cap, current SQLite capacity and the release's 24-hour verification lifetime. An oversized batch fails without silently claiming coverage or allocating a larger disk. Any additional infrastructure spend follows the explicit resource approval path.

## Schedule and observation contract

The shared queue leases tasks durably; schedules enqueue fixed task kinds and never launch arbitrary scripts or a second permanent model worker. A schedule must be disabled until its exact candidate, owner, cadence, timeout, concurrency, replay key and failure alert are reviewed. Retrying an interval reuses its import generation or edition period. Interactive search/company work takes priority over weekly editorial work within the one model slot. Stop new work before recovery; retain pending tasks, usage ledgers and immutable edition evidence.

| Operation | Current interface and required release evidence |
| --- | --- |
| Job refresh | `scripts/import-jobs.py --snapshot <fixed UTC> --typesense-host <approved origin> --previous <last snapshot> --output <new private path>` followed by `server/main.mjs --import <completed snapshot>`. Both steps use the approved read-only transfer and resource boundary. Prove repeated updates, known-ID closures, stale-source behavior and replay before enabling the cadence. |
| Source history | The producer under `source-coverage-history` must supply authoritative scope/revision and complete/interrupted intervals. Latest success or a current snapshot cannot prove two continuous weeks. Missing history suppresses comparative publication. |
| Hiring Wire | The shared runner idempotently enqueues the completed Monday UTC period and binds the protected reader and five-tool Sol dispatcher. Source history, independent qualification and exact deployed evidence must pass before enabling its configuration. Facts, selections and execution identity persist with the edition; replay cannot publish twice. Cleanup uncertainty durably halts the queue for reviewed recovery. |
| Backups | `preview-recovery.py backup` uses the active immutable manifest identity and live deletion generation. Review cadence/recovery objective and confirm backup age, capacity and restore before unattended operation. The ledger is excluded. |
| Resource guard | The installed minute timer checks actual kernel limits, physical allocation, free space and bounded storage. It stops only named Justup units; it never raises caps or repairs reservation loss. |
| Observation | Read `/api/v1/health`, `/api/v1/version`, `/api/v1/session` coverage and exact runner heartbeat. API remains private/no-store/noindex in either frontend deployment mode. Record actual freshness, queue lag, task failures, latency, token/spend reservations, model-slot waits, backup age and guard failures. Missing instrumentation or absent collection is a release gap. |

Record numeric freshness/latency/error/queue-age thresholds and a named response owner before activation, then exercise a missed refresh, unavailable provider, exhausted allowance, interrupted editorial task and stale backup. The existing API metadata log and host guard do not constitute a complete alert pipeline. `operations`, `fresh-job-feed`, `source-coverage-history`, `hiring-wire-editions` and `release-verification` track the integrated evidence. No enabled scheduler, monitor delivery, new source access or external service is implied by this guide.

## Backups, deletion and restoration

Auth owns session cleanup and any explicitly stored account deadline. Accounts are durable by default; sessions expire after seven days by default and expiry does not delete identity. An optional deployment deadline applies only when a new account is created. Private deletion immediately removes owned state and invalidates its backups. Failed cleanup closes authentication availability. Verify model/cache retention against the actual integrated modules before policy approval.

Operations maintains at most two complete SQLite snapshots, each at most 256 MiB and at most seven days old; all are inside the same disk quota. The backup command is an explicit operation; the current restricted deployment has no activated backup schedule. Wider release requires a reviewed cadence and restore rehearsal. Run recovery commands under the preview slice. Use the actual active manifest identity:

```sh
python3 /srv/justup_preview/ops/preview-recovery.py backup \
  --database /srv/justup_preview/state/preview.sqlite \
  --backup-dir /srv/justup_preview/state/backups \
  --generation /srv/justup_preview/state/private-generation \
  --source-commit "$JUSTUP_PREVIEW_COMMIT" --build-identity "$JUSTUP_PREVIEW_BUILD_ID"
```

SQLite's online backup API creates a consistent snapshot; copying the live WAL database with filesystem `cp` is not supported. A 30-second/page budget, integrity check, digest and before/after stable generation checks with an absent transaction-pending marker precede publication. Generation change discards the snapshot. Snapshots/metadata are flat regular files only, private and fsynced; the recorded database epoch must agree with the snapshot and verified active artifact. Oversized/expired/corrupt snapshots fail closed. Pruning runs after a successful backup or by the explicit `prune --backup-dir` command. Verify and prune before leaving a preview unattended; the guard does not silently create snapshots.

The core owns the transaction-aware deletion barrier. Before rotating the generation, it must exclusively create and fsync `state/private-generation.pending`, then rotate/fsync `state/private-generation` and purge/fsync all backup files. The pending marker must remain through the actual SQLite COMMIT or ROLLBACK; only the transaction owner clears and fsyncs it afterwards. Two UUID reads alone are insufficient: a concurrent SQLite reader can see old committed records after the UUID rotates but before deletion commits. Operations therefore reads generation, checks pending absence, rereads the same generation before starting a snapshot, and repeats that stable check afterwards. A retained marker after a crash blocks backup and restore until verified recovery; tooling never clears it automatically. This cross-module pending-marker protocol is implemented by the core and remains a required restore verification. Barrier failure rolls back private SQL deletion; a later SQL rollback may invalidate extra backups safely. Keep the live generation independent of backups. Missing/mismatched generations always block restoration. Never replace it with a value from a snapshot.

For a rehearsal or real recovery, stop API/runner writers, preserve the current generation and validate an exact snapshot with `check-restore`. Restore to a new `state/restored-<reviewed-name>.sqlite`; the CLI refuses an existing destination, unknown paths, running writers or arbitrary preparation commands:

```sh
python3 /srv/justup_preview/ops/preview-recovery.py restore \
  --snapshot /srv/justup_preview/state/backups/backup-EXACT-REVIEWED-NAME.sqlite \
  --generation /srv/justup_preview/state/private-generation \
  --destination /srv/justup_preview/state/restored-rehearsal.sqlite
```

The command uses the verified epoch-2 artifact's `server/main.mjs --prepare-restored-db`. An epoch-1 snapshot requires the explicit `--migrate-v1` option and may bind an exact retained epoch-2 target with `--build-identity`; its separate restored file is migrated forward before session revocation. See the [schema recovery contract](schema.md). That calls the auth-owned synchronous session revocation helper and must return the schema/session-invalidated/zero-remaining-sessions receipt. Recovery tooling checks the live generation before and after preparation. It never guesses auth table names. Restore prepares a separate file and does not activate it. Rehearse that a pre-deletion backup is rejected, a valid snapshot restores private state, all old sessions are rejected and account/request deletion still works. Stop on a missing helper, receipt, incompatible schema or generation change. Moving a prepared database into the live path, clearing only the stopped preview's WAL sidecars and restarting is an explicit reviewed operator step; no live database is overwritten automatically.

Backup expiry is physical cleanup; private deletion additionally invalidates and purges snapshots immediately. On teardown, erase the preview image after the reviewed recovery/retention decision. Do not promise provider zero-retention: actual OpenAI/JEV configuration and recipients still require the privacy inventory.

## Observe, rollback and stop

The CLI API logs only request ID, category, status and duration. The launcher accepts bounded JSON and drops other/raw output. It preserves only allowlisted categories, HTTP status, bounded numbers and generated request IDs. It never stores query/body/password/token/IP/provider output. Logs are mode 0600, at most 8 MiB/day for seven days; the minute guard prunes expired files and enforces the aggregate budget. Global journald settings remain unchanged. Record source verification age, queue depth, model latency/cost, pauses/failures, and Cloudflare/host usage from the actual integrated instrumentation; absent instrumentation is a verification gap, not a zero metric.

For local aggregate product and execution evidence, use the [product evidence guide](product-evidence.md). Its fixed private SQLite metadata is distinct from launcher logs: seven-day retention, 10,000 journey rows, 5,000 execution rows and 200 reference-only review candidates, with owner deletion/expiry/handoff. The default local CLI exports aggregates only; explicit reviewed synthetic/redacted case curation/export is separately bounded. No new service, public telemetry route, provider execution, schedule or resource allocation is enabled. Unknown per-call subscription cost remains null, and source-opening reports do not establish applications or hires.

A guard failure stops only the explicitly named preview API, runner, tunnel, model socket and model service units. Investigate the actual kernel limits, root reserve and preview quota. Do not clear unrelated caches, resize the quota, restart the renderer or increase the allocation as an automatic recovery action. Viktor Shcherbakov owns incident coordination and policy review; use business@colophon-group.org for the operator contact. Actual policy approval and implemented retention/provider behavior remain release gates.

For code rollback within epoch 2, retain the verified previous compatible build and a usable deletion-safe backup. Stop preview writers, select the exact retained build with `switch --build-identity`, then repeat readiness/identity/data/browser checks before reopening routing. The switch checks the actual database epoch after stopping services and preserves existing links on a mismatch. There is no epoch-2 to epoch-1 downgrade: a retained epoch-1 backup is only a forward-recovery input migrated to epoch 2 before auth-owned session invalidation. Keep current protected launch/recovery tooling installed when selecting retained application bytes. Never restore an old snapshot merely to make old code start, overwrite the live deletion barrier, reset cumulative JEV spend or reactivate old sessions. A failed switch leaves the API stopped for inspection.

For teardown, use `--reviewed-plan-sha` with the exact installed marker identity. Remove the frontend candidate route with its owner, remove Justup's scoped runtime/model/tunnel access (do not revoke the shared Jobseek JEV key), preserve/reconcile its cumulative ledger until matching is stopped and access is removed, then run `preview-host.py teardown` in the slice. It disables the preview guard timer, stops only the named preview units and uses a normal unmount. It retains the mode-0600 image by default for an explicit recovery/retention decision. `teardown --erase-data` removes only the owned image, empty mountpoint, dedicated preview UIDs/groups and preview mount/service/socket/timer files after marker/backing validation. It refuses a busy unmount, mismatched/unsafe root-owned marker, nonprivate or aliased image, incorrect backing/mount/filesystem/options or unexpected mountpoint content. Only teardown's internal cleanup validation permits lost physical reservation so an owned sparse image can be normally unmounted and removed; proof, guard, install, stage and switch retain the strict allocation check. There is no general bypass flag. It never uses forced/lazy unmount or wildcard cleanup. The small slice file is retained so the teardown process stays bounded; after it exits, the operator may stop/remove that specifically reviewed slice and reload systemd. Confirm released disk space and unchanged protected-renderer health.

The current deployment keeps production mail, payment collection, crawler writes and production schedules off. Accepted free-period/subscription transitions, live SSE results, fresh jobs, company requests and hiring reports, posting-language preferences, durable reading state and factual Hiring Wire remain first-release requirements; a missing product path blocks invited activation. Keep the runtime-to-`main` block until the real fixed frontend/API/runner release gate passes.

References: [systemd aggregate resource controls](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html), [systemd execution sandbox](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html), [official pinned Node checksums](https://nodejs.org/download/release/v24.22.2/SHASUMS256.txt), [OpenAI CLI installation guide](https://learn.chatgpt.com/docs/codex/cli), [pinned official Codex license](https://github.com/openai/codex/blob/rust-v0.159.2/LICENSE).
