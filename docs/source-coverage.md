---
summary: Select an immutable Jobseek coverage version and project approved public career-page links.
read_when: Configuring the queue source reader or integrating company report source checks.
---

# Consume source coverage

The queue-only `sourceCoverage` configuration is exactly
`{directory,sourceVersion}`. Select `jobseek-coverage-v1` or
`jobseek-coverage-v2` explicitly; no version alias or automatic fallback exists.
The reader defaults to v1 when composed directly without a version. The configured
version must match the artifact's source version and schema: v1 uses
`schemaVersion:1`, and v2 uses `schemaVersion:2`. This source protocol is
independent of the application database schema and Wire fact/tool versions.

The directory must be an absolute normalized protected path outside shared state
and backups. Existing root-owned ancestor, mode, no-symlink, size and fixed Monday
filename checks apply to both versions. No API or model chooses the source path.
The wrapper remains `{artifactVersion:1,snapshotBytesBase64,sha256}`; its hash
covers exact decoded bytes. The compiler retains the original snapshot values
and separately hashes its canonical representation for stored edition evidence.
Neither read path rewrites or upgrades immutable v1 artifacts or stored snapshots.

## Install a reviewed weekly artifact on preview

Use the approved Jobseek company selection and its private producer artifact.
Record the UTC Monday, source version, SHA-256 of the **entire wrapper file**,
exact active Justup backend build identity and installed host-plan digest. The
wrapper digest is separate from the inner snapshot hash. Review the recurring
transfer and approval before handing over real bytes. Keep the wrapper and
transfer receipt in approved private storage.

Use the installed, reviewed `preview-host.py` after the guarded operator-script
upgrade and switch to the exact backend build. Schedule the transfer outside
build switches and other operator updates. Run the following as the root
operator on the verified host inside the existing preview slice, using the
approved transfer record for every placeholder.

```sh
systemd-run --unit=justup-preview-coverage --wait --pipe --collect \
  --slice=justup-preview.slice --property=PrivateNetwork=yes \
  --property=RuntimeMaxSec=90s \
  /usr/bin/python3 /srv/justup_preview/ops/preview-host.py install-coverage \
  --period YYYY-MM-DD --source-version jobseek-coverage-v2 \
  --sha256 "$approved_wrapper_sha256" --build-identity "$active_backend_build" \
  --reviewed-plan-sha "$installed_plan_sha256" < "$private_producer_wrapper"
```

The command checks the private preview mount and resource guard, the active
immutable build, installed plan and exact wrapper bytes. The checker runs as the
queue identity with the retained Node runtime, the same decoder and fact
compiler as Hiring Wire, and no inherited provider configuration. Deliver the
export while the compiler's freshness window is open. The snapshot must have
been generated within the first 24 hours of the UTC Monday and be at most 24
hours old at verification. The output records both digests and aggregate
comparison and suppression counts. A valid but insufficient history returns
zero comparisons.

Configure the runner's protected `sourceCoverage` with the corresponding
directory and version as part of the reviewed activation.

| Source version | Preview directory |
| --- | --- |
| `jobseek-coverage-v1` | `/srv/justup_preview/queue/source-coverage-v1` |
| `jobseek-coverage-v2` | `/srv/justup_preview/queue/source-coverage-v2` |

Installation publishes the complete bytes atomically as `YYYY-MM-DD.json`,
owned by root with the dedicated queue group, mode `0640` in a `0750` directory.
A fresh replay of the same bytes returns the same evidence without replacing the
file. Different bytes for an installed period and version are refused. Each
version retains at most four periods on the preview mount. Before reaching that
limit, verify the exact older bytes in the protected producer archive and the
edition's retained evidence, then have the operator retire the corresponding
older input during reviewed maintenance. Resolve an unexpected staging file
under the same boundary before the next transfer. The intake leaves services
and their configuration untouched. The weekly runner discovers the installed
file using its existing schedule.

## Validate v2 links

The v2 shape retains the same companies, scope/revision coverage and posting
observations. Every scope adds a required `publicLink`, either null or exactly:

```text
{url,status:"approved",provenance,approvedAt}
```

`provenance` is `employer-careers`, `ats-careers` or `reviewed-redirect`.
`approvedAt` is canonical UTC with milliseconds and cannot exceed the snapshot's
`generatedAt`. It is approval evidence, not a successful page check; it may follow
the period end. The URL must already be canonical ASCII public HTTPS, retain its
meaningful career-page path and contain no credentials, query, fragment, encoded
characters, private/IP/test host or non-default port. Unsafe or unknown metadata
fails validation and makes that historical report evidence unavailable.

The producer owns reviewed approval and binds changes/removal to the board scope
revision and tracking start. The consumer never substitutes a crawler endpoint,
posting URL or company homepage for a missing link, follows redirects, repairs
approval metadata, or infers continuity. Adding link evidence does not change the
deterministic comparison/count rules. Existing schema-1 injected adapter versions
remain supported; the concrete reader and queue accept only the two Jobseek versions.

Scope metadata is captured through `generatedAt`, while posting observations and
coverage intervals stop at the fixed `asOf` period end. A scope reset after that
cutoff, including a link approval or removal, may set `trackedSince` after `asOf`.
It remains valid only through `generatedAt`; non-null `lastVerifiedAt` must be
between that tracking start and generation. The changed scope is suppressed from
weekly comparisons without rejecting other attributable scopes. Its original
tracking/link evidence remains in the frozen snapshot and public source checks;
the report shows incomplete history rather than zero or invented continuity.

## Read public source checks

The [company report](company-hiring-reports.md) exposes one `sourceChecks.items`
entry per recorded scope, containing only `publicLink`, `trackedSince` and
`lastVerifiedAt`. Null verification remains null. `sourceChecks.state` describes
approved link availability: `available` when all entries have links, `partial`
when some do, and `unavailable` when none do or no attributable history exists.
It does not describe live page health, recent verification or complete history.
Valid v1 history produces null public links without changing its counts or hash.
No raw scope IDs/revisions or posting identities become public.

Tests use synthetic source artifacts, real SQLite publication and fake editorial
transport, plus the Python-to-Node configuration and intake checks. Qualification
still requires the reviewed producer, an approved exact-file transfer on the
preview host, representative real company histories and the deployed report and
edition journeys.
