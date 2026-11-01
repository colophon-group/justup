// Same-browser account ownership contracts. The shared fixture reads a real context cookie on every request.
import { expect, test } from '@playwright/test';
import { completed, job, search, session } from './api-fixture.mjs';

const START = Date.parse('2026-11-01T12:00:00.000Z');
const names = { alpha: 'Alpha', beta: 'Beta', visitor: 'Visitor' };
const privateSearch = owner => ({ ...search(1, `${names[owner]} accepted search`), id: `${owner}-search`, title: `${names[owner]} edition` });
const privateJob = owner => ({ ...job(1), id: `${owner}-job`, title: `${names[owner]} private role` });
const emptyWorkspace = owner => ({ revision: 0, state: { activeSearchId: `${owner}-search`, drafts: {} }, viewed: [], recoveredDrafts: [] });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function sharedAccounts(context, baseURL, options = {}) {
  const state = { now: START, owner: options.owner === undefined ? 'alpha' : options.owner,
    deadlineKind: options.deadlineKind, deadline: options.deadline ?? START + 3_600_000, ...options };
  const calls = [], held = [], workspaces = new Map(), deleted = new Set();
  let holdPage = null, invalidLogin = null;
  const workspace = owner => { if (!workspaces.has(owner)) workspaces.set(owner, emptyWorkspace(owner)); return workspaces.get(owner); };
  const cookieOwner = headers => /(?:^|;\s*)fixture_owner=([^;]+)/.exec(headers.cookie || '')?.[1] || null;
  const identity = headers => {
    const owner = cookieOwner(headers);
    if (owner && !deleted.has(owner) && !(state.deadlineKind === 'session' && state.now >= state.deadline)) return owner;
    return state.deadlineKind === 'visitor' && state.now < state.deadline ? 'visitor' : null;
  };
  const dto = owner => session({
    user: owner && owner !== 'visitor' ? { id: owner, username: names[owner] } : null,
    visitor: owner === 'visitor' ? { expiresAt: new Date(state.deadline).toISOString() } : null,
    serverTime: new Date(state.now).toISOString(),
    expiresAt: owner && owner !== 'visitor' ? new Date(state.deadlineKind === 'session' ? state.deadline : START + 3_600_000).toISOString() : null,
    csrfToken: `csrf-${owner || 'guest'}`,
    access: { kind: owner && owner !== 'visitor' ? 'account' : 'guest',
      fullAccess: Boolean(owner && owner !== 'visitor' && !(state.deadlineKind === 'access' && state.now >= state.deadline)),
      billingEnabled: false, until: state.deadlineKind === 'access' && state.now < state.deadline ? new Date(state.deadline).toISOString() : null,
      description: state.deadlineKind === 'access' && state.now >= state.deadline ? 'Your paid period has ended.' : 'Current access.' },
    capabilities: { search: true, visitorSearch: owner === 'visitor', companyRequests: false, follows: false, viewed: false, preferences: false, sse: false },
    authentication: { method: 'username_password', loginEnabled: true, registrationEnabled: true, requiresInvitation: false, reason: null },
  });
  const setOwner = async owner => {
    if (owner) await context.addCookies([{ url: baseURL, name: 'fixture_owner', value: owner }]);
    else await context.clearCookies({ name: 'fixture_owner' });
  };
  await setOwner(state.owner);
  await context.addInitScript(() => {
    const NativeChannel = window.BroadcastChannel;
    window.__sentSessionMessages = [];
    window.BroadcastChannel = class extends NativeChannel {
      postMessage(value) { window.__sentSessionMessages.push({ channel: this.name, value }); return super.postMessage(value); }
    };
  });
  const respond = (route, body, status = 200, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
  await context.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.replace('/api/v1', ''), headers = request.headers();
    const owner = identity(headers), method = request.method(), body = request.postDataJSON();
    const call = { page: request.frame().page(), key: `${method} ${path}`, owner, body, headers }; calls.push(call);
    if (method === 'GET' && path === '/session') {
      const snapshot = dto(owner);
      if (call.page === holdPage) { const gate = deferred(); held.push({ route, snapshot, gate }); await gate.promise; return; }
      await respond(route, snapshot); return;
    }
    if (method !== 'GET' && headers['x-csrf-token'] !== `csrf-${owner || 'guest'}`) {
      await respond(route, { error: { code: 'csrf_invalid', message: 'Reconnect before saving.' } }, 403); return;
    }
    if (method === 'POST' && path === '/auth/login') {
      if (body.password !== 'test-only-password' || !names[body.username] || deleted.has(body.username)) {
        if (invalidLogin) { const gate = invalidLogin; invalidLogin = null; gate.started.resolve(); await gate.release.promise; }
        await respond(route, { error: { code: 'invalid_credentials', message: 'Username or password is incorrect.' } }, 401); return;
      }
      await respond(route, {}, 200, { 'Set-Cookie': `fixture_owner=${body.username}; Path=/; SameSite=Lax` }); return;
    }
    if (method === 'POST' && path === '/session/logout' || method === 'DELETE' && path === '/account') {
      if (method === 'DELETE' && body.password !== 'test-only-password') {
        await respond(route, { error: { code: 'invalid_credentials', message: 'Password is incorrect.' } }, 401); return;
      }
      if (method === 'DELETE') deleted.add(owner);
      await respond(route, {}, 200, { 'Set-Cookie': 'fixture_owner=; Path=/; Max-Age=0; SameSite=Lax' }); return;
    }
    const privatePath = path.replace(/^\/visitor/, '');
    if (['/workspace', '/searches'].includes(privatePath) || /^\/searches\//.test(privatePath)) {
      if (!owner) { await respond(route, { error: { code: 'unauthenticated', message: 'Sign in again.' } }, 401); return; }
      if (privatePath === '/workspace' && method === 'GET') { await respond(route, structuredClone(workspace(owner))); return; }
      if (privatePath === '/workspace' && method === 'PATCH') {
        const previous = workspace(owner);
        if (body.activeSearchId !== null && body.activeSearchId !== `${owner}-search`
          || Object.keys(body.drafts).some(id => id !== 'new' && id !== `${owner}-search`)) {
          await respond(route, { error: { code: 'forbidden', message: 'This workspace belongs to another account.' } }, 403); return;
        }
        if (body.expectedRevision !== previous.revision) { await respond(route, { error: { code: 'revision_conflict', message: 'Workspace changed.' } }, 409); return; }
        const next = { ...previous, revision: previous.revision + 1, state: { activeSearchId: body.activeSearchId, drafts: body.drafts } };
        workspaces.set(owner, next); await respond(route, next); return;
      }
      if (privatePath === '/searches' && method === 'GET') { await respond(route, { items: [privateSearch(owner)] }); return; }
      if (privatePath === `/searches/${owner}-search/results` && method === 'GET') {
        const items = state.deadlineKind === 'access' && state.now >= state.deadline ? [] : [privateJob(owner)];
        await respond(route, completed(items, 1, `${owner}-search`)); return;
      }
    }
    if (path === '/companies') { await respond(route, { items: [], nextCursor: null }); return; }
    await respond(route, { error: { code: 'unavailable', message: 'Unavailable in this test.' } }, 503);
  });
  return { state, calls, workspace,
    holdSessions(page) { holdPage = page; },
    async releaseSessions() {
      holdPage = null;
      // Newest authoritative response arrives first; prior generations follow afterward.
      for (const item of held.splice(0).reverse()) {
        try { await respond(item.route, item.snapshot); } catch (error) { if (!item.route.request().failure()) throw error; }
        item.gate.resolve();
      }
    },
    holdInvalidLogin() { const started = deferred(), release = deferred(); invalidLogin = { started, release }; return { started: started.promise, release: () => release.resolve() }; },
  };
}

