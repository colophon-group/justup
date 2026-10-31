// Deterministic preflight/ownership contracts; these never contact a deployed service.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateGateConfig, loadGateConfig, requireInvite, preflight, cleanupAccount, disposableAccount } from '../../tests/browser/release-gate.mjs';

const now = Date.parse('2026-10-31T12:00:00Z');
function fixture() {
  const policy = Buffer.from('reviewed policy fixture');
  const config = {
    origin: 'https://candidate.example',
    frontend: { sourceSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), assetsSha256: 'c'.repeat(64), workerSha256: 'd'.repeat(64), artifactSha256: 'e'.repeat(64), runtimeConfigSha256: 'f'.repeat(64) },
    api: { sourceCommit: 'a'.repeat(40), schemaVersion: 1, buildIdentity: 'build-fixed', runnerIdentity: 'runner-fixed', importGeneration: '00000000-0000-4000-8000-000000000000' },
    policies: { version: 'reviewed-v1', privacySha256: createHash('sha256').update(policy).digest('hex'), usageSha256: createHash('sha256').update(policy).digest('hex') },
    scenario: { query: 'Reviewed query', warnedQuery: 'Reviewed query plus unsupported requirement', companyId: 'company-fixed', companyName: 'Company', sourceUrl: 'https://employer.example/careers/one' },
  };
  const coverage = { kind: 'imported_snapshot', stale: false, verifiedAt: new Date(now - 1000).toISOString() };
  const runner = { ready: true, identity: 'runner-fixed', sourceCommit: config.api.sourceCommit, buildIdentity: config.api.buildIdentity, lastHeartbeat: new Date(now - 1000).toISOString() };
  const data = {
    '/__preview/version': { status: 200, json: { ...config.frontend } },
    '/api/v1/version': { status: 200, json: { ...config.api, runner: { ...runner } } },
    '/api/v1/health': { status: 200, json: { ready: true, runner: { ...runner }, coverage } },
    '/api/v1/session': { status: 200, json: { user: null, access: { fullAccess: false, billingEnabled: false }, serverTime: new Date(now).toISOString(), authentication: { method: 'username_password', loginEnabled: true, registrationEnabled: true }, policies: { reviewed: true, version: 'reviewed-v1', privacyUrl: 'https://candidate.example/privacy.html', usageUrl: 'https://candidate.example/usage.html' }, capabilities: { search: true, companyRequests: true }, coverage } },
    '/api/v1/searches': { status: 401, json: { error: { code: 'unauthenticated' } } },
    '/api/v1/jobs?limit=12': { status: 200, json: { asOf: new Date(now).toISOString(), items: [{ firstObserved: new Date(now - 3 * 86_400_000).toISOString() }], coverage } },
    '/privacy.html': { status: 200, bytes: policy },
    '/usage.html': { status: 200, bytes: policy },
    '/api/v1/companies?q=Company': { status: 200, json: { items: [{ id: 'company-fixed', name: 'Company', coverage: { state: 'imported_snapshot' } }] } },
  };
  return { config, data, get: async path => data[path] };
}
test('invalid configuration and mismatched deployed evidence fail before the registration boundary', async () => {
  const mutations = [
    f => { f.config.origin = 'http://candidate.example'; },
    f => { f.config.frontend.sourceSha = 'moving-branch'; },
    f => { f.config.api.sourceCommit = 'b'.repeat(40); },
    f => { f.data['/__preview/version'].json.artifactSha256 = '0'.repeat(64); },
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
    process.env.JUSTUP_ACCEPTANCE_CONFIG = '';
    await assert.rejects(import(`${url}?empty-live-contract`), /configuration is missing or invalid/);
    process.env.JUSTUP_ACCEPTANCE_CONFIG = path;
    delete process.env.JUSTUP_ACCEPTANCE_INVITE;
    await assert.rejects(import(`${url}?missing-invite-contract`), /protected process environment/);
  } finally {
    for (const [name, value] of Object.entries(old)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});
