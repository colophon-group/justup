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
    navigate(pageHref(route.page === 'invalid' ? 'jobs' : route.page, selected ?? 'en', route.page === 'company' ? route.id : undefined));
  };
  return <InterfaceLocaleProvider
    {...(explicitLocale ? { initialLocale: explicitLocale } : {})}
    {...(initialPublicPage ? { hydrationLocale: initialPublicPage.route.locale } : {})}
    onLocaleChange={changeLocale}
  >{children}</InterfaceLocaleProvider>;
}
