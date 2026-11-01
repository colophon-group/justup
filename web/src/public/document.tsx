// One React tree serves public HTML and the interactive app. This module never reads a session.
import { StrictMode } from 'react';
import { INTERFACE_LOCALES, type InterfaceLocale } from '../i18n/locales.ts';
import { translate } from '../i18n/messages.ts';
import { renderToString } from 'react-dom/server';
import { App } from '../app/App.tsx';
import { InterfacePresentation } from './InterfacePresentation.tsx';
import { ErrorBoundary } from '../app/ErrorBoundary.tsx';
import { readRoute, explicitRouteLocale, type Route } from '../app/useRoute.ts';
import { decodeCompany, decodeCompanySourceReport, decodeCompanyCataloguePage, record } from '../api/decode.ts';
import type { PublicBootstrap } from './bootstrap.ts';
// @ts-expect-error Private dependency-free edge helper is covered by deployment contracts.
import { trustedIngressHeaders } from '../../../deploy/frontend/worker.mjs';

const MAX_BYTES = 384 * 1024;
const MAX_COMPANIES = 20;
const TIMEOUT_MS = 2500;
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);


async function publicJSON(target: URL, fetchUpstream: typeof fetch, ingress: Headers): Promise<{ status: number; value?: unknown }> {
  const controller = new AbortController();
  let deadlineReject: (reason: Error) => void = () => {};
  const deadline = new Promise<never>((_, reject) => { deadlineReject = reject; });
  const timeout = setTimeout(() => { controller.abort(); deadlineReject(new Error('Public source deadline exceeded')); }, TIMEOUT_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const headers = new Headers(ingress);
    headers.set('Accept', 'application/json');
    const response = await Promise.race([fetchUpstream(target, { headers, credentials: 'omit', redirect: 'manual', signal: controller.signal, cache: 'no-store' }), deadline]);
    if (response.status === 404) { void response.body?.cancel().catch(() => {}); return { status: 404 }; }
    if (response.status !== 200 || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) { void response.body?.cancel().catch(() => {}); throw new Error('Public source unavailable'); }
    if (Number(response.headers.get('content-length')) > MAX_BYTES || !response.body) { void response.body?.cancel().catch(() => {}); throw new Error('Oversized public source'); }
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_BYTES) throw new Error('Oversized public source');
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { status: 200, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown };
  } finally {
    clearTimeout(timeout);
    void reader?.cancel().catch(() => {});
  }
}
function publicCompany(company: ReturnType<typeof decodeCompany>) {
  const { evidenceUrls: _evidence, ...publicFacts } = decodeCompany(company);
  return publicFacts;
}
function canonicalPath(route: Route): string {
  const prefix = route.locale === 'en' ? '' : `/${route.locale}`;
  return route.page === 'company' ? `${prefix}/companies/${encodeURIComponent(route.id)}` : route.page === 'companies' ? `${prefix}/companies` : `${prefix}/`;
}
function renderApp(initial: PublicBootstrap): string {
  return renderToString(<StrictMode><InterfacePresentation initialPublicPage={initial}><ErrorBoundary><App initialPublicPage={initial} /></ErrorBoundary></InterfacePresentation></StrictMode>);
}
// Only public, source-independent landing markup is cached. No request/account/company state enters it.
// Initialize React outside an invocation; the deployment CPU ceiling still needs provider evidence.
const landingCache = new Map<InterfaceLocale, { day: string; initial: PublicBootstrap; body: string }>();
function landing(locale: InterfaceLocale, renderedAt: string) {
  const day = renderedAt.slice(0, 10);
  const cached = landingCache.get(locale);
  if (cached?.day === day) return cached;
  const initial: PublicBootstrap = { route: { page: 'jobs', locale }, renderedAt, outcome: 'ready' };
  const value = { day, initial, body: renderApp(initial) };
  landingCache.set(locale, value);
  return value;
}
const initializedAt = new Date().toISOString();
for (const locale of INTERFACE_LOCALES) landing(locale, initializedAt);

