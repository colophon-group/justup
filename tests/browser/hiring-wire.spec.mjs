// Real public response contracts are fixtures here; no edition data ships in web assets.
import { expect, test } from '@playwright/test';
import { completed, mockApi, search } from './api-fixture.mjs';
const published = () => ({ state: 'published', edition: {
  id: '2026-10-26', title: 'Hiring Wire',
  period: { start: '2026-10-19T00:00:00.000Z', end: '2026-10-26T00:00:00.000Z', previousStart: '2026-10-12T00:00:00.000Z' },
  snapshotAt: '2026-10-26T00:00:00.000Z', publishedAt: '2026-10-26T08:00:00.000Z', expiresAt: '2026-11-02T00:00:00.000Z',
  methodology: 'Distinct newly observed listings on comparable career pages, not hires.',
  items: [
    { company: { id: 'library', name: 'Test Library', url: 'https://example.com/' }, headline: 'Test Library: 6 newly observed listings, compared with 4 the previous week', activity: { current: 6, previous: 4, change: 2, percentageChange: 50 }, scope: 'Comparable career pages' },
    { company: { id: 'studio', name: 'Test Studio', url: 'https://example.org/' }, headline: 'Test Studio: 3 newly observed listings, compared with 0 the previous week', activity: { current: 3, previous: 0, change: 3, percentageChange: null }, scope: 'Comparable career pages' },
  ],
} });
const motion = page => page.locator('.wire-track').evaluate(node => getComputedStyle(node).animationPlayState);
test.beforeEach(async ({ page }) => { await page.clock.install({ time: new Date('2026-10-27T12:00:00.000Z') }); });

test('published facts move past hover and click while company links stay internal and accessible', async ({ page }) => {
  const calls = await mockApi(page, { 'GET /hiring-wire': published() });
  await page.goto('/');
  const wire = page.getByRole('region', { name: /Company listing activity/ });
  await expect(wire).toBeVisible();
  await expect(wire.getByRole('link')).toHaveCount(2);
  const first = wire.getByRole('link').first();
  await expect(first).toContainText('+50%');
  await expect(wire.getByRole('link').nth(1)).toContainText('0 → 3');
  await expect(first).toHaveAttribute('href', '#company/library');
  await expect(wire).not.toContainText('WoW');
  await expect(wire.getByRole('button')).toHaveCount(0);
  const before = await page.locator('.wire-track').evaluate(node => getComputedStyle(node).transform);
  await first.hover({ force: true });
  await expect.poll(() => motion(page)).toBe('running');
  await expect.poll(() => page.locator('.wire-track').evaluate(node => getComputedStyle(node).transform)).not.toBe(before);
  await first.click({ force: true });
  await expect(page).toHaveURL(/#company\/library$/);
  await expect.poll(() => motion(page)).toBe('running');
  await expect(page.getByRole('heading', { name: 'Test Library', exact: true })).toBeVisible();
  expect(calls.filter(call => call.key === 'GET /hiring-wire')).toHaveLength(1);
});

test('reduced motion freezes the tape and preserves keyboard access to every story', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 375, height: 780 });
  await mockApi(page, { 'GET /hiring-wire': published() });
  await page.goto('/');
  const wire = page.locator('#hiring-wire');
  await expect(wire).toBeVisible();
  await expect.poll(() => page.locator('.wire-track').evaluate(node => getComputedStyle(node).animationName)).toBe('none');
  await expect.poll(() => wire.evaluate(node => getComputedStyle(node).overflowX)).toBe('auto');
  await page.locator('.brand').focus();
  await page.keyboard.press('Tab');
  await expect(wire.getByRole('link').first()).toBeFocused();
  await page.keyboard.press('Tab');
  const last = wire.getByRole('link').last();
  await expect(last).toBeFocused();
  const geometry = await last.evaluate(node => {
    const link = node.getBoundingClientRect(), frame = node.closest('#hiring-wire').getBoundingClientRect();
    return { right: link.right, left: link.left, frameRight: frame.right, frameLeft: frame.left };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(geometry.frameLeft - 1);
  expect(geometry.left).toBeLessThan(geometry.frameRight);
});

