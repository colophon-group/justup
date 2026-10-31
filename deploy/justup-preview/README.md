---
summary: Review the immutable API artifact and isolated preview host boundary.
read_when: Preparing the demo host, inspecting its systemd units or rehearsing rollback and cleanup.
---

# Preview host files

These files prepare one explicitly reviewed Linux ARM64 host. They do not provision a provider resource, start services, configure Cloudflare or supply model authentication. Disabled API, queue and model socket/service units require separately delivered configuration and actual isolation proofs. Follow the [operations guide](../../docs/demo-operations.md) before applying anything. The empty resource boundary is allocated; application/provider services and public routing remain inactive. Current storage verification and correction status are recorded in [operations issue 35](https://github.com/colophon-group/justup/issues/35#issuecomment-6547490289).

`justup-preview.slice` caps the aggregate preview at half a CPU, low CPU weight, 768 MiB memory pressure/1 GiB maximum, no swap and 96 tasks. Every future runner, tunnel and maintenance process must use this same slice. A new 2 GiB regular-file loop filesystem at `/srv/justup_preview` bounds all application bytes, Node, persistent data, work, backups and diagnostics. The installer refuses existing image/mount/UID/unit paths. It never accepts a supplied device or modifies the existing Murmur volume.

`justup-preview-api.service` runs only the built-in Node API as a dedicated account. Application files are root-owned and read-only; only preview state/logs are writable. The API listens on loopback port 8787; the service permits loopback networking only. Credentials are loaded by an allowlisted launcher, not inherited from the operator. Docker sockets, administrator homes and the Murmur mount are inaccessible. Output goes through bounded metadata-only local logging; global Jobseek journald configuration is untouched.

`justup-preview-guard.timer` is a preview-only minute guard. Kernel quota or filesystem/reserve failures stop only the explicitly named preview units. The installer checks kernel cgroup values before allocating the disk, formats with discard disabled and verifies real allocated blocks remain at least the full 2 GiB logical size, then proves the filesystem rejects an over-limit allocation. Guard/storage checks reject later hole-punching without automatic reallocation. Only marker-bound teardown may waive reservation loss while retaining ownership/backing/mount checks; it uses a normal unmount. These proofs must actually pass on the host before importing data or enabling any service. Unit syntax and namespace behavior still need the planned target-host verification after installer review.

`runtime.json` records the official prebuilt Node 24.22.2 and npm Codex 0.143.0 Linux ARM64 archives and integrity pins. Builds and browser tests run off-host. The artifact tool verifies those pins, extracts Node plus native Codex/bwrap, official metadata/licenses and gathers application files from an exact Git commit, including its tree identity and complete file hashes. No package install or extra database service is added. Disabled Codex code-mode/rg/zsh helpers are excluded; actual Linux version/help, tool and retention proof remains required. Streamed verification and staging keep large native files within the existing memory cap and the complete unpacked bundle below 384 MiB.

The backend artifact contains server/runtime bytes only; its version-2 manifest pins both native runtimes and all retained Codex file hashes. The React/TypeScript/Vite application is compiled off-host by the frontend-owned `scripts/frontend-prepare.mjs`; trusted deployment uploads its retained assets. HTTP preview evidence binds the frontend's `release.json` source/tree and compiled artifact identity to the same API/runner candidate. No frontend source, dependency install or compiler belongs on this host.

`justup-preview-runner.service` runs the fixed queue bootstrap under a third UID. Its launcher checks root-owned mode-0640 `queue/config/runner.json`, exact candidate identity, shared SQLite/heartbeat paths and the fixed model socket. Only queue receives JEV configuration. API and model units hide `queue/`; neither has its group. The queue-owned mode-0700 `queue/budget/` is outside database/backups and holds an operator-prepared mode-0600 cumulative ledger. Installation leaves it empty. Runtime neither initializes nor resets that ledger, and database restore never includes it. Preserve its crash lock and usage history; remove Justup's shared-key delivery before final ledger disposal without revoking Jobseek's key.

The `scripts/preview-operations.test.mjs` wrapper registers the same Python assertions with the deployment/full CI lane and propagates a failed exit or timeout. It adds no second test implementation. Run the offline safety suite directly with:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/preview-operations.test.py
```

The model broker uses systemd socket activation: root creates a mode-0660 socket in a root-owned mode-0750 directory, the queue is the sole client-group member and the API is excluded. The model UID has no API/state/JEV group. Its unit hides API/database/queue/host-private paths, permits writes only to bounded invocation/auth-refresh directories, and requires missing-by-default root-owned isolation review evidence. It starts no agent or auth flow during installation. Target-host filesystem, network and tool isolation must pass before attestation or activation.
