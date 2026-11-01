// No route interception: compiled frontend/Worker → selected real HTTP API/SQLite → deterministic local queue.
import { expect, test } from '@playwright/test';
import { startVisitorRuntime } from '../assembled/visitor-runtime.mjs';
test.use({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 1100 } });
let runtime;
test.beforeEach(async () => { runtime = undefined; runtime = await startVisitorRuntime(); });
test.afterEach(async () => { await runtime?.close(); });
async function login(page) {
  await page.locator('#header-sign-in').click();
  await page.locator('#auth-username').fill('assembled-reader'); await page.locator('#auth-password').fill('Synthetic-local-account-password'); await page.locator('#auth-submit').click();
  await expect(page.locator('#header-sign-in')).toBeHidden();
}
test('a real first visitor search accepts its owned task and displays real imported result', async ({ page }) => {
  await page.goto(runtime.origin);
  await expect(page.locator('#job-search button[type=submit]')).toBeEnabled();
  const boot = runtime.calls.find(call => call.path === '/api/v1/session').session;
  expect(boot.visitor).toBeNull(); expect(boot.capabilities.visitorSearch).toBe(true);
  const version = await (await page.request.get(runtime.origin + '/api/v1/version')).json();
  expect(version.sourceCommit).toBe(runtime.sourceCommit); expect(version.schemaVersion).toBe(2);
  await page.locator('#query').fill('Engineer'); await page.locator('#job-search button[type=submit]').click();
  await expect(page.getByRole('tab', { name: 'Engineering', exact: true })).toBeVisible();
  await expect(page.locator('[data-job="assembled-engineer"]')).toBeVisible();
  await login(page);
  await expect(page.locator('#workspace-conflict')).toHaveCount(0);
  expect(runtime.modelCalls()).toBe(1);
  expect(runtime.count('justup_searches')).toBe(1);
  expect(runtime.count('justup_journey_events')).toBeGreaterThan(0);
  expect(runtime.count('justup_model_executions')).toBe(1);
  expect(runtime.sourceCommit).toMatch(/^[a-f0-9]{40}$/);
});

test('real draft storage and lost-PATCH recovery hand off exact text without model availability', async ({ page }) => {
  runtime.setAvailable(false); runtime.loseNext('PATCH', '/visitor/workspace');
  const raw = '  musée roles\nwithout night shifts  ';
  await page.goto(runtime.origin); await expect(page.locator('#job-search button[type=submit]')).toBeDisabled();
  await page.locator('#query').fill(raw); await page.locator('#query').blur();
  await expect(page.locator('#workspace-sync-status')).toContainText(/unavailable|unreadable/);
  expect(runtime.workspaces()[0].drafts.new).toBe(raw);
  await login(page); await expect(page.locator('#query')).toHaveValue(raw);
  expect(runtime.workspaces()[0].drafts.new).toBe(raw); expect(runtime.modelCalls()).toBe(0);
  expect(runtime.count('justup_model_executions')).toBe(0);
  expect(runtime.calls.filter(call => call.path === '/api/v1/auth/login')).toHaveLength(1);
});

