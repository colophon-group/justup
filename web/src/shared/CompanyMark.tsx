import { safePublicCompanyURL } from "../api/publicCompanyUrls.ts";
import type { Company } from "../api/types.ts";
export function CompanyMark({ company }: { company: Company }) {
  const source = safePublicCompanyURL(company.logoUrl);
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
