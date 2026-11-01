// Product state follows server evidence independently of the deployment's audience.
import { expect, test } from '@playwright/test';
import { mockApi, session, search, job, completed } from './api-fixture.mjs';

test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1280, height: 1100 }); });

test('account access and billing disclosures follow the session rather than a preview label', async ({ page }) => {
  await mockApi(page, { 'GET /session': session({ access: { kind: 'account', fullAccess: false, billingEnabled: true, description: 'Your membership has expired.' } }) });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('#account-access')).toHaveText('Your membership has expired.');
  await expect(page.locator('#settings-content')).not.toContainText('Payments are not enabled');
  await expect(page.locator('.edition-note')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: /^Interface language/ })).toBeVisible();
});

test('unknown source kinds remain transparent without being relabelled as an imported snapshot', async ({ page }) => {
  await mockApi(page, { 'GET /session': session({ coverage: { kind: 'catalogue', verifiedAt: null, stale: false, description: 'Coverage is limited to the listed career pages.' } }) });
  await page.goto('/');
  await expect(page.locator('#coverage-disclosure')).toContainText('verification time not reported');
  await expect(page.locator('#coverage-disclosure')).toContainText('Coverage is limited to the listed career pages.');
  await expect(page.locator('#coverage-disclosure')).not.toContainText('Imported snapshot');
});

test('checking new positions refreshes the accepted revision without interpreting the unsent draft', async ({ page }) => {
  let results = 0;
  const calls = await mockApi(page, {
    'GET /searches': { items: [search()] },
    'GET /searches/search-1/results': () => completed([job(++results)]),
  });
  await page.goto('/');
  await expect(page.locator('[data-job="job-1"]')).toBeVisible();
  await page.locator('#query').fill('An unsent museum search');
  await page.getByRole('button', { name: 'Check for new positions', exact: true }).click();
  await expect(page.locator('[data-job="job-2"]')).toBeVisible();
  await expect(page.locator('[data-job="job-1"]')).toHaveCount(0);
  await expect(page.locator('#query')).toHaveValue('An unsent museum search');
  const reads = calls.filter(call => call.key === 'GET /searches/search-1/results');
  expect(reads).toHaveLength(2);
  expect(reads.every(call => call.url.searchParams.get('revision') === '1' && !call.url.searchParams.has('cursor'))).toBe(true);
  expect(calls.some(call => call.key.startsWith('POST /searches') || call.key.startsWith('PATCH /searches'))).toBe(false);
});

for (const hidden of [{ count: 7, status: 'exact' }, { count: 3, status: 'lower_bound' }, { count: 0, status: 'exact' }, { count: null, status: 'pending' }, { count: null, status: 'unavailable' }, null]) {
  test(`hidden-match access notice uses only reported counts: ${JSON.stringify(hidden)}`, async ({ page }) => {
    await mockApi(page, {
      'GET /session': session({ access: { kind: 'account', fullAccess: false, billingEnabled: false } }),
      'GET /searches': { items: [search()] },
      'GET /searches/search-1/results': { ...completed(), ...(hidden ? { hiddenMatches: hidden } : {}) },
    });
    await page.goto('/');
    await expect(page.locator('#refresh-results')).toBeVisible();
    if (!hidden?.count) {
      await expect(page.locator('#hidden-matches')).toHaveCount(0);
      return;
    }
    await expect(page.locator('#hidden-matches-title')).toHaveText(`${hidden.status === 'exact' ? '' : 'At least '}${hidden.count} recent matches hidden`);
    await expect(page.locator('.compressed-matches')).toHaveAttribute('aria-hidden', 'true');
    await page.getByRole('button', { name: 'Account access ↗', exact: true }).click();
    await expect(page.locator('#settings-dialog')).toBeVisible();
  });
}

for (const requiresInvitation of [false, true, undefined]) {
  test(`registration invitation requirement follows the server, defaulting closed: ${requiresInvitation}`, async ({ page }) => {
    const authentication = { method: 'username_password', loginEnabled: true, registrationEnabled: true, reason: null, ...(requiresInvitation === undefined ? {} : { requiresInvitation }) };
    let signedIn = false;
    const calls = await mockApi(page, {
      'GET /session': () => session({ user: signedIn ? { id: 'reader', username: 'tester' } : null, authentication }),
      'POST /auth/register': () => { signedIn = true; return {}; },
    });
    await page.goto('/'); await page.locator('#header-sign-in').click();
    await page.locator('#auth-register').check();
    await page.locator('#auth-username').fill('tester'); await page.locator('#auth-password').fill('test-only-password');
    if (requiresInvitation !== false) {
      await expect(page.locator('#auth-invite')).toBeVisible();
      await expect(page.locator('#auth-invite')).toHaveAttribute('required', '');
      await page.locator('#auth-submit').click();
      expect(calls.some(call => call.key === 'POST /auth/register')).toBe(false);
      await page.locator('#auth-invite').fill('test-only-invitation');
    } else {
      await expect(page.locator('#auth-invite-field')).toBeHidden();
      await expect(page.locator('#auth-invite')).not.toHaveAttribute('required', '');
    }
    await page.locator('#auth-submit').click();
    await expect(page.locator('#sign-in-dialog')).not.toBeVisible();
    const register = calls.find(call => call.key === 'POST /auth/register');
    expect(register.body).toEqual({ username: 'tester', password: 'test-only-password', ...(requiresInvitation !== false ? { inviteCode: 'test-only-invitation' } : {}) });
  });
}

test('a manual refresh does not reuse the previous reveal count for offscreen new results', async ({ page }) => {
  await page.clock.install();
  await page.setViewportSize({ width: 375, height: 420 });
  let reads = 0, release;
  const refreshed = new Promise(resolve => { release = resolve; });
  await mockApi(page, {
    'GET /searches': { items: [search()] },
    'GET /searches/search-1/results': async () => {
      const batch = ++reads;
      if (batch > 1) await refreshed;
      return completed(Array.from({ length: 10 }, (_, index) => job(batch * 100 + index)));
    },
  });
  await page.goto('/');
  await expect(page.locator('#feed-status')).toContainText('Still checking');
  await page.locator('#feed-tail').scrollIntoViewIfNeeded();
  await page.clock.runFor(500);
  await expect.poll(() => page.locator('[data-job]').count()).toBeGreaterThan(0);
  await page.locator('#refresh-results').click();
  await expect.poll(() => reads).toBe(2);
  // Pin the real slot outside the viewport before releasing refreshed network data.
  await page.evaluate(() => scrollTo(0, 0));
  await expect.poll(() => page.locator('#feed-tail').evaluate(element => element.getBoundingClientRect().top)).toBeGreaterThan(420);
  release();
  await expect(page.locator('#refresh-results')).toBeEnabled();
  await page.clock.runFor(600);
  await expect(page.locator('[data-job]')).toHaveCount(0);
});