async function openPages(context, baseURL, fixture, { clock = false } = {}) {
  const pages = [await context.newPage(), await context.newPage()];
  for (const page of pages) {
    await page.setViewportSize({ width: 1280, height: 550 });
    if (clock) { await page.clock.install({ time: new Date(START) }); await page.clock.pauseAt(new Date(START + 1000)); }
    await page.goto(baseURL);
    if (fixture.state.owner || fixture.state.deadlineKind === 'visitor') await expect(page.locator('[data-job]')).toBeVisible();
    else await expect(page.locator('#header-sign-in')).toBeVisible();
  }
  return pages;
}
async function signIn(page, username = 'beta', password = 'test-only-password') {
  await page.locator('#header-sign-in').click(); await page.locator('#auth-username').fill(username);
  await page.locator('#auth-password').fill(password); await page.locator('#auth-submit').click();
}
async function signOut(page) {
  await page.locator('#account-open').click(); await page.locator('#logout').click();
  await expect(page.locator('#header-sign-in')).toBeVisible();
}
const noInterpretation = calls => expect(calls.filter(call => /^(?:POST|PATCH) \/(?:visitor\/)?searches(?:\/|$)|\/tasks\//.test(call.key))).toEqual([]);
const resume = page => page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));

test('cross-tab logout and login clear private state, block old drafts and reject delayed session replies', async ({ context, baseURL }) => {
  const fixture = await sharedAccounts(context, baseURL);
  const [reader, account] = await openPages(context, baseURL, fixture, { clock: true });
  await reader.locator('#query').fill('Alpha private unsent draft');
  fixture.holdSessions(reader);
  const reads = fixture.calls.filter(call => call.page === reader && call.key === 'GET /session').length;
  await resume(reader);
  await expect.poll(() => fixture.calls.filter(call => call.page === reader && call.key === 'GET /session').length).toBeGreaterThan(reads);
  await signOut(account);
  await expect(reader.locator('[data-job="alpha-job"]')).not.toBeVisible();
  await signIn(account);
  await expect(account.locator('[data-job="beta-job"]')).toBeVisible();
  await reader.clock.runFor(6000);
  expect(fixture.calls.filter(call => call.owner === 'beta' && call.key === 'PATCH /workspace' && JSON.stringify(call.body).includes('Alpha private'))).toEqual([]);
  await fixture.releaseSessions();
  await expect(reader.locator('[data-job="beta-job"]')).toBeVisible();
  await expect(reader.locator('#query')).toHaveValue('Beta accepted search');
  await expect(reader.locator('[data-job="alpha-job"]')).toHaveCount(0);
  expect(JSON.stringify(fixture.workspace('beta'))).not.toContain('Alpha private');
  expect(fixture.workspace('beta').state.activeSearchId).toBe('beta-search');
  for (const page of [reader, account]) {
    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
    const signals = await page.evaluate(() => window.__sentSessionMessages);
    expect(signals.every(message => message.channel === 'justup-session' && message.value === 'invalidate')).toBe(true);
  }
  expect(await account.evaluate(() => window.__sentSessionMessages)).toHaveLength(2);
  noInterpretation(fixture.calls);
});

