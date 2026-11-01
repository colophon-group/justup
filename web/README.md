---
summary: Develop, build and verify the typed Justup browser application.
read_when: Changing the interface, connecting the API or checking compiled frontend assets.
---

# Justup web application

The browser application uses React and strict TypeScript, built by Vite. Its source lives in `src/`; `policies/` contains aligned Privacy and Usage drafts and their static generator; `public/` contains local assets such as policy CSS. Generated `dist/` public assets and the private `worker-dist/` bundle are ignored by Git. The application calls the authoritative same-origin `/api/v1` service for account access, accepted searches, job evidence and company requests.

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

The production build runs TypeScript checking, emits hashed client assets and ten static notices into `web/dist`, and bundles shared public server rendering plus the HTTP boundary into `web/worker-dist/worker.mjs`. The preview server uses `http://127.0.0.1:4173`. A working bundle does not establish backend availability or approve a deployment.

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
| Public documents readable without JavaScript | `src/public/` shared App rendering; `policies/` generated notices and `public/policies.css` |

Account, query, draft and request state remains in memory or on the server, never in application localStorage. A session change cancels old operations and clears private view state. Network data is validated before rendering; React renders text without raw HTML insertion. Company evidence is displayed without inferring headquarters, missing pay, monitoring dates or hiring history.

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

The interface supports English (`en`), German (`de`), French (`fr`), Italian (`it`) and Spanish (`es`). The pure `src/i18n/locales.ts` resolver checks browser languages in order, normalizes regional tags to a supported base language, and falls back to English. Settings can save an account override through the owner-bound `/preferences` compare-and-set API; browser/default (`null`) follows browser settings. The accepted account language stays visible during same-owner reloads or a revision conflict; responses from a previous account cannot replace it. Changing the interface never rewrites a query, accepted configuration, stored title or employer text, and never submits an interpretation request.

A manual visitor override uses only the presentation cookie `justup_interface_locale` (`Path=/`, `SameSite=Lax`, `Secure` on HTTPS, one-year maximum age); browser/default removes it. No automatic detection writes this cookie or creates a visitor record. A signed-in account ignores the visitor choice, and the choice is never copied into an account. Public HTML uses a URL-owned language where explicitly selected; a hydration seed only stabilizes the first render before account/browser resolution.

Presentation links select the matching static Privacy and Usage documents: `/privacy.html` and `/usage.html` for English, or `/privacy.{locale}.html` and `/usage.{locale}.html` for the other four languages. Authentication separately requires the server’s reviewed policy metadata to match the current interface language, canonical same-origin paths, version and exact reviewed locale. An explicit approved fallback uses the server’s reviewed URLs and identifies their language before sign-in. Missing, invalid or mismatched approval never enables account access. Locale changes refresh session policy metadata; successful rendering never approves a document.

 The typing examples are decorative and never become input values or submit searches. Posting-language selection, followed-company filters, viewed-state writes, live result streaming, subscription controls and Hiring Wire require supported service/UI contracts before they can be offered. These are product-readiness requirements. Until live streaming is supported, the explicit results action checks new data for the accepted revision without a model call.

When result responses supply hidden-match metadata, the access notice displays the reported exact count or an explicit lower bound; absent or zero counts produce no notice. The compressed-paper illustration contains no restricted job data.

`/privacy.html` and `/usage.html`, plus `.de.html`, `.fr.html`, `.it.html` and `.es.html` variants, are generated static, explicitly unapproved drafts. Development and public client builds use the same generator; private SSR bundles receive no policy assets. Their successful build or integration does not approve the notices or enable sign-in. Actual data flows, public policy version/URLs, operator review and deployed verification remain required before sharing the service. See the [policy review guide](../docs/policies.md) and [hosting guide](../docs/frontend-delivery.md).

Public landing, catalogue and company reports use `/`, `/companies` and `/companies/:id`, with `/de/`, `/fr/`, `/it/` and `/es/` variants. The default server locale seeds matching hydration; explicit language prefixes remain authoritative and default entries resolve account or browser preferences after hydration. Public catalogue pages share bounded server continuation with the client’s paced infinite reveal. Source build and local fixtures do not establish backend availability or deployed release acceptance.
