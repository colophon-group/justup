// Public paths identify public documents. Workspace navigation stays in one mounted app.
import { useEffect, useRef, useState } from 'react';
import { parseInterfaceLocale, type InterfaceLocale } from '../i18n/locales.ts';
export type { InterfaceLocale } from '../i18n/locales.ts';
export type Route =
  | { page: 'jobs'; locale: InterfaceLocale }
  | { page: 'companies'; locale: InterfaceLocale }
  | { page: 'request'; locale: InterfaceLocale }
  | { page: 'company'; id: string; locale: InterfaceLocale }
  | { page: 'invalid'; locale: InterfaceLocale };

// An unprefixed document has a render locale, but does not override a reader's preferences.
export function explicitRouteLocale(pathname: string): InterfaceLocale | undefined {
  const locale = parseInterfaceLocale(pathname.split('/').filter(Boolean)[0]);
  return locale && locale !== 'en' ? locale : undefined;
}
export function readRoute(pathname: string, hash = ''): Route {
  const parts = pathname.split('/').filter(Boolean);
  const parsed = parseInterfaceLocale(parts[0]);
  const locale = parsed ?? 'en';
  if (parsed) parts.shift();
  if (!parts.length) return { page: hash === '#request' ? 'request' : 'jobs', locale };
  if (parts[0] === 'companies' && parts.length === 1) return { page: 'companies', locale };
  if (parts[0] === 'companies' && parts.length === 2) {
    try {
      const id = decodeURIComponent(parts[1]!);
      if (id && !/[\x00-\x1f/\\]/.test(id)) return { page: 'company', id, locale };
    } catch { /* Malformed IDs are missing pages, never upstream paths. */ }
  }
  return { page: 'invalid', locale };
}
export function pageHref(page: 'jobs' | 'companies' | 'request' | 'company', locale: InterfaceLocale = 'en', id?: string): string {
  const prefix = locale === 'en' ? '' : `/${locale}`;
  if (page === 'company') return `${prefix}/companies/${encodeURIComponent(id || '')}`;
  if (page === 'companies') return `${prefix}/companies`;
  return `${prefix}/${page === 'request' ? '#request' : '#jobs'}`;
}
export function navigate(href: string) {
  const url = new URL(href, location.href);
  history.pushState(null, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
export function useRoute(initialRoute?: Route): Route {
  const [route, setRoute] = useState(() => initialRoute ?? readRoute(location.pathname, location.hash));
  const current = useRef(route);
  const workspaceScroll = useRef(0);
  useEffect(() => {
    const update = () => {
      const next = readRoute(location.pathname, location.hash);
      if (current.current.page === 'jobs' && next.page !== 'jobs') workspaceScroll.current = window.scrollY;
      const returning = current.current.page !== 'jobs' && next.page === 'jobs';
      current.current = next;
      setRoute(next);
      if (returning) requestAnimationFrame(() => window.scrollTo({ top: workspaceScroll.current, behavior: 'instant' }));
    };
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href]');
      if (!link || link.target || link.hasAttribute('download')) return;
      const target = new URL(link.href, location.href);
      if (target.origin !== location.origin || (target.pathname === location.pathname && !['#jobs', '#request'].includes(target.hash))) return;
      const next = readRoute(target.pathname, target.hash);
      if (next.page === 'invalid' || target.search) return;
      event.preventDefault();
      navigate(target.href);
      // Keep the workspace mounted and its search/scroll state intact when returning.
      if (next.page !== 'jobs') window.scrollTo({ top: 0, behavior: 'instant' });
    };
    window.addEventListener('popstate', update);
    window.addEventListener('hashchange', update);
    document.addEventListener('click', click);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener('hashchange', update);
      document.removeEventListener('click', click);
    };
  }, []);
  return route;
}
