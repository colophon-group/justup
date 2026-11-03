// These synthetic public DTOs stay outside the compiled application and exercise explicit visitor ownership.
import { expect, test } from '@playwright/test';
import { mockApi, session, search, job, completed, task, proposal } from './api-fixture.mjs';
const visitor = () => session({ user: null, access: { kind: 'guest', fullAccess: false, billingEnabled: false }, capabilities: { search: true, visitorSearch: true, viewed: true, companyRequests: false } });
const freezeClock = async page => { await page.clock.install({ time: new Date('2026-11-02T08:00:00Z') }); await page.clock.pauseAt(new Date('2026-11-02T08:01:00Z')); };
const visibleJob = index => ({ ...job(index), firstObserved: '2026-10-29T08:00:00.000Z' });
const submit = async (page, query) => { await page.locator('#query').fill(query); await page.locator('#job-search button[type=submit]').click(); };
test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1280, height: 1100 }); });

test('a visitor interprets their own search and sees delayed matches without opening account sign-in', async ({ page }) => {
  const calls = await mockApi(page, {
    'GET /session': visitor(), 'GET /visitor/searches': { items: [] },
    'POST /visitor/searches': { httpStatus: 202, body: { search: { ...search(0), status: 'pending' }, task: task('visitor-task') } },
    'GET /visitor/tasks/visitor-task': task('visitor-task', 'succeeded', { search: search() }),
    'GET /visitor/searches/search-1/results': { ...completed([visibleJob(1)]), hiddenMatches: { status: 'exact', count: 7 } },
  });
  await page.goto('/'); await submit(page, 'Remote library jobs');
  // Result admission follows the real viewport after the options/control area.
  await page.locator('#feed-tail').scrollIntoViewIfNeeded();
  await expect(page.locator('[data-job="job-1"]')).toBeVisible();
  await expect(page.locator('#hidden-matches-title')).toHaveText('7 recent matches hidden');
  await expect(page.locator('#query')).toHaveValue('Remote library jobs');
  await expect(page.locator('#sign-in-dialog')).not.toBeVisible();
  expect(calls.some(call => ['GET /searches', 'POST /searches', 'GET /tasks/visitor-task'].includes(call.key))).toBe(false);
  const create = calls.find(call => call.key === 'POST /visitor/searches');
  expect(Object.keys(create.body).sort()).toEqual(['query', 'requestKey']);
  expect(create.headers['x-csrf-token']).toBe('test-only-csrf');
});

