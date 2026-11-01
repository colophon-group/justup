// Real incremental HTTP stream plus deterministic canonical events; no providers or deployed claims.
import { test, expect } from '@playwright/test';
import { liveFixture } from './live-results-fixture.mjs';
import { job, session, search } from './api-fixture.mjs';
let fixture;
test.beforeEach(async ({ page }) => { fixture = await liveFixture(); await page.setViewportSize({ width: 1280, height: 900 }); });
test.afterEach(async () => { await fixture?.close(); });
async function open(page) {
  await page.goto(fixture.origin);
  await expect(page.locator('[data-job="job-1"]')).toBeVisible();
  await expect.poll(() => fixture.streams.length).toBe(1);
  fixture.snapshot({ reason: 'initial' });
  await expect(page.locator('#live-status')).toContainText('Live results connected.');
}
async function reveal(page, count) {
  for (let i = 0; i < count + 3 && await page.locator('[data-job]').count() < count; i++) {
    await page.locator('#feed-tail').scrollIntoViewIfNeeded();
    await page.waitForTimeout(480);
  }
  await expect.poll(() => page.locator('[data-job]').count()).toBeGreaterThanOrEqual(count);
}
test('live insertion preserves keyed nodes, anchor, focused link and selected text; duplicate recovery stays quiet', async ({ page }) => {
  await open(page); await reveal(page, 8);
  await page.locator('[data-job="job-6"]').evaluate(row => { row.scrollIntoView({ block: 'start' }); row.querySelector('.posting-link').focus({ preventScroll: true }); window.heldRow = row; window.heldLink = row.querySelector('.posting-link'); const range = document.createRange(); range.selectNodeContents(row.querySelector('.posting-link')); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); window.heldText = selection.toString(); window.heldTop = row.getBoundingClientRect().top; });
  const fresh = { ...job(99), firstObserved: '2026-11-02T11:00:00Z' };
  fixture.setJobs([fresh, ...fixture.jobs]); const delivered = fixture.snapshot();
  await expect(page.locator('[data-job="job-99"]')).toHaveCount(1);
  await expect(page.locator('#new-results')).toHaveText('1 new ↑');
  expect(await page.evaluate(() => ({ row: window.heldRow === document.querySelector('[data-job="job-6"]'), link: window.heldLink === document.activeElement, selection: getSelection().toString() === window.heldText, offset: Math.abs(window.heldRow.getBoundingClientRect().top - window.heldTop), animations: window.heldRow.getAnimations().length }))).toEqual({ row: true, link: true, selection: true, offset: 0, animations: 0 });
  fixture.snapshot({ id: delivered.id }); fixture.snapshot({ reason: 'resumed' });
  await expect(page.locator('[data-job="job-99"]')).toHaveCount(1);
  await expect(page.locator('#new-results')).toHaveText('1 new ↑');
  await page.locator('#new-results').click();
  await expect(page.locator('[data-job="job-99"] .posting-link')).toBeFocused();
  const popup = page.waitForEvent('popup'); await page.locator('[data-job="job-99"] .posting-link').click(); (await popup).close();
  await expect(page.locator('[data-job="job-99"]')).toHaveClass(/viewed/);
  await expect(page.locator('#new-results')).toHaveCount(0);
});
test('prefix expansion and buffered older rows remain paced and never New; incomplete enumeration cannot remove them', async ({ page }) => {
  await open(page); await reveal(page, 7);
  await page.evaluate(() => window.scrollTo(0, 0));
  const count = await page.locator('[data-job]').count();
  fixture.snapshot({ items: fixture.jobs.slice(0, 20), complete: false, retained: [] });
  await page.waitForTimeout(1000);
  expect(await page.locator('[data-job]').count()).toBe(count);
  await expect(page.locator('.is-new')).toHaveCount(0);
  const saved = await page.locator('[data-job="job-6"]').elementHandle();
  fixture.snapshot({ items: fixture.jobs.slice(0, 2), complete: false, retained: ['job-1'] });
  await expect(page.locator('[data-job="job-6"]')).toHaveCount(1);
  expect(await saved.evaluate(element => element === document.querySelector('[data-job="job-6"]'))).toBe(true);
  fixture.snapshot({ items: fixture.jobs.slice(0, 2), retained: fixture.jobs.filter(item => item.id !== 'job-6').map(item => item.id) });
  await expect(page.locator('[data-job="job-6"]')).toHaveCount(0);
  await page.locator('#feed-tail').scrollIntoViewIfNeeded(); const before = await page.locator('[data-job]').count();
  await page.waitForTimeout(200); expect(await page.locator('[data-job]').count()).toBe(before);
  await expect.poll(() => page.locator('[data-job]').count()).toBeGreaterThan(before);
  await expect(page.locator('.is-new')).toHaveCount(0);
});
test('reconnect sends Last-Event-ID; dialog and hidden document cancel streams and do not consume reveals', async ({ page }) => {
  await open(page);
  const baseline = fixture.snapshot({ reason: 'resumed' });
  fixture.disconnect(); await expect.poll(() => fixture.streams.length).toBe(2);
  expect(fixture.streams[1].call.headers['last-event-id']).toBe(baseline.id);
  fixture.snapshot({ reason: 'resumed' });
  await page.locator('#account-open').click();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await expect.poll(() => fixture.streams[1].closed).toBe(true);
  const count = await page.locator('[data-job]').count(); await page.waitForTimeout(700); expect(await page.locator('[data-job]').count()).toBe(count);
  await page.keyboard.press('Escape'); await expect.poll(() => fixture.streams.length).toBe(3);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => fixture.streams[2].closed).toBe(true);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => fixture.streams.length).toBeGreaterThanOrEqual(4);
  fixture.snapshot({ reason: 'recovery' }); await expect(page.locator('.is-new')).toHaveCount(0);
});
test('revision rejection and authority loss cannot repopulate private rows; manual recovery never interprets', async ({ page }) => {
  await open(page);
  fixture.snapshot({ items: [{ ...job(98), firstObserved: '2026-11-02T11:00:00Z' }], revision: 2 });
  await expect(page.locator('[data-job="job-98"]')).toHaveCount(0);
  fixture.setSession(session({ user: null, visitor: null, capabilities: { sse: false, search: false, visitorSearch: false } }));
  fixture.unavailable('authority_lost');
  // The rejected revision terminates its connection; reconnect then delivers the authority loss.
  await expect.poll(() => fixture.streams.length).toBeGreaterThanOrEqual(2);
  fixture.unavailable('authority_lost');
  await expect(page.locator('[data-job]')).toHaveCount(0);
  expect(fixture.calls.some(call => ['POST', 'PATCH'].includes(call.method) && /\/searches/.test(call.path))).toBe(false);
});
