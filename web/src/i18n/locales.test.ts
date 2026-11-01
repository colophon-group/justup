import assert from 'node:assert/strict';
import test from 'node:test';
import { INTERFACE_LOCALES, parseInterfaceLocale, resolveInterfaceLocale, resolvePresentationLocale } from './locales.ts';
import { messages, translate, translateNotice, translateCount, type MessageKey } from './messages.ts';
import { salaryText, metadataText } from '../features/search/format.ts';

test('locale resolution is ordered, regional-aware and safe without browser globals', () => {
  assert.equal(resolveInterfaceLocale({}), 'en');
  assert.equal(resolveInterfaceLocale({ browserLanguages: ['nl-NL', 'de-CH', 'fr'] }), 'de');
  assert.equal(resolveInterfaceLocale({ browserLanguages: ['es-419', 'de'] }), 'es');
  assert.equal(resolveInterfaceLocale({ browserLanguages: ['fr-CA', 'de'] }), 'fr');
  assert.equal(resolveInterfaceLocale({ browserLanguages: ['it-IT'] }), 'it');
  assert.equal(resolveInterfaceLocale({ browserLanguages: ['de-CH-u-nu-latn'] }), 'de');
  assert.equal(resolveInterfaceLocale({ browserLanguages: ['ES-mx'] }), 'es');
  assert.equal(resolveInterfaceLocale({ browserLanguages: ['de_bad', 'not a language', 'xx'] }), 'en');
  assert.equal(resolveInterfaceLocale({ override: 'fr', browserLanguages: ['de-CH'] }), 'fr');
  assert.equal(resolveInterfaceLocale({ override: null, browserLanguages: ['de'] }), 'de');
  assert.equal(parseInterfaceLocale('esp'), null);
  assert.equal(parseInterfaceLocale('es'), 'es');
  assert.equal(parseInterfaceLocale(undefined), null);
  assert.equal(parseInterfaceLocale('de-CH'), null);
});
test('every catalogue supplies all five languages and preserves interpolation fields', () => {
  const fields = (value: string) => [...value.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/gu)].map(match => match[1]).sort();
  for (const key of Object.keys(messages) as MessageKey[]) {
    for (const locale of INTERFACE_LOCALES) {
      const text = translate(locale, key);
      assert.ok(text.trim(), `${locale}: ${key}`);
      assert.deepEqual(fields(text), fields(key), `${locale}: ${key}`);
    }
  }
  assert.equal(translate('es', 'Delete {title}', { title: 'My raw model title' }), 'Eliminar My raw model title');
});
test('structured values format locally while unknown source and model text remain intact', () => {
  assert.equal(salaryText({min: 35000, max: null, currency:'EUR', period:'year'}, 'de'), 'Ab EUR 35.000 / Jahr');
  assert.equal(metadataText('remote', 'fr'), 'À distance');
  assert.equal(metadataText('source-defined value', 'es'), 'source-defined value');
  assert.equal(translateNotice('it', 'A freeform model message.'), 'A freeform model message.');
  assert.equal(translateNotice('de', 'Search saved. Your newer edits have not been applied.'), 'Suche gespeichert. Deine neueren Änderungen wurden nicht angewendet.');
  assert.equal(translateNotice('fr', 'The request timed out. Please try again. Reference: abc.'), 'La requête a expiré. Réessaie. Référence : abc.');
});


test('guest cookie contains only an explicit supported presentation choice', async () => {
  const { readGuestLocale, serializeGuestLocale } = await import('./guestPreference.ts');
  assert.equal(readGuestLocale('other=123; justup_interface_locale=de'), 'de');
  assert.equal(readGuestLocale('justup_interface_locale=de-CH'), null);
  assert.equal(readGuestLocale('justup_interface_locale=%65%73'), null);
  assert.equal(readGuestLocale('justup_interface_locale=de; justup_interface_locale=es'), null);
  assert.equal(serializeGuestLocale('es', {secure:true}), 'justup_interface_locale=es; Path=/; SameSite=Lax; Max-Age=31536000; Secure');
  assert.equal(serializeGuestLocale(null, {secure:false}), 'justup_interface_locale=; Path=/; SameSite=Lax; Max-Age=0');
});
test('preference response rejects malformed, unknown or inconsistent metadata', async () => {
  const { decodeInterfacePreferences } = await import('./preferences.ts');
  const value = {accountId:'a',revision:0,interfaceLocale:null,supportedInterfaceLocales:[...INTERFACE_LOCALES],defaultInterfaceLocale:'en',resolvedInterfaceLocale:'de'};
  assert.deepEqual(decodeInterfacePreferences(value),value);
  for (const patch of [{revision:-1},{interfaceLocale:'esp'},{supportedInterfaceLocales:['en','xx']},{resolvedInterfaceLocale:'xx'},{defaultInterfaceLocale:'fr'},{accountId:''}]) {
    assert.throws(() => decodeInterfacePreferences({...value,...patch}));
  }
});

test('counted notices use locale plural rules and number separators', () => {
  const forms = {one:'{count} recent match hidden',other:'{count} recent matches hidden'} as const;
  assert.equal(translateCount('fr',1,forms), '1 résultat récent masqué');
  assert.equal(translateCount('de',2000,forms), '2.000 neue Treffer verborgen');
});

test('presentation documents and account approval remain separate for all locales', async () => {
  const {policyDocument, reviewedPolicyLinks} = await import('./policies.ts');
  for (const locale of INTERFACE_LOCALES) {
    const suffix = locale==='en'?'':'.'+locale;
    assert.equal(policyDocument(locale,'privacy'), `/privacy${suffix}.html`);
    assert.equal(policyDocument(locale,'usage'), `/usage${suffix}.html`);
  }
  const base = {locale:'de',reviewedLocale:'de',fallback:false,reviewed:true,version:'synthetic-v1',privacyUrl:'/privacy.de.html',usageUrl:'/usage.de.html'} as const;
  assert.deepEqual(reviewedPolicyLinks(base,'de','https://example.test'), {privacy:'/privacy.de.html',usage:'/usage.de.html',fallbackLocale:null});
  const fallback={...base,reviewedLocale:'en',fallback:true,privacyUrl:'/privacy.html',usageUrl:'/usage.html'} as const;
  assert.equal(reviewedPolicyLinks(fallback,'de','https://example.test')?.fallbackLocale,'en');
  for (const policy of [{...base,locale:'en' as const},{...base,reviewed:false},{...base,privacyUrl:'/privacy.html'},{...base,usageUrl:'https://other.test/usage.de.html'},{...base,privacyUrl:'/privacy.de.html?x=1'},{...base,privacyUrl:'/other/../privacy.de.html'},{...fallback,fallback:false},{...base,version:''}]) {
    assert.equal(reviewedPolicyLinks(policy,'de','https://example.test'),null);
  }
});

test('hydration seeds release to account or visitor preference while explicit routes stay fixed', () => {
  const options={hydrationLocale:'en',guestOverride:'es',browserLanguages:['fr-CH']} as const;
  assert.equal(resolvePresentationLocale({...options,hydrating:true}), 'en');
  assert.equal(resolvePresentationLocale({...options,hydrating:false}), 'es');
  assert.equal(resolvePresentationLocale({...options,accountOverride:{locale:'de'}}), 'de');
  assert.equal(resolvePresentationLocale({...options,accountOverride:{locale:null}}), 'fr');
  assert.equal(resolvePresentationLocale({...options,explicitLocale:'it',accountOverride:{locale:'de'}}), 'it');
});