test('visitor refinements keep accepted rows until their exact warning is confirmed', async ({ page }) => {
  const query = 'Remote library jobs with visa support';
  const calls = await mockApi(page, {
    'GET /session': visitor(), 'GET /visitor/searches': { items: [search()] },
    'PATCH /visitor/searches/search-1': { search: search(), task: task('visitor-warning') },
    'GET /visitor/tasks/visitor-warning': task('visitor-warning', 'warning', { proposal: proposal({ query, message: 'Visa support is not verified.' }) }),
    'POST /visitor/searches/search-1/confirm': { search: search(2, query) },
    'GET /visitor/searches/search-1/results': call => {
      const revision = Number(call.url.searchParams.get('revision'));
      return { ...completed([visibleJob(revision)], revision), hiddenMatches: { status: 'lower_bound', count: 2 } };
    },
  });
  await page.goto('/'); await page.locator('#feed-tail').scrollIntoViewIfNeeded(); await expect(page.locator('[data-job="job-1"]')).toBeVisible();
  await submit(page, query); await expect(page.locator('#confirm-search-proposal')).toBeVisible();
  await expect(page.locator('[data-job="job-1"]')).toBeVisible();
  await expect(page.locator('#hidden-matches-title')).toHaveText('At least 2 recent matches hidden');
  await expect(page.locator('#sign-in-dialog')).not.toBeVisible();
  await page.locator('#confirm-search-proposal').click();
  await page.locator('#feed-tail').scrollIntoViewIfNeeded();
  await expect(page.locator('[data-job="job-2"]')).toBeVisible();
  await expect(page.locator('[data-job="job-1"]')).toHaveCount(0);
  expect(calls.find(call => call.key === 'PATCH /visitor/searches/search-1').body.expectedRevision).toBe(1);
  expect(calls.filter(call => call.key === 'POST /visitor/searches/search-1/confirm')).toHaveLength(1);
  expect(calls.some(call => /^POST \/auth\//.test(call.key))).toBe(false);
});

test('a visitor interpretation limit preserves the accepted search and unsent edit', async ({ page }) => {
  const calls = await mockApi(page, {
    'GET /session': visitor(), 'GET /visitor/searches': { items: [search()] },
    'GET /visitor/searches/search-1/results': completed([visibleJob(1)]),
    'PATCH /visitor/searches/search-1': { status: 429, body: { error: { code: 'task_limit', message: 'Your visitor search limit has been reached.' } } },
  });
  await page.goto('/'); await page.locator('#feed-tail').scrollIntoViewIfNeeded(); await expect(page.locator('[data-job="job-1"]')).toBeVisible();
  await submit(page, 'Library jobs without night shifts');
  await expect(page.locator('#search-status')).toContainText('visitor search limit');
  await expect(page.locator('#search-status')).toContainText('last accepted revision');
  await expect(page.locator('#query')).toHaveValue('Library jobs without night shifts');
  await expect(page.locator('[data-job="job-1"]')).toBeVisible();
  await expect(page.locator('#sign-in-dialog')).not.toBeVisible();
  await expect(page.locator('#visitor-sign-in')).toBeVisible();
  expect(calls.filter(call => call.key === 'PATCH /visitor/searches/search-1')).toHaveLength(1);
});

test('a shared request-rate pause never suggests that signing in bypasses it', async ({ page }) => {
  await mockApi(page, {
    'GET /session': visitor(), 'GET /visitor/searches': { items: [search()] },
    'GET /visitor/searches/search-1/results': completed([visibleJob(1)]),
    'PATCH /visitor/searches/search-1': { status: 429, body: { error: { code: 'rate_limit', message: 'Please wait before trying again.' } } },
  });
  await page.goto('/'); await page.locator('#feed-tail').scrollIntoViewIfNeeded(); await expect(page.locator('[data-job="job-1"]')).toBeVisible();
  await submit(page, 'Library jobs without night shifts');
  await expect(page.locator('#search-status')).toContainText('Please wait');
  await expect(page.locator('#visitor-sign-in')).toHaveCount(0);
});

test('restored warnings require explicit confirmation without restarting interpretation', async ({ page }) => {
  const query = 'Remote library jobs with visa support';
  const warned = proposal({ query, message: 'Visa support could not be verified.' });
  let workspace = { revision: 3, state: { activeSearchId: 'search-1', drafts: { 'search-1': query } }, viewed: [], recoveredDrafts: [] };
  const calls = await mockApi(page, {
    'GET /session': visitor(), 'GET /visitor/searches': { items: [{ ...search(), draft: { query, status: 'interrupted' }, proposal: warned }] },
    'GET /visitor/workspace': () => workspace,
    'PATCH /visitor/workspace': call => { expect(call.body.expectedRevision).toBe(workspace.revision); workspace = { ...workspace, revision: workspace.revision + 1, state: { activeSearchId: call.body.activeSearchId, drafts: call.body.drafts } }; return workspace; },
    'GET /visitor/searches/search-1/results': call => completed([visibleJob(Number(call.url.searchParams.get('revision')))], Number(call.url.searchParams.get('revision'))),
    'POST /visitor/searches/search-1/confirm': { search: search(2, query) },
  });
  await page.goto('/'); await expect(page.locator('#confirm-search-proposal')).toBeVisible(); await page.locator('#feed-tail').scrollIntoViewIfNeeded();
  await expect(page.locator('#query')).toHaveValue(query);
  await expect(page.locator('[data-job="job-1"]')).toBeVisible();
  expect(calls.some(call => call.key === 'POST /visitor/searches' || call.key === 'PATCH /visitor/searches/search-1' || call.key.startsWith('GET /visitor/tasks'))).toBe(false);
  await page.locator('#confirm-search-proposal').click(); await expect(page.locator('[data-job="job-2"]')).toBeVisible();
  expect(calls.find(call => call.key === 'POST /visitor/searches/search-1/confirm').body).toEqual({ proposalId: 'proposal-1', expectedRevision: 1 });
});

test('restoring a pending search resumes its existing task instead of spending another interpretation', async ({ page }) => {
  let workspace = { revision: 1, state: { activeSearchId: 'search-1', drafts: { 'search-1': 'Remote library jobs' } }, viewed: [], recoveredDrafts: [] };
  const calls = await mockApi(page, {
    'GET /session': visitor(),
    'GET /visitor/searches': { items: [{ ...search(0), status: 'pending', draft: { query: 'Remote library jobs', taskId: 'restored-task' } }] },
    'GET /visitor/workspace': () => workspace,
    'PATCH /visitor/workspace': call => { workspace = { ...workspace, revision: workspace.revision + 1, state: { activeSearchId: call.body.activeSearchId, drafts: call.body.drafts } }; return workspace; },
    'GET /visitor/tasks/restored-task': task('restored-task', 'succeeded', { search: search() }),
    'GET /visitor/searches/search-1/results': completed([visibleJob(1)]),
  });
  await page.goto('/'); await page.locator('#feed-tail').scrollIntoViewIfNeeded(); await expect(page.locator('[data-job="job-1"]')).toBeVisible();
  expect(calls.filter(call => call.key === 'GET /visitor/tasks/restored-task')).toHaveLength(1);
  expect(calls.some(call => call.key === 'POST /visitor/searches' || call.key === 'PATCH /visitor/searches/search-1')).toBe(false);
});

test('an interrupted handoff stays an unsent edit until the user explicitly retries', async ({ page }) => {
  const query = 'Remote library jobs without night shifts';
  let workspace = { revision: 1, state: { activeSearchId: 'search-1', drafts: { 'search-1': query } }, viewed: [], recoveredDrafts: [] };
  const calls = await mockApi(page, {
    'GET /session': visitor(),
    'GET /visitor/searches': { items: [{ ...search(), draft: { query, taskId: null, status: 'interrupted' } }] },
    'GET /visitor/workspace': () => workspace,
    'PATCH /visitor/workspace': call => { workspace = { ...workspace, revision: workspace.revision + 1, state: { activeSearchId: call.body.activeSearchId, drafts: call.body.drafts } }; return workspace; },
    'PATCH /visitor/searches/search-1': { search: search(2, query) },
    'GET /visitor/searches/search-1/results': call => completed([visibleJob(Number(call.url.searchParams.get('revision')))], Number(call.url.searchParams.get('revision'))),
  });
  await page.goto('/'); await expect(page.locator('#search-status')).toContainText('interrupted');
  await expect(page.locator('#query')).toHaveValue(query); await page.locator('#feed-tail').scrollIntoViewIfNeeded(); await expect(page.locator('[data-job="job-1"]')).toBeVisible();
  expect(calls.some(call => /^(POST|PATCH) \/visitor\/searches/.test(call.key) || call.key.startsWith('GET /visitor/tasks/'))).toBe(false);
  await page.locator('#job-search button[type=submit]').click(); await page.locator('#feed-tail').scrollIntoViewIfNeeded(); await expect(page.locator('[data-job="job-2"]')).toBeVisible();
  expect(calls.filter(call => call.key === 'PATCH /visitor/searches/search-1')).toHaveLength(1);
});

test('a failed restored task can be retried explicitly without repeatedly polling its terminal result', async ({ page }) => {
  let workspace = { revision: 1, state: { activeSearchId: 'search-1', drafts: { 'search-1': 'Remote library jobs' } }, viewed: [], recoveredDrafts: [] };
  const calls = await mockApi(page, {
    'GET /session': visitor(),
    'GET /visitor/searches': { items: [{ ...search(0), status: 'pending', draft: { query: 'Remote library jobs', taskId: 'failed-task' } }] },
    'GET /visitor/workspace': () => workspace,
    'PATCH /visitor/workspace': call => { workspace = { ...workspace, revision: workspace.revision + 1, state: { activeSearchId: call.body.activeSearchId, drafts: call.body.drafts } }; return workspace; },
    'GET /visitor/tasks/failed-task': { ...task('failed-task', 'failed'), error: { code: 'provider_unavailable', message: 'Interpretation is unavailable.', retryable: true } },
    'PATCH /visitor/searches/search-1': { search: search() },
    'GET /visitor/searches/search-1/results': completed([visibleJob(1)]),
  });
  await page.goto('/'); await expect(page.locator('#search-status')).toContainText('Interpretation is unavailable');
  await page.locator('#job-search button[type=submit]').click(); await page.locator('#feed-tail').scrollIntoViewIfNeeded(); await expect(page.locator('[data-job="job-1"]')).toBeVisible();
  expect(calls.filter(call => call.key === 'GET /visitor/tasks/failed-task')).toHaveLength(1);
  expect(calls.filter(call => call.key === 'PATCH /visitor/searches/search-1')).toHaveLength(1);
});

test('hidden refresh preserves loaded rows and pagination, pauses for dialogs and stops at its retry budget', async ({ page }) => {
  await freezeClock(page); let reads = 0, release;
  const held = new Promise(resolve => { release = resolve; });
  const title = count => count === 1 ? 'At least 1 recent match hidden' : `At least ${count} recent matches hidden`;
  const calls = await mockApi(page, {
    'GET /session': visitor(), 'GET /visitor/searches': { items: [search()] },
    'GET /visitor/searches/search-1/results': async () => {
      const read = ++reads;
      if (read === 3) await held;
      return { ...completed([visibleJob(read === 1 ? 1 : 2)]), hiddenMatches: { status: 'lower_bound', count: read - 1 } };
    },
  });
  try {
    await page.goto('/'); await page.locator('#feed-tail').scrollIntoViewIfNeeded(); await expect(page.locator('[data-job="job-1"]')).toBeVisible();
    await page.locator('[data-job="job-1"]').evaluate(row => { window.originalHiddenRow = row; });
    await page.locator('#header-sign-in').click(); await page.clock.runFor(10_000);
    expect(reads).toBe(1); await page.keyboard.press('Escape');
    await page.locator('#posting-languages').click(); await expect(page.locator('#posting-language-dialog')).toBeVisible();
    await page.clock.runFor(10_000); expect(reads).toBe(1); await page.keyboard.press('Escape');
    for (let count = 2; count <= 31; count++) {
      const response = page.waitForResponse(response => response.url().includes('/visitor/searches/search-1/results'));
      await page.clock.runFor(2000); await expect.poll(() => reads).toBe(count);
      if (count === 3) {
        // Route entry does not acknowledge consumption. Another timer tick must
        // skip this deliberately held response without consuming another read.
        await page.clock.runFor(2000); expect(reads).toBe(3);
        await expect(page.locator('#hidden-matches-title')).toHaveText(title(1));
        release();
      }
      await (await response).finished();
      // A unique confirmed lower bound acknowledges application publication,
      // including its in-flight cleanup, before advancing the next timer tick.
      await expect(page.locator('#hidden-matches-title')).toHaveText(title(count - 1));
    }
    await page.clock.runFor(10_000); expect(reads).toBe(31);
    await expect(page.locator('[data-job="job-2"]')).toHaveCount(0);
    expect(await page.locator('[data-job="job-1"]').evaluate(row => window.originalHiddenRow === row)).toBe(true);
    await page.locator('#query').fill('Exact unsent text  '); await expect(page.locator('#query')).toHaveValue('Exact unsent text  ');
    expect(calls.filter(call => /^(POST|PATCH) \/visitor\/searches/.test(call.key))).toHaveLength(0);
    const refresh = page.waitForResponse(response => response.url().includes('/visitor/searches/search-1/results'));
    await page.locator('#refresh-results').click(); await (await refresh).finished();
    await page.clock.runFor(120); await expect(page.locator('#hidden-matches-title')).toHaveText(title(31));
    await expect(page.locator('#refresh-results')).toBeEnabled(); expect(reads).toBe(32);
    const resumed = page.waitForResponse(response => response.url().includes('/visitor/searches/search-1/results'));
    await page.clock.runFor(2000); await (await resumed).finished();
    await expect(page.locator('#hidden-matches-title')).toHaveText(title(32)); expect(reads).toBe(33);
  } finally { release(); }
});

test('a failed hidden metadata read keeps rows, reports unavailable and waits for explicit recovery', async ({ page }) => {
  await freezeClock(page); let reads = 0;
  await mockApi(page, {
    'GET /session': visitor(), 'GET /visitor/searches': { items: [search()] },
    'GET /visitor/searches/search-1/results': () => ++reads === 2 ? { abort: true } : { ...completed([visibleJob(1)]), hiddenMatches: reads === 1 ? { status: 'pending', count: null } : { status: 'exact', count: 0 } },
  });
  await page.goto('/'); await expect(page.locator('[data-job="job-1"]')).toBeVisible();
  await page.clock.runFor(2000); await expect(page.locator('#hidden-matches-title')).toHaveText('The recent hidden-match count is unavailable.');
  await expect(page.locator('[data-job="job-1"]')).toBeVisible();
  await page.clock.runFor(10_000); expect(reads).toBe(2);
  const recovered = page.waitForResponse(response => response.url().includes('/visitor/searches/search-1/results'));
  await page.locator('#retry-results').click(); await (await recovered).finished(); await page.evaluate(() => {});
  await page.clock.runFor(120); await expect(page.locator('#hidden-matches')).toHaveCount(0);
  expect(reads).toBe(3); await expect(page.locator('[data-job="job-1"]')).toBeVisible();
});

test('a held hidden metadata reply waits for pointer release and settling without an SSE frame', async ({ page }) => {
  await page.clock.install(); let reads = 0, release, reached;
  const held = new Promise(resolve => { release = resolve; }), arrived = new Promise(resolve => { reached = resolve; });
  await mockApi(page, {
    'GET /session': visitor(), 'GET /visitor/searches': { items: [search()] },
    'GET /visitor/searches/search-1/results': async () => {
      if (++reads === 2) { reached(); await held; }
      return { ...completed([visibleJob(1)]), hiddenMatches: reads === 1 ? { status: 'pending', count: null } : { status: 'exact', count: 0 } };
    },
  });
  try {
    await page.goto('/'); await expect(page.locator('[data-job="job-1"]')).toBeVisible();
    await page.clock.runFor(2200); await arrived;
    await page.locator('[data-job="job-1"]').evaluate(row => {
      row.scrollIntoView({ block: 'start' }); row.querySelector('.posting-link').focus({ preventScroll: true });
      window.hiddenAnchor = { row, top: row.getBoundingClientRect().top, link: document.activeElement };
      document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    release(); await page.waitForLoadState('networkidle');
    await expect(page.locator('#hidden-matches-title')).toHaveText('Checking recent hidden matches…');
    await page.clock.runFor(2000); await expect(page.locator('#hidden-matches')).toBeVisible();
    await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })));
    await expect(page.locator('#hidden-matches')).toBeVisible();
    await page.clock.runFor(120); await expect(page.locator('#hidden-matches')).toHaveCount(0);
    const anchor = await page.evaluate(() => ({ same: window.hiddenAnchor.row === document.querySelector('[data-job="job-1"]'), focus: window.hiddenAnchor.link === document.activeElement,
      offset: Math.abs(window.hiddenAnchor.row.getBoundingClientRect().top - window.hiddenAnchor.top) }));
    expect(anchor.same).toBe(true); expect(anchor.focus).toBe(true);
    // Native scrolling rounds fractional line-box removal to a device pixel.
    expect(anchor.offset).toBeLessThan(1);
  } finally { release(); }
});

