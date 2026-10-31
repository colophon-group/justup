---
summary: Prepare, verify and operate the bounded Cloudflare frontend preview without changing application assets.
read_when: Preparing an exact preview candidate, approving its owned hostname, or checking and rolling back frontend delivery.
---

# Frontend preview delivery

This is preparation for [demo-preview-hosting #27](https://github.com/colophon-group/justup/issues/27), supporting [release verification #36](https://github.com/colophon-group/justup/issues/36). No Cloudflare service, DNS record, certificate or deployment has been created by this implementation. The current prototype must first be integrated with the real API and reviewed policies. Packaging it does not make simulated data a live service.

## Resolve these inputs before a deployment

The release owner records the following in #27. Credentials are not an approval record; consult the [secrets guide](secrets.md) before configuring deployment access.

| Input | Required evidence |
| --- | --- |
| Owned preview HTTPS origin | Exact hostname, ownership/DNS control, existing Cloudflare account and zone, chosen Worker name and DNS collision check. `justup.work` is the intended product domain, not verified deployment authority. |
| Resource authorization | Human approval record and ceiling for the existing machine allocation and Cloudflare free allowance. Any additional account, paid tier or service needs its own approved resource request. |
| API HTTPS origin | Backend owner's fixed origin, valid TLS, public-origin configuration, trusted proxy boundary, limits and isolated data namespace. Do not use the frontend origin as the upstream. |
| Preview audience | API-authoritative limited-public access rules and signed-in tester allowlist. `noindex` is not access control. Sensitive preview content remains protected by API entitlement. |
| Sign-in and policies | Operator-reviewed public Privacy/Usage pages, approved provider inventory, exact public callback URLs, secure session/CSRF settings. Keep sign-in disabled until these exist. |
| Capacity and cleanup | Backend host capacity report; Cloudflare free-plan confirmation, representative request/CPU measurements, named operator, observation window and preview expiry. |
| Exact release | Candidate SHA/tree, compatible API/runner versions and digests, migration/rollback plan, test report and previously retained frontend artifact. |

Repository metadata records the intended domain and the Cloudflare plan only. It does not identify an approved account/zone, exact preview hostname, backend origin, resource-approval link or provider callbacks. The preparation scripts therefore contain no working deployment defaults.

## Prepare the retained artifact

Run with Node 22 or later and Git, from the reviewed repository. Pass the exact 40-character commit ID, not a branch name. Output must be a new directory outside the checkout, so old verified bytes cannot be overwritten:

```sh
node --test deploy/frontend/*.test.mjs
node scripts/frontend-prepare.mjs <candidate-sha> /tmp/justup-preview-candidate
node scripts/frontend-configure.mjs /tmp/justup-preview-candidate <approved-worker-name> https://<approved-preview-host> https://<approved-api-host>
```

The preparer reads `prototype/` and the edge Worker from the committed Git tree. It ignores local dirty and untracked files, rejects symlinks and common secret/control files, and writes sorted per-asset SHA-256 hashes in `release.json`. The configurator verifies these bytes before writing a new `wrangler.json`. Secret detection is a boundary check, not a substitute for reviewing public assets.

The retained artifact consists of `assets/`, `worker.mjs`, `release.json` and runtime-only `wrangler.json`. Keep the directory private to the release process: its deployment configuration includes the API hostname, although it contains no authentication token. Do not put credentials, provider keys, database credentials or API tokens in any of these files. Cloudflare deployment credentials are provided separately by the trusted operator environment. No Git-integrated automatic deployment or credentialed PR workflow is installed.

The official Wrangler CLI is the deployment tool rather than an application dependency; there is no package or lockfile change. Version `4.156.0` was selected from the official npm registry for a bounded packaging dry run. A trusted deployment job must pin its reviewed CLI version and use the retained artifact, rather than executing candidate scripts with deployment credentials.

## Routing and session contract

One Cloudflare Worker serves the existing static interface through its `ASSETS` binding. `run_worker_first=true` gives **every** response the noindex and privacy headers. Asset HTML handling is `none`, with no catch-all HTML fallback; `/privacy.html` and `/usage.html` remain independently fetchable without a session or API. `/robots.txt` disallows all crawling. Workers.dev and provider version preview URLs are disabled, and an unapproved request origin is rejected.

| Route | Behavior |
| --- | --- |
| `/api/v1` and `/api/v1/*` | Forward the same path/query/method/body to the one configured HTTPS API origin. No JSON transformation, retries or response buffering. |
| `/__preview/version` | Public noncached source SHA/tree, asset/Worker/artifact digests, runtime-configuration digest and API prefix. Other configuration fields are never returned. |
| `/privacy.html`, `/usage.html`, other assets | Public static bytes with security headers. Unknown assets stay 404. |

All API responses, including errors and redirects, have private `no-store` browser/CDN policy; conditional cache headers are removed. SSE passes the original response stream directly, carries event ids and reconnect headers unchanged, and cancels with the client. The backend owns event heartbeat, replay/revision correctness, concurrent connection limits, scan throttling and authenticated access. Confirm actual deployed first-event latency and reconnect behavior in the full browser gate; the local stream test proves the edge does not collect a page before responding.

Cookies, CSRF headers, `Origin`, `Last-Event-ID` and ordinary application headers pass to the API. Forged forwarding/Cloudflare metadata is removed; `X-Forwarded-Host` and `X-Forwarded-Proto` are set from the approved frontend origin. The API must only trust that proxy contract on a controlled ingress; its own exposed HTTPS origin still requires session/CSRF/entitlement and rate-limit enforcement. This Worker does not provide origin-to-origin authentication.

Browser mutations require an exact matching `Origin`; this is additional to the API's CSRF-token check. Provider callbacks must use GET redirects under the public `/api/v1` origin; a cross-site POST callback requires an explicit reviewed contract change. The API should issue `__Host-` session cookies with `Secure`, `HttpOnly`, `Path=/`, appropriate SameSite and **no Domain**. Backend-host cookies do not work on the public frontend and are not rewritten by the edge.

The backend builds provider login URLs and callback/return redirects from the approved public origin. Redirects are passed to the browser without being followed by the edge, including external provider redirects. A redirect to the private API origin fails closed. Never expose internal hostnames in public return URLs. Do not put an interactive Cloudflare Access interstitial on callback/API/policy routes without verifying provider callbacks, public policy fetches and SSE; audience restriction belongs in the agreed backend session/access controls for this slice.

The content security policy permits local scripts/fonts, local and HTTPS images, local connections and inline styles used by the interface. It blocks remote script execution, framing and external form submissions. Provider sign-in uses a server-owned navigation URL, not a third-party embedded script. Preserve this contract when integrating the live interface.

## Deploy only after approval

After the inputs above are recorded and the candidate passes the integrated gate, the release operator may use the pinned official CLI:

```sh
npx --yes wrangler@4.156.0 deploy --dry-run --config /tmp/justup-preview-candidate/wrangler.json --outdir /tmp/justup-preview-bundle
# The following is a provider write; run only after the recorded approval and gate.
npx --yes wrangler@4.156.0 deploy --config /tmp/justup-preview-candidate/wrangler.json
node scripts/frontend-smoke.mjs https://<approved-preview-host> /tmp/justup-preview-candidate
```

The custom-domain deployment can create DNS/TLS resources. Inspect existing DNS and the exact account/zone first; never use the command as a discovery probe. The generated config deliberately omits an account id, so the trusted operator must select and verify the approved account explicitly. There is no provisioning or deployment CI job in this change.

Freeze the one stable callback hostname to one candidate during acceptance. Record the Cloudflare version/deployment ID, config digest and source identity. A stable hostname is a mutable route, **not an immutable deployment URL**. This preparation does not satisfy the release guide's immutable-preview-URL requirement by itself: the release owner must record a candidate-specific owned hostname and matching provider callbacks, or approve and implement an equivalent independently pinned routing mechanism before claiming that requirement. Another deployment on a tested hostname invalidates its report.

The smoke command has a 60-second budget, per-request timeout and maximum 200 assets. It uses GET only, validates reported source/config digests and downloads every declared public asset to compare actual bytes, checks both public policies/robots, and confirms a noncached JSON session endpoint. It does not sign in, create accounts, run AI tasks, send mail or change data. API/runner identity, reviewed policy content, access enforcement, SSE reconnect and browser journeys remain separate release-gate checks; a smoke pass alone cannot approve release.

## Limits, observation and rollback

Cloudflare's published Workers Free limits are 100,000 Worker requests/day and 10 ms CPU/request, with 128 MB memory; static assets have a 20,000-file and 25 MiB/file limit. See the official [limits](https://developers.cloudflare.com/workers/platform/limits/), [pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [asset-routing](https://developers.cloudflare.com/workers/static-assets/binding/) references. Recheck the selected account's current plan before deployment. Because all requests run through this Worker for headers, conservatively count asset requests as Worker invocations in the budget; do not assume unlimited asset-only traffic applies to this path.

For the bounded demo, stop admitting new testers at 50% of the daily request allowance and investigate any CPU-limit error, sustained API 5xx or dropped SSE connection. The release owner records measured p50/p95 first-byte latency, API error rate, SSE first-event/reconnect latency, request count and Worker CPU in #27/#36 during the agreed representative load. These are proposed operational stop points, not measurements from this change. No automatic upgrade or paid overflow is authorized. Backend limits, schedules, billing and outbound-mail disablement are owned and verified separately; edge headers cannot establish those properties.

Retain the previous complete artifact and its config, deployment ID and browser/API compatibility report. For rollback, stop acceptance traffic, have the backend owner select a compatible retained API/runner/database recovery path, redeploy the previous frontend artifact with its approved config, and rerun smoke plus affected authenticated journeys. Do not rebuild from a branch alias. On preview expiry, remove only the approved preview Worker/domain mapping and its scoped deployment access, after the backend owner has cleaned up isolated data/tasks. Record cleanup and any failure in #27; failed cleanup blocks another candidate.

## Test ownership

Frontend hosting owns `deploy/frontend/*.test.mjs`: edge routing/privacy/stream contracts plus exact-commit packaging and remote-byte verification. The suite uses Node's built-in test runner, temporary Git repositories and fake fetch responses; no provider, credential, DNS or real deployment is required. Expected runtime is under five seconds, in the deployment-contract CI group. The integrated CI owner registers `deploy/frontend/**` and `scripts/frontend-*.mjs` in the central selector, with broad checks for deployment-contract changes. The explicit deployed smoke belongs to #36 rather than ordinary PR CI.
