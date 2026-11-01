import { expect, test } from '@playwright/test';

// Static draft notices: no accounts, API fixtures or real providers.
const locales = {
  en: { privacy: 'Privacy', usage: 'Usage', status: 'Draft — review incomplete', skip: 'Skip to privacy information' },
  de: { privacy: 'Datenschutz', usage: 'Nutzung', status: 'Entwurf — Prüfung nicht abgeschlossen', skip: 'Zum Datenschutzhinweis' },
  fr: { privacy: 'Vie privée', usage: 'Utilisation', status: 'Projet — vérification incomplète', skip: 'Aller aux informations sur la vie privée' },
  it: { privacy: 'Privacy', usage: 'Utilizzo', status: 'Bozza — revisione incompleta', skip: 'Vai alle informazioni sulla privacy' },
  es: { privacy: 'Privacidad', usage: 'Uso', status: 'Borrador — revisión incompleta', skip: 'Ir a la información de privacidad' },
};
const path = (kind, locale) => `/${kind}${locale === 'en' ? '' : `.${locale}`}.html`;

for (const [locale, copy] of Object.entries(locales)) {
  for (const kind of ['privacy', 'usage']) {
    test(`${locale} ${kind} is a complete public draft without JavaScript or a session`, async ({ browser, baseURL }) => {
      const context = await browser.newContext({ baseURL, javaScriptEnabled: false, viewport: { width: 360, height: 800 } });
      const page = await context.newPage();
      const requests = [];
      page.on('request', request => requests.push(request));
      await page.route('**/api/**', route => route.abort());
      const response = await page.goto(path(kind, locale));
      expect(response.status()).toBe(200);
      await expect(page).toHaveTitle(`${copy[kind]} — Justup`);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.getByRole('heading', { name: copy.status, exact: true })).toBeVisible();
      await expect(page.locator('body')).toHaveAttribute('data-policy-status', 'draft');
      await expect(page.locator('body')).toHaveAttribute('data-policy-version', 'product-draft-5');
      await expect(page.locator('body')).toHaveAttribute('data-policy-reviewed', 'false');
      await expect(page.locator('meta[name="justup-policy-status"]')).toHaveAttribute('content', 'draft');
      await expect(page.locator('meta[name="justup-policy-version"]')).toHaveAttribute('content', 'product-draft-5');
      await expect(page.locator('meta[name="justup-policy-reviewed"]')).toHaveAttribute('content', 'false');
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex,nofollow');
      await expect(page.locator('main')).toContainText('Viktor Shcherbakov');
      await expect(page.getByRole('link', { name: 'business@colophon-group.org', exact: true })).toHaveAttribute('href', 'mailto:business@colophon-group.org');
      const nav = page.locator('.policy-header nav');
      await expect(nav.getByRole('link', { name: copy.privacy, exact: true })).toHaveAttribute('href', path('privacy', locale));
      await expect(nav.getByRole('link', { name: copy.usage, exact: true })).toHaveAttribute('href', path('usage', locale));
      await expect(page.locator('.policy-header nav a').last()).toHaveAttribute('href', `${locale === 'en' ? '/' : `/${locale}/`}#jobs`);
      await expect(page.locator('.policy-languages a')).toHaveCount(5);
      await expect(page.locator('.policy-section')).toHaveCount(kind === 'privacy' ? 10 : 7);
      await expect(page.locator('.policy-document')).toHaveCSS('background-color', 'rgb(249, 231, 212)');
      const contents = page.locator('.policy-contents a');
      await expect(contents).toHaveCount(kind === 'privacy' ? 10 : 7);
      const target = await contents.first().getAttribute('href');
      await contents.first().click();
      await expect(page.locator(target)).toBeInViewport();
      expect(requests.every(request => new URL(request.url()).origin === new URL(baseURL).origin)).toBe(true);
      expect(requests.some(request => request.url().includes('/api/'))).toBe(false);
      await expect(page.locator('script,iframe,form')).toHaveCount(0);
      // Both long localized titles and the language links fit at mobile width.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await context.close();
    });
  }
  test(`${locale} notice navigation and skip link work by keyboard with the API unavailable`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, javaScriptEnabled: false, viewport: { width: 360, height: 800 } });
    const page = await context.newPage();
    await page.route('**/api/**', route => route.abort());
    await page.goto(path('privacy', locale));
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: copy.skip, exact: true })).toBeFocused();
    await expect(page.getByRole('link', { name: copy.skip, exact: true })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main')).toBeFocused();
    await page.locator('.policy-header nav').getByRole('link', { name: copy.usage, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(path('usage', locale).replaceAll('.', '\\.') + '$'));
    await expect(page.getByRole('heading', { name: `${copy.usage}.`, exact: true })).toBeVisible();
    await page.locator('.policy-languages a[lang="en"]').click();
    await expect(page).toHaveURL(/\/usage\.html$/);
    await context.close();
  });
}

