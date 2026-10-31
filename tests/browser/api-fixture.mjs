// Test-only minimal v1 contract fixtures. Never included in the deployed static tree.
export const search = (revision = 1, query = 'Remote library jobs') => ({ id: 'search-1', revision, query, title: 'Library desk', description: 'Metadata only; not a visible summary.', configuration: {}, status: 'ready', requirements: [{ text: 'Remote work', handling: 'primary' }, { text: 'No night shifts', handling: 'residual_ai' }], warnings: ['Salary evidence is not available for every posting.'] });
export const company = { id: 'library', name: 'Test Library', description: 'A test-only public library.', coverage: { state: 'imported_snapshot' }, sources: [{ url: 'https://employer.test/careers' }] };
export const job = index => ({ id: `job-${index}`, title: `Librarian ${index}`, company, sourceUrl: `https://employer.test/careers/${index}`, firstObserved: '2026-10-31T08:00:00Z', locations: [{ name: 'London', workplace: 'remote' }], employmentTypes: ['full_time'], postingLanguages: ['en'], salary: null });
export const session = (overrides = {}) => ({ user: { id: 'reader', username: 'tester' }, csrfToken: 'test-only-csrf', access: { kind: 'demo', fullAccess: true, billingEnabled: false, legacy: false, until: null }, capabilities: { search: true, companyRequests: true, follows: false, viewed: false, preferences: false, sse: false, hiddenMatchCounts: false }, authentication: { method: 'username_password', loginEnabled: true, registrationEnabled: true, reason: null }, policies: { reviewed: true, version: 'test-v1', privacyUrl: '/privacy.html', usageUrl: '/usage.html' }, coverage: { kind: 'imported_snapshot', verifiedAt: '2026-10-31T08:00:00Z', stale: false }, ...overrides });
export const completed = (items = [job(1)], revision = 1) => ({ searchId: 'search-1', revision, items, continuation: { state: 'exhausted', cursor: null, retryAfterMs: null }, ai: { status: 'not_required' } });
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
