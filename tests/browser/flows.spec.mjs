import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { mockApi, search, job, session, company, completed, task, proposal, companyRequest } from './api-fixture.mjs';
const submit = async (page, query = 'Remote library jobs') => { await page.locator('#query').fill(query); await page.locator('#job-search button[type=submit]').click(); };
const capture = async (page, name) => {
  const directory = process.env.JUSTUP_CAPTURE_DIR;
  if (!directory) return;
  if (!isAbsolute(directory)) throw new Error('JUSTUP_CAPTURE_DIR must be an absolute review-artifact directory.');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: join(directory, name + '.png'), fullPage: false });
};
const saved = { 'GET /searches': { items: [search()] }, 'GET /searches/search-1/results': completed() };
test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1280, height: 1100 }); });

test('accepted server searches show actual source links and warnings without a generated summary', async ({ page }) => {
  const calls = await mockApi(page, saved); await page.goto('/');
  await expect(page.locator('#query')).toHaveValue('Remote library jobs'); await expect(page.locator('[data-job]')).toHaveCount(1); await expect(page.locator('#feed-status')).toContainText('available matches');
  await expect(page.locator('#search-accounting')).toContainText('Salary evidence'); await expect(page.locator('body')).not.toContainText('Metadata only');
  await expect(page.locator('.posting-link')).toHaveAttribute('href', 'https://employer.test/careers/1'); await capture(page, 'desktop-results');
  await page.locator('.job-company').click(); await expect(page.getByRole('heading', { name: 'Test Library', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '← Back to search' })).toBeVisible(); await capture(page, 'desktop-company-report'); expect(calls.some(call => call.key.includes('/viewed/'))).toBe(false);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
});

test('202 task success accepts one revision; failed edits preserve accepted rows and the unsent query', async ({ page }) => {
  const calls = await mockApi(page, { 'POST /searches': { httpStatus: 202, body: { search: { ...search(0), status: 'pending' }, task: task('task-1') } }, 'GET /tasks/task-1': task('task-1', 'succeeded', { search: search() }), 'PATCH /searches/search-1': { status: 422, body: { error: { code: 'unsupported_requirement', message: 'This requirement cannot be checked.' } } }, 'GET /searches/search-1/results': completed() });
  await page.goto('/'); await submit(page); await expect(page.locator('[data-job]')).toHaveCount(1);
  await submit(page, 'Remote library jobs, predict my future manager'); await expect(page.locator('#search-status')).toContainText('last accepted revision');
  await expect(page.locator('#query')).toHaveValue('Remote library jobs, predict my future manager'); await expect(page.locator('#feed')).toContainText('Librarian 1');
  const create = calls.find(call => call.key === 'POST /searches'); expect(create.headers['x-csrf-token']).toBe('test-only-csrf'); expect(create.body.requestKey).toBeTruthy();
  expect(calls.find(call => call.key.startsWith('PATCH /searches')).body.expectedRevision).toBe(1);
});

test('unavailable API produces an explicit failure and no sample fallback', async ({ page }) => {
  await mockApi(page, { 'GET /session': { status: 503, body: { error: { code: 'unavailable', message: 'Search service unavailable.' } } } }); await page.goto('/');
  await expect(page.locator('#service-notice')).toContainText('Search service unavailable.'); await expect(page.locator('#job-search button[type=submit]')).toBeDisabled(); await expect(page.locator('[data-job]')).toHaveCount(0);
});

test('visitor search prompts real credentials without creating an anonymous model request', async ({ page }) => {
  const calls = await mockApi(page, { 'GET /session': session({ user: null, access: { kind: 'guest', fullAccess: false, billingEnabled: false } }) }); await page.goto('/'); await capture(page, 'desktop-landing'); await submit(page, 'Part-time museum work');
  await expect(page.locator('#sign-in-dialog')).toBeVisible(); await expect(page.locator('#query')).toHaveValue('Part-time museum work');
  expect(calls.some(call => call.key === 'POST /searches' || call.key === 'GET /searches')).toBe(false);
  await expect(page.locator('#sign-in-dialog a[href="/privacy.html"]')).toBeVisible();
});