test('failed deletion keeps both tabs signed in, and confirmed deletion clears the other tab', async ({ context, baseURL }) => {
  const fixture = await sharedAccounts(context, baseURL);
  const [reader, account] = await openPages(context, baseURL, fixture);
  await reader.locator('#query').fill('An unsent Alpha edit');
  await account.locator('#account-open').click(); await account.locator('#delete-account').click();
  await account.locator('#delete-password').fill('incorrect'); await account.locator('#confirm-delete-account').click();
  await expect(account.locator('#delete-account-status')).toContainText('incorrect');
  await expect(reader.locator('#query')).toHaveValue('An unsent Alpha edit');
  await expect(reader.locator('[data-job="alpha-job"]')).toBeVisible();
  expect(await account.evaluate(() => window.__sentSessionMessages)).toEqual([]);
  await account.locator('#delete-password').fill('test-only-password'); await account.locator('#confirm-delete-account').click();
  await expect(reader.locator('#header-sign-in')).toBeVisible();
  await expect(reader.locator('[data-job="alpha-job"]')).toHaveCount(0);
  await expect(reader.locator('#query')).toHaveValue('');
  expect(fixture.calls.filter(call => call.key === 'DELETE /account')).toHaveLength(2);
  noInterpretation(fixture.calls);
});

