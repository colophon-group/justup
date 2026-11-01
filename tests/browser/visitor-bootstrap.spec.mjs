// Stateless visitor hints use ordinary cookie-scoped workspace routes; no account or model is fabricated.
import { expect, test } from '@playwright/test';
import { mockApi, session } from './api-fixture.mjs';
const empty = () => ({ revision: 0, state: { activeSearchId: null, drafts: {} }, viewed: [], recoveredDrafts: [] });
const guest = interpretation => session({ user: null, visitor: null, capabilities: { visitorSearch: true, search: interpretation, viewed: true } });

test('an unallocated visitor can focus an empty editor and sign in without allocating private work', async ({ page }) => {
  await page.clock.install();
  let signedIn = false;
  const calls = await mockApi(page, {
    'GET /session': () => signedIn ? session() : guest(true),
    'GET /visitor/workspace': empty, 'GET /visitor/searches': { items: [] },
    'POST /auth/login': () => { signedIn = true; return session(); },
  });
  await page.goto('/'); await expect(page.locator('#job-search button[type=submit]')).toBeEnabled();
  await page.locator('#query').focus(); await page.clock.runFor(10_000);
  await page.locator('#header-sign-in').click(); await page.locator('#auth-username').fill('tester'); await page.locator('#auth-password').fill('test-only-password'); await page.locator('#auth-submit').click();
  await expect(page.locator('#header-sign-in')).toBeHidden(); await expect(page.locator('#query')).toHaveValue('');
  expect(calls.filter(call => call.key === 'PATCH /visitor/workspace')).toHaveLength(0);
  expect(calls.filter(call => call.key === 'POST /auth/login')).toHaveLength(1);
  expect(calls.some(call => /^(POST|PATCH) \/(?:visitor\/)?searches/.test(call.key))).toBe(false);
});

test('stateless draft storage survives a lost save and hands off exact text while interpretation is unavailable', async ({ page }) => {
  await page.clock.install();
  const draft = '  musée roles\nwithout weekend shifts  ';
  let saved = empty(), signedIn = false, writes = 0, transferred;
  const calls = await mockApi(page, {
    'GET /session': () => signedIn ? session() : guest(false),
    'GET /visitor/workspace': () => structuredClone(saved), 'GET /visitor/searches': { items: [] },
    'PATCH /visitor/workspace': call => {
      if (call.body.expectedRevision !== saved.revision) return { status: 409, body: { error: { code: 'revision_conflict', message: 'Workspace changed.' } } };
      saved = { ...saved, revision: saved.revision + 1, state: { activeSearchId: call.body.activeSearchId, drafts: call.body.drafts } };
      if (++writes === 1) return { abort: true };
      return saved;
    },
    'POST /auth/login': () => { signedIn = true; transferred = structuredClone(saved); return session(); },
    'GET /workspace': () => transferred,
  });
  await page.goto('/'); await expect(page.locator('#job-search button[type=submit]')).toBeDisabled();
  await page.locator('#query').fill(draft); await page.clock.runFor(1000);
  await expect(page.locator('#workspace-sync-status')).toContainText('The service is unavailable');
  expect(saved.state.drafts.new).toBe(draft);
  await page.locator('#header-sign-in').click(); await page.locator('#auth-username').fill('tester'); await page.locator('#auth-password').fill('test-only-password'); await page.locator('#auth-submit').click();
  await expect(page.locator('#header-sign-in')).toBeHidden(); await expect(page.locator('#query')).toHaveValue(draft);
  expect(transferred.state.drafts.new).toBe(draft);
  expect(calls.filter(call => call.key === 'POST /auth/login')).toHaveLength(1);
  expect(calls.some(call => /^(POST|PATCH) \/(?:visitor\/)?searches/.test(call.key))).toBe(false);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
});
