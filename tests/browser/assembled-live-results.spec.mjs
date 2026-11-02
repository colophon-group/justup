// Retained browser/Worker → real HTTP SSE and SQLite imports. No API interception.
import { expect, test } from '@playwright/test';
import { startVisitorRuntime } from '../assembled/visitor-runtime.mjs';

test.use({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 1100 } });
let runtime, initial, clock;
const DAY = 86400000;
test.beforeEach(async () => { initial = Date.now(); clock = initial; runtime = await startVisitorRuntime({ now: () => clock }); });
test.afterEach(async () => { await runtime?.close(); });

function job(id, firstObserved, changes = {}) {
  return { id, companyId: 'assembled', companyName: 'Assembled Company', companySlug: 'assembled', title: `Engineer ${id}`,
    sourceUrl: `https://example.org/careers/${id}`, active: true, reserved: false, hasContent: true,
    firstObserved: new Date(firstObserved).toISOString(), lastObserved: null, locales: ['en'], locations: [], employmentTypes: [], seniority: null,
    salary: null, bodyText: null, evidence: { source: 'jobseek_public', metadataFetchedAt: new Date(clock).toISOString(),
      bodyFetchedAt: null, bodyUrl: null, bodySha256: null, textSha256: null, bodyBytes: 0, normalizationVersion: 1, truncated: false }, ...changes };
}
function baseline() {
  return Array.from({ length: 32 }, (_, index) => job(index ? `baseline-${String(index).padStart(2, '0')}` : 'assembled-engineer', initial - 3 * DAY - index * 3600000));
}
function importJobs(jobs, observations = []) {
  runtime.app.store.importSnapshot({ schemaVersion: 1, snapshotAt: new Date(clock).toISOString(), verifiedAt: new Date(clock).toISOString(),
    observations, unknownIds: [], jobs });
}
async function startSearch(page, account = false) {
  await page.goto(runtime.origin);
  if (account) {
    await page.locator('#header-sign-in').click();
    await page.locator('#auth-username').fill('assembled-reader');
    await page.locator('#auth-password').fill('Synthetic-local-account-password');
    await page.locator('#auth-submit').click();
    await expect(page.locator('#header-sign-in')).toBeHidden();
  }
  await page.locator('#query').fill('Engineer');
  await page.locator('#job-search button[type=submit]').click();
  await expect(page.locator('[data-job="assembled-engineer"]')).toBeVisible();
  await expect(page.locator('#live-status')).toContainText('Live results connected.');
  // The initial valid frame may be coalesced until the submit gesture finishes.
  await page.waitForTimeout(200);
  await expect.poll(() => runtime.liveConnections()).toBe(1);
}
async function reveal(page, count) {
  for (let attempt = 0; attempt < count + 4 && await page.locator('[data-job]').count() < count; attempt++) {
    await page.locator('#feed-tail').scrollIntoViewIfNeeded();
    await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
    await page.waitForTimeout(480);
  }
  await expect.poll(() => page.locator('[data-job]').count()).toBeGreaterThanOrEqual(count);
}
async function holdReader(page) {
  await page.locator('[data-job="baseline-05"]').evaluate(row => {
    row.scrollIntoView({ block: 'start', behavior: 'instant' });
    row.querySelector('.posting-link').focus({ preventScroll: true });
    const range = document.createRange(); range.selectNodeContents(row.querySelector('.posting-link'));
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    window.liveHeld = { row, link: document.activeElement, text: selection.toString() };
  });
  // Finish the reading gesture before measuring the stable pre-arrival position.
  await page.waitForTimeout(250);
  await page.evaluate(() => { window.liveHeld.top = window.liveHeld.row.getBoundingClientRect().top; });
}
async function expectReader(page) {
  expect(await page.evaluate(() => ({ node: window.liveHeld.row === document.querySelector('[data-job="baseline-05"]'),
    focus: window.liveHeld.link === document.activeElement, selection: getSelection().toString() === window.liveHeld.text,
    offset: Math.abs(window.liveHeld.row.getBoundingClientRect().top - window.liveHeld.top), animations: window.liveHeld.row.getAnimations().length })))
    .toEqual({ node: true, focus: true, selection: true, offset: 0, animations: 0 });
}

