// Built HTML/browser → real HTTP API and SQLite import; no intercepted report responses.
import { expect, test } from '@playwright/test';
import { startVisitorRuntime } from '../assembled/visitor-runtime.mjs';

test.use({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 1100 } });
let runtime, at;
test.beforeEach(async () => { at = Date.now(); runtime = await startVisitorRuntime({ now: () => at }); });
test.afterEach(async () => { await runtime?.close(); });
function importSamples() {
  const iso = value => new Date(value).toISOString();
  const job = (id, days, changes = {}) => ({ id, companyId: 'assembled', companyName: 'Assembled Company', companySlug: 'assembled', title: 'Engineer',
    sourceUrl: `https://example.org/careers/${id}`, active: true, reserved: false, hasContent: true, firstObserved: iso(at - days * 86400000), lastObserved: null,
    locales: ['en'], locations: [], employmentTypes: [], seniority: null, salary: null, occupation: null, bodyText: null,
    evidence: { source: 'jobseek_public', metadataFetchedAt: iso(at), bodyFetchedAt: null, bodyUrl: null, bodySha256: null, textSha256: null, bodyBytes: 0, normalizationVersion: 1, truncated: false }, ...changes });
  runtime.app.store.importSnapshot({ schemaVersion: 1, snapshotAt: iso(at), verifiedAt: iso(at), observations: [], unknownIds: [], jobs: [
    job('assembled-engineer', 3, { occupation: { id: 'developer', name: 'Software developers' }, salary: { min: 90000, max: 120000, currency: 'USD', period: 'year' } }),
    job('sample-usd-year', 4, { occupation: { id: 'developer', name: 'Software developers' }, salary: { min: 110000, max: 150000, currency: 'USD', period: 'year' } }),
    job('sample-usd-month', 5, { occupation: { id: 'archivist', name: 'Archivists & curators' }, salary: { min: 7000, max: null, currency: 'USD', period: 'month' } }),
    job('sample-eur-hour', 6, { salary: { min: null, max: 45, currency: 'EUR', period: 'hour' } }),
    job('sample-incomplete', 7, { salary: { min: 30000, max: 40000, currency: null, period: 'year' } }),
    job('sample-unknown', 8),
    job('hidden-recent', 1, { occupation: { id: 'private', name: 'PRIVATE_ROLE' }, salary: { min: 999, max: 999, currency: 'PRIVATE', period: 'secret' } }),
  ] });
}
async function expectSamples(page) {
  await expect(page.locator('.sample-heading')).toContainText('Sample size: 6');
  await expect(page.locator('#company-roles-title')).toHaveText('Hiring roles.');
  await expect(page.locator('.sample-roles li')).toHaveCount(2);
  await expect(page.locator('.sample-roles li').first()).toContainText('Software developers');
  await expect(page.locator('.sample-roles li').last()).toContainText('Archivists & curators');
  await expect(page.locator('.sample-coverage').first()).toHaveText('3 labelled · 3 unlabelled');
  await expect(page.locator('.sample-coverage').last()).toHaveText('5 reported · 1 not reported');
  await expect(page.locator('.sample-excluded')).toHaveText('Incomplete values excluded: 1');
  await expect(page.locator('.sample-salaries li')).toHaveCount(3);
  await expect(page.locator('[data-currency="USD"][data-period="year"]')).toContainText('USD 90,000–150,000 / year');
  await expect(page.locator('[data-currency="USD"][data-period="year"]')).toContainText('Group sample: 2');
  await expect(page.locator('[data-currency="USD"][data-period="month"]')).toContainText('From USD 7,000 / month');
  await expect(page.locator('[data-currency="EUR"][data-period="hour"]')).toContainText('Up to EUR 45 / hour');
  await expect(page.locator('#company-page')).not.toContainText(/PRIVATE_ROLE|PRIVATE 999|84,000|Historical hiring data is not available/);
}

test('real structured samples agree in public HTML, hydration and client company navigation with one report read', async ({ browser, page }) => {
  importSamples();
  const reads = () => runtime.calls.filter(call => call.path === '/api/v1/companies/assembled/report').length;
  const context = await browser.newContext({ javaScriptEnabled: false, ignoreHTTPSErrors: true });
  const staticPage = await context.newPage();
  const beforeStatic = reads(); await staticPage.goto(runtime.origin + '/companies/assembled'); await expectSamples(staticPage);
  expect(reads() - beforeStatic).toBe(1); await context.close();
  const beforeHydration = reads(); await page.goto(runtime.origin + '/companies/assembled'); await expectSamples(page);
  await expect.poll(() => runtime.calls.filter(call => call.path === '/api/v1/session').length).toBeGreaterThan(0);
  expect(reads() - beforeHydration).toBe(1);
  await page.goto(runtime.origin); await page.locator('#query').fill('Engineer'); await page.locator('#job-search button[type=submit]').click();
  await expect(page.locator('[data-job="assembled-engineer"]')).toBeVisible();
  const beforeNavigation = reads(); await page.locator('[data-job="assembled-engineer"] .job-company').click(); await expectSamples(page);
  expect(reads() - beforeNavigation).toBe(1);
  expect(runtime.modelCalls()).toBe(1);
});

test('stale and absent real sample evidence omit numerical sections while retaining company identity', async ({ browser }) => {
  importSamples(); at += 2 * 86400000; runtime.refreshHeartbeat();
  const context = await browser.newContext({ javaScriptEnabled: false, ignoreHTTPSErrors: true }); const page = await context.newPage();
  await page.goto(runtime.origin + '/companies/assembled');
  await expect(page.getByRole('heading', { name: 'Assembled Company', exact: true })).toBeVisible();
  await expect(page.locator('.company-samples')).toHaveCount(0);
  await expect(page.locator('#company-page')).not.toContainText(/Software developers|USD 90,000|Historical hiring data is not available/);
  await context.close();
});
