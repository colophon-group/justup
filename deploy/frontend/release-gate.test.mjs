// Deterministic preflight/ownership contracts; these never contact a deployed service.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateGateConfig, loadGateConfig, requireInvite, preflight, verifyCandidateBuilds, verifyPolicyState, cleanupCandidateAccount, cleanupAccount, disposableAccount } from '../../tests/browser/release-gate.mjs';

const now = Date.parse('2026-10-31T12:00:00Z');
const locales = ['en', 'de', 'fr', 'it', 'es'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const policyPath = (kind, locale) => `/${kind}${locale === 'en' ? '' : `.${locale}`}.html`;
const runtimePolicy = entry => Object.fromEntries(['locale', 'reviewed', 'reviewedLocale', 'fallback', 'version', 'privacyUrl', 'usageUrl'].map(key => [key, entry[key]]));
function policyBytes(locale, kind, version = 'reviewed-v1') {
  return Buffer.from(`<!doctype html><html lang="${locale}"><head><meta name="justup-policy-version" content="${version}"><meta name="justup-policy-status" content="approved"><meta name="justup-policy-reviewed" content="true"></head><body data-policy="${kind}" data-policy-status="approved" data-policy-reviewed="true" data-policy-version="${version}">Synthetic reviewed fixture</body></html>`);
}
function fixture() {
  const origin = 'https://candidate.example';
  const entries = Object.fromEntries(locales.map(locale => [locale, {
    locale, reviewed: true, reviewedLocale: locale, fallback: false, version: 'reviewed-v1',
    privacyUrl: origin + policyPath('privacy', locale), usageUrl: origin + policyPath('usage', locale),
    privacySha256: digest(policyBytes(locale, 'privacy')), usageSha256: digest(policyBytes(locale, 'usage')),
  }]));
  const config = {
    origin,
    frontend: { deploymentMode: 'preview', sourceSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), assetsSha256: 'c'.repeat(64), workerSha256: 'd'.repeat(64), artifactSha256: 'e'.repeat(64), runtimeConfigSha256: 'f'.repeat(64) },
    api: { sourceCommit: 'a'.repeat(40), schemaVersion: 2, buildIdentity: 'build-fixed', runnerIdentity: 'runner-fixed', importGeneration: '00000000-0000-4000-8000-000000000000' },
    policies: { admittedLocales: entries, fallbackApprovals: {} },
    scenario: { query: 'Reviewed query', warnedQuery: 'Reviewed query plus unsupported requirement', companyId: 'company-fixed', companyName: 'Company', sourceUrl: 'https://employer.example/careers/one' },
  };
  const coverage = { kind: 'imported_snapshot', stale: false, verifiedAt: new Date(now - 1000).toISOString() };
  const runner = { ready: true, identity: 'runner-fixed', sourceCommit: config.api.sourceCommit, buildIdentity: config.api.buildIdentity, lastHeartbeat: new Date(now - 1000).toISOString() };
  const sessions = Object.fromEntries(locales.map(locale => [locale, { status: 200, json: { user: null, access: { fullAccess: false, billingEnabled: false }, serverTime: new Date(now).toISOString(), authentication: { method: 'username_password', loginEnabled: true, registrationEnabled: true }, policies: runtimePolicy(entries[locale]), capabilities: { search: true, companyRequests: true }, coverage } }]));
  const data = {
    '/__release/version': { status: 200, json: { ...config.frontend } },
    '/api/v1/version': { status: 200, json: { ...config.api, runner: { ...runner } } },
    '/api/v1/health': { status: 200, json: { ready: true, runner: { ...runner }, coverage } },
    '/api/v1/session': sessions.en,
    '/api/v1/searches': { status: 401, json: { error: { code: 'unauthenticated' } } },
    '/api/v1/jobs?limit=12': { status: 200, json: { asOf: new Date(now).toISOString(), items: [{ firstObserved: new Date(now - 3 * 86_400_000).toISOString() }], coverage } },
    '/api/v1/companies?q=Company': { status: 200, json: { items: [{ id: 'company-fixed', name: 'Company', coverage: { state: 'imported_snapshot' } }] } },
  };
  for (const locale of locales) for (const kind of ['privacy', 'usage']) data[policyPath(kind, locale)] = { status: 200, bytes: policyBytes(locale, kind) };
  const reads = [];
  const get = async (path, options) => {
    reads.push({ path, locale: options?.locale });
    return path === '/api/v1/session' ? sessions[options?.locale ?? 'en'] : data[path];
  };
  return { config, data, sessions, reads, get };
}
test('invalid configuration and mismatched deployed evidence fail before the registration boundary', async () => {
  const mutations = [
    f => { f.config.origin = 'http://candidate.example'; },
    f => { f.config.frontend.sourceSha = 'moving-branch'; },
    f => { delete f.config.frontend.deploymentMode; },
    f => { f.config.frontend.deploymentMode = 'production'; },
    f => { f.data['/__release/version'].json.deploymentMode = 'production'; },
    f => { f.config.api.sourceCommit = 'b'.repeat(40); },
    f => { f.data['/__release/version'].json.artifactSha256 = '0'.repeat(64); },
    f => { f.data['/api/v1/version'].json.buildIdentity = 'other'; },
    f => { f.data['/api/v1/health'].json.runner.lastHeartbeat = new Date(now - 31_000).toISOString(); },
    f => { f.data['/api/v1/session'].json.authentication.registrationEnabled = false; },
    f => { f.data['/api/v1/session'].json.policies.reviewed = false; },
    f => { f.data['/api/v1/searches'] = { status: 200, json: { items: [] } }; },
    f => { f.data['/api/v1/jobs?limit=12'].json.items[0].firstObserved = new Date(now - 86_400_000).toISOString(); },
    f => { f.data['/api/v1/jobs?limit=12'].json.items[0].firstObserved = new Date(now - 15 * 86_400_000).toISOString(); },
    f => { f.data['/privacy.html'].bytes = Buffer.from('changed'); },
    f => { f.data['/api/v1/companies?q=Company'].json.items.push(f.data['/api/v1/companies?q=Company'].json.items[0]); },
  ];
  for (const change of mutations) {
    const f = fixture(); change(f);
    let registered = false;
    await assert.rejects(async () => { await preflight(f.config, f.get, now); registered = true; });
    assert.equal(registered, false);
  }
  const f = fixture();
  await preflight(f.config, f.get, now);
  assert.equal(validateGateConfig(f.config), f.config);
  assert.throws(() => loadGateConfig('/nonexistent/acceptance.json'), { message: 'Acceptance configuration is missing or invalid; no live journey started.' });
  for (const value of [undefined, '', ' ', 'control\n']) assert.throws(() => requireInvite(value));
  const boundary = fixture();
  boundary.data['/api/v1/jobs?limit=12'].json.asOf = new Date(now + 1000).toISOString();
  boundary.data['/api/v1/jobs?limit=12'].json.items = [2, 14].map(days => ({ firstObserved: new Date(now + 1000 - days * 86_400_000).toISOString() }));
  await preflight(boundary.config, boundary.get, now + 1000);
});
test('stale application schema one is rejected in configured and deployed API identities', async () => {
  for (const change of [
    f => { f.config.api.schemaVersion = 1; },
    f => { f.data['/api/v1/version'].json.schemaVersion = 1; },
  ]) {
    const f = fixture(); change(f);
    await assert.rejects(preflight(f.config, f.get, now));
    assert.equal(f.reads.some(read => read.path === '/api/v1/searches'), false);
  }
});

