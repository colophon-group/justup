// Edge contract suite, owned by frontend hosting. Read for privacy, proxy and streaming regressions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, httpsOrigin } from './worker.mjs';
const ingressSecret = 'A'.repeat(43);
const clientAddress = '203.0.113.25';
const publicOrigin = 'https://preview.justup.test';
const release = { sourceSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), assetsSha256: 'c'.repeat(64), workerSha256: 'd'.repeat(64), artifactSha256: 'e'.repeat(64), secret: 'must-not-leak' };
function environment() {
  return { DEPLOYMENT_MODE: 'preview', PUBLIC_ORIGIN: publicOrigin, API_INGRESS_SECRET: ingressSecret, API_ORIGIN: 'https://api.justup.test', RELEASE_JSON: JSON.stringify(release), RUNTIME_CONFIG_SHA256: 'f'.repeat(64), ASSETS: { fetch: async () => new Response('public policy', { headers: { 'Content-Type': 'text/html' } }) } };
}
const request = (path, options = {}) => { const headers = new Headers(options.headers); if (!headers.has('CF-Connecting-IP')) headers.set('CF-Connecting-IP', clientAddress); return new Request(`${publicOrigin}${path}`, { ...options, headers }); };
function privateHeaders(result) {
  assert.match(result.headers.get('Cache-Control'), /no-store/);
  assert.equal(result.headers.get('Cloudflare-CDN-Cache-Control'), 'no-store');
  assert.match(result.headers.get('X-Robots-Tag'), /noindex/);
}

