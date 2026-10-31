import { safeSourceURL } from "../api/decode.ts";
import type { Company } from "../api/types.ts";
export function CompanyMark({ company }: { company: Company }) {
  const source = safeSourceURL(company.logoUrl);
  return source ? (
    <img
      className="mark company-logo"
      src={source}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
    />
  ) : (
    <span className="mark" aria-hidden="true">
      ↗
    </span>
  );
}
