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
      for (const key of ["status.body", "privacy.retention.redemption", "usage.access.entitlement", "usage.contact.review"] as const) {
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
      for (const [id, , paragraphs] of SECTIONS[kind]) {
        assert.ok(html.includes(`aria-labelledby="${id}"`), `${locale}: ${kind}: ${id}`);
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
