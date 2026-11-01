// Owner-scoped snapshots are network fixtures, never a deployed substitute for persistence.
import { expect, test } from '@playwright/test';
import { mockApi, session, search, job, completed } from './api-fixture.mjs';
const guest = () => session({ user: null, access: { kind: 'guest', fullAccess: false, billingEnabled: false }, capabilities: { search: true, visitorSearch: true, viewed: true } });
const empty = () => ({ revision: 0, state: { activeSearchId: null, drafts: {} }, viewed: [], recoveredDrafts: [] });
const copy = value => structuredClone(value);
const visibleJob = index => ({ ...job(index), firstObserved: '2026-10-29T08:00:00.000Z' });
function stored(initial = empty()) {
  let value = copy(initial);
  return {
    read: () => copy(value),
    replace: next => { value = copy(next); },
    save: call => {
      if (call.body.expectedRevision !== value.revision) return { status: 409, body: { error: { code: 'revision_conflict', message: 'Workspace changed.' } } };
      value = { ...value, revision: value.revision + 1, state: { activeSearchId: call.body.activeSearchId, drafts: call.body.drafts } };
      return copy(value);
    },
  };
}
async function credentials(page) {
  await page.locator('#auth-username').fill('tester'); await page.locator('#auth-password').fill('test-only-password');
  await page.locator('#auth-submit').click();
}
test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1280, height: 1100 }); });

test('held hydration preserves current typing and confirmed autosave restores it after reload', async ({ page }) => {
  await page.clock.install();
  const state = stored({ ...empty(), revision: 3, state: { activeSearchId: 'search-1', drafts: { 'search-1': 'Saved refinement' } } });
  let release; const held = new Promise(resolve => { release = resolve; }); let first = true;
  const calls = await mockApi(page, {
    'GET /session': guest(), 'GET /visitor/searches': { items: [search()] },
    'GET /visitor/workspace': async () => { if (first) { first = false; await held; } return state.read(); },
    'PATCH /visitor/workspace': state.save,
  });
  await page.goto('/'); await page.locator('#query').fill('An unsent museum search'); release();
  await expect(page.getByRole('tab', { name: 'Library desk', exact: true })).toBeVisible();
  await expect(page.locator('#query')).toHaveValue('An unsent museum search');
  await page.clock.runFor(1000);
  await expect.poll(() => state.read().state.drafts.new).toBe('An unsent museum search');
  expect(state.read().state.drafts['search-1']).toBe('Saved refinement');
  await page.reload(); await expect(page.locator('#query')).toHaveValue('An unsent museum search');
  expect(calls.filter(call => /^(POST|PATCH) \/visitor\/searches/.test(call.key))).toHaveLength(0);
});

test('credentials wait for an in-flight older save and then flush the latest unsent text', async ({ page }) => {
  await page.clock.install();
  const guestState = stored(), member = stored(); let signedIn = false, writes = 0;
  let release; const held = new Promise(resolve => { release = resolve; });
  const calls = await mockApi(page, {
    'GET /session': () => signedIn ? session() : guest(),
    'GET /visitor/workspace': guestState.read, 'GET /visitor/searches': { items: [] },
    'PATCH /visitor/workspace': async call => { const reply = guestState.save(call); if (++writes === 1) await held; return reply; },
    'POST /auth/login': () => { signedIn = true; member.replace(guestState.read()); return session(); },
    'GET /workspace': member.read, 'PATCH /workspace': member.save,
  });
  await page.goto('/'); await page.locator('#query').fill('Earlier draft');
  await page.clock.runFor(1000); await expect.poll(() => writes).toBe(1);
  await page.locator('#query').fill('The latest unsent draft'); await page.locator('#header-sign-in').click(); await credentials(page);
  await expect(page.locator('#auth-submit')).toBeDisabled();
  expect(calls.filter(call => call.key === 'POST /auth/login')).toHaveLength(0);
  release(); await expect(page.locator('#header-sign-in')).toBeHidden();
  await expect(page.locator('#query')).toHaveValue('The latest unsent draft');
  expect(member.read().state.drafts.new).toBe('The latest unsent draft');
  const auth = calls.findIndex(call => call.key === 'POST /auth/login');
  const saved = calls.findIndex(call => call.key === 'PATCH /visitor/workspace' && call.body.drafts.new === 'The latest unsent draft');
  expect(saved).toBeGreaterThan(-1); expect(auth).toBeGreaterThan(saved);
  expect(calls.filter(call => /^(POST|PATCH) \/(?:visitor\/)?searches/.test(call.key))).toHaveLength(0);
});

