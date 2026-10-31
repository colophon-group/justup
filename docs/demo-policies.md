---
summary: Public draft policy pages, required data-flow inventory and operator review for the temporary web preview.
read_when: Reviewing demo privacy, usage conditions, sign-in disclosure or policy publication.
---

# Demo Privacy and Usage information

The public `/privacy.html` and `/usage.html` pages are static, English web pages. They work without JavaScript, a session or any API. Their only asset is the local `policies.css`; they do not load identity providers, analytics or remote fonts. Serving these files can still produce hosting/access logs, which must be inventoried. The pages are marked `noindex,nofollow` for the temporary preview.

The current revision is **`demo-draft-1`**, marked **draft — review incomplete** in visible copy, HTML metadata and body attributes. There is no effective date, approved operator identity, contact or implied legal approval. These pages deliberately describe missing facts rather than fill them with invented details. They must not be represented as a completed privacy notice or approved usage conditions.

## Sign-in and publication gate

The interface links both public URLs from sign-in and stable footer navigation. Its deployment/auth configuration must keep real sign-in disabled until the operator reviews the actual implementation, final static pages and owned HTTPS URLs. There is no runtime policy JSON endpoint or policy fetch dependency.

The interface consumes `session.policies.reviewed`, a nonempty `version`, `privacyUrl` and `usageUrl`. Backend/auth configuration must only advertise approval for the exact static revision reviewed by the operator. An absent approval or version keeps sign-in unavailable. A client flag, a passing browser test, or the presence of these draft files is not approval. The server must also prevent real registration and login when policy approval is absent; hiding a button is insufficient.

To approve a revision, replace draft language with confirmed, plain-language information; fill the inventory below; record the operator's review in the issue; assign one version and effective date across both pages; update their visible and machine-readable status/version; verify the public URLs from a signed-out browser; then enable that same version in auth configuration. Any material data-flow or notice change needs another review. Do not enable sign-in by merely changing the draft metadata.

## Inventory required before review

| Area | Required implementation evidence | Current review gap |
| --- | --- | --- |
| Operator | Actual legal name/controller and monitored contact route | Not supplied |
| Login | Actual authentication mechanism and identifiers retained; owned HTTPS pages and applicable login endpoints | Draft auth module uses local invite-only username/password; deployed integration not verified |
| AI matching | Exact query/profile fields, purpose, recipient/model, excluded identifiers, provider retention/training/logging settings | API contract specifies bounded OpenAI/Luna interpretation and optional JEV matching; actual execution/provider handling remains unverified |
| Company requests | Submitted fields, account association, visibility, recipients, confirmation/configuration behavior and enabled priority rules | Backend-owned; not confirmed |
| Browser state | Actual cookie/local-storage keys, purpose, expiry, session duration and clearing behavior | Auth module defaults to seven-day fixed sessions; HTTP cookie and deployed configuration still need verification |
| Company logos and other external assets | Actual imported logo URL origins, redirects, browser requests, proxy/cache delivery and external recipient behavior | Interface can render remote logos; no-referrer does not remove third-party asset requests |
| Analytics and logs | Actual tools or explicit absence; request/security/application fields, purpose, recipients and duration | Hosting/API logging not confirmed |
| Processors and locations | Hosting, auth, AI and support processors; destination countries and transfer/protection arrangements | Providers/regions not confirmed |
| Retention | Account/search/request/session/log/provider/backup durations or criteria | API contract requires bounded periods below; cleanup, backups and deployed values remain unverified |
| Deletion and rights | Working account deletion and contact route; access/correction process, exceptions, backups and provider copies | Auth module transaction removes auth rows and invokes an integration hook; all private-data hooks and HTTP behavior must be verified end to end |
| Usage/access | Real demo availability/limits; no payment collection, invented trial/subscription/legacy credits or active mobile capabilities | Access implementation needs review |
| Approval | Operator review of actual facts, both exact page versions, effective date and public owned URLs | Required before public sharing |

## Implemented authentication context

