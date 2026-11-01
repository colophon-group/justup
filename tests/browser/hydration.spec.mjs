// Delayed saved-search responses must not take ownership of an editor in use.
import { expect, test } from '@playwright/test';
import { completed, mockApi, search } from './api-fixture.mjs';

test('saved-search hydration cannot insert a query between focus and typing', async ({ page }) => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const calls = await mockApi(page, {
    'GET /searches': async () => { await pending; return { items: [search()] }; },
    'GET /searches/search-1/results': completed(),
  });
  await page.goto('/');
  await expect.poll(() => calls.some(call => call.key === 'GET /searches')).toBe(true);
  await page.locator('#query').focus();
  release();
  await expect(page.getByRole('tab', { name: 'Library desk' })).toBeVisible();
  await expect(page.locator('#query')).toBeFocused();
  await expect(page.locator('#query')).toHaveValue('');
  await page.keyboard.insertText('Unsent library draft');
  await expect(page.locator('#query')).toHaveValue('Unsent library draft');
  await expect(page.getByRole('tab', { name: 'Library desk' })).toHaveAttribute('aria-selected', 'false');
  expect(calls.filter(call => call.key.endsWith('/results'))).toHaveLength(0);
  await page.getByRole('tab', { name: 'Library desk' }).click();
  await expect(page.locator('#query')).toHaveValue('Remote library jobs');
  expect(calls.some(call => /^(POST|PATCH) \/(?:visitor\/)?searches/.test(call.key))).toBe(false);
});
