import { test, expect } from '@playwright/test';
import { mockApi, search, completed, session } from './api-fixture.mjs';

const localized = [
  ['en', 'Positions', 'What work are you looking for?'],
  ['de', 'Stellen', 'Welche Arbeit suchst du?'],
  ['fr', 'Offres', 'Quel travail recherches-tu ?'],
  ['it', 'Posizioni', 'Che lavoro stai cercando?'],
  ['es', 'Ofertas', '¿Qué trabajo buscas?'],
];
for (const [locale, positions, prompt] of localized) {
  test(`${locale} browser language has readable navigation and forms at 375px`, async ({ browser }) => {
    const context = await browser.newContext({ locale: `${locale}-CH`, viewport: { width:375, height:812 }, reducedMotion:'reduce' });
    const page = await context.newPage();
    await mockApi(page);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.locator('.topbar nav a').first()).toHaveText(positions);
    await expect(page.locator('#query-label')).toHaveText(prompt);
    await page.locator('#account-open').click();
    await expect(page.locator('#settings-dialog')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('#settings-dialog').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path:`/tmp/justup-interface-${locale}-375.png`, fullPage:true });
    await page.locator('#settings-dialog .icon-close').click();
    for (const route of ['companies', 'companies/library', '#request']) {
      await page.goto('/' + route);
      await expect(page.locator('main .page:visible')).toHaveCount(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await context.close();
  });
}
test('ordered browser languages fall through unsupported choices without changing source text', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'languages', { value:['nl-NL','es-419','de-CH'] }));
  const calls = await mockApi(page, { 'GET /searches': {items:[search()]}, 'GET /searches/search-1/results':completed() });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang','es');
  await expect(page.locator('#query')).toHaveValue('Remote library jobs');
  await expect(page.getByRole('tab')).toHaveText('Library desk');
  await page.locator('#search-results').scrollIntoViewIfNeeded();
  await expect(page.locator('.job-title')).toHaveText('Librarian 1');
  await expect(page.locator('.job-company')).toContainText('Test Library');
  expect(calls.filter(call => call.key.startsWith('POST /search') || call.key.startsWith('PATCH /search'))).toEqual([]);
});

