// Real visitor/account HTTP, SQLite and queue transitions; only local model output is synthetic.
import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { startVisitorRuntime } from '../assembled/visitor-runtime.mjs';
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
test('real invalid refinement preserves accepted criteria, rows and raw text through limited-account handoff and logout', async ({ page }) => {
  const at = Date.now();
  runtime = await startVisitorRuntime({ now: () => at, interpretIntent: input => input.query.includes('invalid') ? { invalid: true } : interpretation() });
  importCohorts(at); await page.goto(runtime.origin); await submit(page);
  await expect(page.locator('[data-job="assembled-engineer"]')).toBeVisible();
  await expect(page.locator('[data-job="boundary"]')).toBeVisible();
  await expect(page.locator('#hidden-matches-title')).toHaveText('1 recent match hidden');
  await expect(page.locator('[data-job="withheld-private"], [data-job="too-old"]')).toHaveCount(0);
  const original = runtime.db.prepare('SELECT id,revision,accepted_json FROM justup_searches').get();
  const raw = '  Engineer invalid refinement\nkeep this exact text  '; await submit(page, raw);
  await expect(page.locator('#search-status')).toContainText(/invalid|could not|failed/i);
  await expect(page.locator('[data-job="assembled-engineer"]')).toBeVisible();
  await expect(page.locator('#query')).toHaveValue(raw);
  expect(runtime.db.prepare('SELECT revision,accepted_json FROM justup_searches').get()).toEqual({ revision: original.revision, accepted_json: original.accepted_json });
  await login(page); await expect(page.locator('#query')).toHaveValue(raw);
  await expect(page.locator('#hidden-matches-title')).toHaveText('1 recent match hidden');
  const session = await (await page.request.get(runtime.origin + '/api/v1/session')).json(); expect(session.access.fullAccess).toBe(false);
  const response = await page.request.get(`${runtime.origin}/api/v1/searches/${original.id}/results?revision=1`);
  expect(response.headers()['x-robots-tag']).toBe('noindex'); expect(await response.text()).not.toContain('withheld-private');
  expect(runtime.modelCalls()).toBe(2);
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
    release();
    await expect(page.locator('#hidden-matches-title')).toHaveText(decision === 'accepted' ? '1 recent match hidden' : 'No recent hidden matches confirmed yet.', { timeout: 10_000 });
    expect(await page.locator('[data-job="assembled-engineer"]').evaluate(row => window.heldVisitorRow === row)).toBe(true);
    await expect(page.locator('#query')).toHaveValue('Unsent exact refinement  ');
    await expect(page.locator('[data-job="withheld-private"], [data-job="too-old"]')).toHaveCount(0);
    const id = runtime.db.prepare('SELECT id FROM justup_searches').get().id;
    const result = await page.request.get(`${runtime.origin}/api/v1/visitor/searches/${id}/results?revision=1`);
    const body = await result.json(); expect(body.continuation.state).toBe('exhausted');
    expect(body.hiddenMatches).toEqual(decision === 'accepted' ? { status: 'exact', count: 1 } : { status: 'lower_bound', count: 0 });
    expect(JSON.stringify(body)).not.toContain('withheld-private'); expect(runtime.modelCalls()).toBe(1);
  } finally { release(); }
});
