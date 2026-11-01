import { parseInterfaceLocale, type InterfaceLocale } from "./locales.ts";
export interface InterfacePreferences {
  accountId: string;
  revision: number;
  interfaceLocale: InterfaceLocale | null;
  supportedInterfaceLocales: InterfaceLocale[];
  defaultInterfaceLocale: 'en';
  resolvedInterfaceLocale: InterfaceLocale;
}
export function decodeInterfacePreferences(value: unknown): InterfacePreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Interface preferences are unavailable.');
  const data = value as Record<string, unknown>;
  const selected = data.interfaceLocale === null ? null : parseInterfaceLocale(data.interfaceLocale);
  const supported = data.supportedInterfaceLocales;
  if (typeof data.accountId !== 'string' || !data.accountId || !Number.isSafeInteger(data.revision) || (data.revision as number) < 0
    || (data.interfaceLocale !== null && selected === null) || !Array.isArray(supported) || !supported.length
    || supported.some(item => parseInterfaceLocale(item) === null) || new Set(supported).size !== supported.length
    || !supported.includes('en') || (selected !== null && !supported.includes(selected))
    || data.defaultInterfaceLocale !== 'en' || parseInterfaceLocale(data.resolvedInterfaceLocale) === null
    || !supported.includes(data.resolvedInterfaceLocale)) throw new Error('Interface preferences are unavailable.');
  return { accountId: data.accountId, revision: data.revision as number, interfaceLocale: selected,
    supportedInterfaceLocales: supported as InterfaceLocale[], defaultInterfaceLocale: 'en', resolvedInterfaceLocale: data.resolvedInterfaceLocale as InterfaceLocale };
}
