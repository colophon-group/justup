// Outbound registration evidence only; fixture denials do not claim durable server acceptance.
import { expect, test } from '@playwright/test';
import { mockApi, session } from './api-fixture.mjs';

const stopped = { status: 400, body: { error: { code: 'invalid_input', message: 'Synthetic registration stopped before account creation.' } } };
const policies = (locale, patch = {}) => ({ locale, reviewedLocale: locale, fallback: false, reviewed: true, version: 'synthetic-current-v2',
  privacyUrl: `/privacy${locale === 'en' ? '' : '.' + locale}.html`, usageUrl: `/usage${locale === 'en' ? '' : '.' + locale}.html`, ...patch });
const accountSession = (locale, patch = {}) => session({ user: null, authentication: { method: 'username_password', loginEnabled: true, registrationEnabled: true, requiresInvitation: false, reason: null }, policies: policies(locale, patch) });
async function openRegistration(page, locale = 'en') {
  await page.goto(locale === 'en' ? '/' : `/${locale}/`);
  await page.locator('#header-sign-in').click();
  await page.locator('#auth-register').check();
  await page.locator('#auth-username').fill('reader');
  await page.locator('#auth-password').fill('test-only-password');
}

for (const locale of ['en', 'de', 'fr', 'it', 'es']) {
  test(`${locale} registration affirms the current admitted version only on explicit submission`, async ({ page }) => {
    const calls = await mockApi(page, { 'GET /session': accountSession(locale), 'POST /auth/register': stopped });
    await openRegistration(page, locale);
    expect(calls.filter(call => call.key.startsWith('POST /auth/'))).toEqual([]);
    await page.locator('#auth-submit').click();
    await expect.poll(() => calls.filter(call => call.key === 'POST /auth/register').length).toBe(1);
    expect(calls.find(call => call.key === 'POST /auth/register').body).toEqual({ username: 'reader', password: 'test-only-password',
      acceptance: { usageVersion: 'synthetic-current-v2', locale, adultAndCapable: true } });
    await expect(page.locator('#sign-in-dialog')).toBeVisible();
    expect(calls.filter(call => call.key === 'POST /auth/login')).toEqual([]);
    expect(calls.filter(call => /activate|free-period/.test(call.key))).toEqual([]);
  });
}

test('an approved English document fallback records the requested German scope', async ({ page }) => {
  const calls = await mockApi(page, { 'GET /session': accountSession('de', { reviewedLocale: 'en', fallback: true, privacyUrl: '/privacy.html', usageUrl: '/usage.html' }), 'POST /auth/register': stopped });
  await openRegistration(page, 'de');
  await expect(page.locator('#policy-language-fallback')).toBeVisible();
  await page.locator('#auth-submit').click();
  await expect.poll(() => calls.filter(call => call.key === 'POST /auth/register').length).toBe(1);
  expect(calls.find(call => call.key === 'POST /auth/register').body.acceptance).toEqual({ usageVersion: 'synthetic-current-v2', locale: 'de', adultAndCapable: true });
});

test('missing version and mismatched requested policy locale never submit registration', async ({ page }) => {
  for (const patch of [{ reviewed: false, reviewedLocale: null, version: null, privacyUrl: null, usageUrl: null }, { locale: 'en' }]) {
    const calls = await mockApi(page, { 'GET /session': accountSession('de', patch), 'POST /auth/register': stopped });
    await page.goto('/de/'); await page.locator('#header-sign-in').click();
    await expect(page.locator('#sign-in-form')).toBeHidden();
    expect(calls.filter(call => call.key.startsWith('POST /auth/'))).toEqual([]);
    await page.unroute('**/api/v1/**');
  }
});

test('a changed admitted version while visitor draft saving is pending cannot submit stale acceptance', async ({ page }) => {
  let version = 'synthetic-current-v2', release;
  const pending = new Promise(resolve => { release = resolve; });
  const calls = await mockApi(page, { 'GET /session': () => accountSession('en', { version }), 'POST /auth/register': stopped,
    'PATCH /visitor/workspace': async call => { await pending; return { revision: call.body.expectedRevision + 1,
      state: { activeSearchId: call.body.activeSearchId, drafts: call.body.drafts }, viewed: [], recoveredDrafts: [] }; } });
  await openRegistration(page);
  // Draft persistence must finish before credentials are sent; keep that real UI boundary pending.
  await page.locator('#sign-in-dialog .icon-close').click();
  await page.locator('#query').fill('Part-time museum jobs');
  await page.locator('#header-sign-in').click(); await page.locator('#auth-register').check();
  await page.locator('#auth-username').fill('reader'); await page.locator('#auth-password').fill('test-only-password');
  await page.locator('#auth-submit').click();
  await expect.poll(() => calls.filter(call => call.key === 'PATCH /visitor/workspace').length).toBe(1);
  version = 'synthetic-new-v3';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => calls.filter(call => call.key === 'GET /session').length).toBeGreaterThan(1);
  release();
  await expect(page.locator('#auth-submit')).toBeEnabled();
  expect(calls.filter(call => call.key.startsWith('POST /auth/'))).toEqual([]);
});