test('sign-in reconciles a committed workspace save whose response was lost without interpreting again', async ({ page }) => {
  await page.clock.install();
  const visitor = stored({ ...empty(), revision: 1, state: { activeSearchId: 'search-1', drafts: { new: 'Another unsent draft' } } }), member = stored();
  let signedIn = false, writes = 0;
  const calls = await mockApi(page, {
    'GET /session': () => signedIn ? session() : guest(),
    'GET /visitor/searches': { items: [search()] }, 'GET /visitor/searches/search-1/results': completed([visibleJob(1)]),
    'GET /visitor/workspace': visitor.read,
    'PATCH /visitor/workspace': call => { const reply = visitor.save(call); return ++writes === 1 ? { abort: true } : reply; },
    'POST /auth/login': () => { signedIn = true; member.replace(visitor.read()); return session(); },
    'GET /searches': { items: [search()] }, 'GET /workspace': member.read, 'PATCH /workspace': member.save,
    'GET /searches/search-1/results': completed([visibleJob(1)]),
  });
  await page.goto('/'); await expect(page.locator('#query')).toHaveValue('Remote library jobs');
  await page.locator('#query').fill('Library roles without night shifts'); await page.clock.runFor(1000);
  await expect(page.locator('#workspace-sync-status')).toContainText('The service is unavailable');
  expect(visitor.read().state).toEqual({ activeSearchId: 'search-1', drafts: { new: 'Another unsent draft', 'search-1': 'Library roles without night shifts' } });
  await page.locator('#header-sign-in').click(); await credentials(page);
  await expect(page.locator('#header-sign-in')).toBeHidden();
  await expect(page.locator('#query')).toHaveValue('Library roles without night shifts');
  await expect(page.locator('#workspace-conflict')).toHaveCount(0);
  expect(member.read().state).toEqual(visitor.read().state);
  expect(calls.filter(call => call.key === 'PATCH /visitor/workspace')).toHaveLength(2);
  expect(calls.filter(call => call.key === 'POST /auth/login')).toHaveLength(1);
  expect(calls.some(call => /^(POST|PATCH) \/(?:visitor\/)?searches/.test(call.key))).toBe(false);
});