test('privacy distinguishes current code from deployment and provider review gaps', async ({ page }) => {
  await page.goto('/privacy.html');
  await expect(page.locator('.policy-status')).toContainText('Sign-in must remain disabled');
  await expect(page.locator('.policy-status')).toContainText('No effective date has been set.');
  const account = page.locator('section[aria-labelledby="section-1"]');
  for (const fact of ['local username and password', 'salted password hash', 'default session lifetime is 7 days', 'a deployment can configure a different lifetime', 'Accounts are retained until you delete them', 'keyed identity-proof hashes', 'Signing in alone does not grant full access', 'Identity verification and billing still require separate reviewed activation', 'account-held followed companies', 'explicit unfollow choices', 'interface and posting-language preferences', 'account lifetime and deletion rules']) await expect(account).toContainText(fact);
  const deployment = page.locator('section[aria-labelledby="deployment-settings"]');
  for (const fact of ['verified and disclosed before invitations', 'Accounts have no automatic expiry by default', 'not subscription rules', '2 SQLite backups', '7-day usable age']) await expect(deployment).toContainText(fact);
  const ai = page.locator('section[aria-labelledby="section-2"]');
  for (const fact of ['remain disabled', 'OpenAI', 'TypeSafe’s JEV', 'does not add your Justup account identifier', 'still require verification']) await expect(ai).toContainText(fact);
  const companies = page.locator('section[aria-labelledby="section-3"]');
  for (const fact of ['without an AI call', 'Native-web discovery remains disabled', 'default request metadata and provider retention', 'does not by itself start career-page collection', 'your account automatically follows the confirmed company when you confirm a request', 'unless you explicitly unfollowed it before']) await expect(companies).toContainText(fact);
  const browserState = page.locator('section[aria-labelledby="section-4"]');
  for (const fact of ['not in browser localStorage', 'justup_interface_locale', 'manually selected interface language', 'Max-Age=31536000', 'choosing the browser/default language removes it', 'creates no visitor record', 'guest choice is never copied into an account']) await expect(browserState).toContainText(fact);
  await expect(page.locator('section[aria-labelledby="section-5"]')).toContainText('Nuremberg, Germany');
  await expect(page.locator('section[aria-labelledby="section-5"]')).toContainText('no remote logo URLs');
  const retention = page.locator('section[aria-labelledby="section-6"]');
  for (const fact of ['while the API is running', 'there is no automatic backup schedule', 'invalidates and purges recovery backups', 'not promised', 'erases ordinary and welcome free-period redemption records and keyed identity evidence', 'No hidden redemption marker is retained', 'may receive another free period']) await expect(retention).toContainText(fact);
  await expect(page.locator('section[aria-labelledby="section-7"]')).toContainText('final operator review');
});

