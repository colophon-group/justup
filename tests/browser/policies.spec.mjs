import { expect, test } from '@playwright/test';

// Static public notices need no accounts, API or JavaScript.
const locales = ['en', 'de', 'fr', 'it', 'es'];
const path = (kind, locale) => `/${kind}${locale === 'en' ? '' : `.${locale}`}.html`;

for (const locale of locales) {
  for (const kind of ['privacy', 'usage']) {
    test(`${locale} ${kind} is a complete approved notice without JavaScript or a session`, async ({ browser, baseURL }) => {
      const context = await browser.newContext({ baseURL, javaScriptEnabled: false, viewport: { width: 360, height: 800 } });
      const page = await context.newPage();
      const requests = [];
      page.on('request', request => requests.push(request));
      await page.route('**/api/**', route => route.abort());
      const response = await page.goto(path(kind, locale));
      expect(response.status()).toBe(200);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.locator('body')).toHaveAttribute('data-policy-status', 'approved');
      await expect(page.locator('body')).toHaveAttribute('data-policy-version', '2026-11-01.1');
      await expect(page.locator('body')).toHaveAttribute('data-policy-reviewed', 'true');
      await expect(page.locator('meta[name="justup-policy-reviewed"]')).toHaveAttribute('content', 'true');
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'index,follow');
      await expect(page.locator('main')).toContainText('Viktor Shcherbakov');
      await expect(page.locator('main')).toContainText("Route d'Oron 5, 1010 Lausanne, Switzerland");
      await expect(page.getByRole('link', { name: 'business@colophon-group.org', exact: true }).first()).toHaveAttribute('href', 'mailto:business@colophon-group.org');
      await expect(page.locator('.policy-languages a')).toHaveCount(5);
      await expect(page.locator('.policy-section')).toHaveCount(kind === 'privacy' ? 10 : 8);
      await expect(page.locator('.policy-document')).toHaveCSS('background-color', 'rgb(249, 231, 212)');
      const contents = page.locator('.policy-contents a');
      await expect(contents).toHaveCount(kind === 'privacy' ? 10 : 8);
      const target = await contents.first().getAttribute('href');
      await contents.first().click();
      await expect(page.locator(target)).toBeInViewport();
      await expect(page.locator('.policy-section p[data-copy]').first()).toBeVisible();
      await expect(page.locator('script,iframe,form')).toHaveCount(0);
      expect(requests.every(request => new URL(request.url()).origin === new URL(baseURL).origin)).toBe(true);
      expect(requests.some(request => request.url().includes('/api/'))).toBe(false);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await context.close();
    });
  }
  test(`${locale} policy language and cross-document links work without JavaScript`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(path('privacy', locale));
    await expect(page.locator('.policy-header nav a').first()).toHaveAttribute('href', path('privacy', locale));
    await expect(page.locator('.policy-header nav a').nth(1)).toHaveAttribute('href', path('usage', locale));
    await page.locator('.policy-header nav a').nth(1).click();
    await expect(page).toHaveURL(new RegExp(path('usage', locale).replaceAll('.', '\\.') + '$'));
    await page.locator('.policy-languages a[lang="en"]').click();
    await expect(page).toHaveURL(/\/usage\.html$/);
    await context.close();
  });
}

test('English notices disclose the approved commercial and data choices', async ({ page }) => {
  await page.goto('/privacy.html');
  const privacy = page.locator('main');
  for (const fact of ['Google, Apple, Microsoft and LinkedIn', 'OpenAI Codex', 'TypeSafe JEV', 'promotional email', 'unchecked consent choice', 'withdraw in Settings', 'Resend', 'Cloudflare', 'Hetzner', 'Stripe', 'Swiss Federal Data Protection', '18 or older']) await expect(privacy).toContainText(fact);
  await page.goto('/usage.html');
  const usage = page.locator('main');
  for (const fact of ['weekly access is USD 3', 'monthly access is USD 10', 'inclusive of applicable tax', 'through the already paid period', 'Refunds and remedies required by applicable law', 'Apple App Store', 'Google Play', 'mandatory consumer protections', 'The English version governs where law permits']) await expect(usage).toContainText(fact);
});
