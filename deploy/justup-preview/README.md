---
summary: Review the immutable API artifact and isolated preview host boundary.
read_when: Preparing the demo host, inspecting its systemd units or rehearsing rollback and cleanup.
---

# Preview host files

These files prepare one explicitly reviewed Linux ARM64 host. They do not provision a provider resource, start the API, configure Cloudflare or provide a model runner. Follow the [operations guide](../../docs/demo-operations.md) before applying anything. No remote changes have been made by adding these files.

`justup-preview.slice` caps the aggregate preview at half a CPU, low CPU weight, 768 MiB memory pressure/1 GiB maximum, no swap and 96 tasks. Every future runner, tunnel and maintenance process must use this same slice. A new 2 GiB regular-file loop filesystem at `/srv/justup_preview` bounds all application bytes, Node, persistent data, work, backups and diagnostics. The installer refuses existing image/mount/UID/unit paths. It never accepts a supplied device or modifies the existing Murmur volume.

`justup-preview-api.service` runs only the built-in Node API as a dedicated account. Application files are root-owned and read-only; only preview state/logs are writable. The API listens on loopback port 8787; the service permits loopback networking only. Credentials are loaded by an allowlisted launcher, not inherited from the operator. Docker sockets, administrator homes and the Murmur mount are inaccessible. Output goes through bounded metadata-only local logging; global Jobseek journald configuration is untouched.

`justup-preview-guard.timer` is a preview-only minute guard. Kernel quota or filesystem/reserve failures stop only the explicitly named preview units. The installer checks kernel cgroup values before allocating the disk, then proves the filesystem rejects an over-limit allocation. These proofs must actually pass on the host before importing data or enabling any service. Unit syntax and namespace behavior still need the planned target-host verification after installer review.

`runtime.json` records the official prebuilt Node 24.22.2 Linux ARM64 archive and SHA256. Builds and browser tests run off-host. The artifact tool verifies that checksum, extracts only the Node executable/license and gathers application files from an exact Git commit, including its tree identity and complete file hashes. No npm application package or extra database service is added.

Run the offline safety suite with:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/preview-operations.test.py
```