test('dialogs and document visibility pause the tape without changing its height', async ({ page }) => {
  await mockApi(page, { 'GET /hiring-wire': published(), 'GET /searches': { items: [search()] }, 'GET /searches/search-1/results': completed([]) });
  await page.goto('/'); await expect(page.locator('#hiring-wire')).toBeVisible();
  const height = await page.locator('#hiring-wire').evaluate(node => node.getBoundingClientRect().height);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect.poll(() => motion(page)).toBe('paused');
  expect(await page.locator('#hiring-wire').evaluate(node => node.getBoundingClientRect().height)).toBe(height);
  await page.keyboard.press('Escape');
  await expect.poll(() => motion(page)).toBe('running');
  await page.getByRole('button', { name: 'Delete Library desk', exact: true }).click();
  await expect(page.locator('#delete-search-dialog')).toBeVisible();
  await expect.poll(() => motion(page)).toBe('paused');
  await page.keyboard.press('Escape');
  await expect.poll(() => motion(page)).toBe('running');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => motion(page)).toBe('paused');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => motion(page)).toBe('running');
});

test('a late published response preserves the search position, focus and unsent text', async ({ page }) => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const calls = await mockApi(page, { 'GET /hiring-wire': async () => { await pending; return published(); } });
  await page.goto('/');
  const query = page.locator('#query');
  await query.fill('Museum jobs');
  await expect.poll(() => calls.some(call => call.key === 'GET /hiring-wire')).toBe(true);
  const before = await query.boundingBox();
  release();
  await expect(page.locator('#hiring-wire')).toBeVisible();
  await expect(query).toHaveValue('Museum jobs');
  await expect(query).toBeFocused();
  expect((await query.boundingBox()).y).toBe(before.y);
});

test('keyboard reading freezes the ordinary-motion tape and reveals the focused company', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 780 });
  await mockApi(page, { 'GET /hiring-wire': published() });
  await page.goto('/'); await expect(page.locator('#hiring-wire')).toBeVisible();
  await page.locator('.brand').focus(); await page.keyboard.press('Tab');
  await expect(page.locator('#hiring-wire').getByRole('link').first()).toBeFocused();
  await expect.poll(() => page.locator('.wire-track').evaluate(node => getComputedStyle(node).animationName)).toBe('none');
  await page.keyboard.press('Tab');
  await expect(page.locator('#hiring-wire').getByRole('link').last()).toBeFocused();
  await expect.poll(() => page.locator('#hiring-wire').evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
});

test('the exact edition deadline hides news, refreshes once and preserves the search layout', async ({ page }) => {
  await page.clock.pauseAt(new Date('2026-11-01T23:59:59.000Z'));
  let reads = 0;
  await mockApi(page, { 'GET /hiring-wire': () => ++reads === 1 ? published() : { state: 'unavailable', edition: null } });
  await page.goto('/'); await expect(page.locator('#hiring-wire')).toBeVisible();
  const query = page.locator('#query'); await query.fill('Museum jobs'); const before = await query.boundingBox();
  await page.clock.runFor(999); await expect(page.locator('#hiring-wire')).toBeVisible();
  await page.clock.runFor(1); await expect(page.locator('#hiring-wire')).toHaveCount(0);
  await expect.poll(() => reads).toBe(2);
  await expect(query).toBeFocused(); await expect(query).toHaveValue('Museum jobs');
  expect((await query.boundingBox()).y).toBe(before.y);
  await page.clock.runFor(30_000); expect(reads).toBe(2);
});

test('an expired returned payload stays hidden without an immediate refetch loop', async ({ page }) => {
  await page.clock.pauseAt(new Date('2026-11-02T00:00:01.000Z'));
  let reads = 0;
  await mockApi(page, { 'GET /hiring-wire': () => { reads++; return published(); } });
  await page.goto('/'); await page.locator('#query').fill('Museum jobs');
  await expect.poll(() => reads).toBe(1); await expect(page.locator('#hiring-wire')).toHaveCount(0);
  await page.clock.runFor(30_000); expect(reads).toBe(1);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => reads).toBe(2);
  await page.clock.runFor(30_000); expect(reads).toBe(2);
  await expect(page.locator('#hiring-wire')).toHaveCount(0);
});

