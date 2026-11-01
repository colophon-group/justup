import { useInterfaceLocale } from "../../i18n/LocaleProvider.tsx";
import type { CompanyRequestPrefill, Warning } from "../../api/types.ts";

export function SearchWarning({
  warning,
  onCompanyRequest,
}: {
  warning: Warning;
  onCompanyRequest: (prefill: CompanyRequestPrefill) => void;
}) {
  const { t } = useInterfaceLocale();
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
          >{t("Request this company ↗")}</button>
        </>
      ) : null}
    </p>
  );
}
