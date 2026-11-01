// Test-only observer for the production presentation boundary; never a product build entry.
import { useEffect, useLayoutEffect, useState } from 'react';
import { InterfacePresentation } from '../../web/src/public/InterfacePresentation.tsx';
import { useInterfaceLocale } from '../../web/src/i18n/LocaleProvider.tsx';
import { ApiClient } from '../../web/src/api/client.ts';
import { navigate } from '../../web/src/app/useRoute.ts';
import type { PublicBootstrap } from '../../web/src/public/bootstrap.ts';
function Observer() {
  const { locale, explicitRequestLocale, setAccountPreference, setOverride, onManualLocaleChange } = useInterfaceLocale();
  const [client] = useState(() => new ApiClient());
  useLayoutEffect(() => { client.setExplicitRequestLocale(explicitRequestLocale); }, [client, explicitRequestLocale]);
  useEffect(() => { void client.request('/fixture-locale', value => value).catch(() => {}); }, [client, explicitRequestLocale]);
  const [account, setAccount] = useState(false);
  const [draft, setDraft] = useState('Draft untouched');
  const manual = (next: 'fr' | null) => {
    if (account) setAccountPreference({ accountId: 'fixture-account', locale: next });
    else setOverride(next);
    onManualLocaleChange(next);
  };
  return <><output id="current-locale">{locale}</output><input id="draft" aria-label="Draft" value={draft} onChange={event => setDraft(event.target.value)} />
    <button onClick={() => { setAccount(true); setAccountPreference({ accountId: 'fixture-account', locale: 'de' }); }}>Account de</button>
    <button onClick={() => { setAccount(true); setAccountPreference({ accountId: 'fixture-account', locale: null }); }}>Account browser default</button>
    <button onClick={() => manual('fr')}>Choose French</button><button onClick={() => manual(null)}>Choose browser default</button>
    <button onClick={() => navigate('/companies')}>Default navigation</button>
  </>;
}
export function Scenario({ initialPublicPage }: { initialPublicPage?: PublicBootstrap | undefined }) {
  return <InterfacePresentation initialPublicPage={initialPublicPage}><Observer /></InterfacePresentation>;
}
