import { parseInterfaceLocale, type InterfaceLocale } from './locales.ts';
export const GUEST_LOCALE_COOKIE = 'justup_interface_locale';
export function readGuestLocale(cookieHeader: string): InterfaceLocale | null {
  const values = cookieHeader.split(';').map(part => part.trim()).filter(part => part.startsWith(GUEST_LOCALE_COOKIE + '='));
  // Ambiguous cookies fail closed to browser/default; values are a strict finite allowlist.
  return values.length === 1 ? parseInterfaceLocale(values[0]?.slice(GUEST_LOCALE_COOKIE.length + 1)) : null;
}
export function serializeGuestLocale(locale: InterfaceLocale | null, { secure }: { secure: boolean }): string {
  return `${GUEST_LOCALE_COOKIE}=${locale ?? ''}; Path=/; SameSite=Lax; Max-Age=${locale ? 31536000 : 0}${secure ? '; Secure' : ''}`;
}
