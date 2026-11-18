// Real visitor/account HTTP, SQLite and queue transitions; only local model output is synthetic.
import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { startVisitorRuntime } from '../assembled/visitor-runtime.mjs';
import { cleanupVisitorSearch, exerciseVisitorSearch, verifyVisitorHandoff } from './release-visitor.mjs';
test.use({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 1100 } });
let runtime;
test.afterEach(async () => { await runtime?.close(); runtime = undefined; });
const DAY = 86400000;
function interpretation(residual = false) {
  const fields = ['companyInclude', 'companyExclude', 'titleAny', 'bodyAll', 'bodyNone', 'locations', 'workplaces', 'employmentTypes', 'postingLanguages', 'seniority'];
  return { title: 'Engineering', configuration: { schemaVersion: 1,
    filters: { ...Object.fromEntries(fields.map(key => [key, null])), titleAny: ['engineer'] },
    residualAi: residual ? { condition: 'A documented four day working week.', requirementIds: ['week'] } : null },
    requirements: [{ id: 'role', text: 'Engineer', handling: 'primary', reason: 'Synthetic title evidence.', bindings: [{ field: 'titleAny', values: ['engineer'] }], companyReference: null },
      ...(residual ? [{ id: 'week', text: 'A documented four day working week.', handling: 'ai', reason: 'Needs posting evidence.', bindings: [], companyReference: null }] : [])] };
}
function importCohorts(at) {
  const jobs = [['assembled-engineer', 3 * DAY], ['withheld-private', DAY], ['boundary', 2 * DAY], ['too-old', 15 * DAY]].map(([id, age]) => {
    const bodyText = ('Synthetic documented four day working week with full compensation. ').repeat(5);
    return ({
    id, companyId: 'assembled', companyName: 'Assembled Company', companySlug: 'assembled', title: `Engineer ${id}`,
    sourceUrl: `https://example.org/careers/${id}`, active: true, reserved: false, hasContent: true,
    firstObserved: new Date(at - age).toISOString(), lastObserved: null, locales: ['en'], locations: [], employmentTypes: [], seniority: null,
    salary: null, bodyText, evidence: { source: 'jobseek_public', metadataFetchedAt: new Date(at).toISOString(),
      bodyFetchedAt: new Date(at).toISOString(), bodyUrl: `https://example.org/careers/${id}`, bodySha256: null, textSha256: createHash('sha256').update(bodyText).digest('hex'), bodyBytes: Buffer.byteLength(bodyText), normalizationVersion: 1, truncated: false, aiEligible: true },
  }); });
  runtime.app.store.importSnapshot({ schemaVersion: 1, snapshotAt: new Date(at - 2 * DAY).toISOString(), verifiedAt: new Date(at).toISOString(), observations: [], unknownIds: [], jobs: jobs.filter(job => job.id === 'too-old') });
  runtime.app.store.importSnapshot({ schemaVersion: 1, snapshotAt: new Date(at).toISOString(), verifiedAt: new Date(at).toISOString(), observations: [], unknownIds: [], jobs: jobs.filter(job => job.id !== 'too-old') });
}
async function submit(page, text = 'Engineer') {
  await page.locator('#query').fill(text); await page.locator('#job-search button[type=submit]').click();
}
async function login(page) {
  await page.locator('#header-sign-in').click(); await page.locator('#auth-username').fill('assembled-reader');
  await page.locator('#auth-password').fill('Synthetic-local-account-password'); await page.locator('#auth-submit').click();
  await expect(page.locator('#header-sign-in')).toBeHidden();
}
test('release visitor checks preserve a ready search and an unsent draft during registration', async ({ page }) => {
  const at = Date.now();
  runtime = await startVisitorRuntime({ now: () => at, interpretIntent: () => interpretation() });
  importCohorts(at);
  await page.goto(runtime.origin + '/fr/');
  const read = async path => {
    const response = await page.request.get(runtime.origin + path, { headers: { 'X-Justup-Locale': 'fr' } });
    return { status: response.status(), json: await response.json() };
  };
  const visitor = await exerciseVisitorSearch(page, read, {
    query: 'Engineer', sourceUrl: 'https://example.org/careers/assembled-engineer', companyId: 'assembled'
  }, () => at - 5_000);
  await page.locator('#header-sign-in').click();
  await page.locator('#auth-register').check();
  await page.locator('#auth-username').fill('release-visitor-fixture');
  await page.locator('#auth-password').fill('Synthetic-visitor-fixture-password');
  const registered = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/v1/auth/register' && response.request().method() === 'POST');
  await page.locator('#auth-submit').click();
  const response = await registered;
  expect(response.status()).toBe(201);
  await verifyVisitorHandoff(page, read, visitor, await response.json());
  expect(runtime.modelCalls()).toBe(1);
});
test('release cleanup deletes the disposable guest when the public session hides the owner', async ({ page }) => {
  const at = Date.now();
  runtime = await startVisitorRuntime({ now: () => at, interpretIntent: () => interpretation() });
  importCohorts(at);
  await page.goto(runtime.origin + '/fr/');
  await page.locator('#query').fill('Unsent disposable visitor text');
  await expect.poll(() => runtime.count('justup_visitors')).toBe(1);
  let before = true;
  const session = async () => {
    const response = await page.request.get(runtime.origin + '/api/v1/session', { headers: { 'X-Justup-Locale': 'fr' } });
    const value = await response.json();
    if (!before) return value;
    before = false;
    expect(value.visitor).not.toBeNull();
    // Match the metadata emitted under policy withdrawal. The server visitor
    // tests cover the real withdrawal and the policy-independent DELETE route.
    return { ...value, visitor: null };
  };
  await cleanupVisitorSearch(session, async csrf => {
    const response = await page.request.delete(runtime.origin + '/api/v1/visitor/session', {
      headers: { Origin: runtime.origin, 'X-CSRF-Token': csrf, 'X-Justup-Locale': 'fr' }, data: {}
    });
    return { status: response.status(), json: await response.json() };
  });
  expect(runtime.count('justup_visitors')).toBe(0);
});
test('real invalid refinement preserves accepted criteria, rows and raw text through limited-account handoff and logout', async ({ page }) => {
  const at = Date.now();
  runtime = await startVisitorRuntime({ now: () => at, interpretIntent: input => input.query.includes('invalid') ? { invalid: true } : interpretation() });
  importCohorts(at); await page.goto(runtime.origin); await submit(page); await page.locator('#feed-tail').scrollIntoViewIfNeeded();
  await expect(page.locator('[data-job="assembled-engineer"]')).toBeVisible();
  await expect(page.locator('[data-job="boundary"]')).toBeVisible();
  await expect(page.locator('#hidden-matches-title')).toHaveText('1 recent match hidden');
  await expect(page.locator('[data-job="withheld-private"], [data-job="too-old"]')).toHaveCount(0);
  const original = runtime.db.prepare('SELECT id,revision,accepted_json FROM justup_searches').get();
  const raw = '  Engineer invalid refinement keep this exact text  '; await submit(page, raw);
  await expect(page.locator('#search-status')).toContainText(/invalid|could not|failed/i);
  await expect(page.locator('[data-job="assembled-engineer"]')).toBeVisible();
  await expect(page.locator('#query')).toHaveValue(raw);
  expect(runtime.db.prepare('SELECT revision,accepted_json FROM justup_searches').get()).toEqual({ revision: original.revision, accepted_json: original.accepted_json });
  await login(page); await expect(page.locator('#query')).toHaveValue(raw);
  await expect(page.locator('#hidden-matches-title')).toHaveText('1 recent match hidden');
  const session = await (await page.request.get(runtime.origin + '/api/v1/session')).json(); expect(session.access.fullAccess).toBe(false);
  const response = await page.request.get(`${runtime.origin}/api/v1/searches/${original.id}/results?revision=1`);
  expect(response.headers()['x-robots-tag'].split(/,\s*/)).toContain('noindex'); expect(await response.text()).not.toContain('withheld-private');
  expect(runtime.modelCalls()).toBe(3);
  expect(runtime.calls.filter(call => call.method === 'POST' && call.path === '/api/v1/searches')).toHaveLength(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.locator('#query')).toHaveValue(''); await expect(page.getByRole('tab')).toHaveCount(0); await expect(page.locator('[data-job]')).toHaveCount(0);
});
for (const decision of ['accepted', 'insufficient_evidence']) test(`real hidden residual ${decision} progresses after visible exhaustion without replacing rows or interpreting again`, async ({ page }) => {
  const at = Date.now(); let release, reached;
  const held = new Promise(resolve => { release = resolve; }), arrived = new Promise(resolve => { reached = resolve; });
  runtime = await startVisitorRuntime({ now: () => at, interpretIntent: () => interpretation(true), classify: async ({ jobs }) => {
    if (jobs.some(job => job.id === 'withheld-private')) { reached(); await held; }
    return { decisions: jobs.map(job => ({ id: job.id, decision: job.id === 'withheld-private' ? decision : 'accepted' })) };
  } });
  try {
    importCohorts(at); await page.goto(runtime.origin); await submit(page, 'Engineer four day working week');
    await expect(page.locator('[data-job="assembled-engineer"]')).toBeVisible(); await arrived;
    await expect(page.locator('#hidden-matches-title')).toHaveText('Checking recent hidden matches…');
    await expect(page.locator('#feed-status')).toContainText('through the available matches');
    await page.locator('#query').fill('Unsent exact refinement  ');
    await page.locator('[data-job="assembled-engineer"]').evaluate(row => { window.heldVisitorRow = row; });
    const readsBeforeCompletion = runtime.calls.filter(call => call.path.endsWith('/results')).length;
    release();
    await expect(page.locator('#hidden-matches-title')).toHaveText(decision === 'accepted' ? '1 recent match hidden' : 'No recent hidden matches confirmed yet.', { timeout: 10_000 });
    expect(await page.locator('[data-job="assembled-engineer"]').evaluate(row => window.heldVisitorRow === row)).toBe(true);
    await expect(page.locator('#query')).toHaveValue('Unsent exact refinement  ');
    await expect(page.locator('[data-job="withheld-private"], [data-job="too-old"]')).toHaveCount(0);
    if (decision === 'insufficient_evidence') {
      await expect(page.locator('#live-status')).toContainText('Live results connected.');
      await page.waitForTimeout(6500);
      // At most one canonical read admits waiting hidden work; a healthy stream
      // then owns the stable lower bound instead of spending the fallback budget.
      expect(runtime.calls.filter(call => call.path.endsWith('/results')).length).toBeLessThanOrEqual(readsBeforeCompletion + 1);
    }
    const id = runtime.db.prepare('SELECT id FROM justup_searches').get().id;
    const result = await page.request.get(`${runtime.origin}/api/v1/visitor/searches/${id}/results?revision=1`);
    const body = await result.json(); expect(body.continuation.state).toBe('exhausted');
    expect(body.ai).toEqual({ status: 'complete' });
    expect(body.hiddenMatches).toEqual(decision === 'accepted' ? { status: 'exact', count: 1 } : { status: 'lower_bound', count: 0 });
    expect(JSON.stringify(body)).not.toContain('withheld-private'); expect(runtime.modelCalls()).toBe(1);

  } finally { release(); }
});

