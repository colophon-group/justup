---
summary: Develop, build and verify the typed Justup browser application.
read_when: Changing the interface, connecting the API or checking compiled frontend assets.
---

# Justup web application

The browser application uses React and strict TypeScript, built by Vite. Its source lives in `src/`; `public/` contains the static Privacy and Usage documents. Generated `dist/` assets are ignored by Git. The application calls the authoritative same-origin `/api/v1` service and ships no fictional job records or simulated accounts.

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

The account form requires reviewed same-origin policy URLs/version and explicit server login/registration availability. Invalid credentials do not revoke a valid session. Passwords and invitation fields clear when submitted or dismissed; account deletion requires a password and confirmed server completion. Cancellation prevents a late operation from changing another account's interface.

Search warnings can offer an editable company-request lead. Opening it sends no request; only form submission starts discovery. Unverified imported results are cleared and paused with the source reason and a manual retry, rather than reported as a completed empty search.

Company requests use stable request keys and server task identities. A network interruption or polling timeout can resume the same pending work. Clarification and exact candidate confirmation remain explicit; a recorded identity never claims that career-page collection has started.

## Verify behavior

```sh
npm run typecheck
npm run test:web
npm test
```

Pure API/state contracts use the Node test runner. Playwright journeys exercise compiled assets, including malformed responses, failed edits, task resumption, stale revisions/accounts, confirmed deletion, company requests and source links. Both lists measure the actual next slot before revealing a row, with a 450 ms cadence after initial visible content. Backgrounding or scrolling away stops consumption; reduced motion removes animation while retaining pacing.

Browser fixtures are outside `web/` and are not included in public assets. Explicit deployed smoke tests run without request interception; full real-service/model/source and fixed frontend/API/runner acceptance remains under the [release verification work](https://github.com/colophon-group/justup/issues/36).

## Current availability

The browser consumes the [agreed API contract](https://github.com/colophon-group/justup/issues/33). Unavailable services fail visibly; no model-backed search, live SSE, followed/viewed writes, posting-language preferences, hidden-match totals, billing or news signal is simulated. The 51 English typing examples are decorative and never become input values or submit searches.

`/privacy.html` and `/usage.html` remain static, explicitly unapproved drafts. Their successful build or integration does not approve the notices or enable sign-in. Actual data flows, public policy version/URLs, operator review and deployed verification remain required before sharing the service. See the [policy review guide](../docs/demo-policies.md) and [hosting guide](../docs/demo-preview-hosting.md).