test('reconciling an earlier lost save preserves and flushes typing made while its authoritative read is held', async ({ page }) => {
  await page.clock.install();
  const visitor = stored(), member = stored(); let signedIn = false, writes = 0, reads = 0;
  let release; const held = new Promise(resolve => { release = resolve; });
  const calls = await mockApi(page, {
    'GET /session': () => signedIn ? session() : guest(), 'GET /visitor/searches': { items: [] },
    'GET /visitor/workspace': async () => { if (++reads === 2) await held; return visitor.read(); },
    'PATCH /visitor/workspace': call => { const reply = visitor.save(call); return ++writes === 1 ? { abort: true } : reply; },
    'POST /auth/login': () => { signedIn = true; member.replace(visitor.read()); return session(); },
    'GET /workspace': member.read, 'PATCH /workspace': member.save,
  });
  await page.goto('/'); await page.locator('#query').fill('An earlier unsent museum search'); await page.clock.runFor(1000);
  await expect(page.locator('#workspace-sync-status')).toContainText('The service is unavailable');
  await page.locator('#retry-workspace').click(); await expect.poll(() => reads).toBe(2);
  await page.locator('#query').fill('My latest museum search with no night shifts');
  await page.locator('#header-sign-in').click(); await credentials(page);
  await expect(page.locator('#auth-submit')).toBeDisabled();
  expect(calls.filter(call => call.key === 'POST /auth/login')).toHaveLength(0);
  release();
  await expect(page.locator('#header-sign-in')).toBeHidden();
  await expect(page.locator('#query')).toHaveValue('My latest museum search with no night shifts');
  expect(member.read().state.drafts.new).toBe('My latest museum search with no night shifts');
  const saved = calls.findIndex(call => call.key === 'PATCH /visitor/workspace' && call.body.drafts.new === 'My latest museum search with no night shifts');
  const auth = calls.findIndex(call => call.key === 'POST /auth/login');
  expect(saved).toBeGreaterThan(-1); expect(auth).toBeGreaterThan(saved);
  expect(calls.filter(call => call.key === 'PATCH /visitor/workspace')).toHaveLength(3);
  expect(calls.filter(call => call.key === 'POST /auth/login')).toHaveLength(1);
  expect(calls.some(call => /^(POST|PATCH) \/(?:visitor\/)?searches/.test(call.key))).toBe(false);
});

for (const divergence of ['draft', 'selection']) {
  test(`a lost workspace save still requires review when its remote ${divergence} differs`, async ({ page }) => {
    await page.clock.install();
    const visitor = stored({ ...empty(), revision: 1, state: { activeSearchId: 'search-1', drafts: {} } }); let writes = 0;
    const calls = await mockApi(page, {
      'GET /session': guest(), 'GET /visitor/searches': { items: [search()] }, 'GET /visitor/searches/search-1/results': completed([visibleJob(1)]),
      'GET /visitor/workspace': visitor.read,
      'PATCH /visitor/workspace': call => {
        if (++writes !== 1) return visitor.save(call);
        visitor.save(call);
        const current = visitor.read();
        visitor.replace({ ...current, revision: current.revision + 1, state: divergence === 'draft'
          ? { ...current.state, drafts: { 'search-1': 'A genuine edit in another tab' } }
          : { ...current.state, activeSearchId: null } });
        return { abort: true };
      },
    });
    await page.goto('/'); await expect(page.locator('#query')).toHaveValue('Remote library jobs');
    await page.locator('#query').fill('My latest library edit'); await page.clock.runFor(1000);
    await expect(page.locator('#workspace-sync-status')).toContainText('The service is unavailable');
    await page.locator('#header-sign-in').click(); await credentials(page);
    await expect(page.locator('#auth-status')).toContainText('Review');
    expect(calls.filter(call => call.key === 'POST /auth/login')).toHaveLength(0);
    await page.getByRole('button', { name: 'Close sign in', exact: true }).click();
    await expect(page.locator('#workspace-conflict')).toBeVisible();
    await expect(page.locator('#query')).toHaveValue('My latest library edit');
    expect(visitor.read().state.activeSearchId).toBe(divergence === 'selection' ? null : 'search-1');
    expect(visitor.read().state.drafts['search-1']).toBe(divergence === 'draft' ? 'A genuine edit in another tab' : 'My latest library edit');
    expect(calls.some(call => /^(POST|PATCH) \/(?:visitor\/)?searches/.test(call.key))).toBe(false);
  });
}

