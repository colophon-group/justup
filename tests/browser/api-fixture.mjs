// Test-only minimal v1 contract fixtures. Never included in the deployed static tree.
export const search = (revision = 1, query = 'Remote library jobs') => ({ id: 'search-1', revision, query, title: 'Library desk', description: 'Metadata only; not a visible summary.', configuration: {}, status: 'ready', requirements: [{ text: 'Remote work', handling: 'primary' }, { text: 'No night shifts', handling: 'residual_ai' }], warnings: [{ code: 'incomplete_salary_evidence', message: 'Salary evidence is not available for every posting.' }] });
export const company = { id: 'library', name: 'Test Library', description: 'A test-only public library.', coverage: { state: 'imported_snapshot' }, sources: [{ url: 'https://employer.test/careers' }] };
export const job = index => ({ id: `job-${index}`, title: `Librarian ${index}`, company, sourceUrl: `https://employer.test/careers/${index}`, firstObserved: '2026-10-31T08:00:00Z', locations: [{ name: 'London', workplace: 'remote' }], employmentTypes: ['full_time'], postingLanguages: ['en'], salary: null });
export const session = (overrides = {}) => ({ user: { id: 'reader', username: 'tester' }, csrfToken: 'test-only-csrf', access: { kind: 'account', fullAccess: true, billingEnabled: false, legacy: false, until: null }, capabilities: { search: true, companyRequests: true, follows: false, viewed: false, preferences: false, sse: false, hiddenMatchCounts: false }, authentication: { method: 'username_password', loginEnabled: true, registrationEnabled: true, reason: null }, policies: { locale:'en', reviewedLocale:'en', fallback:false, reviewed: true, version: 'test-v1', privacyUrl: '/privacy.html', usageUrl: '/usage.html' }, coverage: { kind: 'imported_snapshot', verifiedAt: '2026-10-31T08:00:00Z', stale: false }, ...overrides });
export const completed = (items = [job(1)], revision = 1, searchId = 'search-1') => ({ searchId, revision, items, continuation: { state: 'exhausted', cursor: null, retryAfterMs: null }, ai: { status: 'not_required' } });
export const task = (id, status = 'pending', result = null, kind = 'search_intent') => ({ id, kind, status, createdAt: '2026-10-31T08:00:00Z', updatedAt: '2026-10-31T08:00:01Z', result, error: null });
export const proposal = (overrides = {}) => ({ proposalId: 'proposal-1', searchId: 'search-1', expectedRevision: 1, query: 'Library jobs with visa support', title: 'Library desk', configuration: { schemaVersion: 1, filters: {}, residualAi: null }, requirements: [], warnings: [], ...overrides });
export const companyRequest = (overrides = {}) => {
  const status = overrides.status || 'candidate';
  return { id: 'request-1', input: 'Library', scope: null, status, candidate: status === 'candidate' || status === 'accepted' ? company : null, previewRevision: status === 'candidate' || status === 'accepted' ? 1 : null, clarification: null, taskId: null, createdAt: '2026-10-31T08:00:00Z', ...overrides };
};
export async function mockApi(page, handlers = {}) {
  const calls = [];
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.replace('/api/v1', '');
    const key = `${request.method()} ${path}`;
    const call = { key, url, body: request.postDataJSON(), headers: request.headers() }; calls.push(call);
    let result = handlers[key]; if (typeof result === 'function') result = await result(call, calls);
    if (result === undefined) {
      if (key === 'GET /session') result = session();
      else if (key === 'GET /searches') result = { items: [] };
      else if (key === 'GET /companies') result = { items: [company] };
      else if (key === 'GET /companies/library') result = company;
      else result = { status: 503, body: { error: { code: 'unavailable', message: 'Endpoint unavailable in this test.' } } };
    }
    if (result.abort) { await route.abort(); return; }
    await route.fulfill({ status: result.httpStatus || (typeof result.status === 'number' ? result.status : 200), contentType: 'application/json', body: JSON.stringify(result.body || result) });
  });
  return calls;
}