test('every admitted locale and all ten exact documents are verified before private reads', async () => {
  const f = fixture();
  await preflight(f.config, f.get, now);
  assert.deepEqual(f.reads.filter(read => read.path === '/api/v1/session').map(read => read.locale), locales);
  assert.equal(f.reads.filter(read => /\.html$/.test(read.path)).length, 10);
  const firstPrivate = f.reads.findIndex(read => read.path === '/api/v1/searches');
  assert.ok(firstPrivate > f.reads.findLastIndex(read => /\.html$/.test(read.path)));
  for (const locale of locales) verifyPolicyState(f.config, f.sessions[locale].json.policies, locale);
});

test('missing, mismatched and unreviewed locale evidence rejects before any private work', async () => {
  const mutations = [
    f => { f.config.policies = { version: 'old', privacySha256: 'a'.repeat(64), usageSha256: 'b'.repeat(64) }; },
    f => { f.config.policies.admittedLocales = {}; },
    f => { f.config.policies.admittedLocales.xx = { ...f.config.policies.admittedLocales.en, locale: 'xx' }; },
    f => { delete f.config.policies.admittedLocales.en; },
    f => { delete f.config.policies.admittedLocales.es; },
    f => { f.config.policies.admittedLocales = { en: f.config.policies.admittedLocales.en }; },
    f => { delete f.config.policies.admittedLocales.es.locale; },
    f => { delete f.config.policies.admittedLocales.es.reviewedLocale; },
    f => { f.config.policies.admittedLocales.es.locale = 'fr'; },
    f => { f.config.policies.admittedLocales.es.reviewed = false; },
    f => { f.config.policies.admittedLocales.es.version = ''; },
    f => { f.config.policies.admittedLocales.es.privacyUrl = 'https://candidate.example/privacy.html'; },
    f => { f.config.policies.admittedLocales.es.privacyUrl += '?tracking=1'; },
    f => { f.config.policies.admittedLocales.es.privacyUrl = 'https://other.example/privacy.es.html'; },
    f => { f.sessions.es.json.policies.locale = 'en'; },
    f => { delete f.sessions.es.json.policies.fallback; },
    f => { f.sessions.es.json.policies.reviewed = false; },
    f => { f.sessions.es.json.policies.reviewedLocale = null; },
    f => { f.sessions.es.json.policies.reviewedLocale = 'en'; },
    f => { f.sessions.es.json.policies.version = 'changed'; },
    f => { f.sessions.es.json.policies.usageUrl = 'https://candidate.example/usage.html'; },
    f => { f.sessions.es.json.policies.unexpected = true; },
    f => { f.data['/usage.es.html'].bytes = Buffer.from('changed'); },
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    await assert.rejects(preflight(f.config, f.get, now));
    assert.equal(f.reads.some(read => read.path === '/api/v1/searches'), false);
  }
});

