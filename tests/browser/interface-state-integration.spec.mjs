// Reviewed visitor and news contracts share public paths and presentation locales without rewriting user/source text.
import { expect, test } from '@playwright/test';
import { completed, job, mockApi, search, session } from './api-fixture.mjs';

const cases = [
  ['en', '1 saved draft', 'Use this draft', 'Viewed', 'Company listing activity', '6 newly observed listings, compared with 4 the previous week'],
  ['de', '1 gespeicherter Entwurf', 'Diesen Entwurf verwenden', 'Angesehen', 'Aktivität der Firmenstellenanzeigen', '6 neu erfasste Stellenanzeigen, gegenüber 4 in der Vorwoche'],
  ['fr', '1 brouillon enregistré', 'Utiliser ce brouillon', 'Consultée', 'Activité des offres des entreprises', '6 nouvelles offres repérées, contre 4 la semaine précédente'],
  ['it', '1 bozza salvata', 'Usa questa bozza', 'Visualizzata', 'Attività degli annunci aziendali', '6 nuovi annunci rilevati, rispetto a 4 la settimana precedente'],
  ['es', '1 borrador guardado', 'Usar este borrador', 'Vista', 'Actividad de ofertas de empresas', '6 nuevas ofertas detectadas, frente a 4 la semana anterior'],
];
for (const [locale, summary, useDraft, viewed, wireLabel, visibleHeadline] of cases) {
  test(`${locale} visitor recovery and Wire controls preserve original content and native company navigation`, async ({ browser }) => {
    const context = await browser.newContext({ locale, viewport: { width: 375, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.clock.install({ time: new Date('2026-10-27T12:00:00.000Z') });
    const draft = 'Exact user text: musée, Python, no night shifts';
    const record = { ...search(), draft: { query: draft, taskId: null, status: 'interrupted' } };
    const headline = '6 newly observed listings, compared with 4 the previous week';
    const calls = await mockApi(page, {
      'GET /session': session({ user: null, capabilities: { search: true, visitorSearch: true, viewed: true } }),
      'GET /visitor/searches': { items: [record] },
      'GET /visitor/workspace': { revision: 1, state: { activeSearchId: 'search-1', drafts: { 'search-1': draft } }, viewed: [{ jobId: 'job-1', firstViewedAt: '2026-10-27T10:00:00.000Z' }], recoveredDrafts: [{ id: 'recovered', text: 'An exact recovered draft', createdAt: '2026-10-27T10:00:00.000Z' }] },
      'GET /visitor/searches/search-1/results': completed([{ ...job(1), firstObserved: '2026-10-24T08:00:00.000Z' }]),
      'GET /hiring-wire': { state: 'published', edition: {
        id: '2026-10-26', title: 'Hiring Wire', period: { start: '2026-10-19T00:00:00.000Z', end: '2026-10-26T00:00:00.000Z', previousStart: '2026-10-12T00:00:00.000Z' },
        snapshotAt: '2026-10-26T00:00:00.000Z', publishedAt: '2026-10-26T08:00:00.000Z', expiresAt: '2026-11-02T00:00:00.000Z', methodology: 'Distinct newly observed listings on comparable career pages, not hires.',
        items: [{ company: { id: 'library', name: 'Test Library', url: 'https://example.com/about/' }, headline: `Test Library: ${headline}`, activity: { current: 6, previous: 4, change: 2, percentageChange: 50 }, scope: 'Comparable career pages' }],
      } },
    });
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.locator('#query')).toHaveValue(draft);
    await expect(page.getByRole('tab', { name: 'Library desk', exact: true })).toBeVisible();
    await expect(page.locator('#recovered-drafts summary')).toHaveText(summary);
    await page.locator('#recovered-drafts summary').click();
    await expect(page.getByRole('button', { name: useDraft, exact: true })).toBeVisible();
    await expect(page.locator('#recovered-drafts')).toContainText('An exact recovered draft');
    if (locale !== 'en') await expect(page.locator('#search-status')).not.toContainText('Your earlier check was interrupted');
    await page.locator('#feed-tail').scrollIntoViewIfNeeded();
    await expect(page.getByRole('img', { name: viewed, exact: true })).toBeVisible();
    await expect(page.locator('#search-accounting')).toContainText('Salary evidence is not available for every posting.');
    const wire = page.getByRole('region', { name: new RegExp(wireLabel) });
    await expect(wire).toBeVisible();
    await expect(wire.locator('.wire-headline').first()).toHaveText(visibleHeadline);
    await expect(wire.locator('.wire-company').first()).toHaveText('Test Library');
    const link = wire.getByRole('link').first();
    await expect(link).toHaveAttribute('href', `${locale === 'en' ? '' : `/${locale}`}/companies/library`);
    await link.click();
    await expect(page.getByRole('heading', { name: 'Test Library', exact: true })).toBeVisible();
    await page.locator('.topbar nav a').first().click();
    await expect(page.locator('#query')).toHaveValue(draft);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(calls.some(call => /^(POST|PATCH) \/(?:visitor\/)?searches/.test(call.key))).toBe(false);
    await context.close();
  });
}
