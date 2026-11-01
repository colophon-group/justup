// Source disclosures follow reported evidence; a connection never implies live monitoring.
import type { Coverage } from "../api/types.ts";

export function coverageDescription(coverage: Coverage | undefined): string {
  if (!coverage) return "Company coverage and verification time are not reported by the service.";
  const kind = coverage.kind ?? coverage.state;
  const label = kind === "imported_snapshot" ? "Imported snapshot" : "Company coverage";
  const verified = coverage.verifiedAt
    ? ` · verified ${new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(coverage.verifiedAt))}`
    : " · verification time not reported";
  const freshness = coverage.stale ? " · refresh needed" : "";
  const source = kind === "imported_snapshot"
    ? "An imported snapshot does not imply continuous monitoring."
    : coverage.description || "See the company catalogue for reported sources and coverage.";
  return `${label}${verified}${freshness}. ${source}`;
}
