import type { Salary } from "../../api/types.ts";
import type { InterfaceLocale } from "../../i18n/locales.ts";
import { translate } from "../../i18n/messages.ts";
export function salaryText(salary: Salary | null, locale: InterfaceLocale = 'en'): string {
  if (!salary || (salary.min === null && salary.max === null)) return "";
  const format = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 20 }).format(value);
  const amount = salary.min !== null && salary.max !== null
    ? salary.min === salary.max ? format(salary.min) : `${format(salary.min)}–${format(salary.max)}`
    : format(salary.min ?? salary.max ?? 0);
  const unit = salary.period ? metadataText(salary.period, locale) : '';
  const value = `${salary.currency ? salary.currency + ' ' : ''}${amount}${unit ? ' / ' + unit : ''}`;
  return salary.min === null ? translate(locale, 'Up to {amount}', { amount: value })
    : salary.max === null ? translate(locale, 'From {amount}', { amount: value }) : value;
}
export function ageText(value: string, locale: InterfaceLocale = 'en'): string {
  const minutes = Math.floor(Math.max(0, Date.now() - Date.parse(value)) / 60000);
  const unit = minutes < 60 ? 'minute' : minutes < 1440 ? 'hour' : 'day';
  const count = minutes < 60 ? minutes : minutes < 1440 ? Math.floor(minutes / 60) : Math.floor(minutes / 1440);
  if (locale === 'en') return `${count}${unit === 'minute' ? 'm' : unit === 'hour' ? 'h' : 'd'}`;
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'narrow' }).format(count);
}
const knownMetadata = {
  year: 'year', yearly: 'year', annual: 'year', month: 'month', monthly: 'month', week: 'week', weekly: 'week', day: 'day', daily: 'day', hour: 'hour', hourly: 'hour',
  remote: 'Remote', hybrid: 'Hybrid', onsite: 'On site', on_site: 'On site',
  full_time: 'Full time', part_time: 'Part time', contract: 'Contract', internship: 'Internship', temporary: 'Temporary',
} as const;
// Only known structured enum values are UI labels. Unrecognized source values remain intact.
export function metadataText(value: string, locale: InterfaceLocale): string {
  const key = knownMetadata[value.toLowerCase() as keyof typeof knownMetadata];
  return key ? translate(locale, key) : value;
}