test('search handoff preserves a visitor company lead without starting discovery', async ({ page }) => {
  let signedIn = false;
  const calls = await mockApi(page, {
    'GET /session': () => signedIn ? session() : guest(),
    'POST /auth/login': () => { signedIn = true; return session(); },
  });
  await page.goto('/'); await page.locator('#query').fill('Part-time museum jobs');
  await page.getByRole('link', { name: 'Companies', exact: true }).click(); await page.getByRole('link', { name: 'Request a company +' }).click();
  await page.locator('#request-query').fill('A local museum'); await page.locator('#request-scope').fill('Education and visitor services');
  await page.getByRole('button', { name: 'Find company' }).click(); await credentials(page);
  await expect(page.locator('#sign-in-dialog')).not.toBeVisible();
  await expect(page.locator('#request-query')).toHaveValue('A local museum');
  await expect(page.locator('#request-scope')).toHaveValue('Education and visitor services');
  await page.getByRole('link', { name: 'Positions', exact: true }).click();
  await expect(page.locator('#query')).toHaveValue('Part-time museum jobs');
  expect(calls.some(call => call.key === 'POST /company-requests' || /^(POST|PATCH) \/(?:visitor\/)?searches/.test(call.key))).toBe(false);
});

for (const choice of ['local', 'saved']) {
  test(`a CAS conflict preserves unsaved text until explicit ${choice} review`, async ({ page }) => {
    const state = stored({ ...empty(), revision: 1, state: { activeSearchId: null, drafts: { new: 'Original stored draft' } } });
    let changed = false;
    const other = { ...search(), id: 'other-search', title: 'Other desk' };
    const calls = await mockApi(page, {
      'GET /session': guest(), 'GET /visitor/searches': { items: [other] }, 'GET /visitor/workspace': state.read,
      'PATCH /visitor/workspace': call => {
        if (!changed) { changed = true; state.replace({ ...empty(), revision: 2, state: { activeSearchId: null, drafts: { new: 'Changed in another tab', 'other-search': 'An unrelated saved edit' } } }); }
        return state.save(call);
      },
    });
    await page.goto('/'); await expect(page.locator('#query')).toHaveValue('Original stored draft');
    await page.locator('#query').fill('My latest unsent edit'); await page.locator('#header-sign-in').click(); await credentials(page);
    await expect(page.locator('#auth-status')).toContainText('Review');
    expect(calls.filter(call => call.key === 'POST /auth/login')).toHaveLength(0);
    await page.getByRole('button', { name: 'Close sign in', exact: true }).click();
    await expect(page.locator('#workspace-conflict')).toBeVisible();
    await expect(page.locator('#query')).toHaveValue('My latest unsent edit');
    expect(state.read().state.drafts.new).toBe('Changed in another tab');
    await page.locator(choice === 'local' ? '#keep-local-drafts' : '#use-saved-drafts').click();
    await expect(page.locator('#workspace-conflict')).toHaveCount(0);
    const expected = choice === 'local' ? 'My latest unsent edit' : 'Changed in another tab';
    await expect(page.locator('#query')).toHaveValue(expected);
    await expect.poll(() => state.read().state.drafts.new).toBe(expected);
    expect(state.read().state.drafts['other-search']).toBe('An unrelated saved edit');
  });
}