test('public policies remain fetchable without a session or API configuration', async () => {
  const env = environment(); delete env.API_ORIGIN;
  const handle = createHandler(() => { throw new Error('Must not contact API'); });
  for (const path of ['/privacy.html', '/usage.html']) {
    const result = await handle(request(path), env);
    assert.equal(result.status, 200);
    assert.equal(await result.text(), 'public policy');
    assert.match(result.headers.get('X-Robots-Tag'), /noindex/);
    assert.match(result.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  }
  assert.match(await (await handle(request('/robots.txt'), env)).text(), /Disallow: \//);
});

test('API paths never fall back to HTML and malformed origins fail closed', async () => {
  const handle = createHandler(() => { throw new Error('Must not fetch'); });
  for (const API_ORIGIN of [undefined, 'http://api.test', 'https://user:secret@api.test', 'https://api.test/path', 'https://api.test?q=x']) {
    const result = await handle(request('/api/v1/session'), { ...environment(), API_ORIGIN });
    assert.equal(result.status, 503); privateHeaders(result);
    assert.equal((await result.json()).error.code, 'dependency_unavailable');
  }
  assert.throws(() => httpsOrigin('https://api.test/#x'));
});

test('only exact API prefix proxies and alternate public hostnames are denied', async () => {
  let calls = 0;
  const handle = createHandler(async () => { calls++; return new Response('api'); });
  await handle(request('/api/v10/session'), environment());
  assert.equal(calls, 0);
  const result = await handle(new Request('https://alternate.workers.dev/api/v1/session'), environment());
  assert.equal(result.status, 403); assert.equal(calls, 0);
});

test('proxy preserves credentials, CSRF, cursor, method and body while discarding forged forwarding headers', async () => {
  const handle = createHandler(async (url, init) => {
    assert.equal(url, 'https://api.justup.test/api/v1/searches?cursor=a%2Fb');
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.get('cookie'), '__Host-session=test');
    assert.equal(init.headers.get('x-csrf-token'), 'csrf-test');
    assert.equal(init.headers.get('x-forwarded-host'), 'preview.justup.test');
    assert.equal(init.headers.get('forwarded'), null);
    assert.equal(init.headers.get('x-justup-ingress'), ingressSecret);
    assert.equal(init.headers.get('x-justup-client-ip'), clientAddress);
    assert.equal(init.headers.get('cf-connecting-ip'), null);
    assert.equal(init.headers.get('cf-access-jwt-assertion'), null);
    assert.equal(await new Response(init.body).text(), '{"query":"nurse"}');
    return new Response('{"id":"s1"}', { status: 201, headers: { 'Set-Cookie': '__Host-session=new; Path=/; Secure; HttpOnly; SameSite=Lax', ETag: 'private', 'Cache-Control': 'public,max-age=3600' } });
  });
  const result = await handle(request('/api/v1/searches?cursor=a%2Fb', { method: 'POST', headers: { Origin: publicOrigin, Cookie: '__Host-session=test', 'X-CSRF-Token': 'csrf-test', Forwarded: 'host=evil', 'X-Forwarded-Host': 'evil', 'CF-Access-Jwt-Assertion': 'forged', 'X-Justup-Ingress': 'forged', 'X-Justup-Client-IP': '198.51.100.2' }, body: '{"query":"nurse"}' }), environment());
  assert.equal(result.status, 201); privateHeaders(result);
  assert.equal(result.headers.get('ETag'), null);
  assert.match(result.headers.get('Set-Cookie'), /__Host-session=new/);
});

test('foreign origins and mutations missing origin cannot reach the API', async () => {
  const handle = createHandler(() => { throw new Error('Must not fetch'); });
  for (const headers of [{ Origin: 'https://evil.test' }, {}]) {
    assert.equal((await handle(request('/api/v1/searches', { method: 'POST', headers, body: '{}' }), environment())).status, 403);
  }
});

test('SSE first event is delivered before upstream closes and cancellation propagates', async () => {
  let controller; let cancelled = false;
  const stream = new ReadableStream({ start(value) { controller = value; }, cancel() { cancelled = true; } });
  const result = await createHandler(async (_, init) => { assert.equal(init.headers.get('Last-Event-ID'), 'event-17'); assert.equal(init.headers.get('X-Justup-Ingress'), ingressSecret); return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'public' } }); })(request('/api/v1/searches/s1/events?revision=2', { headers: { 'Last-Event-ID': 'event-17' } }), environment());
  privateHeaders(result);
  assert.equal(result.headers.get('Content-Type'), 'text/event-stream');
  const reader = result.body.getReader();
  controller.enqueue(new TextEncoder().encode('id: 1\ndata: ready\n\n'));
  const first = await Promise.race([reader.read(), new Promise((_, reject) => setTimeout(() => reject(new Error('Stream buffered')), 250))]);
  assert.match(new TextDecoder().decode(first.value), /data: ready/);
  await reader.cancel(); assert.equal(cancelled, true);
});

test('provider redirects pass through without edge follow, while API-host redirects fail closed', async () => {
  for (const location of ['/api/v1/session/callback', 'https://accounts.google.com/o/oauth2/v2/auth?state=test']) {
    const result = await createHandler(async (_, init) => {
      assert.equal(init.redirect, 'manual'); assert.equal(init.headers.get('X-Justup-Ingress'), ingressSecret);
      return new Response(null, { status: 302, headers: { Location: location, 'X-Justup-Ingress': ingressSecret, 'X-Justup-Client-IP': clientAddress } });
    })(request('/api/v1/auth/google'), environment());
    assert.equal(result.status, 302); assert.equal(result.headers.get('Location'), location); privateHeaders(result);
    assert.equal(result.headers.get('X-Justup-Ingress'), null); assert.equal(result.headers.get('X-Justup-Client-IP'), null);
  }
  const invalid = await createHandler(async () => new Response(null, { status: 302, headers: { Location: 'https://api.justup.test/callback' } }))(request('/api/v1/auth/google'), environment());
  assert.equal(invalid.status, 503);
});

test('upstream failures stay private, preserve HTTP errors and do not leak diagnostics', async () => {
  const result = await createHandler(async () => { throw new Error(ingressSecret + clientAddress); })(request('/api/v1/session'), environment());
  assert.equal(result.status, 503); assert.doesNotMatch(await result.text(), new RegExp(ingressSecret + '|203\\.0\\.113')); privateHeaders(result);
  const denied = await createHandler(async () => new Response('{"code":"limited"}', { status: 429, headers: { 'Retry-After': '60' } }))(request('/api/v1/session'), environment());
  assert.equal(denied.status, 429); assert.equal(denied.headers.get('Retry-After'), '60'); privateHeaders(denied);
});

