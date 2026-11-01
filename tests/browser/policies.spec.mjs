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
      await expect(page.locator('.policy-section')).toHaveCount(kind === 'privacy' ? 9 : 7);
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
  for (const fact of ['local username and password', 'salted password hash', 'default session lifetime is 7 days', 'a deployment can configure a different lifetime', 'Accounts are retained until you delete them', 'keyed identity-proof hashes', 'Signing in alone does not grant full access', 'not been selected or approved']) await expect(account).toContainText(fact);
  const deployment = page.locator('section[aria-labelledby="deployment-settings"]');
  for (const fact of ['verified and disclosed before invitations', 'Accounts have no automatic expiry by default', 'not subscription rules', '2 SQLite backups', '7-day usable age']) await expect(deployment).toContainText(fact);
  const ai = page.locator('section[aria-labelledby="section-2"]');
  for (const fact of ['remain disabled', 'OpenAI', 'TypeSafe’s JEV', 'does not add your Justup account identifier', 'still require verification']) await expect(ai).toContainText(fact);
  const companies = page.locator('section[aria-labelledby="section-3"]');
  for (const fact of ['without an AI call', 'Native-web discovery remains disabled', 'default request metadata and provider retention', 'does not by itself start career-page collection']) await expect(companies).toContainText(fact);
  const browserState = page.locator('section[aria-labelledby="section-4"]');
  for (const fact of ['not in browser localStorage', 'justup_interface_locale', 'manually selected interface language', 'Max-Age=31536000', 'choosing the browser/default language removes it', 'creates no visitor record', 'guest choice is never copied into an account']) await expect(browserState).toContainText(fact);
  await expect(page.locator('section[aria-labelledby="section-5"]')).toContainText('Nuremberg, Germany');
  await expect(page.locator('section[aria-labelledby="section-5"]')).toContainText('no remote logo URLs');
  const retention = page.locator('section[aria-labelledby="section-6"]');
  for (const fact of ['while the API is running', 'there is no automatic backup schedule', 'invalidates and purges recovery backups', 'not promised', 'erases ordinary and welcome free-period redemption records and keyed identity evidence', 'No hidden redemption marker is retained', 'may receive another free period']) await expect(retention).toContainText(fact);
  await expect(page.locator('section[aria-labelledby="section-7"]')).toContainText('final operator review');
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
  ]) await expect(page.locator('main')).toContainText(fact);
});
