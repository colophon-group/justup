// Read-only verification of the two reviewed company reports on the fixed HTTPS candidate.
import { expect } from '@playwright/test';

async function openReport(page, companyId, origin) {
  const url = `${origin}/companies/${encodeURIComponent(companyId)}`;
  const response = await page.goto(url);
  expect(response?.status() === 200 && response.url() === url
    && /noindex/.test(response.headers()['x-robots-tag'] ?? '')).toBe(true);
  const panel = page.locator('.company-footprint');
  await expect(panel).toBeVisible();
  return panel;
}

async function observedReport(page, { observedCompanyId, countryCode, listingCount }, origin) {
  const panel = await openReport(page, observedCompanyId, origin);
  const name = new Intl.DisplayNames('en', { type: 'region' }).of(countryCode);
  await expect(panel.getByRole('list', { name: 'Countries listed in the sample' }))
    .toContainText(`${name} (${listingCount.toLocaleString('en')})`);
  const globe = panel.getByRole('group', { name: 'Hiring country globe' });
  await expect(globe).toHaveAccessibleDescription(/Country locations identified.*sampled listings/s);
  return globe;
}

async function unknownReport(page, companyId, origin) {
  const panel = await openReport(page, companyId, origin);
  const globe = panel.getByRole('group', { name: 'Neutral world globe' });
  await expect(globe).toHaveAccessibleDescription(/Hiring countries are unknown/);
  await expect(globe.locator('[data-country]')).toHaveCount(0);
  await expect(panel.getByRole('list')).toHaveCount(0);
}

async function globeCenter(globe) {
  await globe.scrollIntoViewIfNeeded();
  const box = await globe.boundingBox();
  if (!box) throw new Error('The company globe has no interactive area.');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export async function verifyPublicFootprint(browser, page, config) {
  const sample = config.scenario.hiringFootprint;
  const origin = config.origin;
  const globe = await observedReport(page, sample, origin);
  const coast = globe.locator('.globe-land');
  const initial = await coast.getAttribute('d');
  await globe.press('ArrowRight');
  await expect(coast).not.toHaveAttribute('d', initial);
  const country = globe.locator(`[data-country="${sample.countryCode}"]`);
  // A reviewed country may start on the far hemisphere. Follow the same
  // keyboard rotation that a reader can use until the highlighted path appears.
  await expect.poll(async () => {
    if (await country.count() === 1) return true;
    const before = await coast.getAttribute('d');
    await globe.press('ArrowRight');
    await expect(coast).not.toHaveAttribute('d', before);
    return false;
  }, { timeout: 15_000, intervals: [60] }).toBe(true);
  await expect(country).toHaveAttribute('d', /^M.+Z$/);
  expect(await country.evaluate(path => {
    const ocean = path.ownerSVGElement?.querySelector('.globe-ocean');
    const fill = getComputedStyle(path).fill;
    return !!ocean && fill !== 'none' && fill !== getComputedStyle(ocean).fill;
  })).toBe(true);
  await globe.press('Home');
  await expect(coast).toHaveAttribute('d', initial);
  const center = await globeCenter(globe);
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  try { await page.mouse.move(center.x + 40, center.y + 12); } finally { await page.mouse.up(); }
  await expect(coast).not.toHaveAttribute('d', initial);
  const moved = await coast.getAttribute('d');
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(coast).toHaveAttribute('d', moved);
  await unknownReport(page, sample.unknownCompanyId, origin);

  const noScript = await browser.newContext({ locale: 'en', javaScriptEnabled: false });
  try {
    const staticPage = await noScript.newPage();
    await observedReport(staticPage, sample, origin);
    await unknownReport(staticPage, sample.unknownCompanyId, origin);
  } finally { await noScript.close(); }

  const mobile = await browser.newContext({ locale: 'en', viewport: { width: 390, height: 844 },
    isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  try {
    const mobilePage = await mobile.newPage();
    const touchGlobe = await observedReport(mobilePage, sample, origin);
    const outline = touchGlobe.locator('.globe-land');
    const before = await outline.getAttribute('d');
    await expect(touchGlobe).toHaveCSS('touch-action', 'pan-y pinch-zoom');
    const { x, y } = await globeCenter(touchGlobe);
    const cdp = await mobile.newCDPSession(mobilePage);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 48, y }] });
    } finally { await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); }
    await expect(outline).not.toHaveAttribute('d', before);
  } finally { await mobile.close(); }
}
