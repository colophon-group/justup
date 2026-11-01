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
transport, plus the actual Python-to-Node configuration boundary. They do not
qualify a real export, complete history, source destination or deployed browser.
Producer review, approved read-only transfer and the retained deployed report
journey remain release evidence; this consumer provisions or activates nothing.
