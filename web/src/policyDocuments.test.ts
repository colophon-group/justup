// Public policy delivery contracts; no credentials, APIs, providers or JavaScript required.
import assert from "node:assert/strict";
import test from "node:test";
import { CONTACT, en, FACTS, OPERATOR, POLICY_LOCALES, SECTIONS } from "../policies/content.ts";
import { escapeHtml, POLICY_COPY, policyDocuments, policyPath, policySearchPath, renderPolicy } from "../policies/render.ts";
import { policyDocumentsPlugin } from "../policies/vite.ts";

const placeholders = (text: string) => [...text.matchAll(/\{\{([^}]+)\}\}/g)].map(match => match[1]).sort();

test("every required locale has complete aligned plain-text copy and identical shared facts", () => {
  assert.deepEqual(POLICY_LOCALES, ["en", "de", "fr", "it", "es"]);
  for (const locale of POLICY_LOCALES) {
    const copy = POLICY_COPY[locale];
    assert.deepEqual(Object.keys(copy).sort(), Object.keys(en).sort(), locale);
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      assert.ok(copy[key].trim(), `${locale}: ${key}`);
      assert.deepEqual(placeholders(copy[key]), placeholders(en[key]), `${locale}: ${key} facts`);
      assert.doesNotMatch(copy[key], /<[^>]*>|\bTODO\b/, `${locale}: ${key} must be complete plain text`);
    }
    if (locale !== "en") {
      for (const key of ["status.body", "privacy.retention.redemption", "usage.access.entitlement", "usage.contact.review", "privacy.accounts.email", "privacy.accounts.emailRetention", "privacy.accounts.emailConfirmation", "privacy.hosting.email", "usage.access.email", "privacy.accounts.preferences", "privacy.accounts.visitor", "privacy.accounts.bootstrap", "privacy.accounts.handoff", "privacy.measurement.journey", "privacy.measurement.execution", "privacy.measurement.review", "privacy.measurement.bounds", "privacy.browser.routeLocale"] as const) {
        assert.notEqual(copy[key], en[key], `${locale}: ${key} is actually translated`);
      }
    }
  }
  for (const value of Object.values(en)) {
    for (const fact of placeholders(value)) assert.ok(Object.hasOwn(FACTS, fact!), fact);
  }
});

