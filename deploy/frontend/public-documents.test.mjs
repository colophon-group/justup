// Exercise the actual retained SSR Worker; fake records exist only in this test boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPublicHandler } from '../../web/worker-dist/worker.mjs';
const origin = 'https://public.justup.test';
const template = await readFile(new URL('../../web/dist/index.html', import.meta.url), 'utf8');
const company = { id: 'public-corp', name: 'Public & Co', description: 'Public company description.', coverage: { state: 'imported_snapshot' }, sources: [{ url: 'https://careers.example.test/jobs' }], privateAccount: 'PRIVATE_CANARY', modelEvidence: 'MODEL_CANARY', evidenceUrls: ['https://example.test/INTERNAL_EVIDENCE'] };
function environment(mode = 'preview') {
  return { PUBLIC_ORIGIN: origin, API_ORIGIN: 'https://fixed-api.test', DEPLOYMENT_MODE: mode, RELEASE_JSON: JSON.stringify({ sourceSha: 'a'.repeat(40) }), RUNTIME_CONFIG_SHA256: 'f'.repeat(64), ASSETS: { fetch: async request => new Response(new URL(request.url).pathname === '/index.html' ? template : 'Static notice', { headers: { 'Content-Type': 'text/html' } }) } };
}
const request = path => new Request(origin + path, { headers: { Cookie: 'PRIVATE_COOKIE', Authorization: 'PRIVATE_AUTH', 'X-Forwarded-Host': 'evil.test', 'Accept-Language': 'fr', 'X-Private': 'PRIVATE_HEADER', 'X-Justup-Locale': 'es' } });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
test('public documents have real shared HTML, canonical localized URLs, no private state or credential forwarding', async () => {
  let calls = 0;
  const handle = createPublicHandler(async (target, options) => {
    calls++;
    const url = new URL(target);
    assert.equal(url.origin, 'https://fixed-api.test');
    assert.equal(options.credentials, 'omit');
    assert.deepEqual(options.headers, { Accept: 'application/json' });
    assert.equal(options.redirect, 'manual');
    assert.equal(options.cache, 'no-store');
    return json(url.pathname.endsWith('/companies') ? { items: [company], nextCursor: null, account: 'PRIVATE_CANARY' } : company);
  });
  const root = await handle(request('/'), environment());
  const rootHTML = await root.text();
  assert.equal(root.status, 200); assert.equal(calls, 0);
  assert.match(rootHTML, /Beat the/); assert.match(rootHTML, /No sponsored listings/);
  assert.match(rootHTML, /<link rel="canonical" href="https:\/\/public.justup.test\/">/);
  assert.equal((rootHTML.match(/name="description"/g) || []).length, 1);
  for (const path of ['/companies', '/companies/public-corp', '/de/companies/public-corp']) {
    const result = await handle(request(path), environment()); const html = await result.text();
    assert.equal(result.status, 200); assert.match(result.headers.get('Cache-Control'), /no-store/);
    assert.match(result.headers.get('X-Robots-Tag'), /noindex/);
    assert.ok(!result.headers.get('Content-Security-Policy').includes("script-src 'self' 'unsafe-inline'"));
    assert.match(html, /Public &amp; Co/); assert.match(html, /Public company description/);
    assert.match(html, /<template id="public-bootstrap" data-public=/);
    assert.doesNotMatch(html, /PRIVATE_CANARY|MODEL_CANARY|INTERNAL_EVIDENCE|PRIVATE_COOKIE|PRIVATE_AUTH|PRIVATE_HEADER|csrfToken|savedSearches/);
    assert.ok(html.includes(`rel="canonical" href="${origin}${path}"`));
    if (path.startsWith('/de')) { assert.match(html, /<html lang="de">/); assert.match(html, /Stellenbericht/); }
  }
  assert.equal(calls, 5);
});
test('status codes distinguish missing companies from dependency failures and malformed/oversized responses', async () => {
  for (const [upstream, status] of [[() => json({}, 404), 404], [() => json({}, 503), 503], [() => json({ id: 'wrong', name: 'Wrong' }), 503], [() => new Response('<script>private</script>', { headers: { 'content-type': 'text/html' } }), 503], [() => json({ ...company, description: 'x'.repeat(400 * 1024) }), 503]]) {
    const response = await createPublicHandler(upstream)(request('/companies/public-corp'), environment());
    assert.equal(response.status, status); assert.match(response.headers.get('X-Robots-Tag'), /noindex/);
    const html = await response.text(); assert.match(html, status === 404 ? /Page not found/ : /Coverage temporarily unavailable/);
    assert.doesNotMatch(html, /No companies found|That’s the directory so far/);
  }
  const unknown = await createPublicHandler(() => { throw new Error('Must not fetch'); })(request('/not-a-page'), environment());
  assert.equal(unknown.status, 404);
});
test('public redirects discard private query strings and English aliases; policies work without API', async () => {
  const handle = createPublicHandler(() => { throw new Error('Must not fetch'); });
  for (const [path, target] of [['/en/companies', '/companies'], ['/companies/?private=PRIVATE_QUERY', '/companies'], ['/fr', '/fr/']]) {
    const result = await handle(request(path), environment()); assert.equal(result.status, 308); assert.equal(result.headers.get('Location'), origin + target);
  }
  const env = environment(); delete env.API_ORIGIN;
  for (const path of ['/', '/privacy.html', '/usage.html']) assert.equal((await handle(request(path), env)).status, 200);
  assert.equal((await handle(request('/companies'), env)).status, 503);
  assert.equal((await handle(request('/companies/public-corp'), environment('production'))).status, 503);
  const production = await handle(request('/'), environment('production'));
  assert.equal(production.headers.get('X-Robots-Tag'), null);
});
test('public serialized markup cannot break out of its inert template or metadata', async () => {
  const payload = { ...company, name: '\"/><script>alert(1)</script>', description: '</template><script>alert(2)</script>' };
  const result = await createPublicHandler(() => json(payload))(request('/companies/public-corp'), environment());
  const html = await result.text(); assert.equal(result.status, 200);
  assert.doesNotMatch(html, /<script>alert/); assert.equal((html.match(/id="public-bootstrap"/g) || []).length, 1);
  assert.match(html, /&lt;script&gt;/);
});
test('stalled public body is stopped by the total request deadline', async () => {
  const start = Date.now();
  const result = await createPublicHandler(() => new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'application/json' } }))(request('/companies/public-corp'), environment());
  assert.equal(result.status, 503); assert.ok(Date.now() - start < 4000);
});
test('public catalogue pages preserve only catalogue criteria and expose real continuation without a fake complete list', async () => {
  const handle = createPublicHandler(async target => {
    const url = new URL(target);
    assert.equal(url.searchParams.get('limit'), '20');
    assert.equal(url.searchParams.get('q'), 'public');
    return json({ items: [company], nextCursor: url.searchParams.has('cursor') ? null : 'signed-public-next', coverage: { state: 'imported_snapshot' } });
  });
  const first = await handle(request('/companies?q=public'), environment('production'));
  assert.equal(first.status, 200); assert.match(first.headers.get('X-Robots-Tag'), /noindex/);
  const html = await first.text(); assert.match(html, /More companies/); assert.doesNotMatch(html, /That’s the directory so far/);
  assert.match(html, /href="\/companies\?q=public&amp;cursor=signed-public-next"/);
  assert.match(html, /rel="canonical" href="https:\/\/public.justup.test\/companies"/);
  const next = await handle(request('/companies?q=public&cursor=signed-public-next'), environment('production'));
  assert.equal(next.status, 200); assert.doesNotMatch(await next.text(), /More companies/);
  const unbounded = await createPublicHandler(() => json({ items: Array.from({ length: 21 }, (_, i) => ({ ...company, id: String(i) })), nextCursor: null }))(request('/companies'), environment());
  assert.equal(unbounded.status, 503);
});
test('indexable company HTML excludes unapproved legacy links and browser-local company URLs', async () => {
  const unsafe = { ...company, logoUrl: 'https://127.0.0.1/private-logo.svg', websiteUrl: 'https://internal.lan/admin', domain: 'internal.lan',
    sources: [{ url: 'http://127.0.0.1:5432/internal' }, { url: 'https://boards.greenhouse.io/public/jobs?location=remote' }],
    evidenceUrls: ['https://192.168.0.1/evidence'] };
  const result = await createPublicHandler(() => json(unsafe))(request('/companies/public-corp'), environment('production'));
  assert.equal(result.status, 200); assert.equal(result.headers.get('X-Robots-Tag'), null);
  const html = await result.text();
  assert.doesNotMatch(html, /127\.0\.0\.1|internal\.lan|192\.168\.0\.1|boards\.greenhouse\.io/);
  assert.doesNotMatch(html, /Verified career-page links are unavailable|No successful check reported/);
});
test('production public filtered catalogue stays noindex and follow without weakening preview or API privacy', async () => {
  const handle = createPublicHandler(() => json({ items: [company], nextCursor: null }));
  const production = await handle(request('/companies?q=Public'), environment('production'));
  assert.equal(production.status, 200); assert.equal(production.headers.get('X-Robots-Tag'), 'noindex, follow');
  const preview = await handle(request('/companies?q=Public'), environment());
  assert.match(preview.headers.get('X-Robots-Tag'), /noindex, nofollow/);
  const api = await createPublicHandler(() => new Response('{}', { headers: { 'Content-Type': 'application/json', 'X-Robots-Tag': 'noindex, follow' } }))(request('/api/v1/companies'), environment('production'));
  assert.match(api.headers.get('X-Robots-Tag'), /noindex, nofollow/);
});

test('company documents hydrate only approved report links and preserve identity when report evidence fails', async () => {
  const report = { companyId: company.id, asOf: '2026-11-01T12:00:00Z', sourceChecks: { state: 'available', items: [{
    publicLink: { url: 'https://careers.example.com/jobs', status: 'approved', provenance: 'employer-careers', approvedAt: '2026-10-01T00:00:00Z' },
    trackedSince: '2026-10-01T00:00:00Z', lastVerifiedAt: '2026-10-26T00:00:00Z', privateScopeId: 'PRIVATE_SCOPE_CANARY',
  }] } };
  for (const good of [true, false]) {
    const handle = createPublicHandler(target => json(new URL(target).pathname.endsWith('/report') ? good ? report : { ...report, companyId: 'wrong' } : company));
    const response = await handle(request('/companies/public-corp'), environment());
    assert.equal(response.status, 200); const html = await response.text();
    assert.match(html, /Public &amp; Co/); assert.doesNotMatch(html, /PRIVATE_SCOPE_CANARY/);
    if (good) { assert.match(html, /href="https:\/\/careers.example.com\/jobs"/); assert.match(html, /Last checked/); }
    else assert.doesNotMatch(html, /careers.example.com/);
  }
});
