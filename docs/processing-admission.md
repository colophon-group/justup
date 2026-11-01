---
summary: Configure exact locale policy approval and the shared API/queue processing gate.
read_when: Reviewing policy activation, wiring session language metadata or diagnosing paused private processing.
---

# Configure policy and processing admission

All five interface policy pairs remain unapproved `product-draft-5` drafts. Keep `JUSTUP_POLICIES_REVIEWED=false`. Neither a configuration example nor passing tests constitutes operator review or authorizes activation.

## Bind approval to the served language

The API accepts trusted operator configuration, without a settings or consent API:

- `JUSTUP_POLICY_LOCALES` is a JSON object keyed only by `en`, `de`, `fr`, `it`, `es`. Each entry has exactly `{privacyUrl,usageUrl,version,reviewed}`. `reviewed` is a boolean; version is a bounded identifier.
- URLs must equal the configured frontend origin plus `/privacy.html` and `/usage.html` for English, or `/privacy.de.html` and `/usage.de.html` for German, with corresponding `fr`, `it`, `es` suffixes. HTTPS is required outside explicit localhost HTTP tests. Query strings, fragments, other origins and mismatched language paths are rejected.
- `JUSTUP_POLICY_FALLBACKS` optionally maps a requested supported locale to a different explicitly reviewed locale entry. Record operator approval for that exact fallback before configuring it. Fallbacks do not chain.
- The global reviewed flag remains the kill switch for every locale. Existing `JUSTUP_PRIVACY_URL`, `JUSTUP_USAGE_URL`, `JUSTUP_POLICY_VERSION` configuration can describe English approval only. It never approves the other four locales or creates a fallback.

For draft metadata, a locale without an entry resolves to its canonical URLs and `product-draft-5`, with `reviewed:false`. An explicit locale entry takes precedence over legacy English values, including an unreviewed entry. Each approved locale retains its own exact URLs/version; there is no inferred translation equivalence.

`session.policies` preserves `privacyUrl`, `usageUrl`, `version`, `reviewed` and adds `locale` (requested presentation language), `reviewedLocale` (reviewed page language, otherwise null), and `fallback` (true only for an admitted explicit fallback). The browser must evaluate these fields for the effective interface language. There is no separate policy endpoint.

## Resolve presentation consistently

For an authenticated account, resolution is its saved interface override, then bounded `Accept-Language`, then English. A null saved preference means browser/default and ignores any earlier guest cookie. Guests resolve the explicit device cookie, then `Accept-Language`, then English. The fixed five-value `justup_interface_locale` cookie is frontend-owned: set it only after an explicit language choice, with `Path=/; SameSite=Lax; Max-Age=31536000` and `Secure` on HTTPS; clear it for browser/default mode. It contains no identifier and does not allocate a visitor. Login never copies it into an account preference or another account. Forward `Cookie` and `Accept-Language` through the same-origin API proxy.

The API accepts at most 512 header characters and 16 language candidates, canonicalizes standard tags to the supported base language, and stores no browser-language list. Duplicate/invalid locale-cookie values do not select a locale. An explicit `presentationLocale` on a submission must equal this resolved language. The queue persists only the selected enum and a hash of its exact approved policy metadata. Generated search titles/reasons and model-generated company clarification use that selected language; queries, requirement text, company names, canonical IDs, URLs and source evidence retain their original content.

## Use one processing proof

`server/processing-admission.mjs` owns one SQLite row, `justup_processing_admission`, for accounts and visitors together. Startup renames the existing `justup_visitor_admission` table in place, preserving its row, then adds the locale scope column. A legacy row without locale scope cannot admit processing. No private account, search or task rows are reset.

API startup disables the previous proof before serving requests. Fully composed synchronous auth/visitor maintenance then publishes current availability. The proof binds source commit, build identity, exact approved locale metadata, private deletion generation and check time. Writes occur on changed state or after 30 seconds; maintenance runs every 60 seconds. Queue proofs expire at 90 seconds. An independent queue reader never refreshes or repairs the API's proof. Revocation propagation is bounded by those intervals; it is not instantaneous across processes. Restarting the API with closed policies immediately withdraws its persisted proof before accepting routes.

Before each dispatch and again after waits/before transaction commit, account and visitor tasks require the same approved locale key, current owner/entitlement, a live lease and applicable revision/evidence fences. Old tasks without the new policy key cannot execute through the composed authority. Provider unavailability is separate: it does not revoke login, logout, deletion, stored search/request/workspace/preferences reads or the ordinary eligible feed.

Each processing check also performs a direct stable private-generation read: read generation, require no pending marker, read generation again and require equality. A live/foreign/crash-retained pending marker closes processing immediately, even when the proof is young. This code never clears or repairs that marker. An expired/wrong-build proof, missing generation, unreviewed locale or changed exact policy metadata prevents inference and new private processing effects. HTTP reports `policy_unavailable`, `deletion_unavailable` or maintenance `dependency_unavailable`; queued work reports non-retryable `processing_unavailable` separately from provider/network failures. Refresh the session before offering a new submission.

Safe logout and deletion remain available during a policy pause, subject to their own session, CSRF/password and deletion protections. Stored account reads remain owner-bound; result pagination and SSE are processing paths because they can update cursors or enqueue matching. Visitor processing reads retain their policy gate. A pending deletion marker can also prevent a new deletion until operator recovery makes the deletion barrier safe.

## Verify before release

Run `node --test server/policies.test.mjs server/visitor.test.mjs server/model-broker.test.mjs` and the complete server suite with pinned Node 24.22.2. The primary regression uses real SQLite/HTTP and a persisted account session across policy-closed restart. Other contracts cover pending deletion, independent queue expiry/wrong build, exact locale key changes, post-provider account/visitor revocation, preserved cleanup/stored reads, enum/header precedence and zero unauthorized model/JEV/private decision writes. Providers are fake.

Run `python3 scripts/preview-operations.test.py` for immutable packaging and the launcher-to-actual-Node locale configuration compatibility test. These source checks do not establish served page bytes, operator approval, deployed proxy headers, provider handling, cleanup/restore rehearsal or complete release journeys. Record those against exact compatible frontend/API/runner artifacts before real-user activation.
