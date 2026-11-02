---
summary: Build, configure, verify and operate the retained Justup frontend across deployment environments.
read_when: Preparing an exact release candidate, configuring its approved hostname, or verifying and rolling back frontend delivery.
---

# Frontend delivery

The frontend is one compiled product artifact: React/TypeScript assets plus a dependency-free Cloudflare Worker. Build it without credentials, retain its identities, then configure approved runtime origins without rebuilding. The Worker forwards the same-origin API; the API owns account access, policies, capabilities, data freshness and model availability.

A preview is an isolated, time-limited deployment of these product components. Its audience restrictions, noindex protection, resource ceiling and expiry are environment controls. They do not change search or account semantics. Passing a local build or a frontend smoke check does not satisfy the [full release gate](development-process.md#6-verify-a-release-before-it-goes-live).

## Resolve these inputs before a deployment

### Frontend-only test publication

An explicitly authorized incomplete test preview can be published before backend activation. Configure the API argument as literal `disabled`, in `preview` mode only. This omits `API_ORIGIN`, records `API_DISABLED=true`, and binds `apiOrigin:null` into the runtime digest. The retained Worker already returns private JSON 503 for API routes without an upstream; landing, policy assets and release identity remain available, while company data is honestly unavailable. Do not substitute a fictional upstream, fake listings or a successful health response. This changes runtime configuration without rebuilding the retained Worker or assets.

An exact matching `<worker-name>.<approved-account-subdomain>.workers.dev` preview origin enables only that Worker's workers.dev route and omits custom-domain/DNS writes. Other origins retain the custom-domain configuration. Production mode rejects both API-off and workers.dev previews. The smoke tool recognizes only the explicit disabled marker, verifies the retained assets and public rendering, requires API health/session/version to return private JSON 503, and reports `completeReleaseGate:false`. Run deployed public-browser checks afterward. This phase does not activate accounts, models, email, payments or satisfy the complete first-invitation/release gate. Existing account/resource approval, scoped deployment access and exact artifact identity still apply.

```sh
node scripts/frontend-configure.mjs /private/retained-artifact justup-preview-candidate https://justup-preview-candidate.account.workers.dev disabled preview
node scripts/frontend-smoke.mjs https://justup-preview-candidate.account.workers.dev /private/retained-artifact
```

The release owner records the following for each environment in the hosting issue. Keep account IDs, private origins, candidate receipts and access details in protected operator evidence. Credentials are not an approval record; consult the [secrets guide](secrets.md) before configuring deployment access.

| Input | Required evidence |
| --- | --- |
| Owned HTTPS origin | Exact hostname, ownership/DNS control, existing Cloudflare account and zone, chosen Worker name and DNS collision check. Preview acceptance uses a candidate-specific hostname. `justup.work` is the intended product domain, not verified deployment authority. |
| Resource authorization | Human approval record and ceiling for the existing machine allocation and Cloudflare free allowance. Any additional account, paid tier or service needs its own approved resource request. |
| API HTTPS origin | Backend owner's fixed origin, valid TLS, public-origin configuration, trusted proxy boundary, limits and isolated data namespace. Do not use the frontend origin as the upstream. |
| Audience | API-authoritative access rules; a preview also requires a signed-in tester allowlist. `noindex` is not access control. Sensitive preview content remains protected by API entitlement. |
| Sign-in and policies | Operator-reviewed public Privacy/Usage pages, confirmed invite/password settings, secure session/CSRF settings; callback URLs only if an external provider is later approved. Keep sign-in disabled until these exist. |
| Capacity and cleanup | Backend host capacity report; Cloudflare free-plan confirmation, representative request/CPU measurements, named operator, observation window and, for a preview, independent expiry. |
| Exact release | Candidate SHA/tree, compatible API/runner versions and digests, migration/rollback plan, test report and previously retained frontend artifact. |

Repository metadata records the intended domain and the Cloudflare plan only. It does not identify an approved account/zone, exact preview hostname, backend origin, resource-approval link or provider callbacks. Runtime origins must be supplied explicitly; they are never inferred from repository metadata.

## Prepare the retained artifact

Run in an unprivileged, credential-free build job with pinned Node 24.22.2, npm and Git, from the reviewed repository. Do not run candidate builds in an operator/admin session or a trusted deployment job. Pass the exact 40-character commit ID, not a branch name. Output must be a new directory under an existing parent outside the checkout, so old verified bytes cannot be overwritten:

```sh
node --test deploy/frontend/*.test.mjs
node scripts/frontend-prepare.mjs <candidate-sha> /tmp/justup-candidate
node scripts/frontend-configure.mjs /tmp/justup-candidate <approved-worker-name> https://<approved-preview-host> https://<approved-api-host> preview
```

The preparer reads only committed package/lock/build configuration, `web/` source inputs and the reviewed `deploy/frontend/worker.mjs` boundary into a new temporary directory, installs the locked public npm dependencies with install hooks disabled, and runs the production build there. The original checkout and any dirty/untracked files cannot supply build inputs. User/global npm configuration and arbitrary environment variables are excluded. A candidate containing disallowed uncompiled runtime inputs, symlink inputs, committed generated output or secret-looking public files fails closed. The build emits public regular files in `web/dist` and one self-contained private bundle in `web/worker-dist/worker.mjs`. Only those public files and the compiled Worker bundle are retained. Policy generation runs only in the client build; the private Worker output contains no public policy assets. Source files, maps and README files cannot become public assets. Sorted per-asset SHA-256 hashes and source/tree identity are written to `release.json`; the configurator verifies the retained bytes before writing a new `wrangler.json`.

A temporary directory and filtered environment are **not an operating-system sandbox**. Build configuration and npm build scripts execute candidate code. Run this phase only in the unprivileged build environment with no deployment tokens, private credentials or operator files available. The trusted deployment job consumes the retained artifact without rebuilding or executing candidate scripts. Public-file checks supplement source review; they do not establish that arbitrary code is safe.

The build artifact consists of `assets/`, `worker.mjs` and `release.json`. Configuration adds a separate runtime-only `wrangler.json`. Keep the directory private to the release process: its deployment configuration includes the API hostname, although it contains no authentication token. Do not put credentials, provider keys, database credentials or API tokens in any of these files. Cloudflare deployment credentials are provided separately by the trusted operator environment. The artifact workflow has no provider-write access; deployment credentials belong only to the trusted operator environment.

The final configurator argument selects `preview` or `production`; omitting it selects `preview`. Missing or invalid Worker mode fails closed. The mode is included in the runtime-configuration digest and the public release identity. `production` is an explicit environment setting, not authorization to deploy or bypass policy, account, provider or release gates. Promotion changes approved runtime configuration, never retained assets or Worker bytes.

The generated config disables bundling and additional-module discovery: the self-contained compiled Worker is uploaded as the retained build bytes, without a deployment compiler changing its hash. React and the renderer are bundled during the credential-free build; no package resolution or module discovery happens during upload. The official Wrangler CLI is a separate deployment tool. Application dependencies remain pinned in the reviewed lockfile. Pin Wrangler `4.156.0` in the trusted deployment environment. The release operator verifies its version and uploads the retained artifact without executing candidate scripts with deployment credentials.

## Routing and session contract

The current authentication contract uses local username/password accounts. The API decides whether login and registration are enabled. Preview admission and optional account deadlines are configured on the API; the frontend does not assign either policy. External-provider redirects are supported by the edge transport but do not enable an authentication provider. The edge also passes SSE without buffering; the application must use the API capability state and cannot claim live updates until end-to-end streaming is verified.

One Cloudflare Worker serves the compiled application through its `ASSETS` binding. `run_worker_first=true` applies security and privacy headers to every response. Preview mode applies noindex everywhere and `/robots.txt` disallows all crawling. Production mode permits indexing of successful public documents and policy responses and excludes API/release paths in robots; API, release identity, errors and redirects retain noindex and private no-store. Unapproved policy drafts retain their own HTML noindex directive regardless of mode. The shared React application renders `/`, `/companies` and `/companies/:id` as readable public HTML, with explicit `/de/`, `/fr/`, `/it/` and `/es/` localized variants and canonical English URLs without a prefix. `/en` aliases redirect. Public URLs never carry search text into metadata or source requests. Unknown public routes return 404; unavailable or invalid source data returns 503 rather than an empty catalogue. Browser history and in-app navigation use the same public metadata derivation as HTTP rendering, replacing descriptions and language links as pages change. Failed identity reads clear prior company metadata and set client noindex; an optional report failure still preserves the valid company identity. Query and fragment views, company-request views, owned search workspaces and open account dialogs set client noindex. Fragments and dialogs never reach HTTP, so their protection is applied after hydration; public HTTP landing markup contains no private workspace data. Browser noindex cannot remove preview response headers. `/index.html` remains the exact retained client template and is noindex. Asset HTML handling is `none`, with no catch-all HTML fallback; `/privacy.html` and `/usage.html` remain independently fetchable without a session or API. Workers.dev is disabled except for an explicitly configured matching preview origin above; provider version preview URLs remain disabled. Unapproved request origins are rejected.

| Route | Behavior |
| --- | --- |
| `/api/v1` and `/api/v1/*` | Forward the same path/query/method/body to the one configured HTTPS API origin. No JSON transformation, retries or response buffering. |
| `/__release/version` | Public noncached source SHA/tree, asset/Worker/artifact digests, runtime-configuration digest, deployment mode and API prefix. Other configuration fields are never returned. |
| `/privacy.html`, `/usage.html`, other assets | Public static bytes with security headers. Unknown assets stay 404. |

All API responses, including errors and redirects, have private `no-store` browser/CDN policy; conditional cache headers are removed. SSE passes the original response stream directly, carries event ids and reconnect headers unchanged, and cancels with the client. The backend owns event heartbeat, replay/revision correctness, concurrent connection limits, scan throttling and authenticated access. Confirm actual deployed first-event latency and reconnect behavior in the full browser gate; the local stream test proves the edge does not collect a page before responding.

Cookies, CSRF headers, `Origin`, `Last-Event-ID` and ordinary application headers pass to the API. The request-only `X-Justup-Locale` hint accepts one exact `en`, `de`, `fr`, `it` or `es` value on this same-origin API boundary; malformed or repeated values return private HTTP 400. Public document source fetches never forward this locale header, account cookies, authorization or arbitrary browser metadata. Caller-supplied forwarding, Cloudflare and reserved ingress headers are removed from proxy requests; `X-Forwarded-Host` and `X-Forwarded-Proto` are set from the approved frontend origin. Both the proxy and public company source reads authenticate to the configured API with `X-Justup-Ingress` and carry one validated incoming Cloudflare client IP in `X-Justup-Client-IP`. The API still owns session, CSRF, entitlement and per-client rate-limit enforcement.

API-on reads require the private Workers secret binding `API_INGRESS_SECRET`: the same canonical 32-byte base64url value configured as the API's `trustedIngressSecret` (`JUSTUP_TRUSTED_INGRESS_SECRET`). The trusted operator delivers it separately through the approved secret store and Workers secret binding; never put its value in `vars`, command arguments, source, public assets, release metadata or the runtime-configuration digest. Missing or malformed bindings or a missing/invalid `CF-Connecting-IP` fail closed before any API fetch. The Worker captures that incoming platform address before subrequests can replace Cloudflare headers; it never substitutes `X-Forwarded-For`, a caller's reserved header or a Tunnel connection address. Source-independent landing pages, notices and API-off previews need no ingress binding. Reserved ingress response headers are removed before returning to a browser. This source contract does not itself qualify a live Tunnel or enable providers; the deployed bypass/rate-limit/streaming proofs remain release checks.

Browser mutations require an exact matching `Origin`; this is additional to the API's CSRF-token check. Only `POST /api/v1/billing/stripe/webhook` may omit browser Origin, matching the API's raw-body signature-verification boundary. Foreign browser origins remain rejected, and no other mutation gets this exception. Provider callbacks must use GET redirects under the public `/api/v1` origin; a cross-site POST callback requires an explicit reviewed contract change. The API should issue `__Host-` session cookies with `Secure`, `HttpOnly`, `Path=/`, appropriate SameSite and **no Domain**. Backend-host cookies do not work on the public frontend and are not rewritten by the edge.

An enabled external sign-in provider must build login URLs and callback/return redirects from the approved public origin; enabling a provider requires its own reviewed API and policy contract. Redirects are passed to the browser without being followed by the edge, including external provider redirects. A redirect to the private API origin fails closed. Never expose internal hostnames in public return URLs. Do not put an interactive Cloudflare Access interstitial on callback/API/policy routes without verifying provider callbacks, public policy fetches and SSE; audience restriction belongs in the agreed backend session/access controls for this deployment.

The content security policy permits local scripts/fonts, local and HTTPS images, local connections and inline styles used by the interface. It blocks remote script execution, framing and external form submissions. External-provider sign-in, if enabled, must use a server-owned navigation URL rather than an embedded script. Preserve this contract when changing authentication or the interface.

## Deploy only after approval

After the inputs above are recorded and the candidate passes the integrated gate, the release operator may use the pinned official CLI:

```sh
npx --yes wrangler@4.156.0 deploy --dry-run --config /tmp/justup-candidate/wrangler.json --outdir /tmp/justup-bundle
# The following is a provider write; run only after the recorded approval and gate.
npx --yes wrangler@4.156.0 deploy --config /tmp/justup-candidate/wrangler.json
node scripts/frontend-smoke.mjs https://<approved-preview-host> /tmp/justup-candidate
```

The custom-domain deployment can create DNS/TLS resources. Inspect existing DNS and the exact account/zone first; never use the command as a discovery probe. The generated config deliberately omits an account id, so the trusted operator must select and verify the approved account explicitly. Deployment remains an explicit authorized operator action; the artifact workflow has no provider-write credentials.

Freeze each candidate-specific hostname and its compatible API/runner during acceptance. Callback hostnames, when used, must remain fixed too. Record the Cloudflare version/deployment ID, config digest and source identity. A stable hostname is a mutable route, **not an immutable deployment URL**. A mutable route does not satisfy the release guide's immutable-preview-URL requirement by itself: the release owner must record a candidate-specific owned hostname and matching provider callbacks, or approve and implement an equivalent independently pinned routing mechanism before claiming that requirement. Another deployment on a tested hostname invalidates its report.

Public company rendering uses only the configured HTTPS API origin. Its source requests send only `Accept: application/json` and the authenticated ingress secret/client-IP headers; they forward no cookies, browser authorization or other request metadata and perform no model/session calls. Redirects are never followed with those private headers. Source reads have a 2.5-second total deadline and a 384 KiB body limit. Company metadata URLs are restricted to HTTPS public hostnames at decode and render boundaries; browser-local addresses, credentials and custom ports are discarded. Generic URL safety preserves paths/queries and does not establish career-page approval. Unsupported legacy `sources` are omitted entirely. Public company HTML and client navigation read only the report’s validated, approved `sourceChecks` links and supplied last-check dates; missing dates are omitted. Report evidence is optional, so its absence or failure preserves the company identity, with a separate retry after a browser report failure. The same optional report read supplies fresh structured role and salary samples, including their explicit sample denominators and original pay units; absent, stale or invalid numerical evidence is omitted. Public hydration data contains only decoded company facts, the validated public report projection and routing information in an escaped, nonexecuting template; CSP needs no inline script exception. Public HTML uses its URL render locale without account data or incoming cookies. Its bootstrap locale seeds matching hydration and then releases default entries to saved account or guest/browser preferences. Only explicit `/de/`, `/fr/`, `/it/` and `/es/` prefixes remain authoritative; `explicitLocale` records that distinction separately from the render locale. Manual browser-default choice removes the prefix, and history navigation preserves the mounted search draft. A small, five-locale UTC-day cache contains only source-independent landing markup and its matching public bootstrap; it is initialized outside request handling. Company facts and metadata/config identities are never cached there. Local Node timings are not proof of the provider CPU ceiling; record actual Worker initialization, CPU and memory before release. The client hydrates the same App, defers closed private surfaces, and keeps the search workspace mounted during company navigation. Catalogue requests use `limit=20` and the server-owned public `nextCursor`; each bounded response is rendered without slicing or inventing totals. Non-JavaScript documents expose real next links, while the client consumes the same continuation only through its paced viewport gate. Filtered/cursor URLs stay `noindex, follow` in production and canonicalize metadata to the catalogue root; preview, private API responses and errors retain strict noindex/nofollow protections. Locale changes preserve their accepted bounded `q` and `cursor` values without serializing or replacing unsent edits; direct request fragments reconcile after the matching hydration render; stale cursors keep existing rows and offer a user-triggered reload instead of claiming completion. Catalogue rows already on screen survive hydration; unseen rows enter the existing 450 ms viewport-gated queue.

The smoke command has a 60-second budget, per-request timeout and maximum 200 assets. It uses GET only, validates reported source/config digests and deployment mode and downloads every declared public asset, including `/index.html`, to compare actual bytes. The dynamic root document is checked separately for readable shared content, canonical URL, runtime identity, inert public bootstrap and references to retained hashed assets. Rendered company facts and timestamps are runtime observations, not immutable artifact bytes; smoke does not claim their HTML hash equals `index.html`. It checks both public policies/robots, and confirms noncached session/version JSON and health readiness. It does not sign in, create accounts, run AI tasks, send mail or change data. API/runner identity, reviewed policy content, access enforcement, SSE reconnect and browser journeys remain separate release-gate checks; a smoke pass alone cannot approve release.

## Run the deployed browser journey

The `JUSTUP_SMOKE_URL=https://<fixed-host> npm run test:browser` mode is read-only. The separate acceptance mode below runs five isolated language journeys, each registering its own generated account and submitting two search interpretations: ten bounded interpretations in total. Run it only after the release owner has recorded the fixed frontend/API/runner candidate, actual provider isolation and spend guard, reviewed policies, fresh imported data and an approved preview invite. Local tests of the harness are not deployed evidence.

First run the exact-byte smoke above against the retained artifact. Then prepare a JSON configuration outside the checkout with these fields, replacing every placeholder with the recorded identity or reviewed real-source scenario:

```json
{
  "origin": "https://<candidate-specific-owned-host>",
  "frontend": {
    "deploymentMode": "preview",
    "sourceSha": "<40-character source commit>",
    "treeSha": "<40-character source tree>",
    "assetsSha256": "<retained manifest hash>",
    "workerSha256": "<retained manifest hash>",
    "artifactSha256": "<retained manifest hash>",
    "runtimeConfigSha256": "<configured runtime hash>"
  },
  "api": {
    "sourceCommit": "<same source commit as frontend>",
    "schemaVersion": 2,
    "buildIdentity": "<fixed backend build identity>",
    "runnerIdentity": "<fixed runner identity>",
    "importGeneration": "<recorded snapshot generation UUID>"
  },
  "policies": {
    "admittedLocales": {
      "en": {
        "locale": "en", "reviewed": true, "reviewedLocale": "en", "fallback": false,
        "version": "<operator-reviewed en policy version>",
        "privacyUrl": "https://<candidate-specific-owned-host>/privacy.html",
        "usageUrl": "https://<candidate-specific-owned-host>/usage.html",
        "privacySha256": "<reviewed privacy.html byte hash>",
        "usageSha256": "<reviewed usage.html byte hash>"
      },
      "de": {
        "locale": "de", "reviewed": true, "reviewedLocale": "de", "fallback": false,
        "version": "<operator-reviewed de policy version>",
        "privacyUrl": "https://<candidate-specific-owned-host>/privacy.de.html",
        "usageUrl": "https://<candidate-specific-owned-host>/usage.de.html",
        "privacySha256": "<reviewed privacy.de.html byte hash>",
        "usageSha256": "<reviewed usage.de.html byte hash>"
      },
      "fr": {
        "locale": "fr", "reviewed": true, "reviewedLocale": "fr", "fallback": false,
        "version": "<operator-reviewed fr policy version>",
        "privacyUrl": "https://<candidate-specific-owned-host>/privacy.fr.html",
        "usageUrl": "https://<candidate-specific-owned-host>/usage.fr.html",
        "privacySha256": "<reviewed privacy.fr.html byte hash>",
        "usageSha256": "<reviewed usage.fr.html byte hash>"
      },
      "it": {
        "locale": "it", "reviewed": true, "reviewedLocale": "it", "fallback": false,
        "version": "<operator-reviewed it policy version>",
        "privacyUrl": "https://<candidate-specific-owned-host>/privacy.it.html",
        "usageUrl": "https://<candidate-specific-owned-host>/usage.it.html",
        "privacySha256": "<reviewed privacy.it.html byte hash>",
        "usageSha256": "<reviewed usage.it.html byte hash>"
      },
      "es": {
        "locale": "es", "reviewed": true, "reviewedLocale": "es", "fallback": false,
        "version": "<operator-reviewed es policy version>",
        "privacyUrl": "https://<candidate-specific-owned-host>/privacy.es.html",
        "usageUrl": "https://<candidate-specific-owned-host>/usage.es.html",
        "privacySha256": "<reviewed privacy.es.html byte hash>",
        "usageSha256": "<reviewed usage.es.html byte hash>"
      }
    },
    "fallbackApprovals": {}
  },
  "scenario": {
    "query": "<reviewed query yielding the selected real posting>",
    "warnedQuery": "<reviewed edit requiring explicit limitations confirmation>",
    "companyId": "<selected imported company id>",
    "companyName": "<its unambiguous imported name>",
    "sourceUrl": "https://<selected real employer posting>"
  }
}
```

`api.schemaVersion` is the application database schema reported by `/api/v1/version`; full acceptance now requires version 2 and rejects stale application version 1. This does not change independent search/import, runner, SSE, source or JEV wire schema versions.

The former English-only `policies.version`, `privacySha256` and `usageSha256` fields are no longer accepted. Migrate release evidence by listing **all five** interface locales in `policies.admittedLocales`, each with the seven exact server policy-state fields above and both approved document hashes. Locale keys and fields are strict; repeated JSON keys, including escaped equivalents, reject the file. Partial locale maps cannot pass full acceptance. The URLs must be the candidate origin’s exact English root or `.de.html`, `.fr.html`, `.it.html` and `.es.html` notice routes; query strings, fragments, foreign origins and alternate paths are rejected. The live UI journey always runs once for each of the five fixed locales; a scenario cannot narrow that set.

The empty `fallbackApprovals` map means no fallback is approved. Only an explicit operator decision can justify a fallback. For example, an approved German-to-English fallback would keep the `de` admitted entry but set `locale:"de"`, `reviewedLocale:"en"`, `fallback:true`, and the exact same version, English URLs and hashes as the directly reviewed `en` entry. It also requires `fallbackApprovals.de = {"reviewedLocale":"en","version":"<same approved version>","operatorApproved":true}`. The server must report that exact selected locale, reviewed target and fallback. A fallback target must itself be directly reviewed and declared; fallbacks cannot chain. Recording an example or setting a boolean does not supply the operator decision, approve English fallback or approve the current drafts.

The read-only preflight probes each admitted locale through the request-only `X-Justup-Locale` header, without creating a preference cookie. It checks every declared locale against authoritative session policy metadata, then hashes each unique reviewed document’s actual bytes. Its `html.lang`, kind, body and meta version, `approved` status and `reviewed=true` metadata must agree with the recorded target. Correct hashes alone cannot admit a draft or a document in the wrong language. The generated `2026-11-01` notices have approved source metadata but cannot pass admission until the server presents matching reviewed locale identities and the exact deployed hashes are recorded and verified.

Use a supported primary-filter query and a previously reviewed warned edit yielding an eligible limited-access posting first seen between 48 hours and 14 days ago. Registration remains unverified and limited; this journey neither grants full access nor establishes provider eligibility or a free period. Do not use personal search text, a new speculative company lead or an unbounded residual-matching scenario. Search interpretation can invoke the approved model, including its bounded repair; the known-company identity request must resolve immediately from the fixed imported catalogue without company research. The invitation is supplied as `JUSTUP_ACCEPTANCE_INVITE` by the protected process environment, never in this JSON, a command argument, a URL or source control. With that environment already set:

```sh
JUSTUP_ACCEPTANCE_CONFIG=/private/path/candidate-gate.json npm run test:browser
```

Missing configuration, invitation or matching identities fails closed. The acceptance harness requires preview mode; it cannot run its mutating test-account journeys against a production configuration. The read-only preflight checks the fixed frontend/API/runner/import identities, runner heartbeat, fresh snapshot, all five admitted policy states, approved document hashes/versions/languages and exact public URLs, registration/search/request availability, visitor private-route denial and 48-hour-to-14-day result bounds. Only then can registration start. Each of the five browser journeys has a 240-second timeout and a fresh context. It registers its own generated account, logs out/in, searches for the selected real source, preserves accepted rows and revision during a warned edit, explicitly confirms it, records the known company identity, and verifies wrong-password handling and its own account deletion. It rechecks fixed identities and the selected locale’s exact policy state before registration, before the company request and at completion. Non-English journeys use their explicit public route prefix and stable controls rather than English labels.

Every language journey creates only its own random username/password and keeps them in memory; cleanup runs for that isolated account even when the journey fails. Cleanup verifies the exact frontend/API/runner/import candidate and that session ownership matches that generated account before deleting it, and refuses foreign users or changed account ids. Withdrawal of policy approval blocks new processing but does not prevent attempting permitted deletion of the still-owned signed-in account. If withdrawn approval prevents the post-deletion login check, cleanup remains conservatively unconfirmed and requires operator verification; policy denial is not proof that credentials were removed. A transport failure can prevent cleanup; a failed cleanup requires private operator verification before rerunning. Automatic test retries are disabled. Live mode disables traces, screenshots, video, automatic error-context Markdown and persisted browser state; failures report a fixed stage label without request bodies, credentials or Playwright fill call logs. Record only sanitized pass/fail, candidate identities and the verified cleanup outcome in release evidence.

The same reviewed query and company/source data are used unchanged across language journeys; employer content and user search text are not translated. Ten interpreted requests, their bounded repairs and any evaluations remain subject to the existing cumulative/provider caps at an eventual approved run. The harness does not bypass spend guards. Five localized UI journeys are not multilingual model-quality evidence; that evidence is required separately.

This journey does not establish real provider-down recovery, ambiguous-company research, resource/load limits, physical retention/deletion, restore/rollback, SSE or unavailable product features. Those checks remain in the API/runner/operations and full release report. The harness does not publish `Preview / verified` or authorize runtime promotion.

## Promote the retained product artifact

Production promotion follows the [release guide](development-process.md#6-verify-a-release-before-it-goes-live). `dev` is an integration source, never the production deployment source. Confirm the merged `main` tree equals the verified release-candidate tree, retain the exact asset/Worker digests, then create a new runtime-only configuration with the approved production origins and explicit `production` mode. Record its separate configuration digest. Preserve the preview directory and its configuration as evidence. Create a fresh private deployment directory containing only the selected `assets/`, `worker.mjs` and `release.json`, verify those bytes with trusted `verifyArtifact`, then run the configurator there with production origins and explicit `production`. Do not copy the preview `wrangler.json`: the configurator writes a new file and refuses to overwrite one. Do not rebuild or edit retained asset, Worker or manifest bytes to change environments. Run read-only byte smoke and the approved production verification plan; the preview-only mutating harness does not authorize production test accounts or model spending.

Enabling static indexing alone does not establish catalogue discoverability. Verify stable crawlable company URLs, meaningful public content and route-specific metadata on the deployed candidate before making that claim.

## Limits, observation and rollback

Check the selected account's current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [asset-routing behavior](https://developers.cloudflare.com/workers/static-assets/binding/) before deployment. Because this Worker handles headers for all requests, count asset requests conservatively as Worker invocations until measured otherwise. Keep the live allowance and measurements in protected operator evidence, not in this guide.

For a bounded preview, stop admitting new testers at 50% of the daily request allowance and investigate any CPU-limit error, sustained API 5xx or dropped SSE connection. The release owner records measured p50/p95 first-byte latency, API error rate, SSE first-event/reconnect latency, request count and Worker CPU in protected candidate evidence during the agreed representative load. Summarize the decision and outcome in the release issue. Record actual measurements before inviting users; these stop points are limits, not measured capacity. No automatic upgrade or paid overflow is authorized. Backend limits, schedules, billing and outbound-mail disablement are owned and verified separately; edge headers cannot establish those properties.

Retain the previous complete artifact and its config, deployment ID and browser/API compatibility report. For rollback, stop acceptance traffic, have the backend owner select a compatible retained API/runner/database recovery path, redeploy the previous frontend artifact with its approved config, and rerun smoke plus affected authenticated journeys. Do not rebuild from a branch alias. On preview expiry, remove only the approved preview Worker/domain mapping and its scoped deployment access, after the backend owner has cleaned up isolated data/tasks. Record sanitized cleanup status in the hosting issue and exact identifiers in protected operator evidence; failed cleanup blocks another candidate.

## Test ownership

Frontend hosting owns `deploy/frontend/*.test.mjs`: edge routing/privacy/stream contracts plus exact-commit packaging and remote-byte verification. The suite uses Node's built-in test runner, temporary Git repositories with a dependency-free deterministic build command, and fake fetch responses; no provider, credential, DNS or real deployment is required. Expected contract-suite runtime is under thirty seconds, in the deployment-contract CI group. The required CI lane first builds the actual client and Worker, then runs compiled-Worker public HTML/metadata/security/status/deadline contracts and browser hydration/no-JavaScript/history/reveal journeys; a packaging fixture is not proof that the application compiles or behaves correctly. The integrated CI registers `deploy/frontend/**` and `scripts/frontend-*.mjs` in the central selector, with broad checks for deployment-contract changes. The explicit deployed smoke belongs to the release-verification issue rather than ordinary PR CI.
