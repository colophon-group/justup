import { pageHref } from '../../app/useRoute.ts';
import { useInterfaceLocale } from "../../i18n/LocaleProvider.tsx";
// Reports render only supplied company facts and evidence, never fabricated analytics.
import { useEffect, useState } from 'react';
import { type ApiClient, errorText, isAbortError } from '../../api/client';
import type { Company } from '../../api/types';
import { CompanyMark } from '../../shared/CompanyMark';
import { coverageLabel, reportDate } from './presentation';

export interface CompanyPageProps { client: ApiClient; id: string; initialCompany?: Company | undefined }
export function CompanyPage({ client, id, initialCompany }: CompanyPageProps) {
  const { t, locale, notice } = useInterfaceLocale();
  const [company, setCompany] = useState<Company | null>(initialCompany ?? null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (initialCompany?.id === id && retry === 0) return;
    const controller = new AbortController(); setCompany(null); setError('');
    client.getCompany(id, controller.signal).then(result => { if (!controller.signal.aborted) setCompany(result); }).catch(failure => { if (!isAbortError(failure) && !controller.signal.aborted) setError(errorText(failure)); });
    return () => controller.abort();
  }, [client, id, retry, initialCompany]);
  useEffect(() => {
    if (!company) return;
    document.title = `${company.name} — ${t('Hiring report')} — Justup`;
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (description) description.content = `${company.name}: ${company.description || t('Hiring report')}`.slice(0, 300);
  }, [company, t]);
  if (error) return <section id="company-page" className="page"><a className="back" href={pageHref("jobs", locale)}>{t("← Back to search")}</a><h1>{t("Report unavailable.")}</h1><p role="status">{notice(error)}</p><button className="button outline" onClick={() => setRetry(value => value + 1)}>{t("Try again")}</button></section>;
  if (!company) return <section id="company-page" className="page"><p role="status">{t("Opening the company report…")}</p></section>;
  const history = company.hiringHistory || [];
  const maximum = Math.max(1, ...history.map(point => point.count));
  return <section id="company-page" className="page">
    <a className="back" href={pageHref("jobs", locale)}>{t("← Back to search")}</a>
    <div className="section-heading"><h1>{company.name}</h1><span className="eyebrow">{t("Hiring report")}</span></div>
    <div className="detail-actions report-subtitle"><CompanyMark company={company} /></div>
    {company.description ? <p className="detail-description">{company.description}</p> : null}
    <div className="report-facts">{company.monitoringSince ? <p>{t("Monitoring since")}{" "}<time dateTime={company.monitoringSince}>{reportDate(company.monitoringSince, locale)}</time></p> : null}<p>{coverageLabel(company.coverage?.state, locale)}</p></div>
    {history.length ? <section aria-label={t("Historical hiring")}><h2>{t("Hiring over time.")}</h2><p className="small-print">{t("Listing activity reported by the source data.")}</p><ol className="hiring-history">{history.map((point, index) => <li key={`${point.date}:${index}`}><span className="history-bar" style={{ height: `${Math.max(2, point.count / maximum * 100)}%` }} aria-hidden="true" /><b>{point.count.toLocaleString(locale)}</b><small>{reportDate(point.date, locale)}</small></li>)}</ol></section> : <p className="helper">{t("Historical hiring data is not available for this company.")}</p>}
    {company.hiringRoles?.length ? <section><h2>{t("Hiring roles.")}</h2><ul>{company.hiringRoles.map((role, index) => <li key={`${role.name}:${index}`}>{role.name}{role.count !== undefined ? ` · ${role.count.toLocaleString(locale)}` : ''}</li>)}</ul></section> : null}
    {company.reportedSalaries?.length ? <section><h2>{t("Reported salaries.")}</h2><ul>{company.reportedSalaries.map((salary, index) => <li key={index}>{salary.role ? `${salary.role} ` : ''}{salary.text}</li>)}</ul></section> : null}
    <section className="tracked-sources"><h2>{t("At the source.")}</h2><p>{company.lastSuccessfulCheckAt ? <>{t("Last successful check")}{" "}<time dateTime={company.lastSuccessfulCheckAt}>{reportDate(company.lastSuccessfulCheckAt, locale)}</time></> : t("No successful check reported.")}</p>
      <p>{t("Verified career-page links are unavailable.")}</p>
    </section>
  </section>;
}
