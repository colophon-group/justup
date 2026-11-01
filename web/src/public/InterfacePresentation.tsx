// The SSR locale seeds hydration; only a deliberate language prefix remains authoritative.
import { useEffect, useState, type ReactNode } from 'react';
import { InterfaceLocaleProvider } from '../i18n/LocaleProvider.tsx';
import { explicitRouteLocale, navigate, pageHref, readRoute } from '../app/useRoute.ts';
import type { InterfaceLocale } from '../i18n/locales.ts';
import type { PublicBootstrap } from './bootstrap.ts';

export function InterfacePresentation({ initialPublicPage, children }: {
  initialPublicPage?: PublicBootstrap | undefined;
  children: ReactNode;
}) {
  const [explicitLocale, setExplicitLocale] = useState<InterfaceLocale | undefined>(() => initialPublicPage
    ? initialPublicPage.explicitLocale
    : explicitRouteLocale(location.pathname));
  useEffect(() => {
    const update = () => setExplicitLocale(explicitRouteLocale(location.pathname));
    window.addEventListener('popstate', update);
    window.addEventListener('hashchange', update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener('hashchange', update);
    };
  }, []);
  const changeLocale = (selected: InterfaceLocale | null) => {
    const route = readRoute(location.pathname, location.hash);
    // Choosing browser defaults removes the prefix rather than locking today's browser match.
    const target = new URL(pageHref(route.page === 'invalid' ? 'jobs' : route.page, selected ?? 'en', route.page === 'company' ? route.id : undefined), location.origin);
    if (route.page === 'companies') {
      const current = new URL(location.href);
      for (const [key, limit] of [['q', 100], ['cursor', 4096]] as const) {
        const values = current.searchParams.getAll(key);
        if (values.length === 1 && values[0] && values[0].length <= limit && !/[\u0000-\u001f\u007f]/u.test(values[0])) target.searchParams.set(key, values[0]);
      }
    }
    navigate(target.href);
  };
  return <InterfaceLocaleProvider
    {...(explicitLocale ? { initialLocale: explicitLocale } : {})}
    {...(initialPublicPage ? { hydrationLocale: initialPublicPage.route.locale } : {})}
    onLocaleChange={changeLocale}
  >{children}</InterfaceLocaleProvider>;
}
