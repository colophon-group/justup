// Reports render only supplied company facts and evidence, never fabricated analytics.
import { useEffect, useState } from 'react';
import { type ApiClient, errorText, isAbortError } from '../../api/client';
import type { Company } from '../../api/types';
import { CompanyMark } from '../../shared/CompanyMark';
import { coverageLabel, reportDate, safeSourceUrl } from './presentation';

export interface CompanyPageProps { client: ApiClient; id: string }
export function CompanyPage({ client, id }: CompanyPageProps) {
  const [company, setCompany] = useState<Company | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setCompany(null); setError('');
    client.getCompany(id, controller.signal).then(result => { if (!controller.signal.aborted) setCompany(result); }).catch(failure => { if (!isAbortError(failure) && !controller.signal.aborted) setError(errorText(failure)); });
    return () => controller.abort();
  }, [client, id, retry]);
  if (error) return <section id="company-page" className="page"><a className="back" href="#jobs">← Back to search</a><h1>Report unavailable.</h1><p role="status">{error}</p><button className="button outline" onClick={() => setRetry(value => value + 1)}>Try again</button></section>;
  if (!company) return <section id="company-page" className="page"><p role="status">Opening the company report…</p></section>;
  const history = company.hiringHistory || [];
  const maximum = Math.max(1, ...history.map(point => point.count));
  return <section id="company-page" className="page">
    <a className="back" href="#jobs">← Back to search</a>
    <div className="section-heading"><h1>{company.name}</h1><span className="eyebrow">Hiring report</span></div>
    <div className="detail-actions report-subtitle"><CompanyMark company={company} /></div>
    {company.description ? <p className="detail-description">{company.description}</p> : null}
    <div className="report-facts">{company.monitoringSince ? <p>Monitoring since <time dateTime={company.monitoringSince}>{reportDate(company.monitoringSince)}</time></p> : null}<p>{coverageLabel(company.coverage?.state)}</p></div>
    {history.length ? <section aria-label="Historical hiring"><h2>Hiring over time.</h2><p className="small-print">Listing activity reported by the source data.</p><ol className="hiring-history">{history.map((point, index) => <li key={`${point.date}:${index}`}><span className="history-bar" style={{ height: `${Math.max(2, point.count / maximum * 100)}%` }} aria-hidden="true" /><b>{point.count}</b><small>{reportDate(point.date)}</small></li>)}</ol></section> : <p className="helper">Historical hiring data is not available for this company.</p>}
    {company.hiringRoles?.length ? <section><h2>Hiring roles.</h2><ul>{company.hiringRoles.map((role, index) => <li key={`${role.name}:${index}`}>{role.name}{role.count !== undefined ? ` · ${role.count}` : ''}</li>)}</ul></section> : null}
    {company.reportedSalaries?.length ? <section><h2>Reported salaries.</h2><ul>{company.reportedSalaries.map((salary, index) => <li key={index}>{salary.role ? `${salary.role} ` : ''}{salary.text}</li>)}</ul></section> : null}
    <section className="tracked-sources"><h2>At the source.</h2><p>{company.lastSuccessfulCheckAt ? <>Last successful check <time dateTime={company.lastSuccessfulCheckAt}>{reportDate(company.lastSuccessfulCheckAt)}</time></> : 'No successful check reported.'}</p>
      {company.sources?.length ? <ul>{company.sources.map(source => { const url = safeSourceUrl(source.url); return url ? <li key={url}><a href={url} target="_blank" rel="noopener noreferrer">{url.replace(/^https?:\/\//, '').replace(/\/$/, '')} ↗</a>{source.lastSuccessfulCheckAt ? ` · ${reportDate(source.lastSuccessfulCheckAt)}` : ''}</li> : null; })}</ul> : <p>No tracked career pages reported.</p>}
    </section>
  </section>;
}
