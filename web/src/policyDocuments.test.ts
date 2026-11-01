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
      for (const key of ["status.body", "privacy.retention.redemption", "usage.access.entitlement", "privacy.accounts.email", "privacy.accounts.emailRetention", "privacy.accounts.emailConfirmation", "privacy.hosting.email", "usage.access.email", "privacy.accounts.preferences", "privacy.accounts.visitor", "privacy.accounts.bootstrap", "privacy.accounts.handoff", "privacy.measurement.journey", "privacy.measurement.execution", "privacy.measurement.review", "privacy.measurement.bounds", "privacy.browser.routeLocale"] as const) {
        assert.notEqual(copy[key], en[key], `${locale}: ${key} is actually translated`);
      }
    }
  }
  for (const value of Object.values(en)) {
    for (const fact of placeholders(value)) assert.ok(Object.hasOwn(FACTS, fact!), fact);
  }
});

test("ten approved notices carry one version, operator and complete local navigation", () => {
  const documents = policyDocuments();
  assert.equal(documents.size, 10);
  for (const locale of POLICY_LOCALES) {
    for (const kind of ["privacy", "usage"] as const) {
      const html = documents.get(policyPath(kind, locale))!;
      assert.match(html, new RegExp(`<html lang="${locale}">`));
      assert.match(html, /data-policy-status="approved" data-policy-version="2026-11-01" data-policy-reviewed="true"/);
      assert.match(html, /name="justup-policy-reviewed" content="true"/);
      assert.match(html, /name="robots" content="index,follow"/);
      assert.match(html, /default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'/);
      assert.ok(html.includes(OPERATOR));
      assert.ok(html.includes("Route d&#39;Oron 5, 1010 Lausanne, Switzerland"));
      assert.equal([...html.matchAll(new RegExp(`href="${policySearchPath(locale)}"`, "g"))].length, 3);
      assert.ok(html.includes(`href="mailto:${CONTACT}"`));
      assert.doesNotMatch(html, /<script|<iframe|<form|\{\{|https?:\/\//i);
      assert.match(html, /<link rel="stylesheet" href="\/policies.css">/);
      for (const [id, , paragraphs] of SECTIONS[kind]) {
        assert.ok(html.includes(`aria-labelledby="${id}"`), `${locale}: ${kind}: ${id}`);
        for (const key of paragraphs) assert.ok(html.includes(`data-copy="${key}"`), key);
      }
      assert.equal([...html.matchAll(/data-copy=/g)].length, SECTIONS[kind].reduce((sum, [, , paragraphs]) => sum + paragraphs.length, 0));
      for (const language of POLICY_LOCALES) assert.ok(html.includes(`href="${policyPath(kind, language)}" lang="${language}" hreflang="${language}"`));
    }
  }
  assert.equal(policyPath("privacy", "en"), "/privacy.html");
  assert.equal(policyPath("usage", "es"), "/usage.es.html");
  assert.equal(escapeHtml('<img src="x"> & \'test\''), "&lt;img src=&quot;x&quot;&gt; &amp; &#39;test&#39;");
});

test("approved notice covers identity, consent, AI, purchases and mandatory rights", () => {
  const privacy = renderPolicy("privacy", "en");
  const usage = renderPolicy("usage", "en");
  for (const fact of ["Google, Apple, Microsoft and LinkedIn", "Matching email addresses alone do not merge accounts", "unchecked consent choice", "withdraw in Settings", "OpenAI Codex", "TypeSafe JEV", "Route d&#39;Oron 5", "Swiss Federal Data Protection", "18 or older", "Cloudflare", "Hetzner", "Resend", "Stripe"]) {
    assert.ok(`${privacy} ${usage}`.includes(fact), fact);
  }
  for (const fact of ["weekly access is USD 3", "monthly access is USD 10", "inclusive of applicable tax", "through the already paid period", "Refunds and remedies required by applicable law", "App Store", "Google Play", "mandatory consumer protections", "The English version governs where law permits"]) assert.ok(usage.includes(fact), fact);
  for (const locale of POLICY_LOCALES) {
    const copy = POLICY_COPY[locale];
    assert.doesNotMatch(`${copy["status.title"]} ${copy["status.body"]} ${copy["privacy.description"]} ${copy["usage.description"]}`, /draft|review incomplete|brouillon|Entwurf|bozza|borrador/i);
    for (const key of ["privacy.accounts.marketing", "privacy.accounts.billing", "privacy.retention.rights", "privacy.scope.children", "privacy.scope.transfers", "usage.billing.prices", "usage.billing.refunds", "usage.contact.law"] as const) assert.ok(renderPolicy(key.startsWith("privacy") ? "privacy" : "usage", locale).includes(`data-copy="${key}"`));
  }
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
