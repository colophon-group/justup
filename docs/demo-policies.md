---
summary: Public draft policy pages, required data-flow inventory and operator review for the temporary web preview.
read_when: Reviewing demo privacy, usage conditions, sign-in disclosure or policy publication.
---

# Demo Privacy and Usage information

The public `/privacy.html` and `/usage.html` pages are static, English web pages. They work without JavaScript, a session or any API. Their only asset is the local `policies.css`; they do not load identity providers, analytics or remote fonts. Serving these files can still produce hosting/access logs, which must be inventoried. The pages are marked `noindex,nofollow` for the temporary preview.

The current revision is **`demo-draft-1`**, marked **draft — review incomplete** in visible copy, HTML metadata and body attributes. There is no effective date, approved operator identity, contact or implied legal approval. These pages deliberately describe missing facts rather than fill them with invented details. They must not be represented as a completed privacy notice or approved usage conditions.

## Sign-in and publication gate

The interface links both public URLs from sign-in and stable footer navigation. Its deployment/auth configuration must keep real provider sign-in disabled until the operator reviews the actual implementation, final static pages and owned HTTPS URLs. There is no runtime policy JSON endpoint or policy fetch dependency.

The interface consumes `session.policies.approved`, a nonempty `version`, `privacyUrl` and `usageUrl`. Backend/auth configuration must only advertise approval for the exact static revision reviewed by the operator. An absent approval or version keeps sign-in unavailable. A client flag, a passing browser test, or the presence of these draft files is not approval. The server must also prevent an authorization-start request when policy approval is absent; hiding a button is insufficient.

To approve a revision, replace draft language with confirmed, plain-language information; fill the inventory below; record the operator's review in the issue; assign one version and effective date across both pages; update their visible and machine-readable status/version; verify the public URLs from a signed-out browser; then enable that same version in auth configuration. Any material data-flow or notice change needs another review. Do not enable sign-in by merely changing the draft metadata.

## Inventory required before review

| Area | Required implementation evidence | Current review gap |
| --- | --- | --- |
| Operator | Actual legal name/controller and monitored contact route | Not supplied |
| Login | Chosen provider, exact scopes/claims and identifiers retained; owned verified HTTPS homepage/redirect/policy URLs | Provider and scopes not settled |
| AI matching | Exact query/profile fields, purpose, recipient/model, excluded identifiers, provider retention/training/logging settings | Backend-owned; not confirmed |
| Company requests | Submitted fields, account association, visibility, recipients, confirmation/configuration behavior and enabled priority rules | Backend-owned; not confirmed |
| Browser state | Actual cookie/local-storage keys, purpose, expiry, session duration and clearing behavior | Must be checked against live implementation |
| Analytics and logs | Actual tools or explicit absence; request/security/application fields, purpose, recipients and duration | Hosting/API logging not confirmed |
| Processors and locations | Hosting, auth, AI and support processors; destination countries and transfer/protection arrangements | Providers/regions not confirmed |
| Retention | Account/search/request/session/log/provider/backup durations or criteria | Not supplied |
| Deletion and rights | Working account deletion and contact route; access/correction process, exceptions, backups and provider copies | Must be verified end to end |
| Usage/access | Real demo availability/limits; no payment collection, invented trial/subscription/legacy credits or active mobile capabilities | Access implementation needs review |
| Approval | Operator review of actual facts, both exact page versions, effective date and public owned URLs | Required before public sharing |

The intended minimal Google identity permissions and intended query/profile-only OpenAI processing are design intentions, not evidence of active settings. Do not publish them as facts until confirmed. Do not claim production email or crawler writes, mobile readiness, paid entitlements, exact deletion outcomes or zero logging without implementation evidence.

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
