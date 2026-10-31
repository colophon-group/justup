import { expect, test } from '@playwright/test';

test('a search filters positions and survives a reload', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'What work are you looking for?' }).fill('Remote jobs');
  await page.locator('#job-search').getByRole('button', { name: /Search/ }).click();

  await expect(page.getByRole('heading', { name: 'Just in.' })).toBeVisible();
  const firstPosition = page.locator('#feed article[data-job]').first();
  await expect(firstPosition).toBeVisible();
  await expect(firstPosition).toContainText('Remote');

  await page.reload();
  await expect(page.locator('#query')).toHaveValue('Remote jobs');
  await expect(page.locator('#feed article[data-job]').first()).toBeVisible();
});

test('a requested company remains in the catalogue after a reload', async ({ page }) => {
  await page.goto('/#companies');
  await page.getByRole('link', { name: 'Request a company +' }).click();
  await page.getByRole('textbox', { name: 'Company name or website' }).fill('Asterfield');
  await page.getByRole('button', { name: /Find company/ }).click();
  await expect(page.getByRole('heading', { name: 'Asterfield' })).toBeVisible();
  await page.getByRole('button', { name: /Yes, that’s the one/ }).click();

  const signIn = page.getByRole('dialog', { name: 'Your edition awaits.' });
  await expect(signIn).toBeVisible();
  await signIn.getByRole('textbox', { name: 'Email address' }).fill('reader@example.com');
  await signIn.getByRole('button', { name: /Continue/ }).click();
  await expect(page.getByText('Asterfield is in the catalogue.')).toBeVisible();

  await page.reload();
  await page.getByRole('link', { name: 'Companies', exact: true }).click();
  await page.getByRole('button', { name: /Requested/ }).click();
  await expect(page.getByRole('link', { name: 'Asterfield', exact: true })).toBeVisible();
});

test('account access changes which recent positions are visible', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'What work are you looking for?' }).fill('All jobs');
  await page.locator('#job-search').getByRole('button', { name: /Search/ }).click();

  await expect(page.locator('#access-notice')).toContainText(/recent matches hidden/);
  const firstVisibleAsGuest = await page.locator('#feed article[data-job] time').first().getAttribute('datetime');
  expect(firstVisibleAsGuest).toBeTruthy();

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('combobox', { name: 'Preview accounts' }).selectOption('plus');
  await page.getByRole('button', { name: 'Close settings' }).click();

  await expect(page.getByRole('textbox', { name: 'What work are you looking for?' })).toHaveValue('');
  await page.getByRole('textbox', { name: 'What work are you looking for?' }).fill('All jobs');
  await page.locator('#job-search').getByRole('button', { name: /Search/ }).click();
  await expect(page.locator('#access-notice')).toBeHidden();
  const firstVisibleWithPlus = await page.locator('#feed article[data-job] time').first().getAttribute('datetime');
  expect(Date.parse(firstVisibleWithPlus)).toBeGreaterThan(Date.parse(firstVisibleAsGuest));
});
