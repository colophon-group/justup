import { safePublicCompanyURL } from '../../api/publicCompanyUrls.ts';
import type { InterfaceLocale } from "../../i18n/locales.ts";
import { translate } from "../../i18n/messages.ts";
import type { Company, CompanySetup } from '../../api/types.ts';
import {useEffect,useState} from 'react';
// Company evidence is displayed without inferring locations, history or source ownership.
export function coverageLabel(state: string | undefined, locale: InterfaceLocale = 'en'): string {
  if (state === 'imported_snapshot') return translate(locale, 'Imported snapshot');
  if (state === 'requested') return translate(locale, 'Identity requested · collection not confirmed');
  if (state === 'monitoring') return translate(locale, 'Monitoring');
  return translate(locale, 'Coverage not reported');
}
export function monitoringLabel(setup: CompanySetup, locale: InterfaceLocale, at: number | null): string {
  switch (setup.state) {
    case 'monitoring':
      return translate(locale, at !== null && Date.parse(setup.expiresAt) > at ? 'Monitoring' : 'Monitoring evidence unavailable');
    case 'queued': return translate(locale, 'Monitoring setup pending');
    case 'in_progress': return translate(locale, 'Setting up monitoring');
    case 'blocked': return translate(locale, 'Monitoring evidence unavailable');
  }
}
export function companyCoverageLabel(company: Company, locale: InterfaceLocale, at: number | null): string {
  if (company.coverage?.state === 'requested' && company.setup?.state === 'monitoring'
      && at !== null && Date.parse(company.setup.expiresAt) > at) return translate(locale, 'In the company catalogue');
  return coverageLabel(company.coverage?.state, locale);
}
export type MonitoringClock = { serverTime: number; monotonic: number };
function clockTime(serverTime: number, monotonic: number) {
  return serverTime + Math.max(0, performance.now() - monotonic);
}
export function useMonitoringClock(setups: readonly (CompanySetup | undefined)[], clock: MonitoringClock | null) {
  const [,tick] = useState(0);
  const {serverTime,monotonic} = clock ?? {};
  const at = serverTime === undefined || monotonic === undefined ? null : clockTime(serverTime,monotonic);
  const next = setups.reduce((expiry, setup) => {
    if (setup?.state !== 'monitoring' || at === null) return expiry;
    const end = Date.parse(setup.expiresAt);
    return end > at ? Math.min(expiry,end) : expiry;
  },Infinity);
  useEffect(() => {
    if (serverTime === undefined || monotonic === undefined || !Number.isFinite(next)) return;
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      const remaining = next - clockTime(serverTime,monotonic);
      if (remaining <= 0) tick(value => value + 1);
      else timer = setTimeout(check, Math.ceil(remaining));
    };
    check();
    return () => clearTimeout(timer);
  },[next,serverTime,monotonic]);
  return at;
}
export function safeSourceUrl(value: string | undefined): string | null {
  return safePublicCompanyURL(value);
}
export function reportDate(value: string, locale: InterfaceLocale = 'en'): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(date) : translate(locale, 'Not reported');
}
