// Retained browser/Worker -> real language catalogue, HTTP ownership/revision boundary and SQLite filtering.
import { expect, test } from '@playwright/test';
import { startVisitorRuntime } from '../assembled/visitor-runtime.mjs';
test.use({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 1100 } });
let runtime;
test.beforeEach(async () => { runtime = await startVisitorRuntime(); });
test.afterEach(async () => { await runtime?.close(); });
function multilingual() {
  const at = Date.now(), jobs = ['en', 'fr', 'de-CH', null].map((locale, index) => ({
    id: `language-${locale ?? 'unknown'}`, companyId: 'assembled', companyName: 'Assembled Company', companySlug: 'assembled', title: `Engineer ${locale ?? 'unknown'}`,
    sourceUrl: `https://example.org/careers/${index}`, active: true, reserved: false, hasContent: true,
    firstObserved: new Date(at - 3 * 86400000 - index * 3600000).toISOString(), lastObserved: null, locales: locale ? [locale] : [], locations: [], employmentTypes: [], seniority: null, salary: null, bodyText: null,
    evidence: { source: 'jobseek_public', metadataFetchedAt: new Date(at).toISOString(), bodyFetchedAt: null, bodyUrl: null, bodySha256: null, textSha256: null, bodyBytes: 0, normalizationVersion: 1, truncated: false },
  }));
  runtime.app.store.importSnapshot({ schemaVersion: 1, snapshotAt: new Date(at).toISOString(), verifiedAt: new Date(at).toISOString(), observations: [{ id: "assembled-engineer", active: false, observedAt: new Date(at).toISOString() }], unknownIds: [], jobs });
}
async function choose(page, ids) {
  await expect(page.locator('#posting-languages')).toBeEnabled(); await page.locator('#posting-languages').click();
  await page.getByRole('button', { name: 'Any language', exact: true }).click();
  for (const id of ids) await page.locator(`.language-options input[value="${id}"]`).check();
  await page.locator('#apply-posting-languages').click();
}
async function revealAll(page, count) {
  for (let attempt = 0; attempt < 8 && await page.locator('[data-job]').count() < count; attempt++) {
    await page.locator('#feed-tail').scrollIntoViewIfNeeded();
    await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
    await page.waitForTimeout(480);
  }
  await expect(page.locator('[data-job]')).toHaveCount(count);
}
async function login(page) {
  await page.locator('#header-sign-in').click(); await page.locator('#auth-username').fill('assembled-reader');
  await page.locator('#auth-password').fill('Synthetic-local-account-password'); await page.locator('#auth-submit').click();
  await expect(page.locator('#header-sign-in')).toBeHidden();
}
test('real visitor catalogue allocates no owner; creation, filtering, handoff and account revision save retain exact draft', async ({ page }) => {
  multilingual(); await page.goto(runtime.origin); await expect(page.locator('#posting-languages')).toBeEnabled();
  expect(runtime.count('justup_visitors')).toBe(0);
  await choose(page, ['fr', 'de-CH']);
  expect(runtime.count('justup_visitors')).toBe(0); expect(runtime.modelCalls()).toBe(0);
  await page.locator('#query').fill('Engineer'); await page.locator('#job-search button[type=submit]').click();
  await expect(page.locator('[data-job]')).toHaveCount(2);
  await expect(page.locator('[data-job="language-fr"]')).toBeVisible(); await expect(page.locator('[data-job="language-de-CH"]')).toBeVisible();
  await expect(page.locator('[data-job="language-unknown"]')).toHaveCount(0);
  const created = runtime.calls.find(call => call.method === 'POST' && call.path === '/api/v1/visitor/searches');
  expect(created.body.options).toEqual({ followedOnly: false, postingLanguages: ['de-CH', 'fr'] });
  const text = '  My unsent text\nremains exact  '; await page.locator('#query').fill(text); await page.locator('#query').blur();
  await login(page); await expect(page.locator('#query')).toHaveValue(text);
  await choose(page, ['fr']); await expect(page.locator('#posting-language-dialog')).not.toBeVisible();
  await expect(page.locator('[data-job]')).toHaveCount(1); await expect(page.locator('[data-job="language-fr"]')).toBeVisible();
  await expect(page.locator('#query')).toHaveValue(text);
  expect(runtime.calls.some(call => call.method === 'PATCH' && /^\/api\/v1\/searches\/[^/]+\/options$/.test(call.path) && call.body.expectedRevision === 1)).toBe(true);
  await page.reload(); await expect(page.locator('#query')).toHaveValue(text);
  await choose(page, []); await expect(page.locator('#posting-language-dialog')).not.toBeVisible();
  await revealAll(page, 4);
  await expect(page.locator('[data-job="language-unknown"]')).toBeVisible();
  expect(runtime.modelCalls()).toBe(1);
  expect(runtime.calls.filter(call => call.method === 'POST' && /\/searches$/.test(call.path))).toHaveLength(1);
});
test('lost real option acknowledgement reads committed canonical revision without interpreting again', async ({ page }) => {
  multilingual(); await page.goto(runtime.origin); await page.locator('#query').fill('Engineer'); await page.locator('#job-search button[type=submit]').click();
  await revealAll(page, 4);
  await expect(page.locator('[data-job="language-unknown"]')).toBeVisible();
  const id = runtime.db.prepare('SELECT id FROM justup_searches').get().id;
  runtime.loseNext('PATCH', `/visitor/searches/${id}/options`);
  await page.locator('#query').fill('Newer unsent text  '); await choose(page, ['fr']);
  await expect(page.locator('#posting-language-dialog')).toContainText('could not be confirmed');
  await expect(page.locator('#query')).toHaveValue('Newer unsent text  ');
  await page.keyboard.press('Escape'); await expect(page.locator('[data-job]')).toHaveCount(1);
  await page.locator('#posting-languages').click(); await expect(page.locator('.language-options input[value="fr"]')).toBeChecked();
  await page.keyboard.press('Escape'); expect(runtime.modelCalls()).toBe(1);
  const patches = runtime.calls.filter(call => call.method === 'PATCH' && call.path.endsWith('/options'));
  expect(patches).toHaveLength(1); expect(runtime.db.prepare('SELECT revision FROM justup_searches WHERE id=?').get(id).revision).toBe(2);
});
