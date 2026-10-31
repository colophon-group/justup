import type { CompanyRequestPrefill, Warning } from "../../api/types.ts";

export function SearchWarning({
  warning,
  onCompanyRequest,
}: {
  warning: Warning;
  onCompanyRequest: (prefill: CompanyRequestPrefill) => void;
}) {
  const prefill = warning.companyRequestPrefill;
  return (
    <p className="model-warning">
      {warning.message}
      {prefill ? (
        <>
          {" "}
          <button
            className="text-link"
            onClick={() => onCompanyRequest(prefill)}
          >
            Request this company ↗
          </button>
        </>
      ) : null}
    </p>
  );
}
