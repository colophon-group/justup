---
summary: Develop, build and verify the typed Justup browser application.
read_when: Changing the interface, connecting the API or checking compiled frontend assets.
---

# Justup web application

The browser application uses React and strict TypeScript, built by Vite. Its source lives in `src/`; `public/` contains the static Privacy and Usage documents. Generated `dist/` assets are ignored by Git. The application calls the authoritative same-origin `/api/v1` service for account access, accepted searches, job evidence and company requests.

## Develop and build

Use Node 24.22.2, then run from the repository root:

```sh
npm ci
npm run dev
```

Vite serves the development application on `http://127.0.0.1:5173`. Without a same-origin API, the application reports that the service is unavailable. Do not put credentials in frontend source, public files or Vite environment variables. The deployed edge boundary forwards API requests; local API routing must use the same session, Origin and CSRF contract.

Build and inspect the compiled application:

```sh
npm run build
npm run preview
```

The production build runs TypeScript checking and emits hashed assets into `web/dist`. The preview server uses `http://127.0.0.1:4173`. A working bundle does not establish backend availability or approve a deployment.

## Find the implementation

| Area | Location |
| --- | --- |
| Session bootstrap, application layout and routes | `src/app/` |
| Validated public models, JSON transport and bounded task polling | `src/api/` |
| Search text, saved tabs, proposals, results and typing hints | `src/features/search/` |
| Settings, credentials, logout and password-confirmed deletion | `src/features/account/` |
| Company catalogue, source reports and identity requests | `src/features/companies/` |
| Dialog, company mark and measured viewport reveal behavior | `src/shared/` |
| Coral, cream and ink tokens and component styling | `src/styles/` |
| Public documents readable without JavaScript | `public/` |

Account, query, draft and request state remains in memory or on the server, never in application localStorage. A session change cancels old operations and clears private view state. Network data is validated before rendering; React renders text without raw HTML insertion. Company evidence is displayed without inferring headquarters, missing pay, monitoring dates or hiring history.

When visitor search is enabled, signed-out searches use the separate cookie-bound `/visitor/` routes. The server advertises the visitor deadline; its current default is 24 hours. Account routes remain private. Saved tabs, selected search, unsent drafts, viewed positions and recovered drafts come from the server workspace. One revision-checked writer saves edits; a conflict keeps the local text visible until the reader chooses which copy to keep. A search deleted elsewhere cannot be recreated by retrying an old draft write.

Before submitting credentials, the application saves the latest visitor draft. After a successful account handoff it reloads the server's merged workspace, without reinterpreting the query. A lost credential response triggers a session read rather than another credential submission. Recovered drafts require an explicit use or discard action. Clicking an employer posting marks it viewed while preserving native link navigation; opening the company report does not. Hidden-match counts retain the server's exact, lower-bound, pending or unavailable status.

The account form requires reviewed same-origin policy URLs/version and explicit server login/registration availability. Invitation entry follows the server’s `authentication.requiresInvitation` flag; a missing flag conservatively requires an invitation. Public registration omits the invitation field and credential when the server explicitly permits it. Invalid credentials do not revoke a valid session. Passwords and invitation fields clear when submitted or dismissed; account deletion requires a password and confirmed server completion. Cancellation prevents a late operation from changing another account's interface.

The result refresh action reads the accepted search revision without submitting the current text for interpretation. Unsent edits remain in the search bar. Search warnings can offer an editable company-request lead. Opening it sends no request; only form submission starts discovery. Unverified imported results are cleared and paused with the source reason and a manual retry, rather than reported as a completed empty search.

Company requests use stable request keys and server task identities. A network interruption or polling timeout can resume the same pending work. Clarification and exact candidate confirmation remain explicit; a recorded identity never claims that career-page collection has started.

## Verify behavior

```sh
npm run typecheck
npm run test:web
npm test
```

Pure API/state contracts use the Node test runner. Playwright journeys exercise compiled assets, including malformed responses, failed edits, task resumption, stale revisions/accounts, confirmed deletion, company requests and source links. Both lists measure the actual next slot before revealing a row, with a 450 ms cadence after initial visible content. Backgrounding or scrolling away stops consumption; reduced motion removes animation while retaining pacing.

Browser fixtures are outside `web/` and are not included in public assets. Explicit deployed smoke tests run without request interception. A separate fixed-candidate acceptance mode creates a test account and exercises sign-in, search, known-company confirmation and deletion after read-only identity, source and policy checks; see [deployed browser instructions](../docs/frontend-delivery.md#run-the-deployed-browser-journey). Live suites stay out of default CI and retain no credentials, traces, media or automatic error context. Provider, operations and full deployed release acceptance follow the [release verification guide](../docs/development-process.md#6-verify-a-release-before-it-goes-live).

## Product and service state

The browser consumes the same-origin `/api/v1` account and search API through the [validated API client](src/api/client.ts). The same application serves visitors and signed-in accounts. Session capabilities govern search interpretation and company-request submission; reviewed policy metadata and explicit authentication availability govern account forms. Settings show the server's access description, with a neutral fallback when none is supplied. Billing availability never implies that a payment or subscription has occurred.

Source coverage is evidence, not an environment label. Imported snapshots are identified explicitly, with verification time and stale state when supplied. Other source types retain their reported description without being called a snapshot or treated as continuously monitored. Company pages display only reported facts.

The interface is currently English. The typing examples are decorative and never become input values or submit searches. Posting-language selection, followed-company filters, viewed-state writes, live result streaming, subscription controls and Hiring Wire require supported service/UI contracts before they can be offered. These are product-readiness requirements. Until live streaming is supported, the explicit results action checks new data for the accepted revision without a model call.

When result responses supply hidden-match metadata, the access notice displays the reported exact count or an explicit lower bound; absent or zero counts produce no notice. The compressed-paper illustration contains no restricted job data.

`/privacy.html` and `/usage.html` remain static, explicitly unapproved drafts. Their successful build or integration does not approve the notices or enable sign-in. Actual data flows, public policy version/URLs, operator review and deployed verification remain required before sharing the service. See the [policy review guide](../docs/policies.md) and [hosting guide](../docs/frontend-delivery.md).