test('expiry moves only a removed news focus to the main landmark without scrolling', async ({ page }) => {
  await page.clock.pauseAt(new Date('2026-11-01T23:59:59.000Z'));
  let reads = 0;
  await mockApi(page, { 'GET /hiring-wire': () => ++reads === 1 ? published() : { state: 'unavailable', edition: null } });
  await page.goto('/'); await expect(page.locator('#hiring-wire')).toBeVisible();
  await page.locator('.brand').focus(); await page.keyboard.press('Tab');
  await expect(page.locator('#hiring-wire').getByRole('link').first()).toBeFocused();
  const before = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  await page.clock.runFor(1000);
  await expect(page.locator('#hiring-wire')).toHaveCount(0); await expect(page.locator('#main')).toBeFocused();
  expect(await page.evaluate(() => ({ x: scrollX, y: scrollY }))).toEqual(before);
});

test('render-driven deadline removal recovers news focus before its DOM is removed', async ({ page }) => {
  await page.clock.pauseAt(new Date('2026-10-27T12:00:01.000Z'));
  await page.setViewportSize({ width: 1280, height: 550 });
  await mockApi(page, { 'GET /hiring-wire': published() });
  await page.goto('/'); await expect(page.locator('#hiring-wire')).toBeVisible();
  await page.locator('#query').fill('Museum jobs');
  await page.locator('.brand').focus(); await page.keyboard.press('Tab');
  await expect(page.locator('#hiring-wire').getByRole('link').first()).toBeFocused();
  // Advance wall time without running the queued expiry timer. Scrolling then rerenders App.
  await page.clock.setSystemTime(new Date('2026-11-02T00:00:01.000Z'));
  const target = await page.evaluate(() => {
    const y = Math.min(600, document.documentElement.scrollHeight - innerHeight);
    scrollTo(0, y); return y;
  });
  expect(target).toBeGreaterThan(500);
  await expect(page.locator('#back-to-top')).toBeVisible();
  await expect(page.locator('#hiring-wire')).toHaveCount(0);
  await expect(page.locator('#main')).toBeFocused();
  expect(await page.evaluate(() => scrollY)).toBe(target);
  await expect(page.locator('#query')).toHaveValue('Museum jobs');
});

test('visibility return rechecks a suspended deadline and can show the next published edition', async ({ page }) => {
  await page.clock.pauseAt(new Date('2026-11-01T23:59:59.000Z'));
  const next = published();
  Object.assign(next.edition, {
    id: '2026-11-02', period: { start: '2026-10-26T00:00:00.000Z', end: '2026-11-02T00:00:00.000Z', previousStart: '2026-10-19T00:00:00.000Z' },
    snapshotAt: '2026-11-02T00:00:00.000Z', publishedAt: '2026-11-02T00:00:00.000Z', expiresAt: '2026-11-09T00:00:00.000Z',
  });
  let reads = 0;
  await mockApi(page, { 'GET /hiring-wire': () => ++reads === 1 ? published() : next });
  await page.goto('/'); await expect(page.locator('#hiring-wire')).toHaveAttribute('aria-label', /October 26/);
  await page.locator('#query').fill('Museum jobs'); const before = await page.locator('#query').boundingBox();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.setSystemTime(new Date('2026-11-02T00:00:01.000Z'));
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.locator('#hiring-wire')).toHaveAttribute('aria-label', /November 2/);
  expect(reads).toBe(2); expect((await page.locator('#query').boundingBox()).y).toBe(before.y);
});

for (const response of [{ state: 'unavailable', edition: null }, { abort: true }, { ...published(), edition: { ...published().edition, items: [] } }]) {
  test(`unavailable or malformed company news leaves search usable: ${JSON.stringify(response).slice(0, 80)}`, async ({ page }) => {
    await mockApi(page, { 'GET /hiring-wire': response }); await page.goto('/');
    await expect(page.locator('#query')).toBeVisible();
    await expect(page.locator('#hiring-wire')).toHaveCount(0);
    await page.locator('#query').fill('Museum jobs');
    await expect(page.locator('#query')).toHaveValue('Museum jobs');
  });
}