test('release identity is whitelisted, noncached and unavailable until valid', async () => {
  const handle = createHandler();
  const result = await handle(request('/__release/version'), environment());
  const body = await result.json(); privateHeaders(result);
  assert.equal(body.sourceSha, release.sourceSha); assert.equal(body.apiPrefix, '/api/v1');
  assert.equal(body.secret, undefined); assert.equal(body.API_ORIGIN, undefined);
  assert.doesNotMatch(JSON.stringify(body), new RegExp(ingressSecret + '|' + clientAddress));
  assert.equal((await handle(request('/__release/version'), { ...environment(), RELEASE_JSON: '{}' })).status, 503);
});


test('source boundary fails closed without the compiled renderer while retained index bytes stay fetchable', async () => {
  const env = environment();
  env.ASSETS.fetch = async value => new URL(value.url).pathname === '/index.html' ? new Response('index') : new Response('missing', { status: 404 });
  const handle = createHandler();
  const index = await handle(request('/'), env);
  assert.equal(index.status, 503); privateHeaders(index);
  assert.equal((await index.json()).error.code, 'public_renderer_unavailable');
  const retained = await handle(request('/index.html'), env); assert.equal(retained.status, 200); assert.equal(await retained.text(), 'index');
  assert.equal((await handle(request('/missing.html'), env)).status, 404);
});