test('real visitor arrivals preserve the reader and resume the actual event identity without duplicate New rows', async ({ page }) => {
  const rows = baseline(); importJobs(rows); await startSearch(page); await reveal(page, 16); await holdReader(page);
  await expect(page.locator('#new-results')).toHaveCount(0);
  const arrival = job('live-arrival', initial - 2 * DAY - 3600000);
  importJobs([...rows, arrival]);
  await expect(page.locator('[data-job="live-arrival"]')).toHaveCount(1);
  await expect(page.locator('#new-results')).toHaveText('1 new ↑');
  await expectReader(page);
  const beforeReconnect = runtime.calls.filter(call => call.path === '/api/v1/visitor/workspace/events').length;
  runtime.dropLiveConnections();
  await expect(page.locator('#live-status')).not.toContainText('Live results connected.');
  await expect.poll(() => runtime.calls.filter(call => call.path === '/api/v1/visitor/workspace/events').length).toBeGreaterThan(beforeReconnect);
  await expect(page.locator('#live-status')).toContainText('Live results connected.');
  const reconnect = runtime.calls.filter(call => call.path === '/api/v1/visitor/workspace/events').at(-1);
  expect(reconnect.lastEventId).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await expect(page.locator('[data-job="live-arrival"]')).toHaveCount(1);
  await expect(page.locator('#new-results')).toHaveText('1 new ↑'); await expectReader(page);
  await page.locator('#new-results').click();
  await expect(page.locator('[data-job="live-arrival"] .posting-link')).toBeFocused();
  expect(runtime.modelCalls()).toBe(1);
  expect(runtime.calls.filter(call => call.method === 'POST' && call.path === '/api/v1/visitor/searches')).toHaveLength(1);
});

test('real account streams remove closed rows, never expose withheld arrivals and pause stale source evidence without zero claims', async ({ page }) => {
  const rows = baseline(); importJobs(rows); await startSearch(page, true);
  const hidden = job('withheld-arrival', initial - DAY, { title: 'Engineer PRIVATE_WITHHELD_ROLE' });
  importJobs([...rows.filter(row => row.id !== 'assembled-engineer'), hidden], [
    { id: 'assembled-engineer', active: false, observedAt: new Date(clock).toISOString() },
  ]);
  await expect(page.locator('[data-job="assembled-engineer"]')).toHaveCount(0);
  await expect(page.locator('[data-job="withheld-arrival"]')).toHaveCount(0);
  await expect(page.locator('#feed')).not.toContainText('PRIVATE_WITHHELD_ROLE');
  await expect(page.locator('#new-results')).toHaveCount(0);
  expect(runtime.calls.some(call => call.path === '/api/v1/workspace/events' && call.status === 200)).toBe(true);
  const streamsBeforeAging = runtime.calls.filter(call => call.path === '/api/v1/workspace/events').length;
  clock += 2 * DAY; runtime.refreshHeartbeat();
  // Business-time advancement also reaches the real server's connection lifetime.
  // Reopen through the browser's bounded retry before expecting stale coverage.
  await expect.poll(() => runtime.calls.filter(call => call.path === '/api/v1/workspace/events').length).toBeGreaterThan(streamsBeforeAging);
  await expect(page.locator('[data-job]')).toHaveCount(0);
  await expect(page.locator('#feed-status')).toContainText('verification');
  await expect(page.locator('#feed-status')).not.toContainText('No matching positions');
  await expect(page.locator('#header-sign-in')).toBeHidden();
  expect(runtime.modelCalls()).toBe(1);
});
