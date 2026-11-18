// Verify the published facts which a signed-out reader sees on the real homepage.
import { expect } from '@playwright/test';

const englishNumbers = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
const englishPeriod = new Intl.DateTimeFormat('en', {
  month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
});

async function scrollWireOnTouch(page, wire, overflow) {
  const box = await wire.boundingBox();
  const start = Math.round(box.x + box.width * 0.84), end = Math.round(box.x + box.width * 0.16);
  const y = Math.round(box.y + box.height / 2);
  const currentScroll = () => wire.evaluate(node => node.scrollLeft);
  const maxSwipes = Math.ceil(overflow / ((start - end) / 2)) + 2;
  const cdp = await page.context().newCDPSession(page);
  try {
    for (let swipe = 0; swipe < maxSwipes; swipe++) {
      const before = await currentScroll();
      if (overflow - before <= 1) break;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: start, y }] });
      try {
        // Stay within the touch viewport. Between moves, let Chromium process the native gesture.
        for (const fraction of [0.2, 0.4, 0.6, 0.8, 1]) {
          const x = Math.round(start + (end - start) * fraction);
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
        }
      } finally { await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); }
      await expect.poll(currentScroll).toBeGreaterThan(before);
    }
    expect(await currentScroll()).toBeGreaterThanOrEqual(overflow - 1);
  } finally { await cdp.detach(); }
}

export async function verifyWireStrip(page, origin, edition, { reducedMotion }) {
  await page.emulateMedia({ reducedMotion: reducedMotion ? 'reduce' : 'no-preference' });
  const response = await page.goto(`${origin}/`);
  expect(response.status()).toBe(200);
  expect(response.headers()['x-robots-tag']).toContain('noindex');
  const wire = page.getByRole('region', {
    name: `Company listing activity, week ending ${englishPeriod.format(new Date(edition.period.end))}`, exact: true,
  });
  await expect(wire).toBeVisible();
  // Accessible reads must expose each original story once, regardless of the visual repeats.
  const links = wire.getByRole('link');
  await expect(links).toHaveCount(edition.items.length);
  for (const [index, item] of edition.items.entries()) {
    const link = links.nth(index);
    const { current, previous, percentageChange } = item.activity;
    const currentText = englishNumbers.format(current), previousText = englishNumbers.format(previous);
    await expect(link).toHaveAttribute('href', `/companies/${encodeURIComponent(item.company.id)}`);
    await expect(link.locator('.wire-company')).toHaveText(item.company.name);
    const noun = current === 1 ? 'listing' : 'listings';
    await expect(link.locator('.wire-headline')).toHaveText(`${currentText} newly observed ${noun}, compared with ${previousText} the previous week`);
    const comparison = percentageChange === null
      ? `${previousText} → ${currentText}` : `${percentageChange > 0 ? '+' : ''}${englishNumbers.format(percentageChange)}%`;
    await expect(link.locator('.wire-change')).toHaveText(comparison);
  }

  const track = wire.locator('.wire-track');
  if (reducedMotion) {
    await expect(track).toHaveCSS('animation-name', 'none');
    await expect(wire).toHaveCSS('overflow-x', 'auto');
    await wire.scrollIntoViewIfNeeded();
    const overflow = await wire.evaluate(node => node.scrollWidth - node.clientWidth);
    if (overflow > 1) await scrollWireOnTouch(page, wire, overflow);
    await expect(links.last().locator('.wire-change')).toBeInViewport({ ratio: 0.9 });
    return;
  }
  await expect(track).toHaveCSS('animation-name', 'wire-ride');
  await expect(track).toHaveCSS('animation-play-state', 'running');
  await page.locator('.brand').focus();
  for (const link of await links.all()) {
    await page.keyboard.press('Tab');
    await expect(link).toBeFocused();
  }
  await expect(track).toHaveCSS('animation-name', 'none');
  const last = edition.items.at(-1).company;
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`${origin}/companies/${encodeURIComponent(last.id)}`);
  await expect(page.getByRole('heading', { name: last.name, level: 1, exact: true })).toBeVisible();
}
