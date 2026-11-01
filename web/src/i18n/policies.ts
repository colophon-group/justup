import type { SessionPolicies } from '../api/types.ts';
import { parseInterfaceLocale, type InterfaceLocale } from './locales.ts';
export function policyDocument(locale: InterfaceLocale, kind: 'privacy' | 'usage'): string {
  return `/${kind}${locale === 'en' ? '' : '.' + locale}.html`;
}
// Approval belongs to the exact effective language and canonical, same-origin document pair.
export function reviewedPolicyLinks(policies: SessionPolicies | undefined, locale: InterfaceLocale, origin: string): {privacy: string; usage: string; fallbackLocale: InterfaceLocale | null} | null {
  const target = parseInterfaceLocale(policies?.reviewedLocale);
  if (!policies?.reviewed || policies.locale !== locale || !target
    || !policies.version || !/^[A-Za-z0-9_.:-]{1,100}$/u.test(policies.version)
    || policies.fallback !== (policies.reviewedLocale !== locale)) return null;
  for (const [kind, value] of [['privacy', policies.privacyUrl], ['usage', policies.usageUrl]] as const) {
    const expectedPath = policyDocument(target!, kind);
    if (!value || (value !== expectedPath && value !== origin + expectedPath)) return null;
    try {
      const url = new URL(value, origin);
      if (url.origin !== origin || url.username || url.password || url.search || url.hash
        || url.pathname !== expectedPath
        || !['https:', 'http:'].includes(url.protocol)) return null;
    } catch { return null; }
  }
  return {privacy: policies.privacyUrl!, usage: policies.usageUrl!, fallbackLocale: policies.fallback ? policies.reviewedLocale : null};
}