test("ten public notices retain common draft/operator identity, sections, local links and restrictive delivery metadata", () => {
  const documents = policyDocuments();
  assert.equal(documents.size, 10);
  for (const locale of POLICY_LOCALES) {
    for (const kind of ["privacy", "usage"] as const) {
      const html = documents.get(policyPath(kind, locale))!;
      assert.ok(html);
      assert.match(html, new RegExp(`<html lang="${locale}">`));
      assert.match(html, /data-policy-status="draft" data-policy-version="product-draft-5" data-policy-reviewed="false"/);
      assert.match(html, /name="justup-policy-reviewed" content="false"/);
      assert.match(html, /name="robots" content="noindex,nofollow"/);
      assert.match(html, /default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'/);
      assert.ok(html.includes(OPERATOR));
      assert.equal([...html.matchAll(new RegExp(`href="${policySearchPath(locale)}"`, "g"))].length, 3);
      assert.ok(html.includes(`href="mailto:${CONTACT}"`));
      assert.doesNotMatch(html, /<script|<iframe|<form|\{\{|https?:\/\//i);
      assert.equal([...html.matchAll(/<link /g)].length, 1);
      assert.match(html, /<link rel="stylesheet" href="\/policies.css">/);
      assert.ok(html.includes('class="policy-document"'));
      assert.equal([...html.matchAll(/<li><a href="#/g)].length, SECTIONS[kind].length);
      for (const [id, , paragraphs] of SECTIONS[kind]) {
        assert.ok(html.includes(`aria-labelledby="${id}"`), `${locale}: ${kind}: ${id}`);
        assert.ok(html.includes(`href="#${id}"`), `${locale}: ${kind}: section index targets ${id}`);
        for (const key of paragraphs) assert.ok(html.includes(`data-copy="${key}"`), key);
      }
      assert.equal([...html.matchAll(/data-copy=/g)].length, SECTIONS[kind].reduce((sum, [, , paragraphs]) => sum + paragraphs.length, 0));
      for (const language of POLICY_LOCALES) assert.ok(html.includes(`href="${policyPath(kind, language)}" lang="${language}" hreflang="${language}"`));
      assert.ok(html.includes(`href="${policyPath(kind === "privacy" ? "usage" : "privacy", locale)}"`));
    }
  }
  assert.equal(policyPath("privacy", "en"), "/privacy.html");
  assert.equal(policyPath("usage", "es"), "/usage.es.html");
  assert.equal(escapeHtml('<img src="x"> & \'test\''), "&lt;img src=&quot;x&quot;&gt; &amp; &#39;test&#39;");
});

test("access is entitlement-based and deletion does not preserve a hidden redemption exception", () => {
  const usage = renderPolicy("usage", "en");
  const privacy = renderPolicy("privacy", "en");
  for (const fact of ["Signing in alone does not unlock", "without a current full-access entitlement remain limited", "server-verified eligibility", "explicitly starts a free week", "calendar month instead", "Repeating activation does not restart", "No active identity or billing provider is approved yet"]) assert.ok(usage.includes(fact), fact);
  assert.doesNotMatch(usage, /signed-in accounts get|signed-in accounts can see|signed-in accounts receive/i);
  for (const fact of ["Deletion also erases ordinary and welcome free-period redemption records and keyed identity evidence", "No hidden redemption marker is retained", "may receive another free period", "invalidates and purges recovery backups", "not promised"]) assert.ok(privacy.includes(fact), fact);
  for (const locale of POLICY_LOCALES) {
    const document = renderPolicy("privacy", locale);
    for (const fact of ["justup_interface_locale", "Path=/", "SameSite=Lax", "Secure", "Max-Age=31536000"]) assert.ok(document.includes(fact), `${locale}: ${fact}`);
  }
  assert.doesNotMatch(privacy, /retain[^.]{0,80}to prevent[^.]{0,50}(redemption|free period)/i);
});

test("conditional visitor and first-party evidence limits stay aligned without approving deployment", () => {
  assert.deepEqual({ visitorHours: FACTS.visitorHours, recordRetentionDays: FACTS.recordRetentionDays,
    journeyRowLimit: FACTS.journeyRowLimit, executionRowLimit: FACTS.executionRowLimit,
    reviewQueueLimit: FACTS.reviewQueueLimit, caseRetentionDays: FACTS.caseRetentionDays,
    caseVersionLimit: FACTS.caseVersionLimit, caseMaxKiB: FACTS.caseMaxKiB },
  { visitorHours: 24, recordRetentionDays: 7, journeyRowLimit: 10000, executionRowLimit: 5000,
    reviewQueueLimit: 200, caseRetentionDays: 180, caseVersionLimit: 200, caseMaxKiB: 16 });
  for (const locale of POLICY_LOCALES) {
    const html = renderPolicy("privacy", locale);
    for (const value of ["__Host-justup_visitor", "justup_interface_locale", "X-Justup-Locale", "10000", "5000", "180", "200", "16 KiB"]) assert.ok(html.includes(value), `${locale}: ${value}`);
    for (const key of ["privacy.accounts.preferences", "privacy.accounts.visitor", "privacy.accounts.bootstrap", "privacy.accounts.handoff", "privacy.browser.routeLocale", "privacy.measurement.journey", "privacy.measurement.execution", "privacy.measurement.review", "privacy.measurement.bounds"]) assert.ok(html.includes(`data-copy="${key}"`), `${locale}: ${key}`);
    assert.match(html, /data-policy-reviewed="false"/);
  }
  const privacy = renderPolicy("privacy", "en"), usage = renderPolicy("usage", "en");
  for (const fact of ["When visitor search is enabled after integration and review", "fixed server deadline; reads do not extend it", "nonempty drafts can be saved as you type", "including whitespace-only drafts", "even if AI search is unavailable", "exactly as entered, without trimming or normalization", "Browsing alone and empty or invalid saves create no workspace", "Saving a draft is separate from pressing Search", "without overwriting its existing searches", "spent ownership receipt prevents replay", "guest choice is never copied into an account", "only for the API request", "does not save a preference or create a visitor record", "account-held followed companies, explicit unfollow choices", "interface and posting-language preferences", "account lifetime and deletion rules", "your account automatically follows the confirmed company when you confirm a request", "unless you explicitly unfollowed it before", "first-party private journey records", "opaque owner, search or task references", "7-day limit and a 10000-row cap", "7-day limit and a 5000-row cap", "Unconfirmed Codex monetary cost remains unknown", "references only, not user text", "7 days and 200 entries", "180 days", "200 case versions of 16 KiB each", "not automatically copied", "exclude raw queries, drafts, posting bodies, URLs, IP addresses, emails, credentials and traces", "running API and a safe deletion barrier", "do not promise physical deletion at an unconditional deadline", "active deployment"]) assert.ok(privacy.includes(fact), fact);
  assert.doesNotMatch(privacy, /includes no analytics|no analytics or advertising tracker|still being finalized|first-create association response/i);
  assert.ok(usage.includes("not prove immediate deletion"));
  assert.ok(usage.includes("not an application, interview or hire"));
  assert.ok(usage.includes("automatically follows the confirmed company unless you explicitly unfollowed it before"));
  assert.doesNotMatch(privacy, /confirmed identity request does not[^.]*follow a company/i);
});

test("optional email handling distinguishes username registration, conditional delivery and US storage", () => {
  assert.equal(FACTS.verificationSender, "accounts@notify.justup.work");
  assert.equal(FACTS.verificationMinutes, 10);
  assert.equal(FACTS.verificationTaskDays, 30);
  for (const locale of POLICY_LOCALES) {
    const html = renderPolicy("privacy", locale);
    assert.ok(html.includes("accounts@notify.justup.work"), locale);
    assert.ok(html.includes('data-copy="privacy.accounts.email"'), locale);
    assert.ok(html.includes('data-copy="privacy.hosting.email"'), locale);
    assert.ok(html.includes('data-copy="privacy.accounts.emailRetention"'), locale);
    assert.ok(html.includes('data-copy="privacy.accounts.emailConfirmation"'), locale);
    const usage = renderPolicy("usage", locale);
    assert.ok(usage.includes('data-copy="usage.access.email"'), locale);
    for (const document of [html, usage]) assert.doesNotMatch(document, /email[- ]login|E-Mail-Anmeldung|connexion par e-mail|accesso via email|acceso por correo/i);
    if (locale !== "en") {
      for (const key of ["privacy.accounts.email", "privacy.hosting.email", "usage.access.email"] as const) assert.notEqual(POLICY_COPY[locale][key], en[key]);
    }
  }
  const privacy = renderPolicy("privacy", "en"), usage = renderPolicy("usage", "en");
  for (const fact of ["Ordinary registration and sign-in use a local username and password", "optional email-ownership verification step can ask a signed-in user for an address", "if it is integrated, reviewed and enabled", "a signed-in user can provide an address to prove control of that mailbox", "Verification alone does not activate a free period", "Resend receives that recipient address", "verification message with its short-lived code", "delivery reference", "address is held only in the temporary verification record", "removed through local cleanup after delivery, failure or expiry", "Codes are not saved as readable text in local records", "Delivery-task metadata, without the address or code, has a 30-day limit", "running service and safe deletion controls", "valid for 10 minutes", "bound to the original signed-in session and language", "Changing interface language does not change that binding", "confirmed during a delivery-queue or AI outage", "Availability of a new send is separate from confirmation", "with sending routed through Ireland", "stores message content, delivery logs, webhook payloads and its account records in the United States", "does not move that storage to Ireland", "verified for the selected provider account", "does not itself promise deletion of Resend’s copies"]) assert.ok(privacy.includes(fact), fact);
  assert.ok(usage.includes("If reviewed and enabled, signed-in users can provide an address"));
  assert.ok(usage.includes("Verification alone does not activate a free period or grant full access"));
  assert.doesNotMatch(privacy, /Identity and billing providers have not been selected|email-login|email login/);
  assert.doesNotMatch(en["privacy.hosting.email"], /30[- ]day|30 days/);
});

test("Vite emits all notices only into the public build, using identical development bytes", () => {
  const plugin = policyDocumentsPlugin();
  assert.equal(typeof plugin.configResolved, "function");
  assert.equal(typeof plugin.generateBundle, "function");
  assert.equal(typeof plugin.configureServer, "function");
  const emitted: { type: string; fileName: string; source: string }[] = [];
  const hooks = plugin as unknown as {
    configResolved(config: { build: { ssr: false | string } }): void;
    generateBundle(this: { emitFile(file: typeof emitted[number]): void }): void;
    configureServer(server: { middlewares: { use(middleware: (request: { url: string; method: string }, response: object, next: () => void) => void): void } }): void;
  };
  hooks.configResolved({ build: { ssr: false } });
  hooks.generateBundle.call({ emitFile: file => { emitted.push(file); } });
  assert.equal(emitted.length, 10);
  assert.deepEqual(new Map(emitted.map(file => [`/${file.fileName}`, file.source])), policyDocuments());
  hooks.configResolved({ build: { ssr: "src/private-server.ts" } });
  hooks.generateBundle.call({ emitFile: () => { assert.fail("private SSR output must not receive public notices"); } });
  let handler: ((request: { url: string; method: string }, response: object, next: () => void) => void) | undefined;
  hooks.configureServer({ middlewares: { use: middleware => { handler = middleware; } } });
  assert.ok(handler);
  for (const [url, source] of policyDocuments()) {
    for (const method of ["GET", "HEAD"]) {
      const headers = new Map();
      const response = { statusCode: 0, setHeader: (key: string, value: string) => headers.set(key, value), end: (body?: string) => {
        assert.equal(body, method === "HEAD" ? undefined : source);
      } };
      handler({ url: `${url}?review=1`, method }, response, () => assert.fail("known notice should be served"));
      assert.equal(response.statusCode, 200);
      assert.equal(headers.get("Content-Type"), "text/html; charset=utf-8");
    }
  }
  let passed = 0;
  for (const request of [{ url: "/privacy.html", method: "POST" }, { url: "/privacy.xx.html", method: "GET" }, { url: "/api/v1/session", method: "GET" }]) handler(request, {}, () => { passed++; });
  assert.equal(passed, 3);
});
