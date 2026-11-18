// The scoped feed uses the same freshness and access rules as the main feed.
import {useEffect, useRef, useState} from 'react';
import type {ApiClient} from '../../api/client.ts';
import type {CompanyPositionsPage} from '../../api/types.ts';
import {useInterfaceLocale} from '../../i18n/LocaleProvider.tsx';

export function CompanyPositions({client, companyId}: {client:ApiClient; companyId:string}) {
  const {t} = useInterfaceLocale();
  const [request, setRequest] = useState<{cursor:string | null}>();
  const [page, setPage] = useState<CompanyPositionsPage>();
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const section = useRef<HTMLElement>(null);

  useEffect(() => {
    const open = () => {
      if (location.hash !== '#positions') return;
      setRequest(previous => previous ?? {cursor:null});
      section.current?.focus();
    };
    open();
    window.addEventListener('hashchange', open);
    window.addEventListener('popstate', open);
    return () => {
      window.removeEventListener('hashchange', open);
      window.removeEventListener('popstate', open);
    };
  }, []);
  useEffect(() => {
    if (!request) return;
    const controller = new AbortController();
    setState('loading');
    client.getCompanyPositions(companyId,request.cursor,controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (request.cursor && result.continuation.state === 'open' && result.continuation.cursor === request.cursor)
        throw new Error('Position continuation did not advance.');
      setPage(previous => {
        if (!request.cursor || !previous || result.continuation.state === 'paused') return result;
        const known = new Set(previous.items.map(item => item.id));
        return {...result, items:[...previous.items,...result.items.filter(item => !known.has(item.id))]};
      });
      setState('ready');
    }).catch(() => {
      if (!controller.signal.aborted) {setPage(undefined);setState('failed');}
    });
    return () => controller.abort();
  }, [client,companyId,request]);

  const unavailable = state === 'failed' || page?.continuation.state === 'paused';
  return <section id="positions" ref={section} tabIndex={-1} aria-labelledby="positions-title" aria-busy={state === 'loading'}>
    <h2 id="positions-title">{t('Positions')}</h2>
    {page?.items.length ? <ul>{page.items.map(item => <li key={item.id}>
      <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer">{item.title}</a>
      {item.locations.length ? <p>{item.locations.map(location => location.name).join(' · ')}</p> : null}
    </li>)}</ul> : null}
    {unavailable ? <><p role="status">{t('Positions are temporarily unavailable.')}</p>
      <button className="text-link" onClick={() => setRequest({cursor:null})}>{t('Try again')}</button></> : null}
    {state === 'ready' && page?.continuation.state === 'exhausted' && !page.items.length
      ? <p>{t('No positions in the current sample.')}</p> : null}
    {state === 'idle' ? <button className="text-link" onClick={() => {
      history.replaceState(history.state,'','#positions');
      setRequest({cursor:null});
    }}>{t('View positions')}</button> : null}
    {page?.continuation.state === 'open' ? <button className="text-link" disabled={state === 'loading'}
      onClick={() => setRequest({cursor:page.continuation.cursor})}>{t('More positions')}</button> : null}
  </section>;
}