test('a remotely deleted search keeps copyable edits until explicit discard and cannot reappear in the saved copy', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copiedDraftText = text; } } });
  });
  const state = stored({ ...empty(), revision: 1, state: { activeSearchId: 'search-1', drafts: { 'search-1': 'Previously saved library edit' } } });
  const other = { ...search(), id: 'other-search', title: 'Museum desk', query: 'Museum jobs' };
  let deleted = false;
  const calls = await mockApi(page, {
    'GET /session': guest(), 'GET /visitor/workspace': state.read,
    'GET /visitor/searches': () => ({ items: deleted ? [other] : [search(), other] }),
    'GET /visitor/searches/search-1/results': completed([visibleJob(1)]),
    'GET /visitor/searches/other-search/results': completed([], 1, 'other-search'),
    'PATCH /visitor/workspace': call => {
      if (!deleted) {
        deleted = true;
        // Deletion can leave an older saved workspace reference, and ownership
        // validation rejects that reference before checking its CAS revision.
        state.replace({ ...state.read(), revision: 2, state: { activeSearchId: 'search-1', drafts: { 'search-1': 'Previously saved library edit', 'other-search': 'Saved museum edit' } } });
        return { status: 404, body: { error: { code: 'not_found', message: 'Search no longer exists.' } } };
      }
      expect(call.body.activeSearchId).not.toBe('search-1');
      expect(Object.hasOwn(call.body.drafts, 'search-1')).toBe(false);
      return state.save(call);
    },
  });
  await page.goto('/'); await expect(page.locator('#query')).toHaveValue('Previously saved library edit');
  await page.locator('#query').fill('My unsent library search without night shifts'); await page.locator('#query').blur();
  await expect(page.locator('#deleted-search-drafts')).toContainText('A search was deleted in another tab');
  await expect(page.locator('#query')).toHaveValue('My unsent library search without night shifts');
  await expect(page.locator('#keep-local-drafts')).toBeDisabled();
  await page.getByRole('button', { name: 'Copy text from Library desk', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.copiedDraftText)).toBe('My unsent library search without night shifts');
  await expect(page.locator('#deleted-search-drafts')).toContainText('Copied.');
  await page.clock.runFor(10_000);
  expect(calls.filter(call => call.key === 'PATCH /visitor/workspace')).toHaveLength(1);
  await expect(page.locator('#query')).toHaveValue('My unsent library search without night shifts');
  await expect(page.getByRole('tab', { name: 'Library desk', exact: true })).toBeVisible();
  await page.locator('#use-saved-drafts').click();
  await expect(page.locator('#workspace-conflict')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Library desk', exact: true })).toHaveCount(0);
  await page.clock.runFor(1000);
  await expect.poll(() => state.read().state.drafts['search-1']).toBeUndefined();
  expect(calls.filter(call => call.key === 'PATCH /visitor/workspace')).toHaveLength(2);
  expect(calls.some(call => /^(POST|PATCH) \/(?:visitor\/)?searches/.test(call.key))).toBe(false);
  await page.reload(); await expect(page.getByRole('tab', { name: 'Museum desk', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Library desk', exact: true })).toHaveCount(0);
});

test('a lost committed login reply restores both durable drafts and never repeats interpretation', async ({ page }) => {
  const visitor = stored(), member = stored(); let signedIn = false;
  const calls = await mockApi(page, {
    'GET /session': () => signedIn ? session() : guest(),
    'GET /visitor/workspace': visitor.read, 'PATCH /visitor/workspace': visitor.save, 'GET /visitor/searches': { items: [] },
    'POST /auth/login': () => {
      signedIn = true;
      member.replace({ ...empty(), revision: 5, state: { activeSearchId: null, drafts: { new: 'Existing member draft' } }, recoveredDrafts: [{ id: 'recovery-1', text: visitor.read().state.drafts.new, createdAt: '2026-11-01T12:00:00.000Z' }] });
      return { abort: true };
    },
    'GET /workspace': member.read, 'PATCH /workspace': member.save,
    'POST /workspace/recovered-drafts/recovery-1': call => {
      const state = member.read(); expect(call.body.expectedRevision).toBe(state.revision);
      if (call.body.action === 'use') {
        const previous = state.state.drafts.new;
        state.state.drafts.new = state.recoveredDrafts[0].text;
        state.recoveredDrafts = [{ ...state.recoveredDrafts[0], text: previous }];
      } else state.recoveredDrafts = [];
      state.revision++; member.replace(state); return state;
    },
  });
  await page.goto('/'); await page.locator('#query').fill('Visitor draft before sign-in'); await page.locator('#header-sign-in').click(); await credentials(page);
  await expect(page.locator('#header-sign-in')).toBeHidden();
  await expect(page.locator('#query')).toHaveValue('Existing member draft');
  await page.locator('#recovered-drafts summary').click();
  await expect(page.locator('#recovered-drafts')).toContainText('Visitor draft before sign-in');
  await page.getByRole('button', { name: 'Use this draft', exact: true }).click();
  await expect(page.locator('#query')).toHaveValue('Visitor draft before sign-in');
  await expect(page.locator('#recovered-drafts')).toContainText('Existing member draft');
  await page.getByRole('button', { name: 'Discard this saved draft', exact: true }).click();
  expect(calls.filter(call => call.key === 'POST /workspace/recovered-drafts/recovery-1')).toHaveLength(1);
  await page.getByRole('button', { name: 'Keep draft', exact: true }).click();
  expect(member.read().recoveredDrafts).toHaveLength(1);
  await page.getByRole('button', { name: 'Discard this saved draft', exact: true }).click(); await page.locator('#confirm-discard-draft').click();
  await expect(page.locator('#recovered-drafts')).toHaveCount(0);
  expect(calls.filter(call => call.key === 'POST /auth/login')).toHaveLength(1);
  expect(calls.some(call => /^(POST|PATCH) \/(?:visitor\/)?searches/.test(call.key))).toBe(false);
});

test('source navigation stays native when viewed sync fails, then retry persists the eye without row movement', async ({ page, context }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  const state = stored({ ...empty(), revision: 1, state: { activeSearchId: 'search-1', drafts: {} } }); let attempts = 0;
  await context.route('https://employer.test/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Employer source fixture</title>' }));
  const calls = await mockApi(page, {
    'GET /session': guest(), 'GET /visitor/searches': { items: [search()] }, 'GET /visitor/workspace': state.read, 'PATCH /visitor/workspace': state.save,
    'GET /visitor/searches/search-1/results': completed([{ ...visibleJob(1), isNew: true, locations: [], employmentTypes: [] }]),
    'POST /visitor/viewed': call => {
      expect(call.body).toEqual({ jobId: 'job-1' });
      if (++attempts === 1) return { status: 503, body: { error: { code: 'unavailable', message: 'Viewed storage unavailable.' } } };
      state.replace({ ...state.read(), viewed: [{ jobId: 'job-1', firstViewedAt: '2026-11-01T12:00:00.000Z' }] }); return { viewed: true };
    },
  });
  await page.goto('/'); await page.locator('#feed-tail').scrollIntoViewIfNeeded();
  const row = page.locator('[data-job="job-1"]'); await expect(row).toBeVisible();
  const height = await row.evaluate(node => node.getBoundingClientRect().height);
  const opened = page.waitForEvent('popup'); await row.locator('.posting-link').click(); const first = await opened;
  await expect(first).toHaveURL('https://employer.test/careers/1'); await first.close(); await page.bringToFront();
  await expect(row).toHaveClass(/viewed/); await expect(row.getByRole('img', { name: 'Viewed', exact: true })).toBeVisible();
  await expect(page.locator('#workspace-sync-status')).toContainText('not synced yet');
  expect(await row.evaluate(node => node.getBoundingClientRect().height)).toBe(height);
  const retry = page.waitForEvent('popup'); await row.locator('.posting-link').press('Enter'); const second = await retry; await second.close(); await page.bringToFront();
  await expect.poll(() => attempts).toBe(2); await expect(page.locator('#workspace-sync-status')).toBeEmpty();
  await page.reload(); await page.locator('#feed-tail').scrollIntoViewIfNeeded(); await expect(page.locator('[data-job="job-1"]')).toHaveClass(/viewed/);
  expect(calls.filter(call => call.key === 'POST /visitor/viewed')).toHaveLength(2);
});