test('policy HTML language, kind, approval and version must agree even when its recorded hash matches', async () => {
  for (const change of [
    html => html.replace('lang="es"', 'lang="en"'),
    html => html.replace('data-policy="privacy"', 'data-policy="usage"'),
    html => html.replaceAll('reviewed-v1', 'changed-v2'),
    html => html.replaceAll('content="approved"', 'content="draft"'),
    html => html.replaceAll('data-policy-reviewed="true"', 'data-policy-reviewed="false"'),
    html => html.replace('<html lang="es">', '<html lang="es" lang="en">'),
    html => html.replace('</head>', '<meta name="justup-policy-version" content="reviewed-v1"></head>'),
  ]) {
    const f = fixture();
    f.data['/privacy.es.html'].bytes = Buffer.from(change(policyBytes('es', 'privacy').toString()));
    f.config.policies.admittedLocales.es.privacySha256 = digest(f.data['/privacy.es.html'].bytes);
    await assert.rejects(preflight(f.config, f.get, now));
    assert.equal(f.reads.some(read => read.path === '/api/v1/searches'), false);
  }
});

function fallbackFixture() {
  const f = fixture(), en = f.config.policies.admittedLocales.en;
  f.config.policies.admittedLocales.de = { ...en, locale: 'de', reviewedLocale: 'en', fallback: true };
  f.config.policies.fallbackApprovals.de = { reviewedLocale: 'en', version: en.version, operatorApproved: true };
  f.sessions.de.json.policies = runtimePolicy(f.config.policies.admittedLocales.de);
  return f;
}
test('fallback is explicit operator evidence, matches the server and directly reviewed target bytes, and never chains', async () => {
  const valid = fallbackFixture();
  await preflight(valid.config, valid.get, now);
  assert.equal(valid.reads.some(read => read.path === '/privacy.de.html'), false);
  assert.equal(valid.reads.filter(read => read.path === '/privacy.html').length, 1);
  const mutations = [
    f => { delete f.config.policies.fallbackApprovals.de; },
    f => { f.config.policies.fallbackApprovals.de.operatorApproved = false; },
    f => { f.config.policies.fallbackApprovals.de.version = 'other'; },
    f => { f.config.policies.fallbackApprovals.de.reviewedLocale = 'fr'; },
    f => { f.config.policies.fallbackApprovals.es = { ...f.config.policies.fallbackApprovals.de }; },
    f => { f.config.policies.admittedLocales.de.fallback = false; },
    f => { f.config.policies.admittedLocales.de.version = 'other'; },
    f => { f.config.policies.admittedLocales.de.usageSha256 = 'a'.repeat(64); },
    f => { delete f.config.policies.admittedLocales.en; },
    f => { f.config.policies.admittedLocales.en.fallback = true; },
    f => { f.sessions.de.json.policies.fallback = false; },
    f => { f.sessions.de.json.policies.reviewedLocale = 'de'; },
  ];
  for (const mutate of mutations) {
    const f = fallbackFixture(); mutate(f);
    await assert.rejects(preflight(f.config, f.get, now));
    assert.equal(f.reads.some(read => read.path === '/api/v1/searches'), false);
  }
});

