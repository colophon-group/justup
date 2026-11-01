// Local HTTP/SQLite regression proof for the private frontend-to-API boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent, request } from 'node:http';
import { createApplication, configFromEnv } from './main.mjs';
import { syntheticPolicyProof } from './policy-test-fixtures.mjs';

const ORIGIN = 'https://preview.example';
const SECRET = Buffer.alloc(32, 7).toString('base64url');
const TOKEN = 'a'.repeat(43);
const ingress = (ip = '192.0.2.10') => ({ 'X-Justup-Ingress': SECRET, 'X-Justup-Client-IP': ip });
async function setup(t, config = {}, services = []) {
  const calls = { sessions: 0, registrations: 0, webhooks: [] }, logs = [];
  const application = await createApplication({ config: { allowedOrigin: ORIGIN, sourceCommit: 'a'.repeat(40),
    csrfSecret: 'x'.repeat(32), trustedIngressSecret: SECRET, trustedIngressRequired: true,
    requiresInvitation: false, policiesReviewed: true, privacyUrl: ORIGIN + '/privacy.html',
    usageUrl: ORIGIN + '/usage.html', policyVersion: 'fixture',
    policyAssetProof: syntheticPolicyProof({ origin: ORIGIN, sourceCommit: 'a'.repeat(40), version: 'fixture' }), ...config },
    authFactory: () => ({ cleanup() {}, registrationState: () => ({ enabled: true }),
      session(value) { calls.sessions++; return value === TOKEN ? { account: { id: 'account-a' }, expiresAt: Date.now() + 60_000, access: {} } : null; },
      async register() { calls.registrations++; return { token: TOKEN, account: { id: 'account-a' }, expiresAt: Date.now() + 60_000 }; } }),
    serviceFactories: [() => [{ stripeBilling: true, handleWebhook({ body, signature }) {
      calls.webhooks.push({ body, signature }); return { status: 200, body: { accepted: true } };
    } }, ...services]], logger: value => logs.push(value) });
  await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${application.server.address().port}`;
  t.after(async () => { application.server.closeAllConnections(); await application.close(); });
  async function get(path = '/session', headers = ingress()) { return fetch(base + '/api/v1' + path, { headers }); }
  return { application, base, calls, logs, get };
}

test('protected origin rejects unauthenticated requests before any application work', async t => {
  const s = await setup(t);
  for (const path of ['/health', '/version', '/session', '/jobs']) {
    const res = await s.get(path, { Cookie: '__Host-justup_session=' + TOKEN });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'forbidden');
    assert.equal(res.headers.get('set-cookie'), null);
  }
  assert.equal(s.calls.sessions, 0);
  assert.equal(s.application.store.db.prepare('SELECT count(*) AS n FROM justup_tasks').get().n, 0);
});

test('malformed or repeated ingress headers never reach auth and do not reveal their values', async t => {
  const s = await setup(t);
  const variants = [ {}, { 'X-Justup-Ingress': SECRET },
    { ...ingress(), 'X-Justup-Ingress': Buffer.alloc(32, 8).toString('base64url') },
    { ...ingress(), 'X-Justup-Ingress': SECRET + ',' + SECRET },
    { ...ingress(), 'X-Justup-Ingress': SECRET.slice(0, -1) + 'd' },
    ...['', 'unknown', '192.0.2.1, 192.0.2.2', '192.0.2.1:443', '[2001:db8::1]', 'fe80::1%eth0',
      '0127.0.0.1', '127.1', '2001:db8::1:443:bad:ip'].map(ip => ingress(ip)) ];
  for (const headers of variants) {
    const res = await s.get('/session', { ...headers, Cookie: '__Host-justup_session=' + TOKEN });
    assert.equal(res.status, 403);
    assert.ok(!(await res.text()).includes(SECRET));
  }
  for (const name of ['X-Justup-Ingress', 'X-Justup-Client-IP']) {
    const headers = Object.entries(ingress()).flat();
    headers.push(name, ingress()[name]);
    assert.equal((await raw(s.base, '/api/v1/session', { headers })).status, 403);
  }
  assert.equal(s.calls.sessions, 0);
  for (const log of s.logs) assert.deepEqual(Object.keys(log).sort(), ['category', 'durationMs', 'requestId', 'status']);
});

function raw(base, path, { headers = {}, method = 'GET', body, unfinished = false, agent } = {}) {
  return new Promise((resolve, reject) => {
    if (Array.isArray(headers)) headers = [...headers, 'Host', new URL(base).host];
    const req = request(base + path, { method, headers, agent }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
    });
    req.setTimeout(1500, () => req.destroy(new Error('Response waited for an unauthenticated body.')));
    req.on('error', reject);
    if (unfinished) req.flushHeaders(); else req.end(body);
  });
}

test('invalid ingress is rejected before reading a raw webhook body; authenticated bytes stay exact', async t => {
  const s = await setup(t);
  const headers = { 'Content-Type': 'application/json', 'Content-Length': '16', 'Stripe-Signature': 'fixture-signature' };
  const early = await raw(s.base, '/api/v1/billing/stripe/webhook', { method: 'POST', headers, unfinished: true });
  assert.equal(early.status, 403); assert.deepEqual(s.calls.webhooks, []);
  const body = Buffer.from('{ "fixture": 1 }');
  const ok = await raw(s.base, '/api/v1/billing/stripe/webhook', { method: 'POST',
    headers: { ...headers, ...ingress(), 'Content-Length': body.length }, body });
  assert.equal(ok.status, 200); assert.equal(s.calls.webhooks[0].signature, 'fixture-signature');
  assert.deepEqual(s.calls.webhooks[0].body, body);
});

test('authenticated addresses have separate caps on a shared keepalive socket and cannot be overridden', async t => {
  const s = await setup(t, { rateLimits: { read: 1 } });
  const peers = [], sockets = new Set();
  s.application.server.on('request', req => { peers.push(req.socket.remoteAddress); sockets.add(req.socket); });
  const agent = new Agent({ keepAlive: true, maxSockets: 1 }); t.after(() => agent.destroy());
  const get = ip => raw(s.base, '/api/v1/session', { agent, headers: { ...ingress(ip),
    'CF-Connecting-IP': '203.0.113.1', 'X-Forwarded-For': '203.0.113.2', 'Forwarded': 'for=203.0.113.3' } });
  assert.equal((await get('192.0.2.1')).status, 200);
  assert.equal((await get('192.0.2.2')).status, 200);
  assert.equal((await get('192.0.2.1')).status, 429);
  assert.equal((await get('192.0.2.2')).status, 429);
  assert.equal(sockets.size, 1); assert.deepEqual([...new Set(peers)], ['127.0.0.1']);
  assert.equal((await s.get('/session', { ...ingress('203.0.113.4'), 'X-Justup-Ingress': 'bad' })).status, 403);
  assert.equal((await s.get('/session', ingress('203.0.113.4'))).status, 200);
});

test('equivalent IPv6 and mapped IPv4 addresses share rate buckets', async t => {
  const s = await setup(t, { rateLimits: { read: 1 } });
  assert.equal((await s.get('/session', ingress('2001:db8::a'))).status, 200);
  assert.equal((await s.get('/session', ingress('2001:0DB8:0:0:0:0:0:A'))).status, 429);
  assert.equal((await s.get('/session', ingress('192.0.2.5'))).status, 200);
  assert.equal((await s.get('/session', ingress('::ffff:192.0.2.5'))).status, 429);
});

test('authentication and webhook mutation caps use the same authenticated client identity', async t => {
  const s = await setup(t, { rateLimits: { auth: 1, mutation: 1 } });
  for (const path of ['/auth/login', '/billing/stripe/webhook']) {
    const send = ip => fetch(s.base + '/api/v1' + path, { method: 'POST',
      headers: { ...ingress(ip), Origin: 'https://foreign.example', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal((await send('192.0.2.1')).status, path === '/auth/login' ? 403 : 400);
    assert.equal((await send('192.0.2.2')).status, path === '/auth/login' ? 403 : 400);
    assert.equal((await send('192.0.2.1')).status, 429);
  }
  assert.equal(s.calls.registrations, 0); assert.deepEqual(s.calls.webhooks, []);
});

test('supplying a secret enables ingress even when the generic required switch is false', async t => {
  const s = await setup(t, { trustedIngressRequired: false });
  assert.equal((await s.get('/health', {})).status, 403);
  assert.equal((await s.get('/health')).status, 200);
});

test('explicit local mode ignores all claimed forwarding identities', async t => {
  const s = await setup(t, { trustedIngressSecret: undefined, trustedIngressRequired: false, rateLimits: { read: 1 } });
  assert.equal((await s.get('/session', ingress('192.0.2.1'))).status, 200);
  assert.equal((await s.get('/session', { ...ingress('192.0.2.2'), 'CF-Connecting-IP': '203.0.113.9' })).status, 429);
});

test('protected requests preserve cookies and still require Origin and CSRF for registration', async t => {
  const s = await setup(t);
  const session = await s.get(), state = await session.json();
  const cookies = session.headers.getSetCookie();
  assert.ok(cookies.every(cookie => cookie.includes('HttpOnly') && cookie.includes('Secure') && !cookie.includes('Domain=')));
  const headers = { ...ingress(), Origin: ORIGIN, 'X-CSRF-Token': state.csrfToken,
    Cookie: cookies.map(cookie => cookie.split(';')[0]).join('; '), 'Content-Type': 'application/json' };
  for (const change of [{ Origin: 'https://foreign.example' }, { 'X-CSRF-Token': 'bad' }]) {
    const res = await fetch(s.base + '/api/v1/auth/register', { method: 'POST', headers: { ...headers, ...change }, body: '{}' });
    assert.equal(res.status, 403);
  }
  assert.equal(s.calls.registrations, 0);
  const res = await fetch(s.base + '/api/v1/auth/register', { method: 'POST', headers, body: '{}' });
  assert.equal(res.status, 201); assert.equal(s.calls.registrations, 1);
});

test('protected streaming preserves reconnect metadata, first bytes and cancellation', { timeout: 3000 }, async t => {
  const streams = [];
  const s = await setup(t, {}, [{ capabilities: { sse: true }, openStream({ req, res, lastEventId, readAuthority }) {
    const stream = { lastEventId, locale: req.headers['x-justup-locale'], owner: readAuthority().account.id };
    stream.closed = new Promise(resolve => res.once('close', resolve)); streams.push(stream);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'private, no-store' });
    res.write('id: opaque-event\ndata: {}\n\n');
  } }]);
  const url = s.base + '/api/v1/workspace/events?searchId=fixture&revision=1';
  for (const event of [undefined, 'opaque-event']) {
    const controller = new AbortController(); t.after(() => controller.abort());
    const res = await fetch(url, { signal: controller.signal, headers: { ...ingress(), Origin: ORIGIN,
      Cookie: '__Host-justup_session=' + TOKEN, 'X-Justup-Locale': 'en', ...(event ? { 'Last-Event-ID': event } : {}) } });
    assert.equal(res.status, 200); assert.equal(res.headers.get('content-type'), 'text/event-stream');
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const reader = res.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /id: opaque-event/);
    assert.equal(streams.at(-1).lastEventId, event ?? null); assert.equal(streams.at(-1).locale, 'en');
    assert.equal(streams.at(-1).owner, 'account-a');
    await reader.cancel(); controller.abort(); await streams.at(-1).closed;
  }
});

test('required ingress configuration fails before opening storage or composing services', async () => {
  for (const config of [{ trustedIngressRequired: true }, { trustedIngressSecret: '' },
    { trustedIngressSecret: 'x'.repeat(32) }, { trustedIngressSecret: 'a'.repeat(43) }, { trustedIngressRequired: 'false' }]) {
    let composed = false;
    await assert.rejects(createApplication({ config, serviceFactories: [() => { composed = true; return {}; }] }), /ingress configuration/i);
    assert.equal(composed, false);
  }
  const config = configFromEnv({ JUSTUP_TRUSTED_INGRESS_SECRET: SECRET, JUSTUP_TRUSTED_INGRESS_REQUIRED: 'true' });
  assert.equal(config.trustedIngressSecret, SECRET); assert.equal(config.trustedIngressRequired, true);
  assert.throws(() => configFromEnv({ JUSTUP_TRUSTED_INGRESS_REQUIRED: 'true' }), /ingress configuration/i);
  assert.throws(() => configFromEnv({ JUSTUP_TRUSTED_INGRESS_REQUIRED: 'no' }), /TRUSTED_INGRESS_REQUIRED/);
});