test('keyboard opening the language picker stages an in-flight hidden reply until the dialog closes', async ({ page }) => {
  await freezeClock(page); let reads = 0, release, reached;
  const held = new Promise(resolve => { release = resolve; }), arrived = new Promise(resolve => { reached = resolve; });
  await mockApi(page, {
    'GET /session': visitor(), 'GET /visitor/searches': { items: [search()] },
    'GET /visitor/searches/search-1/results': async () => {
      if (++reads === 2) { reached(); await held; }
      return { ...completed([visibleJob(1)]), hiddenMatches: reads === 1 ? { status: 'pending', count: null } : { status: 'exact', count: 0 } };
    },
  });
  try {
    await page.goto('/'); await expect(page.locator('[data-job="job-1"]')).toBeVisible();
    await page.clock.runFor(2000); await arrived;
    await page.locator('#posting-languages').focus(); await page.locator('#posting-languages').press('Enter');
    await expect(page.locator('#posting-language-dialog')).toBeVisible();
    release(); await page.waitForLoadState('networkidle'); await page.clock.runFor(2000);
    await expect(page.locator('#hidden-matches-title')).toHaveText('Checking recent hidden matches…');
    await page.keyboard.press('Escape'); await page.clock.runFor(120);
    await expect(page.locator('#hidden-matches')).toHaveCount(0);
    await expect(page.locator('[data-job="job-1"]')).toBeVisible(); expect(reads).toBe(2);
  } finally { release(); }
});

