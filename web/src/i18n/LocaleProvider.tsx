// Presentation state is separate from queries and posting-language filters.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { resolvePresentationLocale, type InterfaceLocale } from './locales.ts';
import { translate, translateNotice, type MessageKey } from './messages.ts';
import { readGuestLocale, serializeGuestLocale } from './guestPreference.ts';
interface AccountPreference { accountId: string; locale: InterfaceLocale | null }
interface LocaleContextValue {
  locale: InterfaceLocale;
  explicitRequestLocale: InterfaceLocale | null;
  override: InterfaceLocale | null;
  setOverride: (locale: InterfaceLocale | null) => void;
  setAccountPreference: (preference: AccountPreference | null) => void;
  onManualLocaleChange: (locale: InterfaceLocale | null) => void;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
  notice: (text: string) => string;
}
const initial: LocaleContextValue = {
  locale: 'en', explicitRequestLocale: null, override: null, setOverride: () => {}, setAccountPreference: () => {}, onManualLocaleChange: () => {},
  t: (key, params) => translate('en', key, params), notice: text => text,
};
const LocaleContext = createContext<LocaleContextValue>(initial);
export function InterfaceLocaleProvider({ children, initialLocale, hydrationLocale, browserLanguages, onLocaleChange }: {
  children: ReactNode;
  initialLocale?: InterfaceLocale;
  hydrationLocale?: InterfaceLocale;
  browserLanguages?: readonly string[];
  onLocaleChange?: (locale: InterfaceLocale | null) => void;
}) {
  const [languages] = useState(() => browserLanguages ?? (typeof navigator === 'undefined' ? [] : navigator.languages));
  const [guestOverride, setGuestOverride] = useState<InterfaceLocale | null>(() => typeof document === 'undefined' ? null : readGuestLocale(document.cookie));
  const [accountPreference, setAccountPreference] = useState<AccountPreference | null>(null);
  const [hydrating, setHydrating] = useState(hydrationLocale !== undefined);
  useEffect(() => { setHydrating(false); }, []);
  const explicitRequestLocale = initialLocale ?? null;
  const override = accountPreference ? accountPreference.locale : guestOverride;
  const locale = resolvePresentationLocale({explicitLocale: initialLocale, hydrationLocale, hydrating, accountOverride: accountPreference, guestOverride, browserLanguages: languages});
  // Only manual visitor choice writes this presentation-only cookie. Account choices never do.
  const setOverride = useCallback((selected: InterfaceLocale | null) => {
    setGuestOverride(selected);
    document.cookie = serializeGuestLocale(selected, { secure: location.protocol === 'https:' });
  }, []);
  const onManualLocaleChange = useCallback((selected: InterfaceLocale | null) => { onLocaleChange?.(selected); }, [onLocaleChange]);
  const t = useCallback((key: MessageKey, params?: Record<string, string | number>) => translate(locale, key, params), [locale]);
  const notice = useCallback((text: string) => translateNotice(locale, text), [locale]);
  const value = useMemo(() => ({ locale, explicitRequestLocale, override, setOverride, setAccountPreference, onManualLocaleChange, t, notice }), [locale, explicitRequestLocale, override, setOverride, onManualLocaleChange, t, notice]);
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}
export function useInterfaceLocale(): LocaleContextValue { return useContext(LocaleContext); }
