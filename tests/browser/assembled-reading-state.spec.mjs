// Retained browser/Worker -> actual follow/viewed/options HTTP routes and isolated SQLite.
import { expect, test } from '@playwright/test';
import { startVisitorRuntime } from '../assembled/visitor-runtime.mjs';
test.use({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 1100 } });
let runtime;
test.beforeEach(async () => { runtime = await startVisitorRuntime(); });
test.afterEach(async () => { await runtime?.close(); });
const password = 'Synthetic-local-account-password';
async function login(page, username = 'assembled-reader') {
  await page.locator('#header-sign-in').click(); await page.locator('#auth-username').fill(username);
  await page.locator('#auth-password').fill(password); await page.locator('#auth-submit').click();
  await expect(page.locator('#header-sign-in')).toBeHidden();
}
async function logout(page) {
  await page.locator('#account-open').click(); await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.locator('#header-sign-in')).toBeVisible();
}
async function company(page) { await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Companies', exact: true }).click(); }
async function positions(page) { await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Positions', exact: true }).click(); }
function secondCompany() {
  const at = Date.now();
  runtime.app.store.importSnapshot({ schemaVersion: 1, snapshotAt: new Date(at).toISOString(), verifiedAt: new Date(at).toISOString(), observations: [], unknownIds: [], jobs: [{
    id: 'other-engineer', companyId: 'other', companyName: 'Other Company', companySlug: 'other', title: 'Engineer elsewhere', sourceUrl: 'https://example.org/careers/other', active: true, reserved: false, hasContent: true,
    firstObserved: new Date(at - 4 * 86400000).toISOString(), lastObserved: null, locales: ['en'], locations: [], employmentTypes: [], seniority: null, salary: null, bodyText: null,
    evidence: { source: 'jobseek_public', metadataFetchedAt: new Date(at).toISOString(), bodyFetchedAt: null, bodyUrl: null, bodySha256: null, textSha256: null, bodyBytes: 0, normalizationVersion: 1, truncated: false },
  }] });
}
test('follows filter real saved results; unfollow refreshes revisions without changing raw draft; source viewing survives a new session', async ({ page, browser }) => {
  secondCompany(); await page.goto(runtime.origin); await login(page); await company(page);
  const row = page.locator('[data-company="assembled"]');
  await row.getByRole('button', { name: 'Follow Assembled Company', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Unfollow Assembled Company', exact: true })).toBeEnabled();
  await positions(page); await page.locator('#followed-only').check();
  await page.locator('#query').fill('Engineer'); await page.locator('#job-search button[type=submit]').click();
  await expect(page.locator('[data-job]')).toHaveCount(1); await expect(page.locator('[data-job="assembled-engineer"]')).toBeVisible();
  const id = runtime.db.prepare('SELECT id FROM justup_searches').get().id;
  const canonical = await (await page.request.get(`${runtime.origin}/api/v1/searches/${id}/results?revision=1`)).json();
  expect(canonical.items.map(job => job.id)).toEqual(['assembled-engineer']);
  const raw = '  Unsent exact draft\nkeep this  '; await page.locator('#query').fill(raw); await page.locator('#query').blur();
  const posting = page.locator('[data-job="assembled-engineer"] .posting-link');
  await posting.evaluate(link => { window.readingHeld = { row: link.closest('[data-job]'), link, height: link.closest('[data-job]').getBoundingClientRect().height }; });
  // Real native target=_blank navigation opens a page while the same-origin POST records the outbound event.
  await posting.focus(); await expect(posting).toBeFocused();
  const popupPromise = page.waitForEvent('popup'); await posting.click(); const popup = await popupPromise; await popup.close();
  await page.bringToFront(); await expect(page.locator('[data-job="assembled-engineer"]')).toHaveClass(/viewed/); await expect(posting).toBeFocused();
  expect(await posting.evaluate(link => ({ same: link === window.readingHeld.link, row: link.closest('[data-job]') === window.readingHeld.row, height: link.closest('[data-job]').getBoundingClientRect().height === window.readingHeld.height }))).toEqual({ same: true, row: true, height: true });
  await expect.poll(() => runtime.calls.filter(call => call.method === 'POST' && call.path === '/api/v1/viewed' && call.status === 200).length).toBe(1);
  await page.locator('[data-job="assembled-engineer"] .job-company').click();
  await expect(page.getByRole('button', { name: 'Unfollow Assembled Company', exact: true }).last()).toBeEnabled();
  const viewedWrites = runtime.calls.filter(call => call.path.endsWith('/viewed')).length;
  await page.locator('#company-page').getByRole('button', { name: 'Unfollow Assembled Company', exact: true }).click();
  await expect(page.locator('#company-page').getByRole('button', { name: 'Follow Assembled Company', exact: true })).toBeEnabled();
  await positions(page); await expect(page.locator('[data-job]')).toHaveCount(0); await expect(page.locator('#query')).toHaveValue(raw);
  expect(runtime.db.prepare('SELECT revision FROM justup_searches WHERE id=?').get(id).revision).toBe(2);
  expect(runtime.calls.filter(call => call.path.endsWith('/viewed'))).toHaveLength(viewedWrites);
  expect(runtime.modelCalls()).toBe(1);
  await logout(page); await expect(page.locator('#followed-only')).toHaveCount(0);
  const device = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const other = await device.newPage(); await other.goto(runtime.origin); await login(other);
    await expect(other.locator('#query')).toHaveValue(raw); await expect(other.locator('#followed-only')).toBeChecked();
    await company(other); await expect(other.locator('[data-company="assembled"]').getByRole('button', { name: 'Follow Assembled Company', exact: true })).toBeEnabled();
    await other.locator('[data-company="assembled"]').getByRole('button', { name: 'Follow Assembled Company', exact: true }).click();
    await positions(other); await expect(other.locator('[data-job="assembled-engineer"]')).toHaveClass(/viewed/);
    await other.locator('#followed-only').click(); await expect(other.locator('#followed-only')).not.toBeChecked(); await expect(other.locator('[data-job]')).toHaveCount(2);
    expect(runtime.modelCalls()).toBe(1);
  } finally { await device.close(); }
});
test('lost follow and option acknowledgements reconcile committed state without retrying writes or interpretation', async ({ page }) => {
  await page.goto(runtime.origin); await login(page); await company(page);
  runtime.loseNext('PATCH', '/follows/assembled');
  await page.locator('[data-company="assembled"]').getByRole('button', { name: 'Follow Assembled Company', exact: true }).click();
  await expect(page.locator('#companies-page .follow-notice')).toContainText('could not be confirmed');
  await expect(page.locator('[data-company="assembled"] .follow-company')).toBeDisabled();
  await page.getByRole('button', { name: 'Reload follows', exact: true }).click();
  await expect(page.locator('[data-company="assembled"]').getByRole('button', { name: 'Unfollow Assembled Company', exact: true })).toBeEnabled();
  expect(runtime.calls.filter(call => call.method === 'PATCH' && call.path.endsWith('/follows/assembled'))).toHaveLength(1);
  await positions(page); await page.locator('#query').fill('Engineer'); await page.locator('#job-search button[type=submit]').click();
  await expect(page.locator('[data-job]')).toHaveCount(1);
  const id = runtime.db.prepare('SELECT id FROM justup_searches').get().id;
  runtime.loseNext('PATCH', `/searches/${id}/options`);
  await page.locator('#query').fill('Exact unsent text  '); await page.locator('#followed-only').click();
  await expect(page.locator('#search-status')).toContainText('could not be confirmed'); await expect(page.locator('#followed-only')).toBeChecked();
  await expect(page.locator('#query')).toHaveValue('Exact unsent text  ');
  expect(runtime.calls.filter(call => call.method === 'PATCH' && call.path.endsWith('/options'))).toHaveLength(1); expect(runtime.modelCalls()).toBe(1);
});
test('a held previous-account follow reply cannot change the signed-out or next-account interface', async ({ page, context }) => {
  await runtime.app.auth.register({ username: 'second-reader', password });
  await page.goto(runtime.origin); await login(page); await company(page);
  const other = await context.newPage(); await other.goto(runtime.origin); await expect(other.locator('#header-sign-in')).toBeHidden();
  const held = runtime.holdNext('PATCH', '/follows/assembled');
  try {
    await page.locator('[data-company="assembled"]').getByRole('button', { name: 'Follow Assembled Company', exact: true }).click(); await held.arrived;
    await logout(other); await expect(page.locator('#header-sign-in')).toBeVisible(); await expect(page.locator('.follow-company')).toHaveCount(0);
    // Establish a canonical signed-out session before the next credentials.
    // Concurrent guest-seed bootstraps have their own tracked recovery gap;
    // this journey proves held follow replies across a genuine owner change.
    await expect(page.locator('#live-label')).toHaveText('LIVE EDITION');
    await expect(other.locator('#live-label')).toHaveText('LIVE EDITION');
    await other.reload(); await expect(other.locator('#live-label')).toHaveText('LIVE EDITION');
    await login(other, 'second-reader'); await expect(page.locator('#header-sign-in')).toBeHidden();
    await expect(page.locator('[data-company="assembled"]').getByRole('button', { name: 'Follow Assembled Company', exact: true })).toBeEnabled();
    held.release();
    await expect(page.locator('[data-company="assembled"]').getByRole('button', { name: 'Follow Assembled Company', exact: true })).toBeEnabled();
    const follows = await (await page.request.get(runtime.origin + '/api/v1/follows')).json(); expect(follows.items).toEqual([]);
    expect(runtime.db.prepare('SELECT count(*) n FROM justup_company_follows WHERE followed=1').get().n).toBe(1);
  } finally { held.release(); await other.close(); }
});
