// Shared presentation locales. Safe to import from the browser, a renderer or pure tests.
export const INTERFACE_LOCALES = ['en', 'de', 'fr', 'it', 'es'] as const;
export type InterfaceLocale = (typeof INTERFACE_LOCALES)[number];
export const localeName: Record<InterfaceLocale, string> = {
  en: 'English', de: 'Deutsch', fr: 'Français', it: 'Italiano', es: 'Español',
};
export function parseInterfaceLocale(value: unknown): InterfaceLocale | null {
  return typeof value === 'string' && (INTERFACE_LOCALES as readonly string[]).includes(value)
    ? value as InterfaceLocale : null;
}
export function resolveInterfaceLocale({ override, browserLanguages = [] }: {
  override?: InterfaceLocale | null | undefined; browserLanguages?: readonly string[] | undefined;
}): InterfaceLocale {
  if (override && parseInterfaceLocale(override)) return override;
  for (const candidate of browserLanguages) {
    try {
      const canonical = Intl.getCanonicalLocales(candidate)[0];
      const matched = parseInterfaceLocale(canonical?.split('-')[0]);
      if (matched) return matched;
    } catch { /* Ignore invalid language tags and continue the ordered list. */ }
  }
  return 'en';
}

// A hydration seed is temporary. Explicit public routes retain their URL-owned locale.
export function resolvePresentationLocale({explicitLocale, hydrationLocale, hydrating = false, accountOverride, guestOverride, browserLanguages}: {
  explicitLocale?: InterfaceLocale | undefined;
  hydrationLocale?: InterfaceLocale | undefined;
  hydrating?: boolean;
  accountOverride?: {locale: InterfaceLocale | null} | null;
  guestOverride?: InterfaceLocale | null;
  browserLanguages?: readonly string[] | undefined;
}): InterfaceLocale {
  return explicitLocale ?? (hydrating ? hydrationLocale : undefined)
    ?? resolveInterfaceLocale({override: accountOverride ? accountOverride.locale : guestOverride, browserLanguages});
}
