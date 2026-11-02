import { test, expect } from '@playwright/test';
import { mockApi, search, completed, job, session } from './api-fixture.mjs';
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

test('sample reports retain source occupation labels and stay readable in five locales on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  for (const locale of ['en', 'de', 'fr', 'it', 'es']) {
    const response = await page.goto(`${locale === 'en' ? '' : '/' + locale}/companies/library`);
    const source = await response.text();
    const readHead = html => {
      const doc = html ? new DOMParser().parseFromString(html, 'text/html') : document;
      return { title: doc.title, description: doc.querySelector('meta[name=description]').content,
        canonical: new URL(doc.querySelector('link[rel=canonical]').href).pathname,
        alternates: [...doc.querySelectorAll('link[rel=alternate][hreflang]')].map(link => [link.hreflang, new URL(link.href).pathname]) };
    };
    const httpMetadata = await page.evaluate(readHead, source);
    await expect.poll(() => page.evaluate(readHead)).toEqual(httpMetadata);
    await expect(page.locator('.sample-roles li').first()).toContainText('Software developers');
    await expect(page.locator('.sample-roles li').last()).toContainText('Archivists & curators');
    await expect(page.locator('.sample-salaries li')).toHaveCount(3);
    await expect(page.locator('[data-currency="USD"][data-period="month"]')).toContainText('USD');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
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

for (const width of [1280, 375]) test(`public navigation resets metadata and moves keyboard focus through history and reload at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const response = await page.goto('/companies');
  expect(response.status()).toBe(200); expect(response.headers()['x-robots-tag']).toContain('noindex');
  const catalogueDescription = await page.locator('meta[name=description]').getAttribute('content');
  const company = page.getByRole('link', { name: 'Test Library', exact: true });
  await company.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Test Library', exact: true })).toBeVisible();
  await expect(page.locator('#main')).toBeFocused();
  await expect(page.locator('meta[name=description]')).toHaveAttribute('content', /Test Library: A test-only public library/);
  await expect(page.locator('link[rel=alternate][hreflang=de]')).toHaveAttribute('href', `${origin}/de/companies/library`);
  const companyDescription = await page.locator('meta[name=description]').getAttribute('content');
  await page.reload();
  await expect(page.locator('meta[name=description]')).toHaveAttribute('content', companyDescription);
  const catalogueLink = page.getByRole('link', { name: 'Companies', exact: true });
  await catalogueLink.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#companies-page')).toBeVisible(); await expect(page.locator('#main')).toBeFocused();
  await expect(page.locator('meta[name=description]')).toHaveAttribute('content', catalogueDescription);
  await expect(page.locator('link[rel=alternate][hreflang=de]')).toHaveAttribute('href', `${origin}/de/companies`);
  await page.goBack(); await expect(page.getByRole('heading', { name: 'Test Library', exact: true })).toBeVisible();
  await page.goForward(); await expect(page.locator('meta[name=description]')).toHaveAttribute('content', catalogueDescription);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('private fragments, catalogue queries and account dialogs keep noindex through client history', async ({ page }) => {
  await mockApi(page, { 'GET /searches': { items: [search()] }, 'GET /searches/search-1/results': completed([job(1)]) });
  await page.goto('/companies/library');
  await expect(page.locator('meta[name=robots]')).toHaveCount(0);
  await page.getByRole('link', { name: '← Back to search' }).click();
  await expect(page.locator('#query')).toBeVisible();
  await page.locator('#query').fill('PRIVATE_QUERY_CANARY');
  await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', /noindex/);
  await expect(page.locator('head')).not.toContainText('PRIVATE_QUERY_CANARY');
  expect(await page.locator('head').innerHTML()).not.toContain('PRIVATE_QUERY_CANARY');
  await page.goBack(); await expect(page.locator('meta[name=robots]')).toHaveCount(0);
  await page.locator('#account-open').click(); await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', /noindex/);
  await page.keyboard.press('Escape'); await expect(page.locator('meta[name=robots]')).toHaveCount(0);
  await page.getByRole('link', { name: 'Companies', exact: true }).click();
  await page.locator('#company-query').fill('Public'); await page.locator('#company-search button[type=submit]').click();
  await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', /noindex/);
  await expect(page.locator('link[rel=canonical]')).toHaveAttribute('href', `${origin}/companies`);
  await page.getByRole('link', { name: 'Request a company +' }).click();
  await expect(page.locator('#request-page')).toBeVisible(); await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', /noindex/);
  await page.goBack(); await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', /noindex/);
  await page.goForward(); await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', /noindex/);
});

for (const status of [404, 503]) test(`a client company ${status} clears prior public metadata and survives direct reload`, async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  await mockApi(page, { 'GET /companies/library': { status, body: { error: { code: status === 404 ? 'not_found' : 'unavailable', message: 'Company evidence missing.' } } } });
  await page.goto('/companies');
  await page.getByRole('link', { name: 'Test Library', exact: true }).click();
  await expect(page.getByRole('heading', { name: status === 404 ? 'Page not found.' : 'Report unavailable.' })).toBeVisible();
  await expect(page).toHaveTitle(status === 404 ? 'Page not found — Justup' : 'Coverage temporarily unavailable — Justup');
  await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', /noindex/);
  await expect(page.locator('meta[name=description]')).not.toHaveAttribute('content', /Test Library/);
  await expect(page.locator('link[rel=alternate]')).toHaveCount(0);
  // The HTTP fixture still has this company: reload must recover real public facts,
  // rather than treating a previous client failure as authoritative server state.
  const response = await page.reload(); expect(response.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Test Library', exact: true })).toBeVisible();
  await expect(page.locator('meta[name=robots]')).toHaveCount(0);
  const missing = await page.goto('/companies/missing'); expect(missing.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page not found.' })).toBeVisible();
  await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', /noindex/);
});

test('a pending company navigation clears previous company facts before the source responds', async ({ page }) => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/v1/companies/company-1', async route => {
    await held;
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'not_found', message: 'Not found.' } }) });
  });
  await page.goto('/companies/library');
  await page.getByRole('link', { name: 'Companies', exact: true }).click();
  await page.getByRole('link', { name: 'Public company 1', exact: true }).click();
  await expect(page).toHaveTitle('Opening the company report… — Justup');
  await expect(page.locator('meta[name=description]')).not.toHaveAttribute('content', /Test Library/);
  await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', /noindex/);
  await expect(page.locator('link[rel=alternate]')).toHaveCount(0);
  release();
  await expect(page.getByRole('heading', { name: 'Page not found.' })).toBeVisible();
});

for (const allocated of [false, true]) test(`anonymous landing after session bootstrap is ${allocated ? 'private for an allocated visitor' : 'public before any private work'}`, async ({ page }) => {
  await mockApi(page, { 'GET /session': session({ user: null, visitor: allocated ? { expiresAt: '2099-01-01T00:00:00Z' } : null }) });
  await page.goto('/');
  await expect(page.locator('#coverage-disclosure')).toContainText('Imported snapshot');
  if (allocated) await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', /noindex/);
  else await expect(page.locator('meta[name=robots]')).toHaveCount(0);
  await expect(page.locator('link[rel=canonical]')).toHaveAttribute('href', `${origin}/`);
  await expect(page.locator('meta[name=description]')).toHaveAttribute('content', /Find fresh jobs first observed/);
});

test('a mismatched company identity cannot publish wrong facts under the requested canonical URL', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  await mockApi(page, { 'GET /searches': { items: [search()] }, 'GET /searches/search-1/results': completed([job(1)]),
    'GET /companies/library': { id: 'different-company', name: 'WRONG_COMPANY_CANARY', description: 'Wrong company facts.' } });
  await page.goto('/'); await page.locator('.job-company').click();
  await expect(page.getByRole('heading', { name: 'Report unavailable.' })).toBeVisible();
  await expect(page).toHaveTitle('Coverage temporarily unavailable — Justup');
  await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', /noindex/);
  await expect(page.locator('link[rel=canonical]')).toHaveAttribute('href', `${origin}/companies/library`);
  expect(await page.content()).not.toContain('WRONG_COMPANY_CANARY');
  expect(await page.locator('head').innerHTML()).not.toContain('Wrong company facts.');
});