const preferences = (interfaceLocale=null, revision=0, accountId='reader') => ({accountId,revision,interfaceLocale,supportedInterfaceLocales:['en','de','fr','it','es'],defaultInterfaceLocale:'en',resolvedInterfaceLocale:interfaceLocale ?? 'en'});
const preferenceSession = () => session({capabilities:{search:true,companyRequests:true,preferences:true}});
test('account locale saves on the server without reinterpreting or rewriting the search', async ({page}) => {
  let saved = preferences('de');
  const calls = await mockApi(page, {
    'GET /session':preferenceSession(), 'GET /preferences':() => saved,
    'PATCH /preferences':call => { expect(call.body).toEqual({expectedRevision:0,interfaceLocale:'it'}); saved=preferences('it',1); return saved; },
    'GET /searches':{items:[search()]}, 'GET /searches/search-1/results':completed(),
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang','de');
  await page.locator('#query').fill('My exact unsent request: accueil à Paris, no weekends');
  await page.locator('#account-open').click();
  await expect(page.locator('#interface-language')).toHaveValue('de');
  await page.locator('#interface-language').focus();
  await page.locator('#interface-language').selectOption('it');
  await expect(page.locator('html')).toHaveAttribute('lang','it');
  await expect(page.locator('#interface-language')).toBeFocused();
  await page.locator('#settings-dialog .icon-close').click();
  await expect(page.locator('#query')).toHaveValue('My exact unsent request: accueil à Paris, no weekends');
  await expect(page.getByRole('tab')).toHaveText('Library desk');
  expect(calls.filter(call => /^(POST|PATCH) \/search/.test(call.key))).toEqual([]);
  expect(calls.every(call => call.headers['x-justup-locale'] === undefined || call.headers['x-justup-locale'] === 'it')).toBe(true);
  expect(calls.some(call => call.headers['x-justup-locale'] === 'it')).toBe(true);
  expect((await page.context().cookies()).find(cookie => cookie.name === 'justup_interface_locale')).toBeUndefined();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang','it');
});
test('visitor locale cookie persists only a manual override and browser/default clears it', async ({page}) => {
  const calls = await mockApi(page, {'GET /session':session({user:null})});
  await page.goto('/');
  expect(await page.context().cookies()).toEqual([]);
  await page.locator('#account-open').click();
  await page.locator('#interface-language').selectOption('fr');
  await expect(page.locator('html')).toHaveAttribute('lang','fr');
  const cookie = (await page.context().cookies()).find(value => value.name==='justup_interface_locale');
  expect(cookie.value).toBe('fr');expect(cookie.sameSite).toBe('Lax');expect(cookie.path).toBe('/');
  await page.reload(); await expect(page.locator('html')).toHaveAttribute('lang','fr');
  await page.locator('#account-open').click();await page.locator('#interface-language').selectOption('');
  await expect(page.locator('html')).toHaveAttribute('lang','en');
  expect((await page.context().cookies()).find(value => value.name==='justup_interface_locale')).toBeUndefined();
  expect(calls.filter(call => call.key.includes('preferences') || call.key.startsWith('POST'))).toEqual([]);
  expect(calls.every(call => call.headers['x-justup-locale'] === undefined || call.headers['x-justup-locale'] === 'fr')).toBe(true);
  expect(calls.some(call => call.headers['x-justup-locale'] === 'fr')).toBe(true);
});
test('saved account override outranks visitor choice and null follows ordered browser settings', async ({page}) => {
  await page.context().addCookies([{name:'justup_interface_locale',value:'es',url:'http://127.0.0.1:4203'}]);
  await page.addInitScript(() => Object.defineProperty(navigator,'languages',{value:['nl','fr-CA','de-CH']}));
  let saved=preferences('de');
  const calls=await mockApi(page, {'GET /session':preferenceSession(),'GET /preferences':() => saved,
    'PATCH /preferences':call => {
      expect(call.body).toEqual({expectedRevision:0,interfaceLocale:null});
      saved=preferences(null,1);return saved;
    },
  });
  await page.goto('/'); await expect(page.locator('html')).toHaveAttribute('lang','de');
  await page.locator('#account-open').click();await page.locator('#interface-language').selectOption('');
  await expect(page.locator('html')).toHaveAttribute('lang','fr');
  expect((await page.context().cookies()).find(cookie => cookie.name==='justup_interface_locale').value).toBe('es');
  await page.reload();await page.locator('#account-open').click();
  await expect(page.locator('#interface-language')).toBeEnabled();
  await expect(page.locator('#interface-language')).toHaveValue('');
  await expect(page.locator('html')).toHaveAttribute('lang','fr');
  expect(calls.filter(call => call.key==='PATCH /preferences')).toHaveLength(1);
  expect(calls.filter(call => /^(POST|PATCH) \/search/.test(call.key))).toEqual([]);
});

test('failed preference writes keep the accepted language and user text', async ({page}) => {
  const calls = await mockApi(page, {'GET /session':preferenceSession(), 'GET /preferences':preferences('de'),
    'PATCH /preferences':{status:503,body:{error:{code:'dependency_unavailable',message:'This feature is temporarily unavailable.'}}}});
  await page.goto('/');await expect(page.locator('html')).toHaveAttribute('lang','de');
  await page.locator('#query').fill('Unsent bilingual query: fr & de');
  await page.locator('#account-open').click();await page.locator('#interface-language').selectOption('es');
  await expect(page.locator('#settings-dialog')).toContainText('Diese Funktion ist vorübergehend nicht verfügbar.');
  await expect(page.locator('html')).toHaveAttribute('lang','de');
  await expect(page.locator('#query')).toHaveValue('Unsent bilingual query: fr & de');
  expect(calls.filter(call => /^(POST|PATCH) \/search/.test(call.key))).toEqual([]);
});
test('account changes discard prior account preferences and late writes', async ({page}) => {
  let owner='reader';let release;const pending=new Promise(resolve => {release=resolve});
  let patchStarted=false;
  await mockApi(page, {
    'GET /session':() => session({user:{id:owner,username:owner},capabilities:{preferences:true}}),
    'GET /preferences':() => preferences(owner==='reader'?'de':null,0,owner),
    'PATCH /preferences':async () => {patchStarted=true;await pending;return preferences('es',1,'reader')},
    'POST /session/logout':() => {owner='other';return {}},
  });
  await page.goto('/');await expect(page.locator('html')).toHaveAttribute('lang','de');
  await page.locator('#account-open').click();await page.locator('#interface-language').selectOption('es');
  await expect.poll(() => patchStarted).toBe(true);
  await page.locator('#logout').click();
  await expect(page.locator('html')).toHaveAttribute('lang','en');
  release();await page.locator('#account-open').click();
  await expect(page.locator('#settings-dialog')).toContainText('Signed in as other.');
  await expect(page.locator('#interface-language')).toHaveValue('');
  await expect(page.locator('html')).toHaveAttribute('lang','en');
});

test('preference revision conflicts preserve the accepted language and visible error during reload', async ({page}) => {
  let conflicted=false, reloadStarted=false, release;
  const pending=new Promise(resolve => {release=resolve});
  const calls=await mockApi(page, {'GET /session':preferenceSession(),
    // Locale/session reconciliation may reread before the write. Only hold the conflict reload.
    'GET /preferences':async () => {
      if (!conflicted) return preferences('de',1);
      reloadStarted=true;await pending;return preferences('it',2);
    },
    'PATCH /preferences':call => {
      expect(call.body).toEqual({expectedRevision:1,interfaceLocale:'es'});
      conflicted=true;
      return {status:409,body:{error:{code:'revision_conflict',message:'This search changed. Reload it and try again.'}}};
    },
  });
  await page.goto('/');await expect(page.locator('html')).toHaveAttribute('lang','de');
  await page.locator('#query').fill('My unchanged unsent query');
  await page.locator('#account-open').click();await page.locator('#interface-language').selectOption('es');
  await expect.poll(() => reloadStarted).toBe(true);
  await expect(page.locator('#settings-dialog')).toContainText('Deine Spracheinstellung wurde anderswo geändert.');
  await expect(page.locator('html')).toHaveAttribute('lang','de');
  await expect(page.locator('#interface-language')).toHaveValue('de');
  await expect(page.locator('#interface-language')).toBeDisabled();
  await expect(page.locator('#query')).toHaveValue('My unchanged unsent query');
  release();await expect(page.locator('html')).toHaveAttribute('lang','it');
  await expect(page.locator('#settings-dialog')).toContainText('La preferenza di lingua è cambiata altrove.');
  await expect(page.locator('#query')).toHaveValue('My unchanged unsent query');
  expect(calls.filter(call => call.key==='PATCH /preferences')).toHaveLength(1);
  expect(calls.filter(call => /^(POST|PATCH) \/search/.test(call.key))).toEqual([]);
});

for (const locale of ['de','fr','it','es']) {
  test(`${locale} presentation policy links use matching documents without enabling an English approval`, async ({page}) => {
    await page.addInitScript(locale => Object.defineProperty(navigator,'languages',{value:[locale]}), locale);
    await mockApi(page, {'GET /session':session({user:null})});
    await page.goto('/');
    await expect(page.locator('.policy-footer a').first()).toHaveAttribute('href',`/privacy.${locale}.html`);
    await expect(page.locator('.policy-footer a').last()).toHaveAttribute('href',`/usage.${locale}.html`);
    await page.locator('#header-sign-in').click();
    await expect(page.locator('#sign-in-form')).toBeHidden();
    await expect(page.locator('#sign-in-dialog a').first()).toHaveAttribute('href',`/privacy.${locale}.html`);
    await expect(page.locator('#policy-language-fallback')).toHaveCount(0);
  });
}
test('an explicitly approved fallback identifies its language and uses server reviewed URLs for account actions', async ({page}) => {
  await page.addInitScript(() => Object.defineProperty(navigator,'languages',{value:['de-CH']}));
  await mockApi(page, {'GET /session':session({user:null,policies:{locale:'de',reviewedLocale:'en',fallback:true,reviewed:true,version:'synthetic-v1',privacyUrl:'/privacy.html',usageUrl:'/usage.html'}})});
  await page.goto('/');await page.locator('#header-sign-in').click();
  await expect(page.locator('#sign-in-form')).toBeVisible();
  await expect(page.locator('#policy-language-fallback')).toContainText('English');
  await expect(page.locator('#sign-in-dialog a').first()).toHaveAttribute('href','/privacy.html');
  await expect(page.locator('.policy-footer a').first()).toHaveAttribute('href','/privacy.de.html');
});
for (const patch of [{reviewedLocale:'de',fallback:true},{privacyUrl:'/privacy.html'},{usageUrl:'https://elsewhere.test/usage.de.html'}]) {
  test(`invalid policy approval fails closed: ${JSON.stringify(patch)}`, async ({page}) => {
    await page.addInitScript(() => Object.defineProperty(navigator,'languages',{value:['de']}));
    const calls=await mockApi(page, {'GET /session':session({user:null,policies:{locale:'de',reviewedLocale:'de',fallback:false,reviewed:true,version:'synthetic-v1',privacyUrl:'/privacy.de.html',usageUrl:'/usage.de.html',...patch}})});
    await page.goto('/');await page.locator('#header-sign-in').click();
    await expect(page.locator('#sign-in-form')).toBeHidden();
    expect(calls.filter(call=>call.key.startsWith('POST /auth'))).toEqual([]);
  });
}


test('account deletion links the validated reviewed fallback privacy notice', async ({page}) => {
  await page.addInitScript(() => Object.defineProperty(navigator,'languages',{value:['de-CH']}));
  const calls = await mockApi(page, {'GET /session':session({policies:{locale:'de',reviewedLocale:'en',fallback:true,reviewed:true,version:'synthetic-v1',privacyUrl:'/privacy.html',usageUrl:'/usage.html'}})});
  await page.goto('/');await page.locator('#account-open').click();
  await page.locator('#delete-account').click();
  await expect(page.locator('#delete-account-dialog')).toBeVisible();
  await expect(page.locator('#delete-account-dialog a')).toHaveAttribute('href','/privacy.html');
  await expect(page.locator('.policy-footer a').first()).toHaveAttribute('href','/privacy.de.html');
  expect(calls.filter(call => call.key==='DELETE /account')).toEqual([]);
});

test('visitor language remains browser-local and usable when session bootstrap is unavailable', async ({page}) => {
  const calls = await mockApi(page, {'GET /session':{status:503,body:{error:{code:'unavailable',message:'The service is unavailable. Please try again.'}}}});
  await page.goto('/');await expect(page.locator('#service-notice')).toBeVisible();
  await page.locator('#account-open').click();
  await expect(page.locator('#interface-language')).toBeEnabled();
  await page.locator('#interface-language').selectOption('fr');
  await expect(page.locator('html')).toHaveAttribute('lang','fr');
  expect((await page.context().cookies()).find(cookie=>cookie.name==='justup_interface_locale')?.value).toBe('fr');
  await page.reload();await expect(page.locator('html')).toHaveAttribute('lang','fr');
  await page.locator('#account-open').click();
  await expect(page.locator('#interface-language')).toBeEnabled();
  await page.locator('#interface-language').selectOption('');
  await expect(page.locator('html')).toHaveAttribute('lang','en');
  expect((await page.context().cookies()).find(cookie=>cookie.name==='justup_interface_locale')).toBeUndefined();
  expect(calls.filter(call=>call.key.includes('preferences') || /^(POST|PATCH|PUT|DELETE) /.test(call.key))).toEqual([]);
});


test('retrying an unavailable preference load clears the recovered failure and loads the saved language', async ({page}) => {
  let reads=0;
  const calls=await mockApi(page, {'GET /session':preferenceSession(), 'GET /preferences':() => ++reads===1
    ? {status:503,body:{error:{code:'unavailable',message:'The service is unavailable. Please try again.'}}}
    : preferences('de',1),
  });
  await page.goto('/');await page.locator('#query').fill('My original unsent query');
  await page.locator('#account-open').click();
  await expect(page.locator('#settings-dialog')).toContainText('The service is unavailable. Please try again.');
  await expect(page.locator('#interface-language')).toBeDisabled();
  await page.locator('#settings-dialog').getByRole('button',{name:'Retry',exact:true}).click();
  await expect(page.locator('html')).toHaveAttribute('lang','de');
  await expect(page.locator('#interface-language')).toHaveValue('de');
  await expect(page.locator('#interface-language')).toBeEnabled();
  await expect(page.locator('#settings-dialog')).not.toContainText('The service is unavailable. Please try again.');
  await expect(page.locator('#settings-dialog')).not.toContainText('Der Dienst ist nicht verfügbar. Versuche es erneut.');
  await expect(page.locator('#query')).toHaveValue('My original unsent query');
  expect(calls.filter(call=>/^(POST|PATCH|PUT|DELETE) /.test(call.key) && call.key !== 'PATCH /workspace')).toEqual([]);
});
