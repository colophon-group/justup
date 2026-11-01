import type { InterfaceLocale } from "../i18n/locales.ts";
import { translate } from "../i18n/messages.ts";
// Source disclosures follow reported evidence; a connection never implies live monitoring.
import type { Coverage } from "../api/types.ts";

export function coverageDescription(coverage: Coverage | undefined, locale: InterfaceLocale = "en"): string {
  if (!coverage) return translate(locale, "Company coverage and verification time are not reported by the service.");
  const kind = coverage.kind ?? coverage.state;
  const label = kind === "imported_snapshot" ? translate(locale, "Imported snapshot") : translate(locale, "Company coverage");
  const verified = coverage.verifiedAt
    ? ` · ${translate(locale, "verified {date}", { date: new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(coverage.verifiedAt)) })}`
    : ` · ${translate(locale, "verification time not reported")}`;
  const freshness = coverage.stale ? ` · ${translate(locale, "refresh needed")}` : "";
  const source = kind === "imported_snapshot"
    ? translate(locale, "An imported snapshot does not imply continuous monitoring.")
    : coverage.description || translate(locale, "See the company catalogue for reported sources and coverage.");
  return `${label}${verified}${freshness}. ${source}`;
}
