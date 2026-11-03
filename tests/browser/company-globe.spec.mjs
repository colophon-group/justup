// Retained public HTML/client globe contracts; local API fixtures, no provider calls.
import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { mockApi, session } from './api-fixture.mjs';

const origin = `http://127.0.0.1:${process.env.JUSTUP_PUBLIC_TEST_PORT || 4207}`;
test.use({ baseURL: origin, viewport: { width: 1280, height: 900 } });
const globe = page => page.getByRole('group', { name: 'Neutral world globe' });
const coast = page => page.locator('.globe-land');
async function open(page) {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/companies/library');
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeEnabled();
  await globe(page).scrollIntoViewIfNeeded();
  return errors;
}
async function center(page) { const box = await globe(page).boundingBox(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; }
async function capture(page, name) {
  if (!process.env.JUSTUP_GLOBE_QA_DIR) return;
  await mkdir(process.env.JUSTUP_GLOBE_QA_DIR, { recursive: true });
  await page.screenshot({ path: join(process.env.JUSTUP_GLOBE_QA_DIR, `${name}.png`), fullPage: true });
}

test('public HTML has a neutral textual alternative and no hiring-country inference, including a failed report', async ({ browser, page }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const staticPage = await context.newPage(); await staticPage.goto(origin + '/companies/library');
  await expect(staticPage.locator('.company-footprint')).toContainText('UNKNOWN');
  await expect(staticPage.locator('.company-footprint')).toContainText('Hiring countries are unknown.');
  await expect(globe(staticPage)).toHaveAccessibleDescription(/Hiring countries are unknown.*arrow keys.*vertical.*Browser zoom/s);
  await context.close();
  await mockApi(page, { 'GET /session': session({ user: null }), 'GET /companies/library/report': { status: 503, body: { error: { code: 'unavailable', message: 'Unavailable' } } } });
  // Client navigation starts from source-independent HTML and uses the failed API report.
  await page.goto('/'); await page.getByRole('link', { name: 'Companies', exact: true }).click();
  await page.getByRole('link', { name: 'Test Library', exact: true }).click();
  await expect(page.locator('.company-footprint')).toContainText('Hiring countries are unknown.');
  await expect(page.locator('.tracked-sources button')).toHaveText('Try again');
  await expect(page.locator('.company-footprint [data-country], .company-footprint [data-hiring]')).toHaveCount(0);
});

test('pointer drag, release, arrows and Home rotate a square globe with keyboard-only focus and no idle movement', async ({ page }) => {
  const errors = await open(page); const target = globe(page), land = coast(page);
  const box = await target.boundingBox(); expect(box.width).toBe(box.height);
  const initial = await land.getAttribute('d'); const at = await center(page);
  await page.mouse.move(at.x, at.y); await page.mouse.down(); await page.mouse.move(at.x + 90, at.y + 20, { steps: 5 }); await page.mouse.up();
  await expect(land).not.toHaveAttribute('d', initial); await expect(target).toHaveCSS('outline-style', 'none');
  const released = await land.getAttribute('d'); await page.mouse.move(at.x - 50, at.y); await expect(land).toHaveAttribute('d', released);
  await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab'); await expect(target).toBeFocused();
  await expect(target).toHaveCSS('outline-style', 'solid');
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) { const before = await land.getAttribute('d'); await target.press(key); await expect(land).not.toHaveAttribute('d', before); }
  await target.press('Home'); await expect(land).toHaveAttribute('d', initial);
  await page.clock.install(); await page.clock.runFor(5000); await expect(land).toHaveAttribute('d', initial);
  await capture(page, 'desktop-keyboard-focus');
  await page.mouse.click(at.x, at.y); await expect(target).toHaveCSS('outline-style', 'none');
  await capture(page, 'desktop-neutral-globe');
  for (let i = 0; i < 12; i++) await target.press('ArrowRight');
  await page.mouse.click(at.x, at.y); await capture(page, 'desktop-opposite-hemisphere');
  expect(errors).toEqual([]);
});

