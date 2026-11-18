// Durable request milestones are fetched only in the active owner's workspace.
import { useEffect, useState } from 'react';
import type { ApiClient } from '../../api/client.ts';
import type { CompanyRequest } from '../../api/types.ts';
import { pageHref } from '../../app/useRoute.ts';
import { useInterfaceLocale } from '../../i18n/LocaleProvider.tsx';
import { monitoringLabel, reportDate } from './presentation.ts';

export function CompanyRequestUpdates({client, owner, active, latest}: {
  client: ApiClient;
  owner: string | undefined;
  active: boolean;
  latest: CompanyRequest | null;
}) {
  const {locale, t} = useInterfaceLocale();
  const [history, setHistory] = useState<{owner:string; items:CompanyRequest[]; failed:boolean}>();
  const [read, setRead] = useState(0);
  const current = history?.owner === owner ? history : undefined;
  const items = (current?.items ?? []).filter(item => item.status === 'accepted' && item.companyId);
  const accepted = latest?.status === 'accepted' && latest.companyId
    ? items.find(item => item.id === latest.id) ?? latest : null;
  const visible = accepted ? [accepted, ...items.filter(item => item.id !== accepted.id)] : items;

  useEffect(() => {
    if (!active || !owner) return;
    const controller = new AbortController();
    client.listCompanyRequests(controller.signal).then(items => {
      if (!controller.signal.aborted) setHistory({owner, items, failed:false});
    }).catch(() => {
      if (!controller.signal.aborted) setHistory(previous => ({
        owner, items:previous?.owner === owner ? previous.items : [], failed:true,
      }));
    });
    return () => controller.abort();
  }, [active, client, owner, read]);

  const at = Date.now();
  const expires = visible.reduce((soonest, item) => {
    const expiry = item.setup?.state === 'monitoring' ? Date.parse(item.setup.expiresAt) : Infinity;
    return expiry > at ? Math.min(expiry, soonest) : soonest;
  }, Infinity);
  useEffect(() => {
    if (!active || !Number.isFinite(expires)) return;
    const timer = setTimeout(() => setRead(previous => previous + 1), Math.max(0, expires - Date.now()));
    return () => clearTimeout(timer);
  }, [active, expires]);

  if (!active || !owner || (!visible.length && !current?.failed)) return null;
  return <section aria-label={t('Your company requests')}>
    <h2>{t('Your company requests')}</h2>
    <ul>{visible.map(item => {
      const url = pageHref('company', locale, item.companyId);
      return <li key={item.id}>
        <h3>{item.candidate?.name ?? item.input}</h3>
        {item.scope ? <p>{item.scope}</p> : null}
        <a href={url}>{t('In the company catalogue')}</a>
        {item.monitoringStartedAt ? <p>{t('Monitoring confirmed')}{' '}
          <time dateTime={item.monitoringStartedAt}>{reportDate(item.monitoringStartedAt, locale)}</time>
          {' · '}<a href={url + '#positions'}>{t('View positions')}</a>
        </p> : null}
        {item.setup ? <p>{monitoringLabel(item.setup, locale, at)}</p> : null}
      </li>;
    })}</ul>
    <button className="text-link" onClick={() => setRead(previous => previous + 1)}>{t('Refresh company requests')}</button>
  </section>;
}
