import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, errorText, isAbortError, type ApiClient } from '../api/client.ts';
import type { Session } from '../api/types.ts';
import { INTERFACE_LOCALES, type InterfaceLocale } from './locales.ts';
import { useInterfaceLocale } from './LocaleProvider.tsx';

import { decodeInterfacePreferences, type InterfacePreferences } from "./preferences.ts";
export interface AccountLocaleControl {
  supported: readonly InterfaceLocale[];
  disabled: boolean;
  busy: boolean;
  error: string;
  retry: () => void;
  choose: (locale: InterfaceLocale | null) => Promise<void>;
}
// The account owns persistence. A visitor's temporary choice lives only in this provider.
export function useAccountLocale(client: ApiClient, session: Session | null): AccountLocaleControl {
  const { setOverride, setAccountPreference, onManualLocaleChange } = useInterfaceLocale();
  const owner = session?.user?.id ?? null;
  const available = session?.capabilities.preferences === true;
  const [snapshot, setSnapshot] = useState<InterfacePreferences | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  const previousScope = useRef<{ owner: string | null; available: boolean } | null>(null);
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  useEffect(() => client.onSessionResumed(() => {
    if (owner && available) setReload(value => value + 1);
  }), [client, owner, available]);
  useLayoutEffect(() => {
    const sequence = ++generation.current;
    active.current?.abort();
    const scopeChanged = previousScope.current?.owner !== owner || previousScope.current?.available !== available;
    previousScope.current = { owner, available };
    if (scopeChanged) {
      setSnapshot(null); setError(''); setBusy(false);
      setAccountPreference(owner ? { accountId: owner, locale: null } : null);
    }
    if (!owner || !available) return;
    const controller = new AbortController(); active.current = controller;
    setBusy(true);
    client.request('/preferences', decodeInterfacePreferences, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted || sequence !== generation.current || currentOwner.current !== owner) return;
      if (result.accountId !== owner) throw new Error('Interface preferences are unavailable.');
      setSnapshot(result); setAccountPreference({ accountId: owner, locale: result.interfaceLocale });
    }).catch(failure => {
      if (!controller.signal.aborted && sequence === generation.current && !isAbortError(failure)) setError(errorText(failure));
    }).finally(() => { if (!controller.signal.aborted && sequence === generation.current) setBusy(false); });
    return () => { controller.abort(); active.current?.abort(); generation.current++; };
  }, [client, owner, available, reload, setAccountPreference]);
  const choose = useCallback(async (locale: InterfaceLocale | null) => {
    if (!owner) { setOverride(locale); onManualLocaleChange(locale); return; }
    if (!available || busy || snapshot?.accountId !== owner) return;
    const sequence = ++generation.current;
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setError('');
    try {
      const result = await client.request('/preferences', decodeInterfacePreferences, {
        method: 'PATCH', body: { expectedRevision: snapshot.revision, interfaceLocale: locale }, signal: controller.signal,
      });
      if (controller.signal.aborted || sequence !== generation.current || currentOwner.current !== owner) return;
      if (result.accountId !== owner) throw new Error('Interface preferences are unavailable.');
      setSnapshot(result); setAccountPreference({ accountId: owner, locale: result.interfaceLocale }); onManualLocaleChange(result.interfaceLocale);
    } catch (failure) {
      if (!controller.signal.aborted && sequence === generation.current && !isAbortError(failure)) {
        if (failure instanceof ApiError && failure.status === 409) {
          setError('Your language preference changed elsewhere. Review your saved choice and try again.');
          setReload(value => value + 1);
        } else setError(errorText(failure));
      }
    } finally { if (!controller.signal.aborted && sequence === generation.current) setBusy(false); }
  }, [available, busy, client, owner, setOverride, setAccountPreference, onManualLocaleChange, snapshot]);
  return { supported: owner ? snapshot?.supportedInterfaceLocales ?? [] : INTERFACE_LOCALES,
    disabled: Boolean(owner) && (!available || !snapshot || snapshot.accountId !== owner),
    busy, error, retry: () => { setError(''); setReload(value => value + 1); }, choose };
}
