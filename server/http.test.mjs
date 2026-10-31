import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHandler } from './http.mjs';
const ORIGIN = 'https://preview.example.org';
async function setup(t, options = {}) {
  const token = 'a'.repeat(43), account = { id: 'account-a', username: 'tester' };
  let signedIn = false, mutations = 0;
  const auth = {
    cleanup: () => ({}),
    session: (value) => value === token && signedIn ? { account, expiresAt: Date.now() + 60_000, access: { kind: 'demo', fullAccess: true, legacy: false, billingEnabled: false, until: null } } : null,
    register: async () => { signedIn = true; mutations++; return { account, token, expiresAt: Date.now() + 60_000 }; },
    login: async () => { signedIn = true; mutations++; return { account, token, expiresAt: Date.now() + 60_000 }; },
    logout: () => { signedIn = false; mutations++; },
    deleteAccount: async () => { if (options.deleteError) throw Object.assign(new Error('safe'), { code: 'invalid_credentials', status: 401 }); signedIn = false; mutations++; return { deleted: true }; },
  };
  const calls = [], logs = [];
  const feed = { coverage: () => ({ kind: 'imported_snapshot', verifiedAt: null, stale: true }), generation: () => null,
    list: ({ viewer }) => ({ items: [{ id: viewer ? 'preview' : 'public' }] }), companies: () => ({ items: [] }), company: () => ({ id: 'co' }) };
  const task = { id: 'task-a', status: 'succeeded', kind: 'search_intent', payload: { secret: 'private' }, output: { hiddenJob: 'never-serialize' } };
  const tasks = { get: (owner, id) => owner === account.id && id === task.id ? task : null, publicView: (row, result) => ({ id: row.id, status: row.status, result }) };
  const config = { allowedOrigin: ORIGIN, csrfSecret: 'x'.repeat(32), inviteCode: 'test-invite', policiesReviewed: true,
    privacyUrl: `${ORIGIN}/privacy`, usageUrl: `${ORIGIN}/usage`, policyVersion: 'reviewed-1', ...options.config };
  const services = options.services ?? [{ capabilities: { search: true }, route: async (ctx) => { calls.push(ctx); return ctx.path === '/searches' ? { status: 202, body: { ok: true } } : null; } }];
  const server = createServer(createHandler({ auth, feed, tasks, services, config, logger: (v) => logs.push(v) }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  async function request(path, opts = {}) {
    const res = await fetch(base + path, opts); return { res, body: await res.json() };
  }
  const guest = await request('/session');
  const guestCookie = guest.res.headers.getSetCookie().map((v) => v.split(';')[0]).join('; ');
  async function login() {
    const result = await request('/auth/login', { method: 'POST', headers: { Origin: ORIGIN, 'X-CSRF-Token': guest.body.csrfToken, Cookie: guestCookie, 'Content-Type': 'application/json' }, body: '{}' });
    return { ...result, cookie: result.res.headers.getSetCookie().map((v) => v.split(';')[0]).join('; ') };
  }
  return { request, guest, guestCookie, login, calls, logs, mutations: () => mutations };
}
test('session and auth set opaque host-only secure cookies and honest capabilities', async (t) => {
  const s = await setup(t); assert.equal(s.guest.body.user, null); assert.equal(s.guest.body.access.kind, 'guest');
  assert.equal(s.guest.body.capabilities.hiddenMatchCounts, false);
  const result = await s.login(); assert.equal(result.res.status, 200);
  const cookie = result.res.headers.getSetCookie()[0];
  assert.match(cookie, /^__Host-justup_demo_session=[A-Za-z0-9_-]{43};/);
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.ok(cookie.includes(flag));
  assert.ok(!cookie.includes('Domain=')); assert.equal(result.body.user.username, 'tester');
  assert.equal(result.res.headers.get('cache-control'), 'private, no-store');
  const session = await s.request('/session', { headers: { Cookie: result.cookie } }); assert.equal(session.body.csrfToken, result.body.csrfToken);
});
test('policy and invite gates close both login and registration before auth code', async (t) => {
  const s = await setup(t, { config: { policiesReviewed: false } });
  for (const route of ['/auth/login', '/auth/register']) {
    const result = await s.request(route, { method: 'POST', headers: { Origin: ORIGIN, 'X-CSRF-Token': s.guest.body.csrfToken, Cookie: s.guestCookie, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(result.res.status, 503); assert.equal(result.body.error.code, 'policy_unavailable');
  }
  assert.equal(s.mutations(), 0); assert.equal(s.guest.body.policies.reviewed, false);
});
test('origin, CSRF and body limits run before private injected services; guests cannot save searches', async (t) => {
  const s = await setup(t); const login = await s.login();
  const headers = { Origin: ORIGIN, 'X-CSRF-Token': login.body.csrfToken, Cookie: login.cookie, 'Content-Type': 'application/json' };
  for (const change of [{ Origin: 'https://evil.example' }, { 'X-CSRF-Token': 'bad' }]) {
    const r = await s.request('/searches', { method: 'POST', headers: { ...headers, ...change }, body: '{}' }); assert.equal(r.res.status, 403);
  }
  const large = await s.request('/searches', { method: 'POST', headers, body: JSON.stringify({ q: 'x'.repeat(16384) }) }); assert.equal(large.res.status, 400);
  const guest = await s.request('/searches'); assert.equal(guest.res.status, 401);
  assert.equal(s.calls.length, 0);
  const ok = await s.request('/searches', { method: 'POST', headers, body: '{}' }); assert.equal(ok.res.status, 202);
  assert.equal(s.calls[0].accountId, 'account-a'); assert.equal(s.calls[0].viewer.account.id, 'account-a');
});
test('task status is owner-only and generic stored output never reaches HTTP', async (t) => {
  const s = await setup(t); const login = await s.login();
  const missing = await s.request('/tasks/other', { headers: { Cookie: login.cookie } }); assert.equal(missing.res.status, 404);
  const task = await s.request('/tasks/task-a', { headers: { Cookie: login.cookie } }); assert.equal(task.body.result, null);
  assert.ok(!JSON.stringify(task.body).includes('hiddenJob')); assert.ok(!JSON.stringify(task.body).includes('private'));
});
test('rate limits, sanitized errors and diagnostic metadata omit sensitive inputs', async (t) => {
  const s = await setup(t, { config: { rateLimits: { auth: 1 } } });
  assert.equal((await s.login()).res.status, 200);
  const repeated = await s.login(); assert.equal(repeated.res.status, 429); assert.ok(Number(repeated.res.headers.get('retry-after')) > 0);
  for (const log of s.logs) assert.deepEqual(Object.keys(log).sort(), ['category', 'durationMs', 'requestId', 'status']);
  const broken = await setup(t, { services: [{ route: async () => { throw new Error('password secret body'); } }] });
  const login = await broken.login(); const r = await broken.request('/searches', { headers: { Cookie: login.cookie } });
  assert.equal(r.res.status, 500); assert.equal(r.body.error.code, 'internal_error'); assert.ok(!JSON.stringify(r.body).includes('password'));
});
test('logout and confirmed account deletion clear cookie and invalidate viewer', async (t) => {
  const s = await setup(t); let login = await s.login();
  const headers = () => ({ Origin: ORIGIN, 'X-CSRF-Token': login.body.csrfToken, Cookie: login.cookie, 'Content-Type': 'application/json' });
  const deleted = await s.request('/account', { method: 'DELETE', headers: headers(), body: '{"password":"fixture"}' });
  assert.equal(deleted.body.deleted, true); assert.match(deleted.res.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await s.request('/session', { headers: { Cookie: login.cookie } })).body.user, null);
  login = await s.login(); const logout = await s.request('/session/logout', { method: 'POST', headers: headers(), body: '{}' });
  assert.equal(logout.body.loggedOut, true); assert.match(logout.res.headers.get('set-cookie'), /Max-Age=0/);
});

test('authentication availability reflects deletion/config gates and wrong deletion password retains session', async (t) => {
  const blocked = await setup(t, { config: { deletionReady: () => false } });
  assert.equal(blocked.guest.body.authentication.loginEnabled, false);
  assert.equal((await blocked.login()).body.error.code, 'deletion_unavailable');
  const s = await setup(t, { deleteError: true }); const login = await s.login();
  const denied = await s.request('/account', { method: 'DELETE', headers: { Origin: ORIGIN, 'X-CSRF-Token': login.body.csrfToken, Cookie: login.cookie, 'Content-Type': 'application/json' }, body: '{"password":"wrong"}' });
  assert.equal(denied.res.status, 401); assert.equal(denied.body.error.code, 'invalid_credentials');
  assert.equal(denied.res.headers.get('set-cookie'), null);
  assert.equal((await s.request('/session', { headers: { Cookie: login.cookie } })).body.user.id, 'account-a');
});

test('feature idempotency comes only from the bounded HTTP header and request cleanup runs after routing', async (t) => {
  const s = await setup(t); const login = await s.login();
  const headers = { Origin: ORIGIN, 'X-CSRF-Token': login.body.csrfToken, Cookie: login.cookie, 'Content-Type': 'application/json' };
  const ok = await s.request('/searches', { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'accept-identity:one' }, body: '{"requestKey":"body-value"}' });
  assert.equal(ok.res.status, 202); assert.equal(s.calls.at(-1).idempotencyKey, 'accept-identity:one');
  await s.request('/searches', { method: 'POST', headers, body: '{"requestKey":"body-value"}' });
  assert.equal(s.calls.at(-1).idempotencyKey, null);
  const bad = await s.request('/searches', { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'x'.repeat(129) }, body: '{}' });
  assert.equal(bad.res.status, 400);
});