export async function renderPublicDocument(request: Request, env: Record<string, string>, template: string, fetchUpstream: typeof fetch) {
  if (template.length > 64 * 1024 || !template.includes('<div id="root"></div>')) throw new Error('Invalid retained public template');
  const url = new URL(request.url);
  const route = readRoute(url.pathname);
  const release = JSON.parse(env.RELEASE_JSON || '{}') as Record<string, unknown>;
  if (typeof release.sourceSha !== 'string' || !/^[a-f0-9]{40}$/.test(release.sourceSha) || !/^[a-f0-9]{64}$/.test(env.RUNTIME_CONFIG_SHA256 || '')) throw new Error('Public release identity unavailable');
  const canonical = new URL(route.page === 'invalid' ? url.pathname : canonicalPath(route), env.PUBLIC_ORIGIN).href;
  // Only public catalogue criteria/cursors survive navigation. Job queries and arbitrary metadata never do.
  const catalogueQuery = route.page === 'companies' ? (url.searchParams.get('q') || '').trim() : '';
  const cursor = route.page === 'companies' ? url.searchParams.get('cursor') || null : null;
  const navigation = new URL(canonical);
  if (route.page === 'companies') {
    if (catalogueQuery.length > 100 || (cursor && cursor.length > 4096) || url.searchParams.getAll('q').length > 1 || url.searchParams.getAll('cursor').length > 1) return new Response('Invalid company catalogue link.', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    if (catalogueQuery) navigation.searchParams.set('q', catalogueQuery);
    if (cursor) navigation.searchParams.set('cursor', cursor);
  }
  if (route.page !== 'invalid' && (url.pathname !== navigation.pathname || url.search !== navigation.search)) return new Response(null, { status: 308, headers: { Location: navigation.href } });
  const explicitLocale = explicitRouteLocale(url.pathname);
  const initial: PublicBootstrap = { route, ...(explicitLocale ? { explicitLocale } : {}), renderedAt: new Date().toISOString(), outcome: route.page === 'invalid' ? 'not-found' : 'ready' };
  if (route.page === 'companies' || route.page === 'company') {
    try {
      const origin = new URL(env.API_ORIGIN!);
      if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Invalid public source');
      if (origin.origin === env.PUBLIC_ORIGIN) throw new Error('Invalid public source');
      const ingress: Headers = trustedIngressHeaders(request, env);
      const target = new URL(route.page === 'companies' ? '/api/v1/companies' : `/api/v1/companies/${encodeURIComponent(route.id)}`, origin);
      if (route.page === 'companies') { target.searchParams.set('limit', String(MAX_COMPANIES)); target.searchParams.set('q', catalogueQuery); if (cursor) target.searchParams.set('cursor', cursor); }
      const response = await publicJSON(target, fetchUpstream, ingress);
      if (response.status === 404 && route.page === 'company') initial.outcome = 'not-found';
      else if (response.status !== 200) initial.outcome = 'unavailable';
      else if (route.page === 'companies') {
        const page = decodeCompanyCataloguePage(response.value);
        if (page.items.length > MAX_COMPANIES) throw new Error('Unbounded public catalogue');
        initial.companies = page.items.map(publicCompany);
        if (page.coverage) initial.coverage = page.coverage;
        initial.catalogue = { query: catalogueQuery, cursor, nextCursor: page.nextCursor };
      }
      else {
        const value = record(response.value);
        const company = decodeCompany(value.company ?? value);
        if (company.id !== route.id) throw new Error('Mismatched public company');
        initial.company = publicCompany(company);
        // Optional report evidence cannot suppress the independently valid company identity.
        try {
          const report = await publicJSON(new URL(`/api/v1/companies/${encodeURIComponent(route.id)}/report`, origin), fetchUpstream, ingress);
          if (report.status === 200) initial.companySourceReport = decodeCompanySourceReport(report.value, company.id);
        } catch { /* The browser can retry this public evidence separately. */ }

      }
    } catch { initial.outcome = 'unavailable'; }
  }
  const copy = [
    translate(route.locale, 'Fresh jobs. Clear sources.'),
    translate(route.locale, 'Company catalogue'),
    translate(route.locale, 'Hiring report'),
    translate(route.locale, 'Page not found'),
    translate(route.locale, 'Coverage temporarily unavailable'),
    translate(route.locale, 'Find fresh jobs first observed in the last 14 days. Original employer sources, no paid placement, and transparent company coverage.'),
    translate(route.locale, 'Browse the companies included in Justup and see the career pages we track. Coverage is reported openly; request a missing company.'),
  ] as const;
  const title = initial.outcome === 'not-found' ? copy[3] : initial.outcome === 'unavailable' ? copy[4] : route.page === 'company' ? `${initial.company!.name} — ${copy[2]}` : route.page === 'companies' ? copy[1] : copy[0];
  const description = route.page === 'company' && initial.company ? `${initial.company.name}: ${initial.company.description || copy[2]}. ${copy[6]}`.slice(0, 300) : route.page === 'companies' ? copy[6] : copy[5];
  const publicLanding = route.page === 'jobs' && initial.outcome === 'ready' ? landing(route.locale, initial.renderedAt) : undefined;
  const body = publicLanding?.body ?? renderApp(initial);
  const bootstrap = publicLanding ? { ...publicLanding.initial, ...(explicitLocale ? { explicitLocale } : {}) } : initial;
  const status = initial.outcome === 'not-found' ? 404 : initial.outcome === 'unavailable' ? 503 : 200;
  const alternates = route.page === 'invalid' ? '' : INTERFACE_LOCALES.map(locale => `<link rel="alternate" hreflang="${locale}" href="${escape(new URL(canonicalPath({ ...route, locale }), env.PUBLIC_ORIGIN).href)}">`).join('');
  const robots = route.page === 'companies' && (cursor || catalogueQuery) ? '<meta name="robots" content="noindex,follow">' : '';
  const metadata = `<meta name="description" content="${escape(description)}"><link rel="canonical" href="${escape(canonical)}"><meta name="justup-public-document" content="v1"><meta name="justup-source" content="${release.sourceSha}">${alternates}${robots}<meta name="justup-runtime-config" content="${escape(env.RUNTIME_CONFIG_SHA256 || '')}">`;
  const html = template.replace('<html lang="en">', `<html lang="${route.locale}">`).replace(/<title>[^<]*<\/title>/, `<title>${escape(title)} — Justup</title>`).replace(/<meta\s+name="description"[^>]*>/, '').replace('</head>', `${metadata}</head>`).replace('<div id="root"></div>', `<div id="root">${body}</div><template id="public-bootstrap" data-public="${escape(JSON.stringify(bootstrap))}"></template>`);
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Language': route.locale, ...(robots ? { 'X-Robots-Tag': 'noindex, follow' } : {}), ...(status === 503 ? { 'Retry-After': '30' } : {}) } });
}