test('release JSON rejects duplicate and escaped-equivalent locale keys instead of dropping an approval', t => {
  const directory = mkdtempSync(join(tmpdir(), 'justup-policy-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'gate.json'), f = fixture();
  const text = JSON.stringify(f.config);
  writeFileSync(path, text);
  assert.deepEqual(loadGateConfig(path), f.config);
  for (const repeated of ['"en":{},"en":', '"\\u0065n":{},"en":']) {
    writeFileSync(path, text.replace('"admittedLocales":{"en":', `"admittedLocales":{${repeated}`));
    assert.throws(() => loadGateConfig(path), /configuration is missing or invalid/);
  }
});

test('the generated product-draft-5 pages cannot pass an approved release even with matching hashes', async () => {
  const { policyDocuments } = await import('../../web/policies/render.ts');
  const documents = policyDocuments(), f = fixture();
  for (const locale of locales) {
    const entry = f.config.policies.admittedLocales[locale];
    entry.version = 'product-draft-5';
    for (const kind of ['privacy', 'usage']) {
      const path = policyPath(kind, locale);
      f.data[path].bytes = Buffer.from(documents.get(path));
      entry[`${kind}Sha256`] = digest(f.data[path].bytes);
    }
    f.sessions[locale].json.policies = runtimePolicy(entry);
  }
  await assert.rejects(preflight(f.config, f.get, now), /unreviewed/);
  assert.equal(f.reads.some(read => read.path === '/api/v1/searches'), false);
});

test('disposable cleanup refuses foreign users and changed account ids, and removes only its own generated account', async () => {
  for (const user of [{ id: 'foreign', username: 'another' }, { id: 'other-id', username: 'gate-owned' }]) {
    let writes = 0;
    const account = { username: 'gate-owned', password: 'generated-only', id: 'own-id', attempted: true, deleted: false };
    await assert.rejects(cleanupAccount(account, { session: async () => ({ user }), login: async () => { writes++; }, remove: async () => { writes++; } }));
    assert.equal(writes, 0);
  }
  const account = disposableAccount(); account.attempted = true;
  let removed = false, loggedIn = false;
  await cleanupAccount(account, {
    session: async () => ({ user: removed || !loggedIn ? null : { id: 'owned', username: account.username }, csrfToken: 'token' }),
    login: async (username, password) => {
      assert.equal(username === account.username && password === account.password, true);
      if (removed) return { status: 401 };
      loggedIn = true;
      return { status: 200, json: { user: { id: 'owned', username: account.username }, csrfToken: 'token' } };
    },
    remove: async (password, csrf) => { assert.equal(password === account.password && csrf === 'token', true); removed = true; return 200; },
  });
  assert.equal(account.deleted, true);
  await assert.rejects(cleanupAccount({ ...account, id: null, deleted: false }, { session: async () => ({ user: null, csrfToken: 'token' }), login: async () => ({ status: 401 }) }), /cleanup login failed/);
  let calls = 0;
  await cleanupAccount({ ...account, attempted: false, deleted: false }, { session: async () => { calls++; } });
  assert.equal(calls, 0);
});
test('withdrawn policy blocks processing while exact-candidate owned-account cleanup still attempts deletion', async () => {
  const f = fixture();
  const closed = { ...f.sessions.en.json.policies, reviewed: false, reviewedLocale: null };
  let processed = false;
  assert.throws(() => {
    verifyPolicyState(f.config, closed, 'en');
    processed = true;
  }, /policy review/);
  assert.equal(processed, false);
  const account = { username: 'gate-owned', password: 'generated-only', id: 'own-id', attempted: true, deleted: false };
  let removed = false, loginAttempts = 0;
  await assert.rejects(cleanupCandidateAccount(f.config, account, {
    read: f.get,
    session: async () => ({ user: removed ? null : { id: account.id, username: account.username }, csrfToken: 'token', policies: closed, authentication: { loginEnabled: false } }),
    remove: async (password, csrf) => {
      assert.equal(password, account.password);
      assert.equal(csrf, 'token');
      removed = true;
      return 200;
    },
    login: async () => { assert.equal(removed, true); loginAttempts++; return { status: 503, json: { error: { code: 'policy_unavailable' } } }; },
  }, now), /deletion was not confirmed/);
  assert.equal(removed, true, 'Policy closure must not prevent the permitted owned-account deletion attempt.');
  assert.equal(loginAttempts, 1, 'No login is attempted before deleting the still-owned signed-in account.');
  assert.equal(account.deleted, false, 'Closed login admission cannot be mistaken for credential-based deletion proof.');
  assert.deepEqual(f.reads.map(read => read.path), ['/__release/version', '/api/v1/version', '/api/v1/health']);
});

test('candidate identity evaluates heartbeat time after its bounded reads complete', async () => {
  const f = fixture();
  let at = now;
  await verifyCandidateBuilds(f.config, async path => {
    at += 2000;
    const response = await f.get(path);
    if (response.json.runner) response.json.runner.lastHeartbeat = new Date(at).toISOString();
    return response;
  }, () => at);
});

test('cleanup retains exact candidate and account ownership guards independently of policy admission', async () => {
  for (const changed of ['build', 'owner']) {
    const f = fixture();
    if (changed === 'build') f.data['/api/v1/version'].json.buildIdentity = 'other-build';
    const account = { username: 'gate-owned', password: 'generated-only', id: 'own-id', attempted: true, deleted: false };
    let mutations = 0;
    await assert.rejects(cleanupCandidateAccount(f.config, account, {
      read: f.get,
      session: async () => ({ user: { id: 'foreign', username: 'another' } }),
      login: async () => { mutations++; }, remove: async () => { mutations++; },
    }, now));
    assert.equal(mutations, 0);
  }
});

test('live mode disables automatic context copies and media while default CI keeps its fixture suite', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'justup-gate-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'gate.json'); writeFileSync(path, JSON.stringify(fixture().config));
  const names = ['JUSTUP_ACCEPTANCE_CONFIG', 'JUSTUP_ACCEPTANCE_INVITE', 'JUSTUP_SMOKE_URL', 'PLAYWRIGHT_NO_COPY_PROMPT'];
  const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    const url = pathToFileURL(join(process.cwd(), 'playwright.config.mjs')).href;
    const normal = (await import(`${url}?fixture-contract`)).default;
    assert.equal(normal.use.trace, 'retain-on-failure');
    assert.ok(normal.testIgnore.includes('**/acceptance.spec.mjs'));
    process.env.JUSTUP_ACCEPTANCE_CONFIG = path;
    process.env.JUSTUP_ACCEPTANCE_INVITE = 'synthetic-invite';
    const live = (await import(`${url}?live-contract`)).default;
    assert.equal(live.testMatch, '**/acceptance.spec.mjs');
    assert.equal(live.webServer, undefined);
    assert.equal(live.use.trace, 'off'); assert.equal(live.use.screenshot, 'off'); assert.equal(live.use.video, 'off');
    assert.equal(process.env.PLAYWRIGHT_NO_COPY_PROMPT, '1');
    // Discovery only: prove the real acceptance module declares all five isolated journeys.
    // --list never opens a browser, registers accounts or calls a provider.
    const listed = spawnSync(process.execPath, [join(process.cwd(), 'node_modules/@playwright/test/cli.js'), 'test', '--list'], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(listed.status, 0, 'Acceptance discovery failed.');
    for (const locale of locales) assert.ok(listed.stdout.includes(`${locale} fixed deployed candidate`), locale);
    assert.match(listed.stdout, /Total: 5 tests in 1 file/);

    process.env.JUSTUP_ACCEPTANCE_CONFIG = '';
    await assert.rejects(import(`${url}?empty-live-contract`), /configuration is missing or invalid/);
    process.env.JUSTUP_ACCEPTANCE_CONFIG = path;
    delete process.env.JUSTUP_ACCEPTANCE_INVITE;
    await assert.rejects(import(`${url}?missing-invite-contract`), /protected process environment/);
  } finally {
    for (const [name, value] of Object.entries(old)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});
