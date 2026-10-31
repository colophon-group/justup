import { expect, test } from '@playwright/test';

// Public draft notices are static. These tests must not use accounts or real providers.
for (const kind of ['privacy', 'usage']) {
  test(`${kind} is publicly readable without JavaScript or a session`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, javaScriptEnabled: false, viewport: { width: 360, height: 800 } });
    const page = await context.newPage();
    const requests = [];
    page.on('request', request => requests.push(request));
    const response = await page.goto(`/${kind}.html`);

    expect(response.status()).toBe(200);
    await expect(page).toHaveTitle(`${kind === 'privacy' ? 'Privacy' : 'Usage'} — Justup`);
    await expect(page.getByRole('heading', { name: 'Draft — review incomplete' })).toBeVisible();
    await expect(page.locator('.policy-status')).toContainText('Sign-in must remain disabled');
    await expect(page.locator('.policy-status')).toContainText('No effective date has been set.');
    await expect(page.locator('body')).toHaveAttribute('data-policy-status', 'draft');
    await expect(page.locator('meta[name="justup-policy-status"]')).toHaveAttribute('content', 'draft');
    await expect(page.locator('meta[name="justup-policy-version"]')).toHaveAttribute('content', 'demo-draft-1');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex,nofollow');
    await expect(page.getByRole('navigation').getByRole('link', { name: 'Privacy', exact: true })).toHaveAttribute('href', '/privacy.html');
    await expect(page.getByRole('navigation').getByRole('link', { name: 'Usage', exact: true })).toHaveAttribute('href', '/usage.html');
    await expect(page.getByRole('navigation').getByRole('link', { name: /Back to search/ })).toHaveAttribute('href', '/#jobs');
    expect(requests.every(request => new URL(request.url()).origin === new URL(baseURL).origin)).toBe(true);
    expect(requests.some(request => request.url().includes('/api/'))).toBe(false);
    await expect(page.locator('script')).toHaveCount(0);
    await context.close();
  });
}

test('privacy draft names unresolved operator and implementation facts without inventing them', async ({ page }) => {
  await page.goto('/privacy.html');
  await expect(page.getByRole('heading', { name: 'Who runs Justup?' })).toBeVisible();
  for (const fact of [
    'operator’s legal name and a monitored privacy contact have not yet been published',
    'login provider, exact permissions and account identifiers need to be confirmed',
    'search text and profile details are sent to an AI service',
    'Request visibility and retention have not yet been confirmed',
    'session cookies, browser storage, analytics and hosting or application logs',
    'Processing countries and any international transfers',
    'provider copies and backups',
    'No deletion timing or outcome is promised by this draft',
  ]) await expect(page.locator('main')).toContainText(fact);
  await expect(page.locator('a[href^="mailto:"]')).toHaveCount(0);
  await expect(page.getByRole('button')).toHaveCount(0);
});

test('usage explains uncertainty and outside sources without granting unimplemented access', async ({ page }) => {
  await page.goto('/usage.html');
  for (const fact of [
    'temporary preview does not collect payments',
    'does not grant a subscription, trial or legacy-account benefit',
    'can misunderstand criteria',
    'not a complete view of the job market',
    'not necessarily when the employer published it',
    'third-party pages with their own terms and privacy notices',
    'does not guarantee successful collection or a completion date',
    'working operator contact and reporting route must be published',
  ]) await expect(page.locator('main')).toContainText(fact);
});

test('policy navigation works with the API unavailable', async ({ page }) => {
  await page.route('**/api/**', route => route.abort());
  await page.goto('/privacy.html');
  await page.getByRole('navigation').getByRole('link', { name: 'Usage', exact: true }).click();
  await expect(page).toHaveURL(/\/usage\.html$/);
  await expect(page.getByRole('heading', { name: 'Usage.', exact: true })).toBeVisible();
  await page.getByRole('navigation').getByRole('link', { name: 'Privacy', exact: true }).click();
  await expect(page).toHaveURL(/\/privacy\.html$/);
});

test('policy pages fit narrow viewports and have keyboard-visible navigation', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/privacy.html');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to privacy information' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
});
