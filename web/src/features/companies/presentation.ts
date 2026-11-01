import type { InterfaceLocale } from "../../i18n/locales.ts";
import { translate } from "../../i18n/messages.ts";
// Company evidence is displayed without inferring locations, history or source ownership.
export function coverageLabel(state: string | undefined, locale: InterfaceLocale = 'en'): string {
  if (state === 'imported_snapshot') return translate(locale, 'Imported snapshot');
  if (state === 'requested') return translate(locale, 'Identity requested · collection not confirmed');
  if (state === 'monitoring') return translate(locale, 'Monitoring');
  return translate(locale, 'Coverage not reported');
}
export function safeSourceUrl(value: string | undefined): string | null {
  if (!value) return null;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
export function reportDate(value: string, locale: InterfaceLocale = 'en'): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(date) : translate(locale, 'Not reported');
}
