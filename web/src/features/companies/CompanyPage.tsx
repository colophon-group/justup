import { FollowButton, FollowNotice } from "./FollowButton.tsx";
import type { FollowControl } from "./useFollows.ts";
import { pageHref } from '../../app/useRoute.ts';
import { useInterfaceLocale } from "../../i18n/LocaleProvider.tsx";
// Reports render only supplied company facts and evidence, never fabricated analytics.
import { useEffect, useState } from 'react';
import { ApiError, type ApiClient, errorText, isAbortError } from '../../api/client';
import type { PublicDocumentState } from '../../public/metadata.ts';
import type { Company, CompanyHiringHistory, CompanyReport } from '../../api/types';
import { CompanyMark } from '../../shared/CompanyMark';
import { companyCoverageLabel, monitoringLabel, reportDate, useMonitoringClock, type MonitoringClock } from './presentation';
import { CompanyReportSamples } from './CompanyReportSamples';
import { CompanyGlobe } from './CompanyGlobe';
import { CompanyPositions } from './CompanyPositions.tsx';

function ListingHistory({ history }: { history: CompanyHiringHistory }) {
  const { t, locale } = useInterfaceLocale();
  if (history.state === 'unavailable') return null;
  const maximum = Math.max(1, ...history.points.map(point => point.newListings ?? 0));
  const date = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const day = 86_400_000;
  return <section aria-label={t("Historical hiring")}>
    <h2>{t("Hiring over time.")}</h2>
    <p className="small-print">{t("Newly observed listings on monitored career pages.")}</p>
    <ol className="hiring-history">{history.points.map(point => {
      const count = point.newListings;
      const through = new Date(Date.parse(point.end) - day);
      return <li key={point.start} data-coverage={point.state}>
        {count ? <span className="history-bar" style={{ height: `${count / maximum * 100}%` }} aria-hidden="true" /> : null}
        <b>{count === null ? t("Incomplete coverage") : count.toLocaleString(locale)}</b>
        <small><time dateTime={point.start}>{date.format(new Date(point.start))}</time>{" – "}<time dateTime={through.toISOString()}>{date.format(through)}</time></small>
      </li>;
    })}</ol>
  </section>;
}

export interface CompanyPageProps { follows?: FollowControl | undefined; client: ApiClient; id: string; fullAccess?: boolean; positionsReady?: boolean; monitoringClock?: MonitoringClock | null; initialCompany?: Company | undefined; initialReport?: CompanyReport | undefined; onDocumentState?: ((id: string, state: PublicDocumentState) => void) | undefined }
export function CompanyPage({ client, id, fullAccess = false, positionsReady = false, monitoringClock = null, initialCompany, initialReport, onDocumentState, follows }: CompanyPageProps) {
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
  const monitoringTime = useMonitoringClock([company?.setup], monitoringClock);
  if (error) return <section id="company-page" className="page"><a className="back" href={pageHref("jobs", locale)}>{t("← Back to search")}</a><h1>{t(error.missing ? 'Page not found.' : 'Report unavailable.')}</h1>{!error.missing ? <p role="status">{notice(error.message)}</p> : null}{!error.missing ? <button className="button outline" onClick={() => setRetry(value => value + 1)}>{t("Try again")}</button> : null}</section>;
  if (!company) return <section id="company-page" className="page"><p role="status">{t("Opening the company report…")}</p></section>;
  const companyReport = report?.companyId === id ? report : null;
  const monitoringSince = companyReport?.monitoringSince;
  return <section id="company-page" className="page">
    <a className="back" href={pageHref("jobs", locale)}>{t("← Back to search")}</a>
    <div className="section-heading"><h1>{company.name}</h1><span className="eyebrow">{t("Hiring report")}</span></div>
    <div className="detail-actions report-subtitle"><CompanyMark company={company} /><FollowButton companyId={company.id} name={company.name} follows={follows} /></div>
    <FollowNotice follows={follows} />
    {company.description ? <p className="detail-description">{company.description}</p> : null}
    <div className="report-facts">{monitoringSince ? <p>{t("Monitoring since")}{" "}<time dateTime={monitoringSince}>{reportDate(monitoringSince, locale)}</time></p> : null}<p>{companyCoverageLabel(company, locale, monitoringTime)}</p>
      {company.setup?.updatedAt ? <p>{monitoringLabel(company.setup, locale, monitoringTime)}</p> : null}</div>
    <CompanyGlobe key={id} footprint={companyReport?.hiringFootprint} />
    {companyReport?.hiringHistory ? <ListingHistory history={companyReport.hiringHistory} /> : null}
    {companyReport ? <CompanyReportSamples report={companyReport} /> : null}
    {positionsReady ? <CompanyPositions key={`${id}:${fullAccess}`} client={client} companyId={id} /> : null}
    {companyReport?.sourceChecks.items.some(item => item.publicLink) ? <section className="tracked-sources"><h2>{t("At the source.")}</h2>
      <ul>{companyReport.sourceChecks.items.map((item, index) => item.publicLink ? <li key={`${item.publicLink.url}:${index}`}>
        <a href={item.publicLink.url} target="_blank" rel="noopener noreferrer">{new URL(item.publicLink.url).hostname}{new URL(item.publicLink.url).pathname === '/' ? '' : new URL(item.publicLink.url).pathname} ↗</a>
        {item.lastVerifiedAt ? <p>{t("Last checked")}{" "}<time dateTime={item.lastVerifiedAt}>{reportDate(item.lastVerifiedAt, locale)}</time></p> : null}
      </li> : null)}</ul>
    </section> : reportError ? <section className="tracked-sources"><h2>{t("At the source.")}</h2><button className="button outline" onClick={() => setReportRetry(value => value + 1)}>{t("Try again")}</button></section> : null}
  </section>;
}