test('visitor expiry clears old rows and offers a fresh-session reconnect without forcing account sign-in', async ({ page }) => {
  let expired = false;
  await mockApi(page, {
    'GET /session': () => guest(), 'GET /visitor/searches': () => ({ items: expired ? [] : [search()] }),
    'GET /visitor/workspace': () => expired ? empty() : { ...empty(), revision: 1, state: { activeSearchId: 'search-1', drafts: {} } },
    'GET /visitor/searches/search-1/results': () => {
      if (expired) return { status: 401, body: { error: { code: 'unauthenticated', message: 'Visitor expired.' } } };
      return completed([visibleJob(1)]);
    },
  });
  await page.goto('/'); await expect(page.locator('[data-job="job-1"]')).toBeVisible(); expired = true;
  await page.locator('#refresh-results').click(); await expect(page.locator('[data-job]')).toHaveCount(0);
  await expect(page.locator('#service-notice')).toContainText('visitor search session expired');
  await expect(page.locator('#sign-in-dialog')).not.toBeVisible(); await page.locator('#retry-session').click();
  await expect(page.locator('#job-search button[type=submit]')).toBeEnabled(); await expect(page.locator('#search-tabs [role=tab]')).toHaveCount(0);
});

test('sign-in restores transferred searches, latest draft and viewed state alongside an existing member search', async ({ page, context }) => {
  const visitor = stored(), member = stored(); let signedIn = false, transferred = false;
  const other = { ...search(1, 'Museum roles'), id: 'member-search', title: 'Museum desk' };
  await context.route('https://employer.test/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Employer source fixture</title>' }));
  const calls = await mockApi(page, {
    'GET /session': () => signedIn ? session({ access: { kind: 'member', fullAccess: true, billingEnabled: false } }) : guest(),
    'GET /visitor/searches': () => ({ items: [] }),
    'GET /visitor/workspace': visitor.read, 'PATCH /visitor/workspace': visitor.save,
    'POST /visitor/searches': { search: search() },
    'GET /visitor/searches/search-1/results': { ...completed([visibleJob(1)]), hiddenMatches: { status: 'exact', count: 2 } },
    'POST /visitor/viewed': call => { visitor.replace({ ...visitor.read(), viewed: [{ jobId: call.body.jobId, firstViewedAt: '2026-11-01T12:00:00.000Z' }] }); return { viewed: true }; },
    'POST /auth/login': () => {
      signedIn = true; transferred = true;
      member.replace({ ...visitor.read(), revision: visitor.read().revision + 1, state: { activeSearchId: 'search-1', drafts: { ...visitor.read().state.drafts, 'member-search': 'Existing private museum edit' } } });
      visitor.replace(empty()); return session();
    },
    'GET /searches': () => ({ items: [other, search()] }), 'GET /workspace': member.read, 'PATCH /workspace': member.save,
    'GET /searches/search-1/results': { ...completed([job(2), visibleJob(1)]), hiddenMatches: { status: 'exact', count: 0 } },
    'POST /session/logout': () => { signedIn = false; return {}; },
  });
  await page.goto('/'); await page.locator('#query').fill('Remote library jobs'); await page.locator('#job-search button[type=submit]').click();
  await expect(page.locator('[data-job="job-1"]')).toBeVisible();
  const opened = page.waitForEvent('popup'); await page.locator('.posting-link').click(); const source = await opened; await source.close(); await page.bringToFront();
  await page.locator('#query').fill('Remote library jobs without night shifts');
  await page.locator('#header-sign-in').click(); await credentials(page);
  await expect(page.getByRole('tab', { name: 'Museum desk', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Library desk', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#query')).toHaveValue('Remote library jobs without night shifts');
  await expect(page.locator('[data-job="job-1"]')).toHaveClass(/viewed/);
  await expect(page.locator('[data-job="job-2"]')).toBeVisible();
  await expect(page.locator('#hidden-matches')).toHaveCount(0);
  expect(member.read().state.drafts['member-search']).toBe('Existing private museum edit');
  expect(transferred).toBe(true);
  expect(calls.filter(call => call.key === 'POST /visitor/searches')).toHaveLength(1);
  expect(calls.some(call => call.key === 'POST /searches' || call.key.startsWith('PATCH /searches'))).toBe(false);
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.locator('[data-job]')).toHaveCount(0); await expect(page.locator('#query')).toHaveValue('');
  await expect(page.locator('#search-tabs [role=tab]')).toHaveCount(0);
});