test('same-owner resume keeps interrupted hidden reads metadata-only and within the original budget after multiple pages', async ({ page }) => {
  await freezeClock(page); let reads = 0, metadataStarted = false, releaseMetadata, releaseSession, reachedSession;
  const metadata = new Promise(resolve => { releaseMetadata = resolve; }), sessionHeld = new Promise(resolve => { releaseSession = resolve; });
  const sessionStarted = new Promise(resolve => { reachedSession = resolve; }); let sessionReads = 0;
  const calls = await mockApi(page, {
    'GET /session': async () => { if (++sessionReads === 2) { reachedSession(); await sessionHeld; } return visitor(); },
    'GET /visitor/searches': { items: [search()] },
    'GET /visitor/searches/search-1/results': async call => {
      reads++;
      if (reads === 3) { metadataStarted = true; await metadata; }
      const second = call.url.searchParams.get('cursor') === 'page-2';
      return { ...completed(second ? [visibleJob(13), visibleJob(14)] : reads > 2 ? [visibleJob(999)] : Array.from({ length: 12 }, (_, index) => visibleJob(index + 1))),
        continuation: { state: second ? 'exhausted' : 'open', cursor: second ? null : 'page-2', retryAfterMs: null }, hiddenMatches: { status: 'lower_bound', count: 0 } };
    },
  });
  try {
    await page.goto('/'); await expect(page.locator('[data-job="job-1"]')).toBeVisible();
    for (let attempt = 0; attempt < 24 && !metadataStarted; attempt++) {
      await page.locator('#feed-tail').scrollIntoViewIfNeeded(); await page.clock.runFor(500); await page.evaluate(() => {});
    }
    await expect.poll(() => metadataStarted).toBe(true);
    expect(calls.filter(call => call.key.endsWith('/results') && call.url.searchParams.get('cursor') === 'page-2')).toHaveLength(1);
    await page.evaluate(() => { window.metadataRows = [...document.querySelectorAll('[data-job]')]; window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
    await sessionStarted; releaseMetadata(); releaseSession();
    await expect(page.locator('#query')).toBeEditable(); await expect(page.locator('[data-job="job-1"]')).toBeVisible();
    expect(reads).toBe(3);
    for (let count = 4; count <= 32; count++) {
      const response = page.waitForResponse(response => response.url().includes('/visitor/searches/search-1/results'));
      await page.clock.runFor(2000); await (await response).finished(); await page.evaluate(() => {});
      expect(reads).toBe(count);
    }
    await page.clock.runFor(10_000); expect(reads).toBe(32);
    await expect(page.locator('#feed-status')).toContainText('through the available matches');
    await expect(page.locator('#feed-status')).not.toContainText('cursor'); await expect(page.locator('[data-job="job-999"]')).toHaveCount(0);
    expect(await page.evaluate(() => window.metadataRows.every(row => row === document.querySelector(`[data-job="${row.dataset.job}"]`)))).toBe(true);
    expect(calls.filter(call => /^(POST|PATCH) \/visitor\/searches/.test(call.key))).toHaveLength(0);
  } finally { releaseMetadata(); releaseSession(); }
});
