// One static document layout for all aligned, unapproved notice translations.
import { CONTACT, en, FACTS, LOCALE_NAMES, POLICY_LOCALES, POLICY_STATUS, POLICY_VERSION, SECTIONS } from "./content.ts";
import type { PolicyCopy, PolicyKind, PolicyLocale } from "./content.ts";
import { de } from "./de.ts";
import { fr } from "./fr.ts";
import { it } from "./it.ts";
import { es } from "./es.ts";

export const POLICY_COPY: Record<PolicyLocale, PolicyCopy> = { en, de, fr, it, es };
export function policyPath(kind: PolicyKind, locale: PolicyLocale): string {
  return `/${kind}${locale === "en" ? "" : `.${locale}`}.html`;
}
// Public page owner’s route contract: English root; explicit prefixes preserve other locales.
export function policySearchPath(locale: PolicyLocale): string {
  return `${locale === "en" ? "/" : `/${locale}/`}#jobs`;
}
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
function paragraph(value: string): string {
  // Copy is plain text. Only known shared facts may be interpolated; only the common email is linked.
  return value.split(/(\{\{[^}]+\}\})/).map(part => {
    if (!part.startsWith("{{")) return escapeHtml(part);
    const key = part.slice(2, -2);
    if (!Object.hasOwn(FACTS, key)) throw new Error(`Unknown policy fact: ${key}`);
    const fact = String(FACTS[key as keyof typeof FACTS]);
    return key === "email" ? `<a href="mailto:${escapeHtml(CONTACT)}">${escapeHtml(fact)}</a>` : escapeHtml(fact);
  }).join("");
}
export function renderPolicy(kind: PolicyKind, locale: PolicyLocale): string {
  const copy = POLICY_COPY[locale];
  const text = (key: keyof PolicyCopy) => escapeHtml(copy[key]);
  const other = kind === "privacy" ? "usage" : "privacy";
  const sections = SECTIONS[kind].map(([id, heading, paragraphs]) => `      <section class="policy-section" aria-labelledby="${id}">
        <h2 id="${id}">${text(heading)}</h2>
${paragraphs.map(key => `        <p data-copy="${key}">${paragraph(copy[key])}</p>`).join("\n")}
      </section>`).join("\n");
  const languages = POLICY_LOCALES.map(language => `<a href="${policyPath(kind, language)}" lang="${language}" hreflang="${language}"${language === locale ? ' aria-current="page"' : ""}>${LOCALE_NAMES[language]}</a>`).join("");
  return `<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <meta name="justup-policy-status" content="${POLICY_STATUS}">
  <meta name="justup-policy-version" content="${POLICY_VERSION}">
  <meta name="justup-policy-reviewed" content="false">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'">
  <title>${text(`${kind}.title`)} — Justup</title>
  <meta name="description" content="${text(`${kind}.description`)}">
  <link rel="stylesheet" href="/policies.css">
</head>
<body data-policy="${kind}" data-policy-status="${POLICY_STATUS}" data-policy-version="${POLICY_VERSION}" data-policy-reviewed="false">
  <a class="skip-link" href="#main">${text(`${kind}.skip`)}</a>
  <div class="policy-paper">
    <header class="policy-header">
      <a class="policy-brand" href="${policySearchPath(locale)}" aria-label="${text("brand.label")}">JUST<span>UP.</span></a>
      <nav aria-label="${text("nav.label")}"><a href="${policyPath("privacy", locale)}"${kind === "privacy" ? ' aria-current="page"' : ""}>${text("nav.privacy")}</a><a href="${policyPath("usage", locale)}"${kind === "usage" ? ' aria-current="page"' : ""}>${text("nav.usage")}</a><a href="${policySearchPath(locale)}">${text("nav.back")} ↗</a></nav>
    </header>
    <nav class="policy-languages" aria-label="${text("nav.languages")}">${languages}</nav>
    <main id="main" tabindex="-1">
      <p class="eyebrow">${text("eyebrow")}</p>
      <h1>${text(`${kind}.title`)}.</h1>
      <aside class="policy-status" aria-labelledby="review-status">
        <h2 id="review-status">${text("status.title")}</h2>
        <p>${text("status.body")}</p>
        <p>${text("status.version")}: <strong>${POLICY_VERSION}</strong>. ${text("status.date")}</p>
      </aside>
${sections}
    </main>
    <footer><a href="${policyPath(other, locale)}">${text(`footer.${other}`)} ↗</a><a href="${policySearchPath(locale)}">${text("nav.back")} ↗</a></footer>
  </div>
</body>
</html>
`;
}
export function policyDocuments(): ReadonlyMap<string, string> {
  return new Map(POLICY_LOCALES.flatMap(locale => (["privacy", "usage"] as const).map(kind => [policyPath(kind, locale), renderPolicy(kind, locale)])));
}
