// Public metadata uses only route and decoded company facts, shared by HTTP and browser navigation.
import type { Company } from '../api/types.ts';
import type { Route } from '../app/useRoute.ts';
import { INTERFACE_LOCALES, type InterfaceLocale } from '../i18n/locales.ts';
import { translate } from '../i18n/messages.ts';

export interface PublicDocumentState {
  outcome: 'ready' | 'pending' | 'not-found' | 'unavailable';
  company?: Company | undefined;
}
export function canonicalPath(route: Route): string {
  const prefix = route.locale === 'en' ? '' : `/${route.locale}`;
  return route.page === 'company' ? `${prefix}/companies/${encodeURIComponent(route.id)}` : route.page === 'companies' ? `${prefix}/companies` : `${prefix}/`;
}
export function publicMetadata(route: Route, state: PublicDocumentState, origin: string, pathname: string, privateSurface = false, renderLocale: InterfaceLocale = route.locale) {
  const t = (key: Parameters<typeof translate>[1]) => translate(renderLocale, key);
  const catalogue = t('Browse the companies included in Justup and see the career pages we track. Coverage is reported openly; request a missing company.');
  const missing = route.page === 'invalid' || state.outcome === 'not-found';
  const unavailable = state.outcome === 'unavailable';
  const pending = state.outcome === 'pending';
  const title = missing ? t('Page not found') : unavailable ? t('Coverage temporarily unavailable') : pending ? t('Opening the company report…') : route.page === 'company' && state.company ? `${state.company.name} — ${t('Hiring report')}` : route.page === 'companies' ? t('Company catalogue') : route.page === 'request' ? t('Request a company') : t('Fresh jobs. Clear sources.');
  const description = missing || unavailable || pending ? title : route.page === 'company' && state.company ? `${state.company.name}: ${state.company.description || t('Hiring report')}. ${catalogue}`.slice(0, 300) : route.page === 'companies' ? catalogue : t('Find fresh jobs first observed in the last 14 days. Original employer sources, no paid placement, and transparent company coverage.');
  return {
    title: `${title} — Justup`, description,
    canonical: new URL(route.page === 'invalid' ? pathname : canonicalPath(route), origin).href,
    alternates: route.page === 'invalid' || route.page === 'request' || missing || unavailable || pending ? [] : INTERFACE_LOCALES.map(locale => ({ locale, href: new URL(canonicalPath({ ...route, locale }), origin).href })),
    noindex: privateSurface || route.page === 'request' || missing || unavailable || pending,
  };
}
// DOM updates never weaken response-level preview/API/error indexing rules.
export function applyPublicMetadata(metadata: ReturnType<typeof publicMetadata>) {
  document.title = metadata.title;
  let description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
  if (!description) { description = document.createElement('meta'); description.name = 'description'; document.head.append(description); }
  description.content = metadata.description;
  let canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!canonical) { canonical = document.createElement('link'); canonical.rel = 'canonical'; document.head.append(canonical); }
  canonical.href = metadata.canonical;
  document.querySelectorAll('link[rel="alternate"][hreflang]').forEach(link => link.remove());
  for (const alternate of metadata.alternates) {
    const link = document.createElement('link'); link.rel = 'alternate'; link.hreflang = alternate.locale; link.href = alternate.href; document.head.append(link);
  }
  let robots = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
  if (metadata.noindex) {
    if (!robots) { robots = document.createElement('meta'); robots.name = 'robots'; document.head.append(robots); }
    robots.content = 'noindex,follow';
  } else robots?.remove();
}