test('production indexing is an explicit runtime setting and never changes private boundaries', async () => {
  const handle = createHandler(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
  for (const mode of [undefined, '', 'prod', 'Preview']) {
    const result = await handle(request('/'), { ...environment(), DEPLOYMENT_MODE: mode });
    assert.equal(result.status, 503); privateHeaders(result);
    assert.equal((await result.json()).error.code, 'deployment_mode_unavailable');
  }
  const env = { ...environment(), DEPLOYMENT_MODE: 'production' };
  for (const path of ['/privacy.html', '/usage.html']) {
    const result = await handle(request(path), env);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('X-Robots-Tag'), null);
    assert.equal(await result.text(), 'public policy');
    assert.match(result.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  }
  const robots = await handle(request('/robots.txt'), env);
  assert.equal(await robots.text(), 'User-agent: *\nDisallow: /api/\nDisallow: /__release/\n');
  for (const path of ['/api/v1/session', '/__release/version']) {
    const result = await handle(request(path), env); privateHeaders(result);
    if (path.startsWith('/__release/')) assert.equal((await result.json()).deploymentMode, 'production');
  }
  const redirected = await handle(request('/redirect.html'), { ...env, ASSETS: { fetch: async () => new Response(null, { status: 302, headers: { Location: '/' } }) } });
  assert.equal(redirected.status, 302); privateHeaders(redirected);
  const failed = await handle(request('/missing.html'), { ...env, ASSETS: { fetch: async () => new Response('missing', { status: 404 }) } });
  assert.equal(failed.status, 404); privateHeaders(failed);
  const failure = await createHandler(async () => { throw new Error('private'); })(request('/api/v1/session'), env);
  assert.equal(failure.status, 503); privateHeaders(failure);
});

test('only an exact request locale reaches the same-origin API boundary', async () => {
  let calls = 0;
  const handle = createHandler(async (_, init) => {
    calls++; assert.equal(init.headers.get('X-Justup-Locale'), 'it');
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  });
  const valid = await handle(request('/api/v1/session', { headers: { 'X-Justup-Locale': 'it' } }), environment());
  assert.equal(valid.status, 200); privateHeaders(valid); assert.equal(calls, 1);
  for (const locale of ['', 'IT', 'esp', 'it-IT', 'it,de', 'it, it', 'unknown']) {
    const invalid = await handle(request('/api/v1/session', { headers: { 'X-Justup-Locale': locale } }), environment());
    assert.equal(invalid.status, 400); privateHeaders(invalid); assert.equal((await invalid.json()).error.code, 'invalid_locale');
  }
  const repeated = new Headers(); repeated.append('X-Justup-Locale', 'it'); repeated.append('X-Justup-Locale', 'it');
  assert.equal((await handle(request('/api/v1/session', { headers: repeated }), environment())).status, 400);
  assert.equal(calls, 1);
});


test('missing or malformed private binding and platform address never reach upstream', async () => {
  let calls = 0;
  const handle = createHandler(() => { calls++; throw new Error('Must not fetch'); });
  for (const secret of [undefined, '', 'x'.repeat(42), 'x'.repeat(43), 'A'.repeat(43) + '=', 'A'.repeat(42) + '/']) {
    const result = await handle(request('/api/v1/health'), { ...environment(), API_INGRESS_SECRET: secret });
    assert.equal(result.status, 503); privateHeaders(result);
    assert.doesNotMatch(await result.text(), /203\.0\.113|Trusted ingress/);
  }
  for (const address of [null, '', '203.0.113.25, 198.51.100.2', '203.000.113.25', '999.0.0.1', '::ffff:192.168.00.1', '[2001:db8::1]', '2001:db8::1%eth0', '2001::db8::1']) {
    const headers = new Headers(); if (address !== null) headers.set('CF-Connecting-IP', address);
    headers.set('X-Justup-Client-IP', clientAddress); headers.set('X-Forwarded-For', clientAddress);
    const result = await handle(new Request(publicOrigin + '/api/v1/session', { headers }), environment());
    assert.equal(result.status, 503); privateHeaders(result);
  }
  assert.equal(calls, 0);
});
test('one valid IPv4 or IPv6 platform address replaces supplied internal addresses', async () => {
  for (const address of ['203.0.113.25', '2001:db8::1', '2001:0db8:0000:0000:0000:0000:0000:0001', '::ffff:192.0.2.1']) {
    const result = await createHandler(async (_, init) => {
      assert.equal(init.headers.get('X-Justup-Client-IP'), address);
      assert.equal(init.headers.get('X-Justup-Ingress'), ingressSecret);
      return new Response('{}', { headers: { 'X-Justup-Ingress': ingressSecret, 'X-Justup-Client-IP': address } });
    })(request('/api/v1/session', { headers: { 'CF-Connecting-IP': address, 'X-Justup-Client-IP': 'forged', 'X-Justup-Ingress': 'forged' } }), environment());
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('X-Justup-Ingress'), null); assert.equal(result.headers.get('X-Justup-Client-IP'), null);
  }
});
test('signed webhook POST without browser Origin keeps exact bytes and signature', async () => {
  const body = new Uint8Array([123, 13, 10, 32, 34, 120, 34, 58, 34, 0, 255, 34, 125]);
  const result = await createHandler(async (url, init) => {
    assert.equal(url, 'https://api.justup.test/api/v1/billing/stripe/webhook');
    assert.equal(init.headers.get('Origin'), null); assert.equal(init.headers.get('Stripe-Signature'), 'synthetic-signature');
    assert.equal(init.headers.get('X-Justup-Ingress'), ingressSecret);
    assert.deepEqual(new Uint8Array(await new Response(init.body).arrayBuffer()), body);
    return new Response('{}');
  })(request('/api/v1/billing/stripe/webhook', { method: 'POST', headers: { 'Stripe-Signature': 'synthetic-signature' }, body }), environment());
  assert.equal(result.status, 200);
  const denied = createHandler(() => { throw new Error('Must not fetch'); });
  for (const path of ['/api/v1/billing/stripe/webhook/', '/api/v1/billing/other/webhook', '/api/v1/searches']) {
    assert.equal((await denied(request(path, { method: 'POST', body: '{}' }), environment())).status, 403);
  }
});
