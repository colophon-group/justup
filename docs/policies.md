---
summary: Review Justup’s Privacy and Usage notices against the service and deployment configuration.
read_when: Changing data flows, preparing operator review or enabling account/model access.
---

# Review Privacy and Usage

`/privacy.html` and `/usage.html` are static, unapproved **`product-draft-4`** notices. Their visible status, metadata and body attributes say **draft — review incomplete**; there is no effective date. The operator is **Viktor Shcherbakov**, contact **business@colophon-group.org**. A code merge, build or supplied contact does not approve the notices or authorize account/model activation or public sharing.

The notices describe durable service behavior separately from temporary deployment settings. Account invitations, registration capacity, an optional temporary account deadline, snapshot availability and preview expiry are deployment constraints. They must not become product entitlements or imply that an unavailable product capability is complete. No invented corporation, address, jurisdiction or provider handling guarantee belongs in these pages.

## Approve one exact version

1. Select compatible frontend/API/runner artifacts and record their source identities, public policy URLs, both policy byte hashes and policy version. Review the complete text, not only its metadata or passing tests.
2. Verify the deployed cookies, private ownership, expiry, cleanup, logs, backup/deletion/restore and enabled capabilities against the inventory below. Local contracts establish code behavior; they do not establish host configuration or completed cleanup.
3. Before enabling inference, verify the model tool catalogue, operating-system isolation, invocation-file retention and crash cleanup, held-out quality/latency, subscription/default-account metadata and provider handling. Keep accounts/models disabled while their respective prerequisites are missing.
4. Confirm hosting/access/security logs, processing locations and applicable transfer arrangements, including provider copies. Confirm support-mailbox handling: users who email the published contact supply a message and reply address even though account registration has no email field.
5. Obtain operator review of the exact verified text. Record approval, effective date and approved version in the `privacy-usage` release evidence, publish and verify both pages signed out, then configure authentication with the same reviewed version and same-origin URLs. Changing draft metadata alone is not approval.

The browser requires `session.policies.reviewed`, a nonempty version and same-origin Privacy/Usage URLs. The server independently rejects registration/login without its policy and retention/deletion prerequisites. There is no runtime policy JSON endpoint. Any material change in data flows, recipients, access or retention needs review before activation.

## Verify service data handling

Use the composed service paths, not a standalone hook, as evidence: [authentication](../server/auth.mjs), [HTTP/cookies/diagnostics](../server/http.mjs), [cleanup and deletion](../server/main.mjs), [feed projection](../server/feed.mjs), [matching](../server/matching.mjs), [model broker](../server/model-broker.mjs) and [runner](../server/model-runner.mjs).

| Area and purpose | Implemented contract | Verify before approval |
| --- | --- | --- |
| Account access | Username/password; random account ID and normalized username, salted password hash and creation time. No account-email field, Google login, resume upload, payment collection or password-recovery mail. | Registration/login availability, invitation and capacity configuration, HTTPS routing and cookie behavior. |
| Sessions and private state | Random session tokens stored as hashes. Sessions last at most seven days and respect any configured account deadline. Accounts have no default expiry; searches, revisions, requests, tasks, identity proposals and matching use server-derived account ownership. | Configured lifetimes, private ownership, CSRF checks, expiry and completed cleanup. |
| Browser state | Essential host-only HTTPS cookies `__Host-justup_session` and `__Host-justup_csrf` use `Path=/`, Secure, HttpOnly and SameSite=Lax. Sensitive account/query/draft/request state stays in memory or server storage, not application localStorage. | Actual cookie names/values/expiry/clearing and browser storage on the chosen public origin. Local HTTP test cookies do not establish deployed behavior. |
| Search interpretation | Current query, bounded prior accepted query/configuration, supported filters and validation feedback go to OpenAI when enabled. Account IDs, usernames, passwords, sessions and billing IDs are not added. User-entered text can itself contain personal data. | Actual request/default metadata, provider handling and held-out quality/latency. |
| Extra matching | TypeSafe/JEV receives the remaining condition plus eligible primary-filtered public posting text/metadata, without added private account identifiers. Matching has expiry and account/search deletion hooks. | Provider configuration, cumulative spend guard, metadata, retention/training/location/transfer handling and cleanup. |
| Company identity requests | Account-owned name/domain/link/scope, proposed identity, clarification, confirmation, task and evidence data. Known imported identities need no inference. Confirmation records identity/scope; it does not activate collection, following or priority. | Native-web discovery profile, search/browse inputs, default request metadata, provider retention and site access; official-source evidence, exact identity confirmation and private ownership through the deployed service. Keep that discovery profile disabled until verified. |
| Diagnostics and rate limiting | App diagnostics permit request ID/category/status/duration, redacted codes and bounded numeric token/cost counts; exclude raw queries/bodies, usernames, passwords, tokens and IP addresses. Direct-peer network information is HMACed into in-memory rate-limit keys. | App/launcher/host/tunnel/Cloudflare log fields, retention and access. One-minute rate windows are not a one-minute storage TTL: expired keys can remain until replacement/pruning. |
| Cleanup and recovery | Expired private records are removed while the API runs. Pruning follows successful backup or an explicit command; no automatic backup schedule exists. | Configured lifetimes, completed cleanup/pruning and bounded storage. Access deadlines are not proof of immediate physical deletion while a host is stopped. |
| Account deletion | Password-confirmed deletion composes private search/request/matching/task removal in the auth transaction. A transaction-pending barrier rotates the recovery generation and invalidates/purges backups. Restore requires the current generation and revokes restored sessions. | Host failure/restore rehearsal and deployed end-to-end deletion. Do not promise instant secure erasure of SQLite/WAL/filesystem remnants or provider copies. |
| Hosting and external requests | Cloudflare frontend/HTTPS routing is intended to forward API traffic, including forms/cookies, to the isolated Hetzner application/database host in Nuremberg, Germany. Imported job/company DTOs currently use `logoUrl:null`. Employer/source navigation is user initiated. No app analytics/advertising tracker; prepared Worker observability is disabled. | Actual route/provider inventory, network/access/security logs, processing countries/transfers and retention. No remote-logo recipient is established; inventory a delivery path before enabling one. |