test('a delayed rejected login cannot revoke the account established in another tab', async ({ context, baseURL }) => {
  const fixture = await sharedAccounts(context, baseURL, { owner: null });
  const [account, stale] = await openPages(context, baseURL, fixture);
  const rejected = fixture.holdInvalidLogin();
  await signIn(stale, 'beta', 'incorrect'); await rejected.started;
  await signIn(account, 'alpha');
  await expect(stale.locator('[data-job="alpha-job"]')).toBeVisible();
  rejected.release();
  await expect(stale.locator('#header-sign-in')).toHaveCount(0);
  await expect(stale.locator('#query')).toHaveValue('Alpha accepted search');
  expect(await stale.evaluate(() => window.__sentSessionMessages)).toEqual([]);
  noInterpretation(fixture.calls);
});

test('same-owner visibility resume preserves unsent text, focus and reading position without polling', async ({ context, baseURL }) => {
  const fixture = await sharedAccounts(context, baseURL, { now: START + 1000 });
  const [reader] = await openPages(context, baseURL, fixture, { clock: true });
  await reader.locator('#query').fill('My unsubmitted Alpha draft');
  const before = await reader.locator('#query').evaluate(input => { input.focus(); input.setSelectionRange(3, 9); scrollTo(0, 140); return { x: scrollX, y: scrollY, start: input.selectionStart, end: input.selectionEnd }; });
  const reads = fixture.calls.filter(call => call.page === reader && call.key === 'GET /session').length;
  await reader.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => fixture.calls.filter(call => call.page === reader && call.key === 'GET /session').length).toBeGreaterThan(reads);
  await expect(reader.locator('#service-notice')).toBeHidden();
  await expect(reader.locator('#query')).toHaveValue('My unsubmitted Alpha draft');
  await expect(reader.locator('#query')).toBeFocused();
  expect(await reader.locator('#query').evaluate(input => ({ x: scrollX, y: scrollY, start: input.selectionStart, end: input.selectionEnd }))).toEqual(before);
  const reconciled = fixture.calls.filter(call => call.page === reader && call.key === 'GET /session').length;
  await reader.clock.runFor(30_000);
  expect(fixture.calls.filter(call => call.page === reader && call.key === 'GET /session')).toHaveLength(reconciled);
  noInterpretation(fixture.calls);
});

for (const kind of ['session', 'visitor', 'access']) {
  test(`${kind} deadline reconciles authoritative state without an extra grace period or polling`, async ({ context, baseURL }) => {
    const fixture = await sharedAccounts(context, baseURL, { owner: kind === 'visitor' ? null : 'alpha', now: START + 1000, deadlineKind: kind, deadline: START + 11_000 });
    const [reader] = await openPages(context, baseURL, fixture, { clock: true });
    const before = fixture.calls.filter(call => call.page === reader && call.key === 'GET /session').length;
    fixture.state.now = START + 10_999;
    await reader.clock.runFor(9999);
    await expect(reader.locator(`[data-job="${kind === 'visitor' ? 'visitor' : 'alpha'}-job"]`)).toBeVisible();
    fixture.state.now = START + 11_000;
    await reader.clock.runFor(1);
    if (kind === 'access') {
      await reader.locator('#account-open').click();
      await expect(reader.locator('#account-access')).toHaveText('Your paid period has ended.');
      await expect(reader.locator('#settings-content')).toContainText('Signed in as Alpha.');
      await expect(reader.locator('[data-job="alpha-job"]')).toHaveCount(0);
    } else {
      await expect(reader.locator('#header-sign-in')).toBeVisible();
      await expect(reader.locator('[data-job]')).toHaveCount(0);
    }
    await expect.poll(() => fixture.calls.filter(call => call.page === reader && call.key === 'GET /session').length).toBeGreaterThan(before);
    const after = fixture.calls.filter(call => call.page === reader && call.key === 'GET /session').length;
    await reader.clock.runFor(30_000);
    expect(fixture.calls.filter(call => call.page === reader && call.key === 'GET /session')).toHaveLength(after);
    noInterpretation(fixture.calls);
  });
}
