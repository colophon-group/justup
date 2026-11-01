import { test, expect } from '@playwright/test';
import { mockApi, search, completed, job } from './api-fixture.mjs';
const origin = `http://127.0.0.1:${process.env.JUSTUP_PUBLIC_TEST_PORT || 4207}`;
test.use({ baseURL: origin, timezoneId: 'Pacific/Kiritimati' });
test('public company reports and catalogue work without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false }); const page = await context.newPage();
  const response = await page.goto(`${origin}/companies`); expect(response.status()).toBe(200);
  await expect(page.locator('#company-list [data-company]')).toHaveCount(20);
  await page.getByRole('link', { name: 'More companies' }).click();
  await expect(page.locator('#company-list [data-company]')).toHaveCount(10);
  await page.goBack();
  await page.getByRole('link', { name: 'Test Library', exact: true }).click();
  await expect(page).toHaveURL(/\/companies\/library$/); await expect(page.getByRole('heading', { name: 'Test Library', exact: true })).toBeVisible();
  await expect(page.locator('#company-page a[href="https://careers.example.com/library"]')).toHaveCount(1);
  await expect(page.locator('#company-page a[href="https://employer.test/careers"]')).toHaveCount(0);
  await page.goto(`${origin}/companies/missing`); await expect(page.getByRole('heading', { name: 'Page not found.' })).toBeVisible();
  await context.close();
});
test('built public HTML hydrates without errors and buffers unseen catalogue rows until scrolling', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-01T12:00:00Z') });
  await page.clock.pauseAt(new Date('2026-11-01T12:00:01Z'));
  await page.setViewportSize({ width: 1280, height: 900 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/companies');
  await expect(page.locator('#live-label')).toHaveText('LIVE EDITION');
  const rows = page.locator('#company-list [data-company]');
  await expect(rows).not.toHaveCount(30);
  const initial = await rows.count(); expect(initial).toBeLessThan(30);
  await page.locator('#company-query').focus(); await page.clock.runFor(1100); expect(await rows.count()).toBe(initial); await expect(page.locator('#company-query')).toBeFocused();
  await page.locator('#company-tail').scrollIntoViewIfNeeded();
  // Start the interval from a delivered scroll event, not Playwright's return
  // from scrolling before the browser has dispatched that event.
  await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
  const before = await rows.count();
  await page.clock.runFor(449); expect(await rows.count()).toBe(before);
  await page.clock.runFor(1); await expect(rows).toHaveCount(before + 1);
  expect(errors).toEqual([]);
});
test('client company navigation preserves search draft and browser history', async ({ page }) => {
  await mockApi(page, { 'GET /searches': { items: [search()] }, 'GET /searches/search-1/results': completed([job(1)]) });
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.goto('/'); await expect(page.locator('[data-job]')).toHaveCount(1);
  await page.locator('#query').fill('Unsent detailed request');
  await page.locator('.job-company').click(); await expect(page).toHaveURL(/\/companies\/library$/);
  await expect(page.getByRole('heading', { name: 'Test Library', exact: true })).toBeVisible();
  await expect(page.locator('link[rel=canonical]')).toHaveAttribute('href', `${origin}/companies/library`);
  await page.getByRole('link', { name: '← Back to search' }).click(); await expect(page.locator('#query')).toHaveValue('Unsent detailed request');
  await page.goBack(); await expect(page.getByRole('heading', { name: 'Test Library', exact: true })).toBeVisible();
  await page.goBack(); await expect(page.locator('#query')).toHaveValue('Unsent detailed request');
});
test('catalogue continuation keeps buffered rows and reports stale cursors without a false end', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  let pages = 0;
  await page.route('**/api/v1/companies?**', route => {
    pages++;
    return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'stale_cursor', message: 'The catalogue changed. Reload to continue.' } }) });
  });
  await page.goto('/companies');
  const rows = page.locator('#company-list [data-company]');
  for (let index = 0; index < 25 && pages === 0; index++) { await page.locator('#company-tail').scrollIntoViewIfNeeded(); await page.waitForTimeout(460); }
  await expect(page.locator('#company-scroll-status')).toContainText('The catalogue changed');
  await expect(page.getByRole('button', { name: 'Reload directory' })).toBeVisible();
  await expect(rows).toHaveCount(20); expect(pages).toBe(1);
  await page.waitForTimeout(600); expect(pages).toBe(1);
  await expect(page.locator('#company-scroll-status')).not.toContainText('That’s the directory so far.');
});

test('company report dates hydrate consistently across browser time zones', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/companies/library');
  await expect(page.locator('time[datetime="2026-10-31T23:30:00Z"]')).toHaveText('Oct 31, 2026');
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});
test('client company refetch cannot restore unsafe metadata or unsupported legacy career links', async ({ page }) => {
  const privateRequests = [];
  await page.route(/https?:\/\/(?:127\.0\.0\.1:5432|192\.168\.0\.1|internal\.lan)/, route => { privateRequests.push(route.request().url()); return route.abort(); });
  await mockApi(page, { 'GET /searches': { items: [search()] }, 'GET /searches/search-1/results': completed([job(1)]),
    'GET /companies/library': { id: 'library', name: 'Test Library', logoUrl: 'https://192.168.0.1/logo.svg', websiteUrl: 'http://127.0.0.1:5432/internal',
      sources: [{ url: 'http://127.0.0.1:5432/internal' }, { url: 'https://boards.greenhouse.io/public/jobs?location=remote' }] } });
  await page.setViewportSize({ width: 1280, height: 1100 }); await page.goto('/');
  await page.locator('.job-company').click(); await expect(page.getByRole('heading', { name: 'Test Library', exact: true })).toBeVisible();
  await expect(page.locator('#company-page a[href*="127.0.0.1:5432"], #company-page a[href*="boards.greenhouse.io"], #company-page img[src*="192.168.0.1"]')).toHaveCount(0);
  await expect(page.locator('#company-page')).not.toContainText('Verified career-page links are unavailable.');
  expect(privateRequests).toEqual([]);
});
test('a direct request fragment reconciles after public HTML hydration', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/#request');
  await expect(page.locator('#request-page')).toBeVisible();
  await expect(page.locator('#jobs-page')).toBeHidden();
  expect(errors).toEqual([]);
});
test('changing interface language preserves accepted catalogue criteria and cursor while keeping an unsent edit', async ({ page }) => {
  await page.goto('/companies?q=Public&cursor=public-next');
  await page.locator('#company-query').fill('Unsent company search');
  await page.locator('#account-open').click();
  await page.locator('#interface-language').selectOption('de');
  await expect.poll(() => new URL(page.url()).pathname).toBe('/de/companies');
  expect(new URL(page.url()).searchParams.get('q')).toBe('Public');
  expect(new URL(page.url()).searchParams.get('cursor')).toBe('public-next');
  await expect(page.locator('#company-query')).toHaveValue('Unsent company search');
  await page.reload(); await expect(page.locator('#company-query')).toHaveValue('Public');
});