Disabling Worker observability in [frontend configuration](../scripts/frontend-configure.mjs) does not establish that Cloudflare keeps no platform, access or security logs.

## Check temporary deployment settings separately

Accounts are durable by default: `accountTtlMs` and `accountExpiresAt` default to `null`, and public `account.expiresAt` is `null` when no temporary deadline applies. Accounts remain until user deletion unless an explicitly configured and disclosed temporary deadline applies. The default registration capacity is 30, with an optional uncapped configuration, and invitation access defaults on. These code defaults do not prove the selected deployment settings. Read back capacity, invitation access, any temporary account deadline and deployment expiry before issuing invitations; account lifetime is independent of deployment expiry unless an explicit account deadline is configured.

Sessions last at most seven days, bounded by any configured account deadline; guest request-protection cookies last one hour. Local matching/diagnostics have seven-day limits, and recovery permits at most two SQLite backups with a seven-day usable age.

Read back these values from the selected deployment before approval. They are not subscription rules. A temporary deadline must be disclosed explicitly; an account must not silently change from durable to expiring. A changed configuration requires matching disclosure review and cannot inherit approval from a notice for different settings. Record audience, fixed deployment expiry and independent teardown in the deployment evidence; do not express them as a disposable product architecture.

## Verify each enabled model profile

Search interpretation and company discovery have different tool requirements. The intent parser remains tool-free. Company discovery requires native web search/browsing; its exact supported profile, input handling and activation evidence are not settled. Do not infer the company profile’s tool catalogue or privacy handling from the intent profile.

The currently implemented company path uses broker-managed bounded official-page fetches with model-supplied identity evidence; it is not proof of a native-web discovery path. Its current bounds are: known imported identity, zero inferences; explicit website, at most two trusted official pages and one grounded call; name-only input, at most one private unverified domain proposal (512 observed tokens), then official-page fetch and one grounded call. The combined output/deadline bound is 6,000 tokens/60 seconds. Published URLs must come from fetched evidence and the name must be grounded in title, heading or visible text. Those limits describe the current broker implementation, not an approved native-web profile. An unverified proposal is never a confirmed public identity.

Before enabling native-web company discovery, inventory the company input and generated search/browse inputs sent to OpenAI, default account/request metadata, provider-side retention and processing, and requests to outside sites. Confirm which recipients and countries actually apply; do not guess them. Publish matching disclosures and verify evidence grounding, ambiguity handling, token/deadline limits, quality and cost against the exact implemented profile. The public draft keeps native-web discovery explicitly conditional and disabled pending these checks.

Every enabled profile needs its own exact pinned model/CLI/configuration identity, complete advertised tool catalogue, operating-system/filesystem/network boundary, invocation log/cache/trace retention and failure/crash cleanup evidence. Also verify provider/subscription/default-account metadata, schema/evidence validation, held-out quality, latency and budget. The intent profile requires an empty tool catalogue; the company profile must prove only its approved native-web tools are available. Neither source tests nor zero observed tool calls establish these deployment/provider facts. Never claim zero provider retention. TypeSafe/JEV remains a separate residual-matching recipient and requires its own verified configuration and spend guard.

## Verify public coverage and availability

Results are newest first, limited to the last 14 days by original source first-observed time. The current imported snapshot is not continuous monitoring. Visitors have a 48-hour delay; stale or missing source evidence pauses results instead of proving zero matches. Search warnings require explicit partial-criteria confirmation, and failed interpretation preserves the accepted revision. Company identity confirmation does not onboard collection or guarantee completion.

Billing, trials, legacy entitlements, SSE, followed/viewed writes, posting-language preferences, request priority and Hiring Wire are not currently available. Hiring Wire is a first-release requirement; its absence is a readiness gap, not a preview exemption. Its weekly hiring changes must come from verified source history, with model inputs and provider handling inventoried if generation uses a model. Do not treat a deployment limitation as completion of the product requirements. Company reports must not infer headquarters or hiring performance from unavailable data. Outside employer/source pages apply their own terms and privacy handling.

## Test public delivery and activation gates

The pages use only local CSS, with no JavaScript, remote fonts, analytics or identity-provider assets. They remain readable without an account/API and carry noindex metadata. Serving static files can still generate hosting logs.

Run `npm run build`, then `npm run test:browser -- tests/browser/policies.spec.mjs` and the account policy-gate journeys. Browser checks cover static accessibility, local-only delivery, draft/version/operator/contact, service versus deployment disclosures, outstanding provider checks and navigation. Unreviewed policies must continue to disable sign-in. These checks do not substitute for the [exact deployed release gate](development-process.md#6-verify-a-release-before-it-goes-live).

Reference: [FDPIC transparency guidance](https://www.edoeb.admin.ch/en/duty-to-provide-information) informs the identity/purpose/recipient/location review structure; it does not establish jurisdiction or compliance.