for (const autosaveDelay of [0, 6500]) test(`a lost real create response recovers the same request key and retains raw outer whitespace after ${autosaveDelay ? 'background autosave' : 'immediate retry'}`, async ({ page }) => {
  await page.clock.install();
  runtime.loseNext('POST', '/visitor/searches'); const raw = '  Engineer  ';
  await page.goto(runtime.origin); await page.locator('#query').fill(raw); await page.locator('#job-search button[type=submit]').click();
  await expect(page.locator('#search-status')).toContainText(/unavailable|unreadable/);
  const id = runtime.db.prepare('SELECT id FROM justup_searches').get().id;
  expect(runtime.workspaces()[0].drafts[id]).toBe(raw);
  if (autosaveDelay) {
    // Exercise the ordinary background writer before retrying the ambiguous
    // request; a forced submission flush alone missed this resurrection bug.
    await page.clock.runFor(autosaveDelay);
    await page.waitForLoadState('networkidle');
  }
  await page.locator('#job-search button[type=submit]').click();
  await expect(page.getByRole('tab', { name: 'Engineering', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-job="assembled-engineer"]')).toBeVisible();
  await expect(page.locator('#query')).toHaveValue(raw);
  const creates = runtime.calls.filter(call => call.path === '/api/v1/visitor/searches' && call.method === 'POST');
  expect(creates).toHaveLength(2); expect(creates[1].body.requestKey).toBe(creates[0].body.requestKey);
  expect(runtime.modelCalls()).toBe(1); expect(runtime.count('justup_searches')).toBe(1);
  await page.locator('#add-search').click();
  await expect(page.locator('#query')).toHaveValue('');
  await page.getByRole('tab', { name: 'Engineering', exact: true }).click();
  await expect(page.locator('#query')).toHaveValue(raw);
  await login(page); await expect(page.locator('#query')).toHaveValue(raw);
  expect(runtime.workspaces()[0].drafts[id]).toBe(raw);
});

test('newer independent text after a lost create survives autosave, tab changes and sign-in without another interpretation', async ({ page }) => {
  await page.clock.install();
  runtime.loseNext('POST', '/visitor/searches'); const raw = '  Engineer  ';
  await page.goto(runtime.origin); await page.waitForLoadState('networkidle'); await page.locator('#query').fill(raw);
  const recovering = runtime.holdNext('GET', '/visitor/workspace');
  await page.locator('#job-search button[type=submit]').click(); await recovering.arrived;
  const newer = 'A genuinely newer unsent search\nwithout night shifts  ';
  await page.locator('#query').fill(newer); recovering.release();
  await expect(page.locator('#search-status')).toContainText(/unavailable|unreadable/);
  const id = runtime.db.prepare('SELECT id FROM justup_searches').get().id;
  await page.clock.runFor(6500); await page.waitForLoadState('networkidle');
  await expect(page.locator('#query')).toHaveValue(newer);
  await expect(page.getByRole('tab').first()).toHaveAttribute('aria-selected', 'false');
  await expect.poll(() => runtime.workspaces()[0].drafts.new).toBe(newer);
  expect(runtime.workspaces()[0].drafts[id]).toBe(raw);
  expect(runtime.workspaces()[0].activeSearchId).toBeNull();
  await page.getByRole('tab').first().click();
  await expect(page.getByRole('tab', { name: 'Engineering', exact: true })).toBeVisible();
  await expect(page.locator('#query')).toHaveValue(raw);
  await page.locator('#add-search').click(); await expect(page.locator('#query')).toHaveValue(newer);
  await expect(page.getByRole('tab').first()).toHaveAttribute('aria-selected', 'false');
  await login(page); await expect(page.locator('#query')).toHaveValue(newer);
  await expect(page.getByRole('tab').first()).toHaveAttribute('aria-selected', 'false');
  expect(runtime.workspaces()[0].drafts.new).toBe(newer);
  expect(runtime.workspaces()[0].drafts[id]).toBe(raw);
  expect(runtime.calls.filter(call => call.path === '/api/v1/visitor/searches' && call.method === 'POST')).toHaveLength(1);
  expect(runtime.modelCalls()).toBe(1); expect(runtime.count('justup_searches')).toBe(1);
});

for (const recovered of [false, true]) for (const remaining of [false, true]) test(`owned ${recovered ? 'recovered' : 'normal'} search deletion preserves fresh drafting ${remaining ? 'with another search' : 'after last-search reclamation'}`, async ({ page }) => {
  await page.clock.install(); await page.goto(runtime.origin);
  if (remaining) {
    await page.locator('#query').fill('Engineer first'); await page.locator('#job-search button[type=submit]').click();
    await expect(page.getByRole('tab', { name: 'Engineering', exact: true })).toBeVisible();
    await page.locator('#add-search').click();
  }
  const before = new Set(runtime.db.prepare('SELECT id FROM justup_searches').all().map(row => row.id));
  if (recovered) runtime.loseNext('POST', '/visitor/searches');
  await page.locator('#query').fill('  Engineer  '); await page.locator('#job-search button[type=submit]').click();
  if (recovered) await expect(page.locator('#search-status')).toContainText(/unavailable|unreadable/);
  else await expect(page.getByRole('tab', { name: 'Engineering', exact: true })).toHaveCount(remaining ? 2 : 1);
  const id = runtime.db.prepare('SELECT id FROM justup_searches').all().find(row => !before.has(row.id)).id;
  const callsBefore = runtime.calls.length;
  await page.locator('.search-tab .tab-remove').last().click(); await page.locator('#confirm-delete-search').click();
  await expect(page.locator('#delete-search-dialog')).not.toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(remaining ? 1 : 0);
  if (remaining) await page.locator('#add-search').click();
  const newer = '  A fresh genuine new draft\nno night shifts  '; await page.locator('#query').fill(newer);
  await page.clock.runFor(6500); await page.waitForLoadState('networkidle');
  await expect(page.locator('#query')).toHaveValue(newer);
  await expect.poll(() => runtime.workspaces()[0]?.drafts.new).toBe(newer);
  expect(Object.hasOwn(runtime.workspaces()[0].drafts, id)).toBe(false);
  expect(runtime.workspaces()[0].activeSearchId).toBeNull();
  expect(runtime.calls.slice(callsBefore).filter(call => call.path === '/api/v1/visitor/workspace' && call.method === 'PATCH').every(call => call.status === 200)).toBe(true);
  expect(runtime.calls.filter(call => call.path === `/api/v1/visitor/searches/${id}` && call.method === 'DELETE' && call.status === 200)).toHaveLength(1);
  expect(runtime.modelCalls()).toBe(remaining ? 2 : 1); expect(runtime.count('justup_searches')).toBe(remaining ? 1 : 0);
});

test('acknowledged last deletion with a lost renewal keeps writes blocked until a fresh retry preserves later typing', async ({ page }) => {
  await page.clock.install(); await page.goto(runtime.origin);
  await page.locator('#query').fill('Engineer'); await page.locator('#job-search button[type=submit]').click();
  await expect(page.getByRole('tab', { name: 'Engineering', exact: true })).toBeVisible();
  runtime.loseNext('GET', '/session');
  await page.locator('.search-tab .tab-remove').click(); await page.locator('#confirm-delete-search').click();
  await expect(page.locator('#delete-search-dialog')).not.toBeVisible();
  await expect(page.locator('#workspace-sync-status')).toContainText('Reconnect');
  expect(runtime.count('justup_visitors')).toBe(0);
  const beforeRetry = runtime.calls.length, newer = 'Exact text while renewal is unavailable  ';
  await page.locator('#query').fill(newer); await page.clock.runFor(6500); await page.waitForLoadState('networkidle');
  await expect(page.locator('#query')).toHaveValue(newer);
  expect(runtime.calls.slice(beforeRetry).some(call => call.path === '/api/v1/visitor/workspace' && call.method === 'PATCH')).toBe(false);
  const held = runtime.holdNext('GET', '/session');
  await page.locator('#retry-workspace').click(); await held.arrived;
  const latest = '  Latest exact draft\nwhile the retry read is held  '; await page.locator('#query').fill(latest); held.release();
  await expect.poll(() => runtime.workspaces()[0]?.drafts.new).toBe(latest);
  await expect(page.locator('#query')).toHaveValue(latest);
  await expect(page.locator('#workspace-sync-status')).toBeEmpty();
  await expect(page.locator('#workspace-conflict')).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveCount(0);
  expect(runtime.calls.slice(beforeRetry).filter(call => call.path === '/api/v1/visitor/workspace' && call.method === 'PATCH').every(call => call.status === 200)).toBe(true);
  expect(runtime.modelCalls()).toBe(1); expect(runtime.count('justup_searches')).toBe(0);
});

test('owned deletion retains a genuine remote conflict when newer local text predates the hydration read', async ({ page }) => {
  await page.clock.install(); await page.goto(runtime.origin);
  await page.locator('#query').fill('Engineer first'); await page.locator('#job-search button[type=submit]').click();
  await expect(page.getByRole('tab', { name: 'Engineering', exact: true })).toBeVisible();
  await page.locator('#add-search').click(); await page.locator('#query').fill('Engineer second');
  await page.locator('#job-search button[type=submit]').click();
  await expect(page.getByRole('tab', { name: 'Engineering', exact: true })).toHaveCount(2);
  runtime.loseNext('GET', '/session');
  await page.locator('.search-tab .tab-remove').last().click(); await page.locator('#confirm-delete-search').click();
  await expect(page.locator('#delete-search-dialog')).not.toBeVisible();
  await expect(page.locator('#workspace-sync-status')).toContainText('Reconnect');
  const held = runtime.holdNext('GET', '/session');
  await page.locator('#retry-workspace').click(); await held.arrived;
  const local = '  Local edit before hydration  ', remote = 'Independent edit from another browser';
  const remainingId = runtime.db.prepare('SELECT id FROM justup_searches').get().id;
  await page.locator('#query').fill(local);
  const session = await (await page.request.get(runtime.origin + '/api/v1/session')).json();
  const workspace = await (await page.request.get(runtime.origin + '/api/v1/visitor/workspace')).json();
  const updated = await page.request.patch(runtime.origin + '/api/v1/visitor/workspace', {
    headers: { Origin: runtime.origin, 'X-CSRF-Token': session.csrfToken },
    data: { expectedRevision: workspace.revision, activeSearchId: null, drafts: { ...workspace.state.drafts, [remainingId]: remote } },
  }); expect(updated.status()).toBe(200);
  await expect(page.locator('#query')).toHaveValue(local);
  held.release(); await expect(page.locator('#delete-search-dialog')).not.toBeVisible();
  await expect(page.locator('#workspace-conflict')).toBeVisible();
  await expect(page.locator('#query')).toHaveValue(local);
  await page.clock.runFor(6500); await page.waitForLoadState('networkidle');
  expect(runtime.workspaces()[0].drafts[remainingId]).toBe(remote);
  await page.locator('#keep-local-drafts').click();
  await expect(page.locator('#workspace-conflict')).toHaveCount(0);
  await expect.poll(() => runtime.workspaces()[0].drafts[remainingId]).toBe(local);
  await expect(page.locator('#query')).toHaveValue(local);
  expect(runtime.modelCalls()).toBe(2); expect(runtime.count('justup_searches')).toBe(1);
});

for (const lost of [false, true]) test(`real clear/rebootstrap preserves typing while the clearing reply is ${lost ? 'lost' : 'held'}`, async ({ page }) => {
  await page.goto(runtime.origin); await page.locator('#query').fill('An earlier draft'); await page.locator('#query').blur();
  await expect.poll(() => runtime.workspaces()[0]?.drafts.new).toBe('An earlier draft');
  const cleared = body => body?.drafts?.new === '';
  const held = runtime.holdNext('PATCH', '/visitor/workspace', cleared); if (lost) runtime.loseNext('PATCH', '/visitor/workspace', cleared);
  await page.locator('#query').fill(''); await page.locator('#query').blur(); await held.arrived;
  expect(runtime.count('justup_visitors')).toBe(0);
  const newer = 'A newer exact draft\nwith more details'; await page.locator('#query').fill(newer); held.release();
  await page.locator('#query').blur();
  await expect.poll(() => runtime.workspaces()[0]?.drafts.new).toBe(newer);
  await expect(page.locator('#query')).toHaveValue(newer); await expect(page.locator('#workspace-conflict')).toHaveCount(0);
  expect(runtime.count('justup_visitors')).toBe(1); expect(runtime.modelCalls()).toBe(0);
  await login(page); await expect(page.locator('#query')).toHaveValue(newer);
});

test('real account browser-default locale ignores a prior guest cookie and sends French model context', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'fr-CA', ignoreHTTPSErrors: true, viewport: { width: 1280, height: 1100 } }); const page = await context.newPage();
  await context.addCookies([{ name: 'justup_interface_locale', value: 'es', url: runtime.origin }]);
  await page.goto(runtime.origin); await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await page.locator('#query').fill('  Engineer  '); await login(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr'); await expect(page.locator('#query')).toHaveValue('  Engineer  ');
  await expect.poll(() => runtime.calls.filter(call => call.session?.user).at(-1)?.session.policies.locale).toBe('fr');
  expect(runtime.modelCalls()).toBe(0);
  await page.locator('#job-search button[type=submit]').click(); await expect(page.getByRole('tab', { name: 'Engineering', exact: true })).toBeVisible();
  expect(runtime.modelInputs[0].presentationLocale).toBe('fr'); await expect(page.locator('#query')).toHaveValue('  Engineer  ');
  await context.close();
});

