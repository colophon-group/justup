// The catalogue displays reported coverage; account filters require their own supported API.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { type ApiClient, errorText, isAbortError } from '../../api/client';
import type { Company } from '../../api/types';
import { CompanyMark } from '../../shared/CompanyMark';
import { useViewportReveal } from '../../shared/useViewportReveal';
import { coverageLabel } from './presentation';

export interface CompaniesPageProps { client: ApiClient; active: boolean; connected?: boolean }
export function CompaniesPage({ client, active, connected = true }: CompaniesPageProps) {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState({ query: '', revision: 0 });
  const [items, setItems] = useState<Company[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [error, setError] = useState('');
  const loaded = useRef<string | null>(null);
  const tail = useRef<HTMLDivElement>(null);
  const key = `${connected ? 'connected' : 'offline'}:${search.query}:${search.revision}`;
  useEffect(() => {
    if (!connected) { loaded.current = null; setItems([]); setStatus('idle'); return; }
    if (!active || loaded.current === key) return;
    const controller = new AbortController();
    setStatus('loading'); setError('');
    client.getCompanies(search.query, controller.signal).then(companies => {
      if (controller.signal.aborted) return;
      loaded.current = key; setItems(companies); setStatus('ready');
    }).catch(failure => {
      if (!isAbortError(failure) && !controller.signal.aborted) { setError(errorText(failure)); setStatus('failed'); }
    });
    return () => controller.abort();
  }, [active, client, connected, key, search.query]);
  const { visible, revealing, initialCount } = useViewportReveal({ items, resetKey: key, tailRef: tail, active, loading: status === 'loading' });
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setSearch(previous => ({ query: query.trim(), revision: previous.revision + 1 })); }
  return <section id="companies-page" className="page" hidden={!active}>
    <div className="intro-grid"><p>Good coverage starts with being clear about it.<br />Every company in our catalogue. On the record.</p></div>
    <form id="company-search" className="catalogue-search" onSubmit={submit}>
      <label htmlFor="company-query">Find a company</label>
      <div className="query-field"><input id="company-query" type="search" placeholder="Name, website or industry" autoComplete="off" value={query} onChange={event => setQuery(event.target.value)} /><button className="search-submit" type="submit">Search <span aria-hidden="true">↵</span></button></div>
    </form>
    <div className="section-heading"><h1>The sources.</h1><a className="button dark" href="#request">Request a company +</a></div>
    <div className="catalogue-toolbar"><span className="eyebrow">All companies</span></div>
    <div id="company-list">{visible.map((company, index) => <article key={company.id} className={`company-row list-row${index >= initialCount ? ' is-revealed' : ''}`} data-company={company.id}>
      <div className="company-info"><a className="company-name row-link" href={`#company/${encodeURIComponent(company.id)}`}><CompanyMark company={company} /><span>{company.name}</span></a></div>
      <div className="company-industry">{company.industry || company.description || ''}</div>
      <div className="company-state"><span className="status">{coverageLabel(company.coverage?.state)}</span></div>
      <span className="company-open row-arrow" aria-hidden="true">↗</span>
    </article>)}</div>
    <div id="company-tail" ref={tail}><p id="company-scroll-status" role="status" aria-live="polite">
      {!connected ? 'The company catalogue is unavailable until the service reconnects.' : status === 'failed' ? <>{error} <button className="text-link" onClick={() => setSearch(previous => ({ ...previous, revision: previous.revision + 1 }))}>Retry</button></>
        : status === 'loading' ? 'Checking the directory…'
          : status === 'idle' ? 'The company catalogue is unavailable until the service reconnects.'
            : visible.length < items.length || revealing ? 'More from the directory…'
              : <>{items.length ? 'That’s the directory so far.' : 'No companies found.'} <a className="text-link" href="#request">Send us a lead ↗</a></>}
    </p></div>
  </section>;
}