test('credentials are policy-gated; rejected login preserves the visitor draft and clears password/invite', async ({ page }) => {
  const calls = await mockApi(page, { 'GET /session': session({ user: null }), 'POST /auth/login': { status: 401, body: { error: { code: 'invalid_credentials', message: 'Username or password is incorrect.' } } } }); await page.goto('/'); await submit(page, 'Garden jobs');
  await page.locator('#auth-username').fill('reader'); await page.locator('#auth-password').fill('test-only-password'); await page.locator('#auth-submit').click();
  await expect(page.locator('#auth-status')).toContainText('incorrect'); await expect(page.locator('#auth-password')).toHaveValue(''); await expect(page.locator('#query')).toHaveValue('Garden jobs');
  expect(calls.find(call => call.key === 'POST /auth/login').body).toEqual({ username: 'reader', password: 'test-only-password' }); expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
});

test('unreviewed static policies keep registration and login disabled', async ({ page }) => {
  await mockApi(page, { 'GET /session': session({ user: null, policies: {locale:'en',reviewedLocale:null,fallback:false, reviewed: false, version: 'product-draft-4', privacyUrl: null, usageUrl: null } }) }); await page.goto('/'); await page.locator('#header-sign-in').click();
  await expect(page.locator('#sign-in-unavailable')).toContainText('being reviewed'); await expect(page.locator('#sign-in-form')).toBeHidden();
});

test('unfinished zero-yield pages continue, while failed matching never becomes a clean empty search', async ({ page }) => {
  let batches = 0;
  await mockApi(page, { ...saved, 'GET /searches/search-1/results': () => ++batches === 1 ? { searchId: 'search-1', revision: 1, items: [], continuation: { state: 'pending', cursor: 'next', retryAfterMs: 450 }, ai: { status: 'pending' } } : { searchId: 'search-1', revision: 1, items: [], continuation: { state: 'failed', cursor: 'resume', retryAfterMs: null }, ai: { status: 'failed' } } }); await page.goto('/');
  await expect(page.locator('#feed-status')).toContainText('Still checking'); await page.locator('#feed-tail').scrollIntoViewIfNeeded();
  await expect(page.locator('#feed-status')).toContainText('Requirement checks failed'); await expect(page.locator('#feed-status')).not.toContainText('No matching positions');
});

test('offscreen rows remain buffered until scrolling, then reveal individually at 450ms pacing', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 550 }); await mockApi(page, { ...saved, 'GET /searches/search-1/results': completed(Array.from({ length: 16 }, (_, index) => job(index))) }); await page.goto('/');
  await expect(page.locator('#search-results')).toBeVisible(); await page.waitForTimeout(800); expect(await page.locator('[data-job]').count()).toBe(0);
  await page.locator('#feed-tail').scrollIntoViewIfNeeded(); await expect.poll(() => page.locator('[data-job]').count()).toBeGreaterThan(0);
  await page.evaluate(() => scrollTo(0, 0)); await page.waitForTimeout(550); const stopped = await page.locator('[data-job]').count(); await page.waitForTimeout(700); expect(await page.locator('[data-job]').count()).toBe(stopped); expect(stopped).toBeLessThan(16);
});

test('stale result requests cannot overwrite a newer accepted revision', async ({ page }) => {
  let release; const wait = new Promise(resolve => { release = resolve; });
  await mockApi(page, { ...saved, 'PATCH /searches/search-1': { search: search(2, 'Garden jobs') }, 'GET /searches/search-1/results': async call => { if (call.url.searchParams.get('revision') === '1') { await wait; return completed([job(1)]); } return completed([{ ...job(2), title: 'Gardener' }], 2); } }); await page.goto('/'); await expect(page.locator('#query')).toHaveValue('Remote library jobs'); await submit(page, 'Garden jobs'); await expect(page.locator('#feed')).toContainText('Gardener'); release(); await expect(page.locator('#feed')).not.toContainText('Librarian 1');
});

