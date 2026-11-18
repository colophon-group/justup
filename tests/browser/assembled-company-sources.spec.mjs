// No API interception: compiled Worker/browser → real HTTP API/SQLite → frozen published coverage.
import { expect, test } from '@playwright/test';
import { startVisitorRuntime } from '../assembled/visitor-runtime.mjs';
import { createTasks } from '../../server/tasks.mjs';
import { createHiringWireService } from '../../server/hiring-wire.mjs';
import { createHiringWireEditorial } from '../../server/hiring-wire-editorial.mjs';
import { digest } from '../../server/hiring-wire-facts.mjs';
import { verifyPublishedWire } from './release-gate.mjs';
import { verifyWireStrip } from './release-wire.mjs';
test.use({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 1100 } });
const periodEnd = new Date();
periodEnd.setUTCHours(0, 0, 0, 0);
periodEnd.setUTCDate(periodEnd.getUTCDate() - (periodEnd.getUTCDay() + 6) % 7);
const publicationTime = +periodEnd + 2 * 3600000;
const verificationTime = Math.max(publicationTime + 1000, Date.now());
let runtime;
test.beforeEach(async () => { runtime = await startVisitorRuntime({ now: () => verificationTime }); });
test.afterEach(async () => { await runtime?.close(); });
async function publishSources({ completeCompany = false } = {}) {
  const end = periodEnd;
  const iso = value => new Date(value).toISOString(), DAY = 86400000, period = end.toISOString();
  const trackedSince = iso(+end - 21 * DAY), start = iso(+end - 14 * DAY), now = () => publicationTime;
  const snapshot = { schemaVersion: 2, sourceVersion: 'jobseek-coverage-v2', snapshotId: 'assembled-approved-links', asOf: period, generatedAt: iso(+end + 3600000),
    companies: [
      { id: 'assembled', name: 'Assembled Company', url: 'https://example.org/' },
      { id: 'museum', name: 'Museum for the History of Science and Engineering', url: 'https://example.com/' },
    ],
    scopes: [
      { id: 'private-linked-scope', companyId: 'assembled', revision: 'one', trackedSince, lastVerifiedAt: period,
        publicLink: { url: 'https://careers.example.com/jobs', status: 'approved', provenance: 'employer-careers', approvedAt: trackedSince }, coverage: [{ start, end: period, state: 'complete' }] },
      { id: 'private-unverified-scope', companyId: 'assembled', revision: 'one', trackedSince, lastVerifiedAt: null,
        publicLink: { url: 'https://ats.example.org/openings', status: 'approved', provenance: 'ats-careers', approvedAt: trackedSince }, coverage: [{ start, end: period, state: 'unknown' }] },
      { id: 'private-unlinked-scope', companyId: 'assembled', revision: 'one', trackedSince, lastVerifiedAt: null, publicLink: null, coverage: [{ start, end: period, state: 'unknown' }] },
      { id: 'private-museum-scope', companyId: 'museum', revision: 'one', trackedSince, lastVerifiedAt: period, publicLink: null, coverage: [{ start, end: period, state: 'complete' }] },
    ], postings: [
      { id: 'old-observation', scopeId: 'private-linked-scope', firstObserved: iso(+end - 3 * DAY) },
      { id: 'museum-observation', scopeId: 'private-museum-scope', firstObserved: iso(+end - 2 * DAY) },
      { id: 'museum-prior-observation', scopeId: 'private-museum-scope', firstObserved: iso(+end - 8 * DAY) },
    ],
  };
  if (completeCompany) snapshot.scopes = snapshot.scopes.filter(scope => scope.lastVerifiedAt !== null);
  const tasks = createTasks({ db: runtime.db, now });
  const editorial = createHiringWireEditorial({ transport: { qualified: () => true, executionId: () => 'assembled-publication',
    step: async ({ context }) => ({ type: 'final', data: { snapshotId: context.snapshot.id, items: ['museum', 'assembled'].map(id =>
      ({ factId: context.facts.find(fact => fact.company.id === id).id, angle: 'counts' })) } }) } });
  const wire = createHiringWireService({ db: runtime.db, tasks, now, source: { authoritative: true, version: snapshot.sourceVersion, readSnapshot: async () => snapshot }, editorial });
  wire.enqueuePeriod(period); const task = tasks.claim({ workerId: 'assembled-company', kinds: ['hiring_wire'] });
  expect((await wire.runTask(task)).committed).toBe(true);
  return period;
}

test('the deployed Wire assertions verify real current and retained HTTP reads and render the exact published facts', async ({ page, browser }) => {
  const periodEnd = await publishSources();
  const read = async (path, context = page.request) => {
    const response = await context.get(runtime.origin + path);
    expect(response.status()).toBe(200);
    expect(response.headers()['x-robots-tag']).toContain('noindex');
    expect(response.headers()['cache-control']).toContain('no-store');
    return { json: await response.json() };
  };
  const stored = runtime.db.prepare('SELECT public_json FROM hiring_wire_editions WHERE status = ?').get('published');
  const expected = { periodEnd, editionSha256: digest(JSON.parse(stored.public_json)) };
  const edition = await verifyPublishedWire(expected, read, () => verificationTime);
  await page.clock.setFixedTime(verificationTime);
  await verifyWireStrip(page, runtime.origin, edition, { reducedMotion: false });

  const mobile = await browser.newContext({
    ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  try {
    const mobilePage = await mobile.newPage();
    await mobilePage.clock.setFixedTime(verificationTime);
    await verifyWireStrip(mobilePage, runtime.origin, edition, { reducedMotion: true });
    expect(await mobilePage.locator('#hiring-wire').evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
  } finally { await mobile.close(); }
  expect(runtime.modelCalls()).toBe(0);
});

test('real approved source evidence appears in public HTML and client company navigation without invented checks', async ({ browser, page }) => {
  const checked = await publishSources();
  const context = await browser.newContext({ javaScriptEnabled: false, ignoreHTTPSErrors: true }); const staticPage = await context.newPage();
  const response = await staticPage.goto(runtime.origin + '/companies/assembled'); expect(response.status()).toBe(200);
  await expect(staticPage.locator('.tracked-sources a')).toHaveCount(2);
  await expect(staticPage.locator('.tracked-sources a').first()).toHaveAttribute('href', 'https://careers.example.com/jobs');
  await expect(staticPage.locator('.tracked-sources time')).toHaveCount(1);
  await expect(staticPage.locator('.tracked-sources time')).toHaveAttribute('datetime', checked);
  await expect(staticPage.locator('.tracked-sources')).not.toContainText(/No successful|unavailable|private-/);
  const incomplete = staticPage.getByRole('region', { name: 'Historical hiring' });
  await expect(incomplete.locator('li b')).toHaveText(['Incomplete coverage', 'Incomplete coverage']);
  await expect(incomplete.locator('.history-bar')).toHaveCount(0);
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
  await expect(page.getByRole('region', { name: 'Historical hiring' })).toHaveCount(0);
  await expect(page.locator('.report-facts time')).toHaveCount(0);
});

test('published complete weeks show the tracking start and a true zero through the public report', async ({ page }) => {
  const period = await publishSources({ completeCompany: true });
  await page.goto(runtime.origin + '/companies/assembled');
  const monitoring = new Date(Date.parse(period) - 21 * 86_400_000).toISOString();
  await expect(page.locator('.report-facts time')).toHaveAttribute('datetime', monitoring);
  const history = page.getByRole('region', { name: 'Historical hiring' });
  await expect(history.locator('li[data-coverage="complete"] b')).toHaveText(['0', '1']);
  await expect(history.locator('.history-bar')).toHaveCount(1);
});