The separately reviewed [demo-account-access module](https://github.com/colophon-group/justup/pull/38), inspected at revision [`1eb7db9`](https://github.com/colophon-group/justup/blob/1eb7db9b5d19b3727e7a451188bcd1e93f56b259/server/auth.mjs), implements local invite-only username/password accounts. These are module facts, not evidence that the module or these settings are deployed. Its [integration guide](https://github.com/colophon-group/justup/blob/1eb7db9b5d19b3727e7a451188bcd1e93f56b259/docs/demo-auth.md) identifies the HTTP and operations work still required.

- The module has no external identity provider, Google scopes, email collection, billing integration or password-recovery flow. The former Google OAuth design possibility must not be described as active.
- SQLite account rows contain a random account ID, normalized username, random password salt, scrypt password hash and creation time. Session rows contain a token hash, account ID, creation time and expiry. The module does not store the raw password, session token or invitation in SQLite. Raw credentials still reach the HTTP/server process for validation; the final notice must explain the integrated handling without implying hashes eliminate all processing.
- The account limit defaults to **30**, and fixed session lifetime defaults to **seven days**. Both are configurable module defaults. Confirm the deployed values before placing limits or expiry in an approved notice. Reading a session does not extend expiry; expired rows are pruned on successful registration/login, so expiry is not a promise of immediate row removal.
- Sign-out removes that session row. Password-confirmed account deletion revokes all sessions, invokes the synchronous `deleteAccountData(accountId)` hook and removes the account in one SQLite transaction; callback failure rolls changes back. The integration must compose every account-owned private-data deletion hook before exposing the route. The hook defaults to a no-op and does not itself prove searches or requests are removed.
- Current-row deletion does not erase earlier bytes from SQLite files, write-ahead logs or backups. Cleanup schedules, backup retention and handling of any external copies are operational review gaps. Public job records are not account-owned private rows.
- HTTP cookie name/security/expiry and clearing, origin checks, rate limits, private-row visibility and log handling remain integration requirements, not behavior demonstrated by the standalone auth module tests.

The intended query/profile-only OpenAI processing is still a design intention, not evidence of active fields or provider settings. Do not claim production email or crawler writes, mobile readiness, paid entitlements, exact deletion outcomes or zero logging without implementation evidence.

## Backend contract pending implementation evidence

The backend integration’s local `docs/demo-api.md` explicitly describes implementation requirements rather than deployed endpoints. The [implementation inventory](https://github.com/colophon-group/justup/issues/34#issuecomment-6546226303) confirms the intended choices below. They remain integration/operational requirements until handlers, cleanup and the deployed configuration have been verified:

- Accounts use the isolated SQLite preview database on the existing Nuremberg host. Registration and login are disabled until reviewed static policy URLs/version are configured. The browser uses a host-only, HttpOnly, Secure, SameSite=Lax cookie, and state changes require a matching origin and CSRF protection. Exact deployed cookie details still need confirmation.
- Model-backed search sends the current request, prior accepted query/configuration when editing, compiler capabilities and selected posting-language context to OpenAI through bounded Luna execution. No account IDs, usernames, passwords, session tokens, billing identifiers or resumes are allowed in prompts. The contract allows one bounded repair, and raw model output must not enter application logs. Residual AI matching sends a condition and public posting evidence to its JEV provider; the actual provider, subprocess/trace handling and retention/training settings are still needed.
- Company research uses the submitted company name/domain/link/scope and public evidence, with local private request tracking and bounded OpenAI/Codex research. Accepted identity requests do not start production crawler onboarding or establish live monitoring.
- The contract requires account deletion to remove the account, sessions and private searches, requests, tasks and model-decision caches. Search/request deletion also removes associated private task/decision state. Verify these hooks in the same auth transaction and test failure/restore behavior; a contractual list is not evidence that every deletion path works.
- The required ceilings are seven days for sessions/local matching decisions, thirty days for accounts and their private state, and initially seven days for local diagnostic logs. Verify implemented expiry/cleanup and configured values, plus SQLite/WAL/backup and external-provider handling, before publishing any period as a guarantee.
- Required application diagnostics include route category, status, request ID, duration, token/cost counts and redacted codes, excluding raw query/body, passwords, tokens and IP addresses. Hosting, reverse-proxy and Cloudflare logs need their own actual inventory; an application-log rule does not establish what those layers retain.
- The contract gives accounts last-fourteen-day imported results and visitors a forty-eight-hour delay, with server access checks. It disables billing, production mail/crawler writes, follows, viewed state, preferences, SSE, hidden-match counts and Hiring Wire for the initial preview. Verify deployed capability/access flags before final usage copy.

Company logo delivery also requires verification: the interface can render an API-provided `logoUrl` directly as a remote image with `referrerpolicy="no-referrer"`. Hosting preparation permits direct external HTTPS images and introduces no image proxy/cache; its global no-referrer policy also does not eliminate those requests. These are prepared configuration facts, not verification of a deployed origin or imported logo set. If imported URLs use external origins, the browser still contacts those hosts, which can receive its IP address and other request metadata. Confirm actual logo origins/redirects, whether assets are proxied or cached, and any host logging/retention. The local-only property of the policy pages does not apply to every application asset.

The exact HTTP route behavior, AI recipients/regions, provider terms/settings, external asset delivery, storage/log fields, cleanup and account/request deletion remain release-review gaps. The final static pages must describe observed behavior rather than repeat unverified requirements.

## Usage content and scope

The usage draft explains AI uncertainty, incomplete coverage, first-observed timestamps, gaps or stale source availability, third-party application pages and non-guaranteed company discovery/configuration. It describes a temporary web preview with no payment collection, without granting billing or legacy-account benefits. Operator contact and problem reporting remain explicit review gaps. It does not describe mobile functionality or assert legal compliance.

## Primary reference material

- [Google OAuth 2.0 policies](https://developers.google.com/identity/protocols/oauth2/policies): request necessary permissions only; match consent configuration to scopes; use authorized/owned domains; provide public homepage links to privacy and terms information.
- [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy): keep disclosures accurate and consistent with actual access and use, including changed uses of Google user data.
- [FDPIC duty-to-inform guidance](https://www.edoeb.admin.ch/en/duty-to-provide-information): make information accessible and complete, identify the controller/contact, purposes and recipients, and explain foreign destination/protection information where relevant.

These sources guide the inventory and review. They do not establish compliance for this draft or replace operator review.

## Verification

`tests/browser/policies.spec.mjs` checks signed-out public access with JavaScript disabled, draft status/version, unresolved operator/processing facts, usage limitations, policy navigation while APIs fail, local-only asset requests and narrow-screen keyboard navigation. Tests make no real provider calls and do not use accounts, tokens, a policy API fixture or production data.

Run `npx playwright test tests/browser/policies.spec.mjs` and `npm run test:syntax`. Operator identity, real data inventory, deletion behavior, owned domain/consent settings, final copy and approval remain deployment review requirements, not facts validated by these static browser tests.
