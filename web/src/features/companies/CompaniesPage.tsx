// Public catalogue pages share bounded continuation with non-JavaScript documents.
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { type ApiClient, errorText, isAbortError } from '../../api/client.ts';
import type { Company } from '../../api/types.ts';
import type { PublicBootstrap } from '../../public/bootstrap.ts';
import { pageHref } from '../../app/useRoute.ts';
import { useInterfaceLocale } from '../../i18n/LocaleProvider.tsx';
import { CompanyMark } from '../../shared/CompanyMark.tsx';
import { useViewportReveal } from '../../shared/useViewportReveal.ts';
import { coverageLabel } from './presentation.ts';
export interface CompaniesPageProps {
  client: ApiClient; active: boolean; connected?: boolean;
  initialCompanies?: Company[] | undefined;
  initialCatalogue?: PublicBootstrap['catalogue'];
}
export function CompaniesPage({ client, active, connected = true, initialCompanies, initialCatalogue }: CompaniesPageProps) {
  const { locale, t, notice } = useInterfaceLocale();
  const [query, setQuery] = useState(initialCatalogue?.query ?? '');
  const [search, setSearch] = useState({ query: initialCatalogue?.query ?? '', revision: 0 });
  const [items, setItems] = useState<Company[]>(initialCompanies ?? []);
  const [nextCursor, setNextCursor] = useState(initialCatalogue?.nextCursor ?? null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>(initialCompanies ? 'ready' : 'idle');
  const [paging, setPaging] = useState(false);
  const [error, setError] = useState('');
  const key = `${connected ? 'connected' : 'offline'}:${search.query}:${search.revision}`;
  const loaded = useRef<string | null>(initialCompanies ? `connected:${initialCatalogue?.query ?? ''}:0` : null);
  const currentKey = useRef(key); currentKey.current = key;
  const ids = useRef(new Set(initialCompanies?.map(company => company.id)));
  const pageRequest = useRef<AbortController | null>(null);
  const tail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    pageRequest.current?.abort(); setPaging(false);
    if (!connected) { loaded.current = null; setItems([]); setNextCursor(null); setStatus('idle'); return; }
    if (!active || loaded.current === key) return;
    const controller = new AbortController();
    setItems([]); setNextCursor(null); setStatus('loading'); setError('');
    client.getCompanyCataloguePage(search.query, null, controller.signal).then(page => {
      if (controller.signal.aborted || currentKey.current !== key) return;
      loaded.current = key; ids.current = new Set(page.items.map(company => company.id));
      setItems(page.items); setNextCursor(page.nextCursor); setStatus('ready');
    }).catch(failure => {
      if (!isAbortError(failure) && !controller.signal.aborted) { setError(errorText(failure)); setStatus('failed'); }
    });
    return () => controller.abort();
  }, [active, client, connected, key, search.query]);
  useEffect(() => () => pageRequest.current?.abort(), []);
  const more = useCallback(() => {
    if (!nextCursor || paging || error || currentKey.current !== key) return;
    const controller = new AbortController(); pageRequest.current = controller; setPaging(true);
    client.getCompanyCataloguePage(search.query, nextCursor, controller.signal).then(page => {
      if (controller.signal.aborted || currentKey.current !== key) return;
      if (page.nextCursor === nextCursor || page.items.some(company => ids.current.has(company.id))) throw new Error(t('The company directory changed. Reload the directory to continue.'));
      page.items.forEach(company => ids.current.add(company.id));
      setItems(previous => [...previous, ...page.items]); setNextCursor(page.nextCursor);
    }).catch(failure => { if (!isAbortError(failure) && !controller.signal.aborted) setError(errorText(failure)); })
      .finally(() => { if (!controller.signal.aborted && currentKey.current === key) setPaging(false); });
  }, [client, error, key, nextCursor, paging, search.query, t]);
  const { visible, revealing, initialCount } = useViewportReveal({ items, resetKey: key, tailRef: tail, active,
    loading: status === 'loading' || paging, hasMore: !!nextCursor && !error, onNeedMore: more, prerenderedCount: initialCompanies?.length ?? 0 });
  function reload(nextQuery = search.query) {
    const criteria = nextQuery.trim();
    const params = new URLSearchParams(); if (criteria) params.set('q', criteria);
    history.replaceState(history.state, '', `${pageHref('companies', locale)}${params.size ? '?' + params : ''}`);
    setSearch(previous => ({ query: criteria, revision: previous.revision + 1 }));
  }
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); reload(query); }
  const next = new URLSearchParams(); if (search.query) next.set('q', search.query); if (nextCursor) next.set('cursor', nextCursor);
  return <section id="companies-page" className="page" hidden={!active}>
    <div className="intro-grid"><p>{t("Good coverage starts with being clear about it.")}<br />{t("Every company in our catalogue. On the record.")}</p></div>
    <form id="company-search" className="catalogue-search" action={pageHref('companies', locale)} method="get" onSubmit={submit}>
      <label htmlFor="company-query">{t('Find a company')}</label>
      <div className="query-field"><input id="company-query" name="q" maxLength={100} type="search" placeholder={t("Name, website or industry")} autoComplete="off" value={query} onChange={event => setQuery(event.target.value)} /><button className="search-submit" type="submit">{t("Search")} <span aria-hidden="true">↵</span></button></div>
    </form>
    <div className="section-heading"><h1>{t('The sources.')}</h1><a className="button dark" href={pageHref('request', locale)}>{t('Request a company +')}</a></div>
    <div className="catalogue-toolbar"><span className="eyebrow">{t('All companies')}</span></div>
    <div id="company-list">{visible.map((company, index) => <article key={company.id} className={`company-row list-row${index >= initialCount ? ' is-revealed' : ''}`} data-company={company.id}>
      <div className="company-info"><a className="company-name row-link" href={pageHref('company', locale, company.id)}><CompanyMark company={company} /><span>{company.name}</span></a></div>
      <div className="company-industry">{company.industry || company.description || ''}</div>
      <div className="company-state"><span className="status">{coverageLabel(company.coverage?.state, locale)}</span></div>
      <span className="company-open row-arrow" aria-hidden="true">↗</span>
    </article>)}</div>
    <div id="company-tail" ref={tail}><div id="company-scroll-status" role="status" aria-live="polite">
      {!connected ? <p>{t('The company catalogue is unavailable until the service reconnects.')}</p> : error ? <p>{notice(error)} <button className="text-link" onClick={() => reload()}>{t('Reload directory')}</button></p>
        : status === 'loading' || paging ? <p>{t('Checking the directory…')}</p>
          : status === 'idle' ? <p>{t('The company catalogue is unavailable until the service reconnects.')}</p>
            : visible.length < items.length || revealing || nextCursor ? <p>{t('More from the directory…')}</p>
              : <p>{items.length ? t('That’s the directory so far.') : t('No companies found.')} <a className="text-link" href={pageHref('request', locale)}>{t('Send us a lead ↗')}</a></p>}
      {nextCursor ? <a className="text-link" href={`${pageHref('companies', locale)}?${next}`} onClick={event => { event.preventDefault(); if (error) reload(); else more(); }}>{t(error ? 'Reload directory ↗' : 'More companies ↗')}</a> : null}
    </div></div>
  </section>;
}