test('a warned proposal keeps old results until its exact limitations are explicitly confirmed', async ({ page }) => {
  let confirmations = 0;
  const calls = await mockApi(page, { ...saved, 'PATCH /searches/search-1': { search: search(), task: task('warning-task') }, 'GET /tasks/warning-task': task('warning-task', 'warning', { proposal: proposal({ message: 'Visa support cannot be verified.', warnings: [{ code: 'unverified_visa', message: 'Visa requirement would remain unverified.' }] }) }), 'POST /searches/search-1/confirm': () => ++confirmations === 1 ? { status: 503, body: { error: { code: 'dependency_unavailable', message: 'Confirmation is temporarily unavailable.' } } } : { search: search(2, 'Library jobs, visa support preferred') }, 'GET /searches/search-1/results': call => completed([job(1)], Number(call.url.searchParams.get('revision'))) });
  await page.goto('/'); await expect(page.locator('[data-job]')).toHaveCount(1); await submit(page, 'Library jobs with visa support');
  await expect(page.locator('#search-status')).toContainText('needs your decision'); expect(calls.some(call => call.key.endsWith('/confirm'))).toBe(false); await expect(page.locator('#feed')).toContainText('Librarian 1');
  await page.locator('#confirm-search-proposal').click(); await expect(page.locator('#search-status')).toContainText('temporarily unavailable'); await expect(page.locator('#feed')).toContainText('Librarian 1');
  await page.locator('#confirm-search-proposal').click(); await expect(page.locator('#search-status')).toContainText('confirmed limitations');
  const attempts = calls.filter(call => call.key.endsWith('/confirm')); expect(attempts).toHaveLength(2); expect(attempts[0].body).toEqual({ proposalId: 'proposal-1', expectedRevision: 1 }); expect(attempts[1].body).toEqual(attempts[0].body); expect(attempts[1].headers['idempotency-key']).toBe(attempts[0].headers['idempotency-key']);
});

test('request clarification and acceptance bind the exact preview revision', async ({ page }) => {
  let attempts = 0;
  const longName = 'Test Library — ' + 'InternationalCouncil'.repeat(6);
  const layouts = [];
  const measureLayout = async stage => {
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: width === 375 ? 800 : 1100 });
      const layout = await page.locator('#request-content').evaluate((element, stage) => {
        const content = element.getBoundingClientRect(), field = element.querySelector('.query-field'), heading = element.querySelector('.candidate-heading h2');
        return { stage, viewport: innerWidth, document: document.documentElement.scrollWidth, contentRight: content.right, fieldRight: field?.getBoundingClientRect().right ?? null, headingRight: heading?.getBoundingClientRect().right ?? null };
      }, stage);
      layouts.push(layout);
      if (process.env.JUSTUP_CAPTURE_DIR) { await mkdir(process.env.JUSTUP_CAPTURE_DIR, { recursive: true }); await writeFile(join(process.env.JUSTUP_CAPTURE_DIR, 'request-layout.json'), JSON.stringify(layouts, null, 2)); }
      expect(layout.document, `${stage} document at ${width}px`).toBeLessThanOrEqual(width);
      if (layout.fieldRight !== null) expect(layout.fieldRight, `${stage} field at ${width}px`).toBeLessThanOrEqual(layout.contentRight + 1);
      if (layout.headingRight !== null) expect(layout.headingRight, `${stage} heading at ${width}px`).toBeLessThanOrEqual(layout.contentRight + 1);
    }
    await page.setViewportSize({ width: 1280, height: 1100 });
  };
  const calls = await mockApi(page, { 'POST /company-requests': () => ({ request: ++attempts === 1 ? companyRequest({ status: 'clarification', clarification: 'Which library?' }) : companyRequest({ id: 'request-2', input: 'Library, London', previewRevision: 4, candidate: { ...company, name: longName } }) }), 'POST /company-requests/request-2/accept': { request: companyRequest({ id: 'request-2', status: 'accepted', company }) } }); await page.goto('/#request'); await page.locator('#request-query').fill('Library'); await page.getByRole('button', { name: 'Find company' }).click();
  await expect(page.getByText('Which library?', { exact: true })).toBeVisible(); await measureLayout('clarification'); await capture(page, 'desktop-request'); await page.locator('#company-clarification').fill('London'); await page.getByRole('button', { name: 'Continue ↗' }).click();
  await expect(page.getByRole('heading', { name: longName, exact: true })).toBeVisible(); await measureLayout('candidate');
  await page.getByRole('button', { name: 'Yes, that’s the one ↗' }).click(); await expect(page.getByRole('heading', { name: 'On the record.' })).toBeVisible();
  const accept = calls.find(call => call.key.endsWith('/accept')); expect(accept.body).toEqual({ candidateId: 'library', previewRevision: 4 }); expect(accept.headers['idempotency-key']).toBeTruthy(); expect(calls.find(call => call.key === 'POST /company-requests').body.input).toBe('Library');
});

