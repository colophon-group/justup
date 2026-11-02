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
  // Establish the settled reading position after native selection/scroll layout.
  await page.waitForTimeout(250);
  await page.evaluate(() => { window.heldTop = window.heldRow.getBoundingClientRect().top; });
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
  const baseline = fixture.snapshot({ reason: 'resumed', items: [{ ...fixture.jobs[0], title: 'Reconnect acknowledged' }, ...fixture.jobs.slice(1)] });
  await expect(page.locator('[data-job="job-1"] .job-title')).toHaveText('Reconnect acknowledged');
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
test('complete baseline beyond the prefix preserves older paginated rows and recovers a stale cursor without New', async ({ page }) => {
  const many = Array.from({ length: 120 }, (_, index) => ({ ...job(index + 1), firstObserved: new Date(Date.UTC(2026, 10, 1, 12, 0, -index)).toISOString() }));
  fixture.setJobs(many);
  await page.goto(fixture.origin); await expect(page.locator('[data-job="job-1"]')).toBeVisible();
  await expect.poll(() => fixture.streams.length).toBe(1);
  fixture.snapshot({ items: many.slice(0, 2), retained: many.map(item => item.id), reason: 'initial' });
  await reveal(page, 13);
  await expect.poll(() => fixture.calls.filter(call => call.path.endsWith('/results')).length).toBeGreaterThanOrEqual(2);
  const loaded = fixture.calls.filter(call => call.path.endsWith('/results'));
  expect(loaded[1].query.cursor).toBe('12');
  const row = await page.locator('[data-job="job-13"]').elementHandle();
  fixture.staleCursor(); fixture.snapshot({ items: many.slice(0, 4), retained: many.map(item => item.id) });
  await reveal(page, 25);
  const reads = fixture.calls.filter(call => call.path.endsWith('/results'));
  expect(reads.some((call, index) => call.query.cursor === '24' && !reads[index + 1]?.query.cursor)).toBe(true);
  expect(await row.evaluate(element => element === document.querySelector('[data-job="job-13"]'))).toBe(true);
  await expect(page.locator('.is-new')).toHaveCount(0);
  await expect(page.locator('#new-results')).toHaveCount(0);
});
test('pointer selection gesture coalesces live arrivals; editor caret and scroll stay stable through manual recovery', async ({ page }) => {
  await open(page); await reveal(page, 6);
  await page.locator('[data-job="job-4"]').scrollIntoViewIfNeeded();
  await page.locator('[data-job="job-4"] .posting-link').dispatchEvent('pointerdown');
  const fresh = { ...job(97), firstObserved: '2026-11-02T11:00:00Z' };
  fixture.setJobs([fresh, ...fixture.jobs]); fixture.snapshot();
  await page.waitForTimeout(300); await expect(page.locator('[data-job="job-97"]')).toHaveCount(0);
  await page.locator('[data-job="job-4"] .posting-link').dispatchEvent('pointerup');
  await expect(page.locator('[data-job="job-97"]')).toHaveCount(1);
  await page.locator('#query').fill('Unsent reader text');
  await page.locator('#query').evaluate(input => { input.focus(); input.setSelectionRange(3, 9); window.editor = input; window.editorY = scrollY; });
  fixture.setJobs([{ ...job(96), firstObserved: '2026-11-02T11:30:00Z' }, fresh, ...fixture.jobs]); fixture.snapshot();
  await expect(page.locator('[data-job="job-96"]')).toHaveCount(1);
  expect(await page.locator('#query').evaluate(input => ({ same: input === window.editor && document.activeElement === input, start: input.selectionStart, end: input.selectionEnd, y: scrollY === window.editorY }))).toEqual({ same: true, start: 3, end: 9, y: true });
  await page.locator('#refresh-results').click();
  await expect(page.locator('#query')).toHaveValue('Unsent reader text');
  await expect(page.locator('#new-results')).toHaveText('2 new ↑');
  expect(fixture.calls.some(call => ['POST', 'PATCH'].includes(call.method) && /\/searches/.test(call.path))).toBe(false);
});
test('reduced motion removes live movement while retaining older-row viewport pacing', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }); await open(page); await reveal(page, 7);
  await page.evaluate(() => window.scrollTo(0, 0)); const before = await page.locator('[data-job]').count();
  const fresh = { ...job(95), firstObserved: '2026-11-02T11:00:00Z' };
  fixture.setJobs([fresh, ...fixture.jobs]); fixture.snapshot(); await expect(page.locator('[data-job="job-95"]')).toHaveCount(1);
  expect(await page.locator('[data-job="job-95"]').evaluate(row => row.getAnimations().length)).toBe(0);
  await page.waitForTimeout(600); expect(await page.locator('[data-job]').count()).toBe(before + 1);
  await page.locator('#feed-tail').scrollIntoViewIfNeeded(); const atTail = await page.locator('[data-job]').count();
  await page.waitForTimeout(200); expect(await page.locator('[data-job]').count()).toBe(atTail);
  await expect.poll(() => page.locator('[data-job]').count()).toBeGreaterThan(atTail);
});
test('active tabs, accepted revisions, interface locale and owner changes retire old stream scopes', async ({ page }) => {
  fixture.setSearch([search(), { ...search(), id: 'search-2', title: 'Second desk' }]);
  fixture.setSession(session({ capabilities: { ...session().capabilities, sse: true, viewed: true, preferences: true } }));
  await open(page); const old = fixture.snapshot();
  await page.getByRole('tab', { name: 'Second desk', exact: true }).click();
  await expect.poll(() => fixture.streams[0].closed).toBe(true);
  await expect.poll(() => fixture.streams.at(-1).call.query.searchId).toBe('search-2');
  expect(fixture.streams.at(-1).call.headers['last-event-id']).toBeUndefined();
  await page.getByRole('tab', { name: 'Library desk', exact: true }).click();
  await expect.poll(() => fixture.streams.at(-1).call.query.searchId).toBe('search-1');
  await page.locator('#account-open').click(); await page.locator('#interface-language').selectOption('de');
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await page.locator('#settings-dialog .icon-close').click();
  await expect.poll(() => fixture.streams.at(-1).call.query.locale).toBe('de');
  expect(fixture.streams.at(-1).call.headers['last-event-id']).toBeUndefined();
  fixture.setSearch(search(2)); fixture.unavailable('search_changed');
  await expect.poll(() => fixture.streams.at(-1).call.query.revision).toBe('2');
  const beforeOwner = fixture.streams.at(-1); fixture.setSession(session({ user: { id: 'other-reader', username: 'another' }, capabilities: { ...session().capabilities, sse: true } }));
  fixture.setJobs([{ ...job(91), firstObserved: '2026-11-02T11:00:00Z' }]);
  await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await expect.poll(() => beforeOwner.closed).toBe(true);
  await expect(page.locator('[data-job="job-91"]')).toBeVisible();
  await expect(page.locator('[data-job="job-1"]')).toHaveCount(0);
  expect(fixture.streams.at(-1).call.headers['last-event-id']).not.toBe(old.id);
  expect(fixture.calls.some(call => ['POST', 'PATCH'].includes(call.method) && /\/searches/.test(call.path))).toBe(false);
});
test('an HTTP authority rejection on reconnect clears private rows and rechecks the session', async ({ page }) => {
  await open(page);
  fixture.setSession(session({ user: null, visitor: null, capabilities: { sse: false, search: false, visitorSearch: false } }));
  fixture.rejectStreams(401); fixture.disconnect();
  await expect(page.locator('[data-job]')).toHaveCount(0);
  expect(fixture.calls.filter(call => call.path === '/api/v1/session').length).toBeGreaterThanOrEqual(2);
});
test('a policy rejection revalidates authority and pauses until explicit recovery without a fabricated empty search', async ({ page }) => {
  await open(page); fixture.rejectStreams(403); fixture.disconnect();
  await expect(page.locator('#live-status')).toContainText('Live results paused.');
  await expect.poll(() => fixture.calls.filter(call => call.path === '/api/v1/session').length).toBeGreaterThanOrEqual(2);
  await expect(page.locator('[data-job="job-1"]')).toHaveCount(1);
  const connections = fixture.calls.filter(call => call.path.endsWith('/workspace/events')).length;
  await page.waitForTimeout(1200); expect(fixture.calls.filter(call => call.path.endsWith('/workspace/events')).length).toBe(connections);
  await page.locator('#refresh-results').click(); await expect.poll(() => fixture.streams.length).toBe(2);
  fixture.snapshot({ reason: 'recovery' }); await expect(page.locator('.is-new')).toHaveCount(0);
  expect(fixture.calls.some(call => ['POST', 'PATCH'].includes(call.method) && /\/searches/.test(call.path))).toBe(false);
});
test('consecutive unavailable reconnects stop after eight retries', async ({ page }) => {
  await page.clock.install(); await open(page);
  fixture.rejectStreams(503, true); fixture.disconnect();
  for (let attempts = 2; attempts <= 9; attempts++) {
    await page.clock.fastForward(8100);
    await expect.poll(() => fixture.calls.filter(call => call.path.endsWith('/workspace/events')).length).toBe(attempts);
  }
  await page.clock.fastForward(60_000);
  expect(fixture.calls.filter(call => call.path.endsWith('/workspace/events')).length).toBe(9);
  await expect(page.locator('[data-job="job-1"]')).toHaveCount(1);
  await expect(page.locator('#live-status')).toContainText('Live results paused.');
});

test('arrivals keep the header position while the reader is above the results', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  const before = await page.locator('.topbar').evaluate(element => ({ top: element.getBoundingClientRect().top, y: scrollY }));
  const fresh = { ...job(92), firstObserved: '2026-11-02T11:00:00Z' };
  fixture.setJobs([fresh, ...fixture.jobs]); fixture.snapshot();
  await expect(page.locator('[data-job="job-92"]')).toHaveCount(1);
  expect(await page.locator('.topbar').evaluate(element => ({ top: element.getBoundingClientRect().top, y: scrollY }))).toEqual(before);
});