const visibleCheckOutcomes = [
  { decision: 'mixed', status: 'insufficient_evidence', state: 'exhausted', visible: true,
    message: 'Some positions lacked enough evidence to confirm a match.' },
  { decision: 'insufficient_evidence', status: 'insufficient_evidence', state: 'exhausted', visible: false,
    message: 'Some positions lacked enough evidence to confirm a match.' },
  { decision: 'rejected', status: 'complete', state: 'exhausted', visible: false,
    message: 'No matches in the available listings.' },
  { decision: 'outage', status: 'provider_unavailable', state: 'paused', visible: false,
    message: 'Search paused. There may be more matches.' },
];

for (const outcome of visibleCheckOutcomes) test(`visible residual ${outcome.decision} renders its own outcome after pending`, async ({ page }) => {
  const at = Date.now();
  let markStarted, release;
  const started = new Promise(resolve => { markStarted = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  runtime = await startVisitorRuntime({ now: () => at, interpretIntent: () => interpretation(true), classify: async ({ jobs }) => {
    const visible = jobs.some(job => job.id === 'assembled-engineer' || job.id === 'boundary');
    if (visible) {
      markStarted();
      await held;
      if (outcome.decision === 'outage') throw new Error('Synthetic provider outage');
    }
    const decision = visible ? outcome.decision : 'rejected';
    return { decisions: jobs.map(job => {
      if (decision !== 'mixed') return { id: job.id, decision };
      return { id: job.id, decision: job.id === 'assembled-engineer' ? 'accepted' : 'insufficient_evidence' };
    }) };
  } });
  try {
    importCohorts(at);
    await page.goto(runtime.origin);
    const query = 'Engineer four day working week';
    await submit(page, query);
    await started;
    const status = page.locator('#feed-status');
    await expect(page.locator('#live-status')).toContainText('Live results connected.');
    await expect(status).toContainText('Still checking for matching positions…');
    await expect(page.locator('[data-job]')).toHaveCount(0);
    release();
    await expect(status).toContainText(outcome.message, { timeout: 10_000 });
    await expect(status).toContainText('Search coverage is limited.');
    await expect(page.locator('[data-job]')).toHaveCount(outcome.visible ? 1 : 0);
    if (outcome.visible) await expect(page.locator('[data-job="assembled-engineer"]')).toBeVisible();
    if (outcome.state === 'paused') await expect(page.locator('#resume-results')).toBeVisible();
    await expect(page.locator('#query')).toHaveValue(query);
    const search = runtime.db.prepare('SELECT id,revision FROM justup_searches').get();
    const response = await page.request.get(`${runtime.origin}/api/v1/visitor/searches/${search.id}/results?revision=${search.revision}`);
    expect(response.status()).toBe(200);
    const result = await response.json();
    expect(result.ai).toEqual({ status: outcome.status });
    expect(result.coverage).toMatchObject({ stale: false, state: 'limited_coverage' });
    expect(result.continuation.state).toBe(outcome.state);
    expect(result.items.map(job => job.id)).toEqual(outcome.visible ? ['assembled-engineer'] : []);
    expect(JSON.stringify(result)).not.toMatch(/withheld-private|bodyText|Synthetic provider outage/);
    expect(runtime.modelCalls()).toBe(1);
  } finally { release(); }
});

for (const kind of ['interpretation', 'classification']) test(`shutdown cancels an unreleased synthetic ${kind} callback before storage closes`, async ({ page }) => {
  const at = Date.now(); let reached, deadline;
  const arrived = new Promise(resolve => { reached = resolve; });
  const never = () => { reached(); return new Promise(() => {}); };
  runtime = await startVisitorRuntime({ now: () => at,
    interpretIntent: kind === 'interpretation' ? never : () => interpretation(true),
    ...(kind === 'classification' ? { classify: never } : {}),
  });
  importCohorts(at); await page.goto(runtime.origin); await submit(page); await arrived;
  try {
    await Promise.race([runtime.close(), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Synthetic callback stranded fixture shutdown')), 2000); })]);
    await runtime.close();
  } finally { clearTimeout(deadline); }
});
