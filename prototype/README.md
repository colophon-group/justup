---
summary: Run the API-driven Justup integration interface and its browser contracts.
read_when: Changing browser behavior, wiring the demo API, or checking preview journeys.
---

# Justup browser interface

`prototype/` is the current static browser client for same-origin `/api/v1`. A static file server alone displays an explicit unavailable state. Bundled listings/company reports, simulated authentication, browser search interpretation, fake company discovery and sample employer pages have been removed. Payment collection is disabled. The interface is explicitly English-only; it does not pretend to translate model/service messages.

## Run and verify

```sh
npm ci
npm test
python3 -m http.server 4173 --bind 127.0.0.1 --directory prototype
```

Open [the local interface](http://127.0.0.1:4173). Real flows require the same-origin API/proxy described by the hosting guide; never place credentials in static browser files.

`npm test` runs JavaScript syntax checks and deterministic Playwright journeys. Network fixtures live only in `tests/browser/api-fixture.mjs`, outside the deployed tree. They cover saved revisions, 202 tasks, failed edits, explicit warning confirmation, real credentials/error handling, policy review gating, deletion, expiry, stale account/search responses, request clarification/acceptance, source URL validation and viewport reveal. Passing fixtures does not establish live-service correctness or AI quality.

For an explicit smoke check against real services, without interception:

```sh
JUSTUP_SMOKE_URL=https://your-owned-preview.example npm run test:browser
```

This checks actual session connectivity and frontend links. Full signed-in journeys, model evaluation, deletion behavior and fixed frontend/API/runner build identities remain deployed acceptance work under [demo-preview-verification](https://github.com/colophon-group/justup/issues/36).

## Runtime map

| File | Responsibility |
| --- | --- |
| `api.js` | Same-origin credentialled JSON, CSRF, idempotency, timeouts and nested safe errors |
| `app.js` | Session/search/task/result/request state, asynchronous guards and routes |
| `surfaces.js` | Settings overlay, invite-only credentials, sign-out and password-confirmed deletion |
| `posting-languages.js` | Full ISO language picker; unavailable without its server capability |
| `search-examples.js` | Decorative typewriter examples; never submitted as user text |
| `company-report.js` | Actual identity/source facts and supplied optional series only |
| `wire.js` | Empty unless genuine publisher signals exist; unavailable in the first slice |
| `i18n.js` | English-only adapter, independent of posting languages |

## API and behavior

The single integration target is the [agreed demo-live-interface contract](https://github.com/colophon-group/justup/issues/33#issuecomment-6546169847). No endpoint is claimed to be deployed by this client change.

- Session uses `user`, `access`, `csrfToken`, `capabilities`, `coverage` and reviewed policy URLs/version. Visitors retain an unsubmitted draft in memory; model-backed saved searches require sign-in. The initial surface does not invent an active all-jobs search.
- Real account routes are `/auth/login` and `/auth/register` with username/password and registration invitation. Credentials never enter storage, URLs or logs; password/invitation fields clear on submission and dialog close. Invalid login is handled locally so it cannot erase the visitor's query. Server-reviewed static policy metadata and nonempty version gate the form. Privacy and Usage links appear in the dialog and stable footer; no policies JSON service is required.
- `/searches` creates/edits with `query`, `requestKey` and `expectedRevision` on edit. A 202 task is polled at owner-only `/tasks/:id` with bounded backoff. Accepted search revisions remain separate from drafts/proposals. Failed edits retain the old results and unsent input. The user's text is the visible request; generated title labels the tab, and actionable unmet requirements/warnings remain visible without a generated summary.
- Warned task proposals require an explicit `/searches/:id/confirm` with exact `proposalId` and expected revision. A warning never silently changes criteria. Task envelopes currently consume named `result.search`, `result.request` or `result.proposal`; the [remaining response-envelope questions](https://github.com/colophon-group/justup/issues/33#issuecomment-6546136711) need backend confirmation before integration freezes.
- Results use source `firstObserved`, structured values and `continuation` (`open`, `pending`, `paused`, `exhausted`, `failed`). Search/revision/generation guards reject stale responses; deduplication and repeated-cursor checks prevent loops. Zero unfinished batches continue; failed/paused AI checks never become a clean zero-results conclusion. Only the backend may deliver authorized confirmed matches, never restricted DTOs hidden behind CSS. Unsafe/missing source URLs produce an explicit error. Postings link to their actual source; company name/logo independently open the company report.
- Company requests send `input` and `requestKey`; pending work uses tasks. Clarification/unresolved states never invent identities. Acceptance binds exact `candidateId` and `previewRevision` with stable idempotency. Identity acceptance does not claim crawler setup started. Session/request-generation guards reject superseded previews, including after logout/expiry. Catalogue/report facts come only from imported evidence; missing historical/salary/geographic data stays unavailable.
- Sign-out/account deletion clear account state on confirmed completion. Deletion requires password re-entry. Expiry clears protected state immediately and exposes reconnect. Server-side ownership, cookie flags, rate limits, deletion semantics and model limits remain backend responsibilities.

All mutations carry `X-CSRF-Token`; relevant creates/accepts also use idempotency. Nested errors are `{error:{code,message,requestId}}`; retry timing is respected where supplied. No client-generated trial/paid/legacy access exists.

## Optional features and motion

The first demo contract disables SSE, follows, viewed writes, preferences, hidden-match counts and Hiring Wire. Their controls are hidden or explain unavailability; there are no simulated successes. Missing hidden counts produce no count claim. The broader optional adapters require explicit capabilities and are not evidence that backend endpoints exist. No current SSE implementation is claimed; absent live-update capability states that refresh is required.

The existing coral/cream/ink design, text-size logos, display headlines, typewriter body, WANTED requests and everyday newspaper humor remain. Errors, account access and privacy wording stay literal. Company logos retain original colours; feedback uses cream/coral rather than an ink background.

Additional rows reveal individually with 450ms pacing only while the tail is actually in view. Scrolling away or backgrounding stops consumption. The catalogue uses the same pacing. Reduced motion removes visual motion while retaining pacing. Typing hints stop on interaction and resume after blur only when the field is empty; their examples never become drafts or submit values.

## Browser state

Account data, tokens, queries, unsent drafts, requests, follows and viewed IDs are never persisted in localStorage. Per-search unsent text stays only in memory so tab switches and deleting an inactive search preserve it. Reload restores only accepted server searches. The obsolete `justup-prototype-v1` cache is removed without reading or uploading it. Logout, expiry and deletion clear private memory, request generations and old response destinations.
