import { expect, test } from '@playwright/test';
// Explicit opt-in smoke: no request interception, no fixtures and no invented live evidence.
test('deployed origin serves the interface and reports a real session', async ({ page, request }) => {
  const session = await request.get('/api/v1/session');
  expect(session.ok(), 'A live demo requires a reachable session API').toBe(true);
  const body = await session.json(); expect(body).toHaveProperty('user'); expect(body).toHaveProperty('capabilities');
  await page.goto('/'); await expect(page.getByRole('link', { name: 'Justup home' })).toBeVisible();
  await expect(page.locator('#service-notice')).toBeHidden();
  await expect(page.locator('.policy-footer a[href="/privacy.html"]')).toBeVisible();
  await expect(page.locator('.policy-footer a[href="/usage.html"]')).toBeVisible();
});
