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
  await expect(page.getByRole('link', { name: /employer.test\/careers/ })).toHaveAttribute('href', 'https://employer.test/careers');
  await page.goto(`${origin}/companies/missing`); await expect(page.getByRole('heading', { name: 'Page not found.' })).toBeVisible();
  await context.close();
});
test('built public HTML hydrates without errors and buffers unseen catalogue rows until scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/companies');
  const rows = page.locator('#company-list [data-company]');
  await expect(rows).not.toHaveCount(30);
  const initial = await rows.count(); expect(initial).toBeLessThan(30);
  await page.locator('#company-query').focus(); await page.waitForTimeout(1100); expect(await rows.count()).toBe(initial); await expect(page.locator('#company-query')).toBeFocused();
  await page.locator('#company-tail').scrollIntoViewIfNeeded(); const before = await rows.count();
  await page.waitForTimeout(200); expect(await rows.count()).toBe(before);
  await expect(rows).toHaveCount(before + 1, { timeout: 800 });
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
