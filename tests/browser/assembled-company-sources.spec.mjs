// No API interception: compiled Worker/browser → real HTTP API/SQLite → frozen published coverage.
import { expect, test } from '@playwright/test';
import { startVisitorRuntime } from '../assembled/visitor-runtime.mjs';
import { createTasks } from '../../server/tasks.mjs';
import { createHiringWireService } from '../../server/hiring-wire.mjs';
import { createHiringWireEditorial } from '../../server/hiring-wire-editorial.mjs';
test.use({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 1100 } });
let runtime;
test.beforeEach(async () => { runtime = await startVisitorRuntime(); });
test.afterEach(async () => { await runtime?.close(); });
async function publishSources() {
  const end = new Date(); end.setUTCHours(0, 0, 0, 0); end.setUTCDate(end.getUTCDate() - (end.getUTCDay() + 6) % 7 - 7);
  // Use the preceding completed week so publication is already past even early Monday UTC.
  const iso = value => new Date(value).toISOString(), DAY = 86400000, period = end.toISOString();
  const trackedSince = iso(+end - 21 * DAY), start = iso(+end - 14 * DAY), now = () => +end + 2 * 3600000;
  const snapshot = { schemaVersion: 2, sourceVersion: 'jobseek-coverage-v2', snapshotId: 'assembled-approved-links', asOf: period, generatedAt: iso(+end + 3600000),
    companies: [{ id: 'assembled', name: 'Assembled Company', url: 'https://example.org/' }],
    scopes: [
      { id: 'private-linked-scope', companyId: 'assembled', revision: 'one', trackedSince, lastVerifiedAt: period,
        publicLink: { url: 'https://careers.example.com/jobs', status: 'approved', provenance: 'employer-careers', approvedAt: trackedSince }, coverage: [{ start, end: period, state: 'complete' }] },
      { id: 'private-unverified-scope', companyId: 'assembled', revision: 'one', trackedSince, lastVerifiedAt: null,
        publicLink: { url: 'https://ats.example.org/openings', status: 'approved', provenance: 'ats-careers', approvedAt: trackedSince }, coverage: [{ start, end: period, state: 'unknown' }] },
      { id: 'private-unlinked-scope', companyId: 'assembled', revision: 'one', trackedSince, lastVerifiedAt: null, publicLink: null, coverage: [{ start, end: period, state: 'unknown' }] },
    ], postings: [{ id: 'old-observation', scopeId: 'private-linked-scope', firstObserved: iso(+end - 3 * DAY) }],
  };
  const tasks = createTasks({ db: runtime.db, now });
  const editorial = createHiringWireEditorial({ transport: { qualified: () => true, executionId: () => 'assembled-publication',
    step: async ({ context }) => ({ type: 'final', data: { snapshotId: context.snapshot.id, items: [{ factId: context.facts[0].id, angle: 'counts' }] } }) } });
  const wire = createHiringWireService({ db: runtime.db, tasks, now, source: { authoritative: true, version: snapshot.sourceVersion, readSnapshot: async () => snapshot }, editorial });
  wire.enqueuePeriod(period); const task = tasks.claim({ workerId: 'assembled-company', kinds: ['hiring_wire'] });
  expect((await wire.runTask(task)).committed).toBe(true);
  return period;
}
test('real approved source evidence appears in public HTML and client company navigation without invented checks', async ({ browser, page }) => {
  const checked = await publishSources();
  const context = await browser.newContext({ javaScriptEnabled: false, ignoreHTTPSErrors: true }); const staticPage = await context.newPage();
  const response = await staticPage.goto(runtime.origin + '/companies/assembled'); expect(response.status()).toBe(200);
  await expect(staticPage.locator('.tracked-sources a')).toHaveCount(2);
  await expect(staticPage.locator('.tracked-sources a').first()).toHaveAttribute('href', 'https://careers.example.com/jobs');
  await expect(staticPage.locator('.tracked-sources time')).toHaveCount(1);
  await expect(staticPage.locator('.tracked-sources time')).toHaveAttribute('datetime', checked);
  await expect(staticPage.locator('.tracked-sources')).not.toContainText(/No successful|unavailable|private-/);
  await context.close();
  await page.goto(runtime.origin); await page.locator('#query').fill('Engineer'); await page.locator('#job-search button[type=submit]').click();
  await expect(page.locator('[data-job="assembled-engineer"]')).toBeVisible();
  await page.locator('.job-company').click();
  await expect(page.locator('.tracked-sources a')).toHaveCount(2);
  await expect(page.locator('.tracked-sources a').last()).toHaveAttribute('href', 'https://ats.example.org/openings');
  await expect(page.locator('.tracked-sources time')).toHaveCount(1);
  expect(runtime.calls.some(call => call.path === '/api/v1/companies/assembled/report' && call.status === 200)).toBe(true);
  expect(runtime.modelCalls()).toBe(1);
  // Clearing only the published history removes links; it never recycles raw company sources.
  runtime.db.prepare('DELETE FROM hiring_wire_editions').run();
  await page.reload(); await expect(page.getByRole('heading', { name: 'Assembled Company', exact: true })).toBeVisible();
  await expect(page.locator('.tracked-sources')).toHaveCount(0);
});