test('native wheel rotates without zoom or a scroll trap and leaves outside input and Ctrl zoom available', async ({ page }) => {
  await open(page); const target = globe(page), land = coast(page), at = await center(page);
  const initial = await land.getAttribute('d'), size = await target.boundingBox(), beforeScroll = await page.evaluate(() => scrollY);
  const focused = await page.evaluate(() => document.activeElement?.outerHTML);
  await page.mouse.move(at.x, at.y); await page.mouse.wheel(0, 90);
  await expect(land).not.toHaveAttribute('d', initial);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(beforeScroll);
  expect((await target.boundingBox()).width).toBe(size.width);
  expect(await page.evaluate(() => document.activeElement?.outerHTML)).toBe(focused);
  await target.scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Reset view' }).click(); await expect(land).toHaveAttribute('d', initial);
  const next = await center(page); await page.mouse.move(next.x, next.y); await page.mouse.wheel(50, 0); await expect(land).not.toHaveAttribute('d', initial);
  const horizontal = await land.getAttribute('d'); await page.keyboard.down('Shift'); await page.mouse.wheel(0, 40); await page.keyboard.up('Shift'); await expect(land).not.toHaveAttribute('d', horizontal);
  const rotated = await land.getAttribute('d');
  const allowed = await target.evaluate(element => element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: 100, clientX: element.getBoundingClientRect().x + element.clientWidth / 2, clientY: element.getBoundingClientRect().y + element.clientHeight / 2 })));
  expect(allowed).toBe(true); await expect(land).toHaveAttribute('d', rotated);
  const bounds = await target.boundingBox(); await page.mouse.move(bounds.x + 2, bounds.y + 2); await page.mouse.wheel(30, 0); await expect(land).toHaveAttribute('d', rotated);
  await page.mouse.move(10, 100); await page.mouse.wheel(0, 80); await expect(land).toHaveAttribute('d', rotated);
});

test('narrow touch horizontal rotation preserves native vertical scrolling, pinch zoom and reset under reduced motion', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  const page = await context.newPage(); const errors = await open(page); const target = globe(page), land = coast(page);
  await expect(target).toHaveCSS('touch-action', 'pan-y pinch-zoom');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const box = await target.boundingBox(); expect(box.width).toBe(box.height);
  const initial = await land.getAttribute('d'), at = await center(page); const cdp = await context.newCDPSession(page);
  async function swipe(from, to) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
    for (let i = 1; i <= 6; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * i / 6, y: from.y + (to.y - from.y) * i / 6 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  await swipe(at, { x: at.x - 80, y: at.y }); await expect(land).not.toHaveAttribute('d', initial);
  await page.getByRole('button', { name: 'Reset view' }).click(); await expect(land).toHaveAttribute('d', initial);
  await target.scrollIntoViewIfNeeded(); const vertical = await center(page), before = await page.evaluate(() => scrollY);
  await swipe(vertical, { x: vertical.x, y: vertical.y - 100 });
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(before); await expect(land).toHaveAttribute('d', initial);
  await target.focus(); await target.press('ArrowRight'); await expect(land).not.toHaveAttribute('d', initial); await target.press('Home'); await expect(land).toHaveAttribute('d', initial);
  await page.clock.install(); await page.clock.runFor(5000); await expect(land).toHaveAttribute('d', initial);
  await expect(page.locator('.company-footprint')).toContainText('Hiring countries are unknown.');
  await target.blur(); await capture(page, 'narrow-neutral-globe');
  // A real browser gesture proves that touch-action leaves native pinch zoom open.
  const zoom = await page.evaluate(() => visualViewport.scale), pinch = await center(page);
  await cdp.send('Input.synthesizePinchGesture', { x: pinch.x, y: pinch.y, scaleFactor: 1.4, relativeSpeed: 800, gestureSourceType: 'touch' });
  await expect.poll(() => page.evaluate(() => visualViewport.scale)).toBeGreaterThan(zoom);
  await expect(land).toHaveAttribute('d', initial);
  expect(errors).toEqual([]); await context.close();
});
