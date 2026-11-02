import { pageHref } from '../../app/useRoute.ts';
import { useInterfaceLocale } from "../../i18n/LocaleProvider.tsx";
// Reports render only supplied company facts and evidence, never fabricated analytics.
import { useEffect, useState } from 'react';
import { ApiError, type ApiClient, errorText, isAbortError } from '../../api/client';
import type { PublicDocumentState } from '../../public/metadata.ts';
import type { Company, CompanyReport } from '../../api/types';
import { CompanyMark } from '../../shared/CompanyMark';
import { coverageLabel, reportDate } from './presentation';
import { CompanyReportSamples } from './CompanyReportSamples';

export interface CompanyPageProps { client: ApiClient; id: string; initialCompany?: Company | undefined; initialReport?: CompanyReport | undefined; onDocumentState?: ((id: string, state: PublicDocumentState) => void) | undefined }
export function CompanyPage({ client, id, initialCompany, initialReport, onDocumentState }: CompanyPageProps) {
  const { t, locale, notice } = useInterfaceLocale();
  const [company, setCompany] = useState<Company | null>(initialCompany ?? null);
  const [report, setReport] = useState<CompanyReport | null>(initialReport ?? null);
  const [reportError, setReportError] = useState(false);
  const [reportRetry, setReportRetry] = useState(0);
  const [error, setError] = useState<{ message: string; missing: boolean } | null>(null);
  useEffect(() => {
    if (initialReport?.companyId === id && reportRetry === 0) return;
    const controller = new AbortController(); setReport(null); setReportError(false);
    client.getCompanyReport(id, controller.signal).then(report => {
      if (!controller.signal.aborted) setReport(report);
    }).catch(failure => { if (!isAbortError(failure) && !controller.signal.aborted) setReportError(true); });
    return () => controller.abort();
  }, [client, id, initialReport, reportRetry]);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (initialCompany?.id === id && retry === 0) return;
    const controller = new AbortController(); setCompany(null); setError(null);
    client.getCompany(id, controller.signal).then(result => { if (!controller.signal.aborted) setCompany(result); }).catch(failure => { if (!isAbortError(failure) && !controller.signal.aborted) setError({ message: errorText(failure), missing: failure instanceof ApiError && failure.status === 404 }); });
    return () => controller.abort();
  }, [client, id, retry, initialCompany]);
  useEffect(() => {
    onDocumentState?.(id, { outcome: error ? error.missing ? 'not-found' : 'unavailable' : company ? 'ready' : 'pending', company: company ?? undefined });
  }, [id, company, error, onDocumentState]);
  if (error) return <section id="company-page" className="page"><a className="back" href={pageHref("jobs", locale)}>{t("← Back to search")}</a><h1>{t(error.missing ? 'Page not found.' : 'Report unavailable.')}</h1>{!error.missing ? <p role="status">{notice(error.message)}</p> : null}{!error.missing ? <button className="button outline" onClick={() => setRetry(value => value + 1)}>{t("Try again")}</button> : null}</section>;
  if (!company) return <section id="company-page" className="page"><p role="status">{t("Opening the company report…")}</p></section>;
  const history = company.hiringHistory || [];
  const maximum = Math.max(1, ...history.map(point => point.count));
  return <section id="company-page" className="page">
    <a className="back" href={pageHref("jobs", locale)}>{t("← Back to search")}</a>
    <div className="section-heading"><h1>{company.name}</h1><span className="eyebrow">{t("Hiring report")}</span></div>
    <div className="detail-actions report-subtitle"><CompanyMark company={company} /></div>
    {company.description ? <p className="detail-description">{company.description}</p> : null}
    <div className="report-facts">{company.monitoringSince ? <p>{t("Monitoring since")}{" "}<time dateTime={company.monitoringSince}>{reportDate(company.monitoringSince, locale)}</time></p> : null}<p>{coverageLabel(company.coverage?.state, locale)}</p></div>
    {history.length ? <section aria-label={t("Historical hiring")}><h2>{t("Hiring over time.")}</h2><p className="small-print">{t("Listing activity reported by the source data.")}</p><ol className="hiring-history">{history.map((point, index) => <li key={`${point.date}:${index}`}><span className="history-bar" style={{ height: `${Math.max(2, point.count / maximum * 100)}%` }} aria-hidden="true" /><b>{point.count.toLocaleString(locale)}</b><small>{reportDate(point.date, locale)}</small></li>)}</ol></section> : null}
    {report?.companyId === id ? <CompanyReportSamples report={report} /> : null}
    {report?.companyId === id && report.sourceChecks.items.some(item => item.publicLink) ? <section className="tracked-sources"><h2>{t("At the source.")}</h2>
      <ul>{report.sourceChecks.items.map((item, index) => item.publicLink ? <li key={`${item.publicLink.url}:${index}`}>
        <a href={item.publicLink.url} target="_blank" rel="noopener noreferrer">{new URL(item.publicLink.url).hostname}{new URL(item.publicLink.url).pathname === '/' ? '' : new URL(item.publicLink.url).pathname} ↗</a>
        {item.lastVerifiedAt ? <p>{t("Last checked")}{" "}<time dateTime={item.lastVerifiedAt}>{reportDate(item.lastVerifiedAt, locale)}</time></p> : null}
      </li> : null)}</ul>
    </section> : reportError ? <section className="tracked-sources"><h2>{t("At the source.")}</h2><button className="button outline" onClick={() => setReportRetry(value => value + 1)}>{t("Try again")}</button></section> : null}
  </section>;
}
