---
summary: Bounded operator entry points for the weekly Hiring Wire task and history validation.
read_when: Preparing the weekly scheduler, validating its authoritative export or maintaining its editorial tools.
---

# Hiring Wire commands

These commands run without model credentials. They never start a provider, install a timer or publish an edition themselves. Read [the Wire contract](../../docs/hiring-wire.md) before connecting a history source or the separately qualified Sol subscription transport.

`node scripts/hiring-wire/enqueue.mjs` queues the latest completed Monday-to-Monday UTC period in the existing shared task database. Set the absolute existing `JUSTUP_DB_PATH`; use `JUSTUP_SHARED_STATE=true` only in the reviewed shared runtime. `--period 2026-11-02T00:00:00.000Z` selects an explicit period. The command prints only the task identity/status and edition period. Failed attempts can be requeued against the same immutable edition snapshot, with a maximum of eight task identities per period.

The operations-owned weekly scheduler invokes this command. The existing runner dispatches `hiring_wire` only after interactive tasks, using the same global lease and resource ceiling. The queue command does not establish authoritative coverage, qualify a model, activate automation or grant model access to this database.

`node scripts/hiring-wire/check-snapshot.mjs /absolute/reviewed-snapshot.json --period 2026-11-02T00:00:00.000Z` validates a bounded source projection and prints aggregate counts and a hash. It does not import, publish or echo source identifiers. A valid file still needs the reviewed authoritative producer; syntax validation cannot establish source trust.

The durable selection script is a small declarative recipe in `hiring_wire_tool_versions`. Sol reads, replaces and executes it through the exported narrow tools in `server/hiring-wire-editorial.mjs`. It controls shortlist filtering, sorting, the item budget and avoidance of recent selections. Arbitrary JavaScript, commands, paths and URLs are rejected. Each edition saves the exact recipe revision and content; the newest 32 working revisions remain available. Source changes use normal repository review, while bounded recipe updates form the editorial workspace.

The server suite recursively discovers the Wire tests, including the CLI contract, with `node scripts/test-server.mjs`. Synthetic fixtures are test-only and cannot become shipped editions. No new package or permanent service is used.