test('conditional visitor and first-party measurement disclosures preserve boundaries and fixed retention inventory', async ({ page }) => {
  await page.goto('/privacy.html');
  const account = page.locator('section[aria-labelledby="section-1"]');
  for (const fact of ['after integration and review', '24 hours with a fixed server deadline', 'reads do not extend it', 'nonempty drafts can be saved as you type', 'including whitespace-only drafts', 'even if AI search is unavailable', 'exactly as entered, without trimming or normalization', 'Browsing alone and empty or invalid saves create no workspace', 'Saving a draft is separate from pressing Search', 'without overwriting its existing searches', 'Unfinished visitor tasks are cancelled', 'spent ownership receipt prevents replay', 'removed on account deletion']) await expect(account).toContainText(fact);
  await expect(account).not.toContainText('still being finalized');
  const browserState = page.locator('section[aria-labelledby="section-4"]');
  for (const fact of ['__Host-justup_visitor', 'remaining server lifetime', 'stateless ownership hint', 'without creating a server workspace', 'X-Justup-Locale', 'only for the API request', 'does not save a preference or create a visitor record', 'separate from third-party analytics or advertising trackers', 'no new public analytics service, public analytics endpoint or analytics cookie']) await expect(browserState).toContainText(fact);
  await expect(browserState).not.toContainText('includes no analytics');
  const evidence = page.locator('section[aria-labelledby="measurement-records"]');
  for (const fact of ['When enabled after integration and review', 'access segment, interface language, timestamps, numeric counts', 'opaque owner, search or task references', '7-day limit and a 10000-row cap', 'Anonymous public viewing is unmeasured', 'never proof of an application or hire', 'confirmed cost', 'numeric repair and yield counts', '7-day limit and a 5000-row cap', 'Unconfirmed Codex monetary cost remains unknown', 'references only, not user text', '7 days and 200 entries', 'operator-reviewed synthetic or explicitly redacted cases', '180 days', '200 case versions of 16 KiB each', 'not automatically copied', 'exclude raw queries, drafts, posting bodies, URLs, IP addresses, emails, credentials and traces', 'deletion and expiry erase private references', 'handoff transfers eligible ownership references', 'running API and a safe deletion barrier', 'do not promise physical deletion at an unconditional deadline', 'active deployment']) await expect(evidence).toContainText(fact);
  await expect(page.locator('section[aria-labelledby="section-7"]')).toContainText('Later visitor bootstrap or issuance changes require renewed reconciliation');
  await page.goto('/usage.html');
  await expect(page.locator('main')).toContainText('not prove immediate deletion');
  await expect(page.locator('main')).toContainText('not an application, interview or hire');
});

test('optional email notices disclose the recipient and US storage without claiming activation or deletion guarantees', async ({ page }) => {
  await page.goto('/privacy.html');
  const account = page.locator('section[aria-labelledby="section-1"]');
  for (const fact of ['Ordinary registration and sign-in use a local username and password', 'optional email-ownership verification step can ask a signed-in user for an address', 'if it is integrated, reviewed and enabled', 'a signed-in user can provide an address to prove control of that mailbox', 'Verification alone does not activate a free period', 'Resend receives that recipient address', 'verification message with its short-lived code', 'delivery reference', 'address is held only in the temporary verification record', 'removed through local cleanup after delivery, failure or expiry', 'Codes are not saved as readable text in local records', 'Delivery-task metadata, without the address or code, has a 30-day limit', 'running service and safe deletion controls', 'valid for 10 minutes', 'bound to the original signed-in session and language', 'Changing interface language does not change that binding', 'confirmed during a delivery-queue or AI outage', 'Availability of a new send is separate from confirmation']) await expect(account).toContainText(fact);
  const hosting = page.locator('section[aria-labelledby="section-5"]');
  for (const fact of ['When enabled', 'accounts@notify.justup.work', 'with sending routed through Ireland', 'stores message content, delivery logs, webhook payloads and its account records in the United States', 'does not move that storage to Ireland', 'verified for the selected provider account', 'does not itself promise deletion of Resend’s copies']) await expect(hosting).toContainText(fact);
  await expect(hosting).not.toContainText('30 days');
  await expect(page.locator('body')).toHaveAttribute('data-policy-reviewed', 'false');
  await page.goto('/usage.html');
  await expect(page.locator('main')).toContainText('If reviewed and enabled, signed-in users can provide an address');
  await expect(page.locator('main')).toContainText('Verification alone does not activate a free period or grant full access');
});

test('usage keeps signed-in but unentitled accounts limited and future providers inactive', async ({ page }) => {
  await page.goto('/usage.html');
  for (const fact of [
    'invitation-only username/password accounts and does not collect payments',
    'Signing in alone does not unlock the newest matches',
    'accounts without a current full-access entitlement remain limited',
    'server-verified eligibility and an active free or paid access period',
    'explicitly starts a free week', 'calendar month instead', 'Repeating activation does not restart',
    'No active identity or billing provider is approved yet',
    'bounded imported snapshot', 'not continuous monitoring', 'always newest first',
    'between 48 hours and 14 days ago', 'not necessarily when the employer published it',
    'stale imported evidence pauses results', 'needs your explicit confirmation',
    'Reports and weekly changes require verified source history',
    'No language fallback is approved automatically',
    'automatically follows the confirmed company unless you explicitly unfollowed it before',
  ]) await expect(page.locator('main')).toContainText(fact);
});
