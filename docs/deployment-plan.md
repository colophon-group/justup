---
summary: Place Justup on existing capacity and define the isolated preview, release and resource gates.
read_when: Allocating backend capacity, preparing a preview or planning a production release.
---

# Deployment plan: Cloudflare and existing Hetzner capacity

Status: accepted starting deployment plan

Date: 31 October 2026

This plan implements the [user-facing backend design](backend-design.md). It prioritizes low incremental cost and a small operational surface while demand is being validated. Existing infrastructure is a capacity and cost input; the new application's behavior follows the Justup design. Crawler deployment and operation are outside this plan.

The public repository is [colophon-group/justup](https://github.com/colophon-group/justup), and the product domain is `justup.work`. The current browser interface has no live API, runner or complete release preview yet. Follow the [development and release guide](https://github.com/colophon-group/justup/blob/main/docs/development-process.md) for the authoritative contribution, release and resource-approval rules.

This is the full product deployment plan. The temporary [demo-release](https://github.com/colophon-group/justup/issues/26) has a narrower allocation on an existing ARM host, isolated preview state and no billing, production mail or crawler writes. Its current host observations, provisional ceilings and load evidence belong in [demo-preview-hosting](https://github.com/colophon-group/justup/issues/27). They do not reserve the capacity described below or authorize a production launch.

## 1. Deployment split

Use Cloudflare for frontend delivery and public caching. Keep the application backend, authoritative product state, search coordination and Codex execution on Hetzner. Start in one region using existing capacity.

| Feature | Initial placement |
| --- | --- |
| Landing page, workspace UI, JavaScript, CSS and fonts | Cloudflare static assets and CDN. |
| Public company pages and published Hiring Wire | Cloudflare delivery/cache, backed by Hetzner data. Public pages need crawlable content. If server rendering is required, start with the Hetzner application; Workers rendering remains an option. |
| Accounts, access, subscriptions, saved searches, follows, viewed state and billing callbacks | Hetzner API and PostgreSQL. Keep authoritative application state together. |
| Search compilation, normalization, primary filtering, candidate evaluation scheduling and continuations | Hetzner, beside the relevant data and durable evaluation state. |
| Luna search planning and company previews; weekly Sol Hiring Wire session | Bounded Codex execution on an existing Hetzner host, with durable task workspaces and versioned tools. |
| Live SSE results | Hetzner API, streamed through Cloudflare. |
| Logos, edition artifacts and evaluation exports | Existing storage initially; R2 is an optional object-storage destination when useful. |
| System One inference | Provider chosen through the evaluation collection. Hetzner owns orchestration; the model can run through an external inference provider. |

Workers can support lightweight APIs, webhooks, token verification and streaming. D1, Durable Objects, Queues and Workflows are available capabilities. Keeping the application backend together on Hetzner currently gives the simplest data access and task execution. Add an edge capability when a measured product need justifies it.

## 2. Existing capacity

Use existing Hetzner capacity before proposing another rental:

- The PostgreSQL host is the initial candidate for the application API and a separate application database.
- The operator has confirmed that the existing 4 GB ARM Murmur host is available for Justup. It is an alternative placement for the API and/or bounded runner.
- Reassess the search host after the old search workload is retired or reduced. Retain data needed for the new search contract until its handoff is verified.
- Preserve the crawler's variable CPU and memory headroom when placing latency-sensitive application work.

Inspect current memory, CPU, disk, retained volume contents and backups before assigning service limits. Treat live inventory and provider quotes as dated operational evidence, not reserved capacity or enduring prices. Record that evidence in the relevant work or resource issue.

## 3. Product deployment allocation

Start without another VM rental. Place the API and application database on the existing PostgreSQL host, with separate application credentials and bounded process resources. The bounded runner can share existing capacity, prioritizing interactive Luna tasks over weekly editorial work. Keep agent workspaces on the host executing the task and include them in backup planning.

The available 4 GB ARM Murmur host is an existing option for the API and/or runner when separating them from PostgreSQL is useful. Check selected binaries/images for ARM compatibility and measure its actual operating headroom before assigning resource limits.

Keep search execution beside its data. The current search index remains an occupied resource until the retained data and new search requirements establish its replacement or reduction. Application architecture does not depend on retaining the old search implementation.

Sharing the application and database host couples their maintenance and failure domain. Accept that tradeoff initially, with separate service limits and working database backups. Prefer the already available ARM host for later separation before renting another machine.

## 4. Cloudflare serving and SSE

Cloudflare static asset hosting provides free asset requests and storage. Use ordinary CDN/proxy routing or a thin frontend Worker for requests to the Hetzner API. Choose the routing mechanism during implementation, keeping one authoritative API and a straightforward browser authentication path.

If a frontend Worker forwards SSE, return the origin response body as a stream. The origin sends headers promptly, uses `Content-Type: text/event-stream` and private/no-store cache behavior, and flushes heartbeats approximately every 15–30 seconds. Disable response buffering along the path. Keep matching work separate from the connection handler.

Workers HTTP streams have no fixed wall-time limit while the client remains connected; CPU limits still apply. Streams can disconnect during runtime updates and network changes. Use one stream per workspace, clean up disconnected clients, bound per-client buffering, and reconcile authoritative state after reconnecting. The backend's revision, access and expiry rules apply throughout.

SSE forwarding needs no Durable Object. Continuously active Durable Objects have their own duration billing, so add one only for a concrete coordination requirement. Cache public catalogue and Wire responses explicitly; Cloudflare's CDN does not cache HTML or JSON by default. Keep personalized search and account responses private.

## 5. Cost baseline and rental fallback

The initial target is **€0 additional VM rental** by reusing existing hosts. Existing infrastructure bills continue. Model execution/inference, domain, email/authentication services, payment fees, storage growth and backup costs remain separate budget lines.

Start with static frontend delivery and ordinary proxying. Add paid Workers, R2 or another managed capability only for a concrete need within approved resource scope. Check current request, CPU, storage and operation pricing against the expected workload; include preview resources and model evaluations in the budget.

Additional VM rental is a fallback after existing capacity is assessed. Compare compatible ARM and x86 options in the required region, using a current project API quote that includes IPv4, storage, backups and tax as applicable. Record the quote, alternatives and spending ceiling in the resource request rather than embedding an expiring price table in this guide.

## 6. What triggers a change

Measure search latency, interactive task wait time, candidate yield, ready-result buffer starvation, memory pressure and cost per useful search. Control speculative candidate work and reuse classification decisions before adding machines. Data/index size can drive resource needs even with few users.

Move the API or runner to the available ARM host when shared-host contention or maintenance coupling becomes material. Propose additional capacity only when measured needs exceed existing resources. A single-region application is the starting point; broader geographic deployment follows demonstrated user demand.

Workers AI can be benchmarked against JEV or other System One providers using the saved evaluation collection. Compare quality, measured batching throughput and cost per accepted result. Frontend hosting does not determine the inference provider.

## 7. Preview and release

Ordinary work integrates through `work/<semantic-slug>` PRs into protected `dev`. That branch is not a production deployment source. A frozen `release/vX.Y.Z` candidate targets `main`; urgent `hotfix/<semantic-slug>` changes follow the development guide and return to `dev` afterward.

The full-suite and `Preview / verified` release gate are not implemented yet. Product runtime changes cannot enter `main` before the real gate exists and passes. Backend implementation must also register its focused checks, impact rules and full-suite participation alongside the existing `CI / decision` selection path.

The preview must deploy compatible versions of all three runtime components: the Cloudflare frontend, Hetzner API and Hetzner runner. Use an isolated database, task state and execution namespace, preview-only credentials and protected, non-indexable URLs. Existing hosts may support these isolated processes when their measured resources and approved scope allow it; isolation does not require a new VM. Preview cannot run production schedules, send real user communications, change live billing or process production user data.

Build the three artifacts once. Record the exact candidate SHA, current `main` base OID, candidate tree hash, immutable frontend deployment URL and ID, API/runner artifact digests and deployed readiness/identity results. Run the full required suites and a small Playwright journey set against that fixed compatible preview. Include ordinary and failure paths for search interpretation and repair, AI availability and scrolling, access changes, SSE recovery, company requests, runner retries and sandbox billing. Use deterministic provider fixtures plus bounded real-provider checks where required, with defined quality, latency and cost thresholds.

Release is an explicit action using the retained verified bytes. Reverify when the candidate or `main` base changes, and require the merged `main` tree to match the tested candidate before tagging and deployment. Use runtime configuration or stable relative routes so preview-specific origins and credentials are not embedded in frontend assets. If Cloudflare Pages is selected, disable automatic production builds and Direct Upload the retained frontend bytes as a new production deployment; a preview deployment cannot itself be promoted or used as a production rollback target.

Retain sanitized reports and failure traces. Keep a successful preview available for release-owner review, then clean it up after the decision; failed and cancelled runs also capture diagnostics and clean up. Enforce independent expiry for abandoned previews. Keep prior deployable artifacts and a rehearsed database recovery path. After production deployment, verify artifact identity, run smoke checks and observe predefined error, latency, queue and critical-result thresholds before declaring the release successful.

## 8. Resource approval

This accepted architecture and access to credentials do not authorize provisioning a new external service or infrastructure spend. Open a separate blocked `resource-request` issue describing purpose, alternatives, environment, data/access scope, owner, estimated cost, spending ceiling and cleanup. An authorized human must explicitly approve the scope and ceiling in that issue before provisioning; increases require renewed approval. Link its status from the implementation issue and PR. Planning and code preparation can proceed while approval is pending.

## References

- [Backend design](backend-design.md) and [product design](product-design.md).
- [Development and release guide](https://github.com/colophon-group/justup/blob/main/docs/development-process.md).
- [Cloudflare static asset billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
- [Cloudflare Streams](https://developers.cloudflare.com/workers/runtime-apis/streams/), [origin connection limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits/) and [default cache behavior](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/).
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) and [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/).
- [Hetzner Cloud API](https://docs.hetzner.cloud/reference/cloud) for project-specific inventory, prices and location availability; [backup scope](https://docs.hetzner.com/cloud/servers/backups-snapshots/overview/).