test('password-confirmed deletion sends no request before confirmation and clears private state', async ({ page }) => {
  let deleted = false; const calls = await mockApi(page, { ...saved, 'GET /session': () => session({ user: deleted ? null : { id: 'reader', username: 'tester' } }), 'DELETE /account': call => { expect(call.body.password).toBe('test-only-password'); deleted = true; return {}; } }); await page.goto('/'); await expect(page.locator('[data-job]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('button', { name: 'Delete account', exact: true }).click(); expect(calls.some(call => call.key === 'DELETE /account')).toBe(false);
  await page.locator('#delete-password').fill('test-only-password'); await page.locator('#confirm-delete-account').click(); await expect(page.locator('[data-job]')).toHaveCount(0); await expect(page.locator('#header-sign-in')).toBeVisible(); await expect(page.locator('#settings-content')).not.toContainText('Signed in as tester'); await expect(page.locator('#settings-dialog')).not.toBeVisible(); await expect(page.locator('#auth-username')).toHaveValue('');
});

test('401 expiry clears private state and rejects a late request preview from the prior session', async ({ page }) => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  await mockApi(page, { ...saved, 'POST /company-requests': async () => { await pending; return { request: companyRequest({ id: 'old', candidate: { ...company, name: 'Private old preview' } }) }; }, 'POST /session/logout': { status: 401, body: { error: { code: 'session_expired', message: 'Your session expired.' } } } }); await page.goto('/'); await expect(page.locator('[data-job]')).toHaveCount(1);
  await page.goto('/#request'); await page.locator('#request-query').fill('Old lead'); await page.getByRole('button', { name: 'Find company' }).click(); await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(page.locator('#sign-in-dialog')).toBeVisible(); release(); await page.waitForTimeout(100); await expect(page.locator('body')).not.toContainText('Private old preview'); await expect(page.locator('[data-job]')).toHaveCount(0); await expect(page.locator('#search-tabs [role=tab]')).toHaveCount(0);
});

test('inactive deletion and tab changes preserve per-search drafts without reloading active results', async ({ page }) => {
  const other = { ...search(), id: 'search-2', title: 'Garden desk', query: 'Garden jobs' }; const calls = await mockApi(page, { ...saved, 'GET /searches': { items: [search(), other] }, 'GET /searches/search-2/results': completed([job(2)], 1, 'search-2'), 'DELETE /searches/search-2': {} }); await page.goto('/'); await expect(page.getByRole('tab', { name: 'Library desk' })).toHaveAttribute('aria-selected', 'true'); await expect(page.locator('#query')).toHaveValue('Remote library jobs'); await page.locator('#query').fill('Unsent library draft'); await page.getByRole('tab', { name: 'Garden desk' }).click(); await page.locator('#query').fill('Unsent garden draft'); await page.getByRole('tab', { name: 'Library desk' }).click(); await expect(page.locator('#query')).toHaveValue('Unsent library draft'); const before = calls.filter(call => call.key === 'GET /searches/search-1/results').length;
  await page.getByRole('button', { name: 'Delete Garden desk' }).click(); await page.locator('#confirm-delete-search').click(); await expect(page.getByRole('tab', { name: 'Garden desk' })).toHaveCount(0); await expect(page.locator('#query')).toHaveValue('Unsent library draft'); expect(calls.filter(call => call.key === 'GET /searches/search-1/results').length).toBe(before);
});

test('unsafe source URLs cause an explicit contract error and optional surfaces stay unavailable', async ({ page }) => {
  await mockApi(page, { ...saved, 'GET /searches/search-1/results': completed([{ ...job(1), sourceUrl: 'javascript:alert(1)' }]) }); await page.goto('/'); await expect(page.locator('#feed-status')).toContainText('invalid position source URL'); await expect(page.locator('[data-job]')).toHaveCount(0); await expect(page.locator('#followed-only')).toBeHidden(); await expect(page.locator('.search-config [data-posting-languages]')).toBeHidden(); await expect(page.locator('#hiring-wire')).toBeHidden();
});

test('an incorrect deletion password keeps the account and accepted results intact', async ({ page }) => {
  await mockApi(page, { ...saved, 'DELETE /account': { status: 401, body: { error: { code: 'invalid_credentials', message: 'Password is incorrect.' } } } }); await page.goto('/'); await expect(page.locator('[data-job]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('button', { name: 'Delete account', exact: true }).click(); await page.locator('#delete-password').fill('incorrect-test-password'); await page.locator('#confirm-delete-account').click();
  await expect(page.locator('#delete-account-status')).toContainText('incorrect'); await expect(page.locator('[data-job]')).toHaveCount(1); await expect(page.locator('#sign-in-dialog')).not.toBeVisible(); await expect(page.locator('#delete-password')).toHaveValue('');
});

test('a pending company task resumes after polling failure without a duplicate submission', async ({ page }) => {
  let attempts = 0; const calls = await mockApi(page, { 'POST /company-requests': { httpStatus: 202, body: { request: companyRequest({ status: 'pending' }), task: task('company-task', 'pending', null, 'company_resolution') } }, 'GET /tasks/company-task': () => ++attempts === 1 ? { status: 503, body: { error: { code: 'unavailable', message: 'Task service unavailable.' } } } : task('company-task', 'succeeded', { request: companyRequest() }, 'company_resolution') });
  await page.goto('/#request'); await page.locator('#request-query').fill('Library'); await page.getByRole('button', { name: 'Find company' }).click(); await expect(page.locator('#request-status')).toContainText('Task service unavailable'); await page.getByRole('button', { name: 'Check again', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Test Library' })).toBeVisible(); expect(calls.filter(call => call.key === 'POST /company-requests')).toHaveLength(1);
});

test('editing a warned query invalidates its old confirmation action', async ({ page }) => {
  await mockApi(page, { ...saved, 'PATCH /searches/search-1': { search: search(), task: task('warning-task') }, 'GET /tasks/warning-task': task('warning-task', 'warning', { proposal: proposal({ message: 'Cannot check this.' }) }) }); await page.goto('/'); await submit(page, 'Warned request'); await expect(page.locator('#confirm-search-proposal')).toBeVisible(); await page.locator('#query').fill('A different query'); await expect(page.locator('#confirm-search-proposal')).toHaveCount(0);
});

test('an older save finishing cannot release the busy state of a newer tab submission', async ({ page }) => {
  let finishOld, finishNew;
  const oldResponse = new Promise(resolve => { finishOld = resolve; }), newResponse = new Promise(resolve => { finishNew = resolve; });
  const second = { ...search(), id: 'search-2', title: 'Garden desk', query: 'Garden jobs' };
  await mockApi(page, { ...saved, 'GET /searches': { items: [search(), second] }, 'GET /searches/search-2/results': completed([job(2)], 1, 'search-2'), 'PATCH /searches/search-1': async () => { await oldResponse; return { search: search(2, 'Old changed request') }; }, 'PATCH /searches/search-2': async () => { await newResponse; return { search: { ...second, revision: 2, query: 'New changed request' } }; } });
  await page.goto('/'); await submit(page, 'Old changed request'); await page.getByRole('tab', { name: 'Garden desk' }).click(); await submit(page, 'New changed request');
  await expect(page.locator('#job-search button[type=submit]')).toBeDisabled(); finishOld(); await page.waitForTimeout(100); await expect(page.locator('#job-search button[type=submit]')).toBeDisabled();
  finishNew(); await expect(page.locator('#job-search button[type=submit]')).toBeEnabled(); await expect(page.locator('#query')).toHaveValue('New changed request');
});

test('configured authentication availability is enforced independently of reviewed policies', async ({ page }) => {
  await mockApi(page, { 'GET /session': session({ user: null, authentication: { method: 'username_password', loginEnabled: false, registrationEnabled: false, reason: 'deletion_unavailable' } }) }); await page.goto('/'); await page.locator('#header-sign-in').click(); await expect(page.locator('#sign-in-form')).toBeHidden(); await expect(page.locator('#sign-in-unavailable')).toContainText('unavailable right now');
});

test('guest company submission prompts sign-in without a model POST or clearing either draft', async ({ page }) => {
  const calls = await mockApi(page, { 'GET /session': session({ user: null, capabilities: { search: false, companyRequests: true } }) });
  await page.goto('/'); await expect(page.locator('#job-search button[type=submit]')).toBeEnabled(); await page.locator('#query').fill('Part-time museum jobs');
  await page.getByRole('link', { name: 'Companies', exact: true }).click(); await page.getByRole('link', { name: 'Request a company +' }).click();
  await page.locator('#request-query').fill('A local museum'); await page.getByRole('button', { name: 'Find company' }).click();
  await expect(page.locator('#sign-in-dialog')).toBeVisible(); await expect(page.locator('#request-query')).toHaveValue('A local museum'); await expect(page.locator('#query')).toHaveValue('Part-time museum jobs');
  expect(calls.some(call => call.key === 'POST /company-requests')).toBe(false); await expect(page.locator('#service-notice')).toBeHidden(); await expect(page.locator('#search-status')).not.toContainText('expired');
});

for (const surface of ['positions', 'companies']) {
  test(`short mobile ${surface} list stays empty below the fold until its real slot is visible`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 420 });
    const items = Array.from({ length: 10 }, (_, index) => ({ ...company, id: `company-${index}`, name: `Library ${index}` }));
    await mockApi(page, { ...saved, 'GET /companies': { items }, 'GET /searches/search-1/results': completed(Array.from({ length: 10 }, (_, index) => job(index))) });
    const isJobs = surface === 'positions', rows = isJobs ? '#feed [data-job]' : '#company-list [data-company]', tail = isJobs ? '#feed-tail' : '#company-tail';
    await page.goto(isJobs ? '/' : '/#companies');
    await expect(page.locator(isJobs ? '#feed-status' : '#company-scroll-status')).toContainText(isJobs ? 'Still checking' : 'More from the directory');
    await expect.poll(() => page.locator(tail).evaluate(element => element.getBoundingClientRect().top)).toBeGreaterThan(420);
    await page.waitForTimeout(600); await expect(page.locator(rows)).toHaveCount(0);
    await page.locator(tail).scrollIntoViewIfNeeded(); await expect.poll(() => page.locator(rows).count()).toBeGreaterThan(0); await capture(page, 'mobile-' + surface);
    await page.evaluate(() => scrollTo(0, 0)); await page.waitForTimeout(500); const stopped = await page.locator(rows).count();
    await page.waitForTimeout(600); expect(await page.locator(rows).count()).toBe(stopped); expect(stopped).toBeLessThan(10);
  });
}

test('initial fills measure wrapped row geometry instead of assuming a fixed row height', async ({ page }) => {
  const tallTitle = 'Long role title with detailed responsibilities '.repeat(18);
  const tallDescription = 'Imported company description with several lines of public evidence. '.repeat(25);
  await mockApi(page, { ...saved, 'GET /searches/search-1/results': completed(Array.from({ length: 12 }, (_, index) => ({ ...job(index), title: tallTitle + index }))), 'GET /companies': { items: Array.from({ length: 12 }, (_, index) => ({ ...company, id: `company-${index}`, description: tallDescription })) } });
  for (const [route, rows] of [['/', '#feed [data-job]'], ['/#companies', '#company-list [data-company]']]) {
    await page.goto(route); await expect.poll(() => page.locator(rows).count()).toBeGreaterThan(0); await page.waitForTimeout(550);
    const tops = await page.locator(rows).evaluateAll(elements => elements.map(element => element.getBoundingClientRect().top));
    expect(tops.every(top => top < 1100)).toBe(true); expect(tops.length).toBeLessThan(12);
  }
});

test('logout and deletion mutations send the JSON object required by the HTTP boundary', async ({ page }) => {
  let signedOut = false;
  const calls = await mockApi(page, { ...saved, 'GET /session': () => session({ user: signedOut ? null : { id: 'reader', username: 'tester' } }), 'DELETE /searches/search-1': { deleted: true }, 'POST /company-requests': { request: companyRequest() }, 'DELETE /company-requests/request-1': { deleted: true }, 'POST /session/logout': () => { signedOut = true; return {}; } });
  await page.goto('/'); await expect(page.getByRole('tab', { name: 'Library desk' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete Library desk' }).click(); await page.locator('#confirm-delete-search').click(); await expect(page.getByRole('tab', { name: 'Library desk' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Companies', exact: true }).click(); await page.getByRole('link', { name: 'Request a company +' }).click(); await page.locator('#request-query').fill('Library'); await page.getByRole('button', { name: 'Find company' }).click(); await page.getByRole('button', { name: 'Not this company' }).click(); await expect(page.locator('#request-query')).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(page.locator('#header-sign-in')).toBeVisible();
  for (const key of ['DELETE /searches/search-1', 'DELETE /company-requests/request-1', 'POST /session/logout']) {
    const call = calls.find(item => item.key === key); expect(call, key).toBeTruthy(); expect(call.headers['content-type']).toBe('application/json'); expect(call.body).toEqual({}); expect(call.headers['x-csrf-token']).toBe('test-only-csrf');
  }
});

test('reported salary ranges retain their currency, bounds and disclosed period while unknown pay is omitted', async ({ page }) => {
  const cases = [
    { salary: { min: 80000, max: 110000, currency: 'USD', period: 'year' }, expected: 'USD 80,000–110,000 / year' },
    { salary: { min: 6000, max: null, currency: 'CHF', period: 'month' }, expected: 'From CHF 6,000 / month' },
    { salary: { min: null, max: 45.5, currency: 'EUR', period: 'hour' }, expected: 'Up to EUR 45.5 / hour' },
    { salary: { min: 300000, max: null, currency: 'JPY', period: null }, expected: 'From JPY 300,000' },
    { salary: { min: 400, max: 500, currency: 'GBP', period: 'fortnight' }, expected: 'GBP 400–500 / fortnight' },
    { salary: null, expected: null },
    { salary: { min: null, max: null, currency: 'USD', period: 'year' }, expected: null },
  ];
  await page.setViewportSize({ width: 1280, height: 2400 }); await mockApi(page, { ...saved, 'GET /searches/search-1/results': completed(cases.map((item, index) => ({ ...job(index), salary: item.salary }))) }); await page.goto('/');
  for (const [index, item] of cases.entries()) {
    const row = page.locator(`[data-job="job-${index}"]`); await expect(row).toBeVisible();
    if (item.expected) await expect(row.locator('.job-salary')).toHaveText('¤ ' + item.expected);
    else { await expect(row.locator('.job-salary')).toHaveCount(0); await expect(row).not.toContainText('Salary not listed'); }
  }
});

test('company-request submission capability does not advertise an unsupported requested catalogue filter', async ({ page }) => {
  await mockApi(page); await page.goto('/#companies'); await expect(page.locator('#companies-page')).toBeVisible(); await expect(page.locator('#company-list [data-company]')).toHaveCount(1); await expect(page.locator('#company-scroll-status')).toContainText('That’s the directory so far.');
  await expect(page.locator('[data-status=requested]')).toBeHidden(); await expect(page.getByRole('link', { name: 'Request a company +' })).toBeVisible(); await capture(page, 'desktop-companies');
  await page.getByRole('link', { name: 'Request a company +' }).click(); await expect(page.getByRole('button', { name: 'Find company' })).toBeEnabled();
});

for (const registration of [false, true]) {
  test(`successful ${registration ? 'registration' : 'login'} retains the visitor draft and uses the refreshed server CSRF`, async ({ page }) => {
    let signedIn = false;
    const draft = 'Part-time museum work';
    const accountSession = () => session({ user: signedIn ? { id: 'reader', username: 'tester' } : null, csrfToken: signedIn ? 'fresh-account-csrf' : 'test-only-csrf' });
    const authPath = registration ? 'POST /auth/register' : 'POST /auth/login';
    const calls = await mockApi(page, {
      'GET /session': accountSession,
      [authPath]: () => { signedIn = true; return accountSession(); },
      'POST /searches': { search: search(1, draft) },
      'GET /searches/search-1/results': completed(),
      'POST /session/logout': () => { signedIn = false; return {}; },
    });
    await page.goto('/'); await submit(page, draft); await expect(page.locator('#sign-in-dialog')).toBeVisible();
    await page.locator('#auth-username').fill('tester'); await page.locator('#auth-password').fill('test-only-password');
    if (registration) { await page.locator('#auth-register').check(); await page.locator('#auth-invite').fill('test-only-invite'); }
    await page.locator('#auth-submit').click();
    await expect(page.locator('#sign-in-dialog')).not.toBeVisible(); await expect(page.locator('#header-sign-in')).toBeHidden(); await expect(page.locator('#query')).toHaveValue(draft);
    expect(calls.filter(call => call.key === 'POST /searches')).toHaveLength(0);
    await page.locator('#job-search button[type=submit]').click(); await expect(page.locator('[data-job]')).toHaveCount(1);
    const create = calls.find(call => call.key === 'POST /searches'); expect(create.headers['x-csrf-token']).toBe('fresh-account-csrf'); expect(create.body.query).toBe(draft);
    const credentials = calls.find(call => call.key === authPath).body;
    expect(credentials).toEqual({ username: 'tester', password: 'test-only-password', ...(registration ? { inviteCode: 'test-only-invite' } : {}) });
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.locator('#header-sign-in')).toBeVisible(); await expect(page.locator('[data-job]')).toHaveCount(0); await expect(page.getByRole('tab', { name: 'Library desk' })).toHaveCount(0); await expect(page.locator('#query')).toHaveValue(''); await expect(page.locator('#auth-username')).toHaveValue('');
  });
}

test('closing a pending sign-in dialog prevents its late completion from refreshing account state', async ({ page }) => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const calls = await mockApi(page, { 'GET /session': session({ user: null }), 'POST /auth/login': async () => { await pending; return session(); } });
  await page.goto('/'); await submit(page, 'A visitor draft');
  await page.locator('#auth-username').fill('tester'); await page.locator('#auth-password').fill('test-only-password'); await page.locator('#auth-submit').click();
  await expect.poll(() => calls.filter(call => call.key === 'POST /auth/login').length).toBe(1);
  await page.getByRole('button', { name: 'Close sign in', exact: true }).click(); release();
  await page.waitForTimeout(200); await expect(page.locator('#sign-in-dialog')).not.toBeVisible(); await expect(page.locator('#header-sign-in')).toBeVisible(); await expect(page.locator('#query')).toHaveValue('A visitor draft');
  expect(calls.filter(call => call.key === 'GET /session')).toHaveLength(1);
});

test('settings can open deletion confirmation and Escape restores a useful account control', async ({ page }) => {
  await mockApi(page); await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await expect(page.locator('#settings-dialog')).toBeVisible(); await capture(page, 'desktop-settings');
  await page.getByRole('button', { name: 'Delete account', exact: true }).click();
  await expect(page.locator('#delete-account-dialog')).toBeVisible(); await expect(page.locator('#settings-dialog')).not.toBeVisible(); await capture(page, 'desktop-delete-confirmation');
  await page.keyboard.press('Escape'); await expect(page.locator('#delete-account-dialog')).not.toBeVisible(); await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
});

test('skip navigation focuses content and search tabs support keyboard changes without resubmitting drafts', async ({ page }) => {
  const other = { ...search(), id: 'search-2', title: 'Garden desk', query: 'Garden jobs' };
  const calls = await mockApi(page, { ...saved, 'GET /searches': { items: [search(), other] }, 'GET /searches/search-2/results': completed([job(2)], 1, 'search-2') });
  await page.goto('/'); await expect(page.getByRole('tab', { name: 'Library desk' })).toBeVisible();
  await page.keyboard.press('Tab'); await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused(); await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused(); await expect(page).not.toHaveURL(/#main$/);
  const library = page.getByRole('tab', { name: 'Library desk' }), garden = page.getByRole('tab', { name: 'Garden desk' });
  await library.focus(); await page.keyboard.press('ArrowRight'); await expect(garden).toBeFocused(); await expect(garden).toHaveAttribute('aria-selected', 'true'); await expect(page.locator('#query')).toHaveValue('Garden jobs');
  await page.locator('#query').fill('Unsubmitted garden draft'); await garden.focus(); await page.keyboard.press('Home'); await expect(library).toBeFocused();
  await page.keyboard.press('End'); await expect(garden).toBeFocused(); await expect(page.locator('#query')).toHaveValue('Unsubmitted garden draft');
  expect(calls.some(call => call.key === 'POST /searches' || call.key.startsWith('PATCH /searches/'))).toBe(false);
  await page.getByRole('link', { name: 'Companies', exact: true }).click(); await page.getByRole('link', { name: 'Skip to content' }).focus(); await page.keyboard.press('Enter'); await expect(page.locator('#main')).toBeFocused(); await expect(page).toHaveURL(/#companies$/);
});
