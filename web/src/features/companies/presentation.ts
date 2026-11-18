import { safePublicCompanyURL } from '../../api/publicCompanyUrls.ts';
import type { InterfaceLocale } from "../../i18n/locales.ts";
import { translate } from "../../i18n/messages.ts";
import type { CompanySetup } from '../../api/types.ts';
import {useEffect,useState} from 'react';
// Company evidence is displayed without inferring locations, history or source ownership.
export function coverageLabel(state: string | undefined, locale: InterfaceLocale = 'en'): string {
  if (state === 'imported_snapshot') return translate(locale, 'Imported snapshot');
  if (state === 'requested') return translate(locale, 'Identity requested · collection not confirmed');
  if (state === 'monitoring') return translate(locale, 'Monitoring');
  return translate(locale, 'Coverage not reported');
}
export function monitoringLabel(setup: CompanySetup, locale: InterfaceLocale, at?: number): string {
  switch (setup.state) {
    case 'monitoring':
      return translate(locale, at !== undefined && Date.parse(setup.expiresAt) <= at ? 'Monitoring evidence unavailable' : 'Monitoring');
    case 'queued': return translate(locale, 'Monitoring setup pending');
    case 'in_progress': return translate(locale, 'Setting up monitoring');
    case 'blocked': return translate(locale, 'Monitoring evidence unavailable');
  }
}
export function useMonitoringClock(setups: readonly (CompanySetup | undefined)[]) {
  const [at,setAt] = useState<number>();
  const next = setups.reduce((expiry, setup) => {
    if (setup?.state !== 'monitoring') return expiry;
    const end = Date.parse(setup.expiresAt);
    return at === undefined || end > at ? Math.min(expiry,end) : expiry;
  },Infinity);
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    if (at === undefined || next <= Date.now()) {setAt(Date.now());return;}
    const timer = setTimeout(() => setAt(Date.now()), next - Date.now());
    return () => clearTimeout(timer);
  },[at,next]);
  return at;
}
export function safeSourceUrl(value: string | undefined): string | null {
  return safePublicCompanyURL(value);
}
export function reportDate(value: string, locale: InterfaceLocale = 'en'): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(date) : translate(locale, 'Not reported');
}
