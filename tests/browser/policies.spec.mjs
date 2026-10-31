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
    await expect(page.locator('meta[name="justup-policy-version"]')).toHaveAttribute('content', 'demo-draft-3');
    await expect(page.locator('body')).toHaveAttribute('data-policy-version', 'demo-draft-3');
    await expect(page.locator('.policy-status')).toContainText('Draft version: demo-draft-3.');
    await expect(page.locator('main')).toContainText('Justup is operated by Viktor Shcherbakov');
    await expect(page.getByRole('link', { name: 'business@colophon-group.org', exact: true })).toHaveAttribute('href', 'mailto:business@colophon-group.org');
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

test('privacy draft states prepared data flows and keeps deployment/provider proof outstanding', async ({ page }) => {
  await page.goto('/privacy.html');
  await expect(page.locator('section[aria-labelledby="section-0"]')).toContainText('message and reply address');
  const account = page.locator('section[aria-labelledby="section-1"]');
  await expect(account).toContainText('invite-only local username/password');
  await expect(account).toContainText('salted password hash');
  await expect(account).toContainText('30 days after registration');
  await expect(account).not.toContainText('need to be confirmed');
  const ai = page.locator('section[aria-labelledby="section-2"]');
  await expect(ai).toContainText('remain disabled');
  await expect(ai).toContainText('OpenAI');
  await expect(ai).toContainText('TypeSafe’s JEV');
  await expect(ai).toContainText('does not add your Justup account identifier');
  await expect(page.locator('section[aria-labelledby="section-3"]')).toContainText('without an AI call');
  await expect(page.locator('section[aria-labelledby="section-4"]')).toContainText('not in browser localStorage');
  await expect(page.locator('section[aria-labelledby="section-4"]')).toContainText('does not mean the hosting services keep no access or security logs');
  await expect(page.locator('section[aria-labelledby="section-5"]')).toContainText('Nuremberg, Germany');
  await expect(page.locator('section[aria-labelledby="section-5"]')).toContainText('account-form submissions and cookies');
  await expect(page.locator('section[aria-labelledby="section-5"]')).toContainText('no remote logo URLs');
  const retention = page.locator('section[aria-labelledby="section-6"]');
  await expect(retention).toContainText('while the API is running');
  await expect(retention).toContainText('two SQLite backups');
  await expect(retention).toContainText('seven-day usable backup age');
  await expect(retention).toContainText('invalidates and purges recovery backups');
  await expect(retention).toContainText('immediate secure erasure');
  await expect(retention).toContainText('is not promised');
  await expect(page.locator('section[aria-labelledby="section-7"]')).toContainText('provider’s actual metadata');
  await expect(page.locator('section[aria-labelledby="section-7"]')).toContainText('final operator review');
  await expect(page.locator('a[href^="mailto:"]')).toHaveCount(1);
  await expect(page.getByRole('button')).toHaveCount(0);
});

test('usage describes the bounded snapshot and explicit confirmation without activating future features', async ({ page }) => {
  await page.goto('/usage.html');
  for (const fact of [
    'temporary preview does not collect payments',
    'does not grant a subscription, trial or legacy-account benefit',
    'bounded imported snapshot',
    'not continuous monitoring',
    'always newest first',
    'between 48 hours and 14 days ago',
    'not necessarily when the employer published it',
    'stale imported evidence pauses results',
    'needs your explicit confirmation',
    'does not start a crawler, follow the company, grant priority',
    'third-party pages with their own terms and privacy notices',
    'For questions or to report an incorrect match',
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
