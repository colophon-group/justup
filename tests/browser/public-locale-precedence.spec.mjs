import { test, expect } from '@playwright/test';
const origin = `http://127.0.0.1:${process.env.JUSTUP_PUBLIC_TEST_PORT || 4207}`;
test.use({ baseURL: origin });
async function setup(context, page) {
  await context.addCookies([{ name: 'justup_interface_locale', value: 'es', url: origin }]);
  await context.addInitScript(() => Object.defineProperty(navigator, 'languages', { get: () => ['xx-ZZ', 'fr-CA', 'it'] }));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && /hydrat|mismatch|#418/i.test(message.text())) errors.push(message.text()); });
  return errors;
}
for (const seed of ['en', 'es']) test(`default SSR locale ${seed} is a hydration seed; saved account and ordered browser defaults can replace it without changing drafts`, async ({ context, page }) => {
  const errors = await setup(context, page);
  const response = await page.goto(`/?__locale_seam=1&seed=${seed}`);
  expect(await response.text()).toContain(`<output id="current-locale">${seed}</output>`);
  await expect(page.locator('#current-locale')).toHaveText('es');
  await page.getByLabel('Draft').fill('Keep every nuance of my search');
  await page.getByRole('button', { name: 'Account de', exact: true }).click();
  await expect(page.locator('#current-locale')).toHaveText('de');
  await page.getByRole('button', { name: 'Default navigation' }).click();
  await expect(page.locator('#current-locale')).toHaveText('de');
  await page.goBack(); await expect(page.locator('#current-locale')).toHaveText('de');
  await page.getByRole('button', { name: 'Account browser default', exact: true }).click();
  await expect(page.locator('#current-locale')).toHaveText('fr');
  await expect(page.getByLabel('Draft')).toHaveValue('Keep every nuance of my search');
  expect(errors).toEqual([]);
});
test('explicit paths stay authoritative, manual changes and back navigation retain reader drafts', async ({ context, page }) => {
  const errors = await setup(context, page);
  await page.goto('/it/?__locale_seam=1'); await expect(page.locator('#current-locale')).toHaveText('it');
  await page.getByRole('button', { name: 'Account de', exact: true }).click(); await expect(page.locator('#current-locale')).toHaveText('it');
  await page.getByLabel('Draft').fill('My unsent draft');
  await page.getByRole('button', { name: 'Choose French' }).click(); await expect(page).toHaveURL(/\/fr\/#jobs$/); await expect(page.locator('#current-locale')).toHaveText('fr');
  await page.getByRole('button', { name: 'Choose browser default' }).click(); await expect(page).toHaveURL(/\/#jobs$/); await expect(page.locator('#current-locale')).toHaveText('fr');
  await page.goBack(); await expect(page.locator('#current-locale')).toHaveText('fr');
  await page.goBack(); await expect(page.locator('#current-locale')).toHaveText('it');
  await expect(page.getByLabel('Draft')).toHaveValue('My unsent draft'); expect(errors).toEqual([]);
});
test('an entry without a server bootstrap does not become pinned to English on popstate', async ({ context, page }) => {
  const errors = await setup(context, page);
  await page.goto('/?__locale_seam=1&withoutBootstrap=1'); await expect(page.locator('#current-locale')).toHaveText('es');
  await page.getByRole('button', { name: 'Default navigation' }).click(); await expect(page.locator('#current-locale')).toHaveText('es');
  await page.getByRole('button', { name: 'Account de', exact: true }).click(); await expect(page.locator('#current-locale')).toHaveText('de');
  await page.goBack(); await expect(page.locator('#current-locale')).toHaveText('de'); expect(errors).toEqual([]);
});

test('only explicit route locale reaches API requests and returning to defaults clears the hint', async ({ context, page }) => {
  const errors = await setup(context, page);
  const hints = [];
  await page.route('**/api/v1/fixture-locale', route => {
    hints.push(route.request().headers()['x-justup-locale'] ?? null);
    return route.fulfill({ contentType: 'application/json', body: '{}' });
  });
  await page.goto('/it/?__locale_seam=1');
  await expect.poll(() => hints.at(-1)).toBe('it');
  await page.getByRole('button', { name: 'Account de', exact: true }).click();
  await expect(page.locator('#current-locale')).toHaveText('it');
  await page.getByLabel('Draft').fill('A draft is not a locale preference');
  await page.getByRole('button', { name: 'Default navigation' }).click();
  await expect(page.locator('#current-locale')).toHaveText('de');
  await expect.poll(() => hints.at(-1)).toBe(null);
  await page.goBack(); await expect(page.locator('#current-locale')).toHaveText('it');
  await expect.poll(() => hints.at(-1)).toBe('it');
  await expect(page.getByLabel('Draft')).toHaveValue('A draft is not a locale preference');
  expect(hints.every(value => value === 'it' || value === null)).toBe(true);
  expect(errors).toEqual([]);
});