test('real explicit Italian overrides saved German and default navigation clears the request hint without rewriting the draft', async ({ page }) => {
  await page.goto(runtime.origin); await page.locator('#query').fill('Exact unsent text'); await login(page);
  const session = await (await page.request.get(runtime.origin + '/api/v1/session')).json();
  const preferences = await (await page.request.get(runtime.origin + '/api/v1/preferences')).json();
  const saved = await page.request.patch(runtime.origin + '/api/v1/preferences', { headers: { Origin: runtime.origin, 'X-CSRF-Token': session.csrfToken }, data: { expectedRevision: preferences.revision, interfaceLocale: 'de' } }); expect(saved.status()).toBe(200);
  await page.goto(runtime.origin + '/it/'); await expect(page.locator('html')).toHaveAttribute('lang', 'it');
  await expect(page.locator('#query')).toHaveValue('Exact unsent text');
  const explicit = runtime.calls.filter(call => call.path === '/api/v1/session').at(-1); expect(explicit.locale).toBe('it'); expect(explicit.session.policies.locale).toBe('it');
  await page.goto(runtime.origin + '/'); await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(page.locator('#query')).toHaveValue('Exact unsent text');
  await expect.poll(() => runtime.calls.filter(call => call.path === '/api/v1/session').at(-1)?.locale).toBeNull();
  expect(runtime.calls.filter(call => call.path === '/api/v1/session').at(-1).session.policies.locale).toBe('de');
  expect(runtime.modelCalls()).toBe(0);
});
