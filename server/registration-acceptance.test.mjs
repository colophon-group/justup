// Registration acceptance at the real HTTP/SQLite boundary; no provider is used.
// Run when changing account admission, policy identity or private deletion.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import test from 'node:test';
import { createApplication } from './main.mjs';
import { createAuth } from './auth.mjs';
import { POLICY_LOCALES, policyScopes } from './policies.mjs';
import { syntheticPolicyProof } from './policy-test-fixtures.mjs';

const PASSWORD = 'A synthetic account password';
const ORIGIN = 'https://preview.justup.work';
const VERSION = '2026-11-01';
const START = Date.parse('2026-11-01T19:00:00Z');
const acceptance = (locale = 'en') => ({ usageVersion: VERSION, locale, adultAndCapable: true });

async function fixture(t, extra = {}) {
  const config = { dbPath: ':memory:', allowedOrigin: ORIGIN, requiresInvitation: false,
    sourceCommit: 'a'.repeat(40), buildIdentity: 'b'.repeat(64), policiesReviewed: true,
    policyVersion: VERSION, csrfSecret: 'c'.repeat(32), rateLimits: { auth: 100, mutation: 100 },
    policyLocales: Object.fromEntries(POLICY_LOCALES.map(locale => {
      const suffix = locale === 'en' ? '' : `.${locale}`;
      return [locale, { privacyUrl: `${ORIGIN}/privacy${suffix}.html`, usageUrl: `${ORIGIN}/usage${suffix}.html`, version: VERSION, reviewed: true }];
    })),
    policyAssetProof: syntheticPolicyProof({ origin: ORIGIN, sourceCommit: 'a'.repeat(40), version: VERSION, locales: POLICY_LOCALES }),
    ...extra.config };
  const app = await createApplication({ config, now: () => START, authFactory: extra.authFactory });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  async function guest(locale = 'en') {
    const res = await fetch(`${base}/session`, { headers: { 'X-Justup-Locale': locale } });
    const body = await res.json();
    return { body, cookie: res.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
  }
  async function register(input, locale = 'en') {
    const session = await guest(locale);
    const res = await fetch(`${base}/auth/register`, { method: 'POST',
      headers: { Origin: ORIGIN, Cookie: session.cookie, 'X-CSRF-Token': session.body.csrfToken,
        'X-Justup-Locale': locale, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    return { status: res.status, body: await res.json(), cookie: res.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
  }
  return { app, config, base, guest, register };
}

test('registration requires affirmative current-version adult/capacity acceptance before storing an account', async t => {
  const f = await fixture(t);
  const credentials = { username: 'reader', password: PASSWORD };
  for (const declaration of [undefined, null, {}, { ...acceptance(), adultAndCapable: false },
    { ...acceptance(), adultAndCapable: 'true' }, { ...acceptance(), usageVersion: 'older' },
    { ...acceptance(), locale: 'de' }, { ...acceptance(), dateOfBirth: '2000-01-01' }]) {
    const result = await f.register({ ...credentials, ...(declaration === undefined ? {} : { acceptance: declaration }) });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'invalid_input');
    assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM auth_accounts').get().n, 0);
    assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM auth_sessions').get().n, 0);
  }
});

test('all five locales bind acceptance to exact admitted notice bytes and registration grants no free time', async t => {
  const f = await fixture(t);
  for (const locale of POLICY_LOCALES) {
    const result = await f.register({ username: `reader-${locale}`, password: PASSWORD, acceptance: acceptance(locale) }, locale);
    assert.equal(result.status, 201);
    assert.equal(result.body.access.kind, 'limited');
    assert.equal(result.body.access.fullAccess, false);
    assert.equal(result.body.access.canActivateFreePeriod, false);
    const row = f.app.store.db.prepare('SELECT * FROM auth_registration_acceptance WHERE account_id=?').get(result.body.user.id);
    assert.equal(row.accepted_at, START);
    assert.equal(row.usage_version, VERSION);
    assert.equal(row.locale, locale);
    assert.equal(row.reviewed_locale, locale);
    assert.equal(row.adult_and_capable, 1);
    assert.deepEqual(JSON.parse(row.policy_scope_json), policyScopes(f.config)[locale]);
    assert.equal(JSON.stringify(result.body).includes('adult_and_capable'), false);
  }
  assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM access_free_periods').get().n, 0);
});

test('policy replacement during password work rolls back registration and its acceptance', async t => {
  let config;
  const f = await fixture(t, { authFactory: options => {
    config = options.config;
    const auth = createAuth(options), register = auth.register;
    return { ...auth, register: (...args) => {
      const pending = register(...args);
      config.policyAssetProof.locales.en.usageSha256 = 'e'.repeat(64);
      return pending;
    } };
  } });
  const result = await f.register({ username: 'reader', password: PASSWORD, acceptance: acceptance() });
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'policy_unavailable');
  for (const table of ['auth_accounts', 'auth_sessions', 'auth_registration_acceptance']) {
    assert.equal(f.app.store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  }
});

test('a failed synchronous handoff rolls back the account, acceptance and session together', async t => {
  const f = await fixture(t, { authFactory: options => {
    const auth = createAuth(options);
    return { ...auth, register: (input, registration) => auth.register(input, { ...registration,
      afterAuthenticated: context => {
        registration.afterAuthenticated(context);
        assert.equal(options.db.prepare('SELECT count(*) n FROM auth_registration_acceptance').get().n, 1);
        throw Object.assign(new Error('Synthetic handoff failure.'), { code: 'dependency_unavailable', status: 503 });
      } }) };
  } });
  const result = await f.register({ username: 'reader', password: PASSWORD, acceptance: acceptance() });
  assert.equal(result.status, 503);
  for (const table of ['auth_accounts', 'auth_sessions', 'auth_registration_acceptance']) {
    assert.equal(f.app.store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  }
});

test('an approved fallback stores both requested language and the actual reviewed notice language', async t => {
  const f = await fixture(t);
  f.config.policyLocales.de.reviewed = false;
  f.config.policyFallbacks = { de: 'en' };
  const result = await f.register({ username: 'fallback-reader', password: PASSWORD, acceptance: acceptance('de') }, 'de');
  assert.equal(result.status, 201);
  const row = f.app.store.db.prepare('SELECT * FROM auth_registration_acceptance').get();
  assert.equal(row.locale, 'de');
  assert.equal(row.reviewed_locale, 'en');
  assert.deepEqual(JSON.parse(row.policy_scope_json), policyScopes(f.config).de);
});

test('acceptance survives reopen and failed deletion; final deletion erases it through the private barrier', async t => {
  const root = mkdtempSync(join(tmpdir(), 'justup-registration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const backupDir = join(root, 'backups'), privateGenerationPath = join(root, 'private-generation');
  mkdirSync(backupDir, { mode: 0o700 });
  writeFileSync(privateGenerationPath, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n', { mode: 0o600 });
  const f = await fixture(t, { config: { dbPath: join(root, 'accounts.sqlite'), backupDir, privateGenerationPath } });
  const older = await f.app.auth.register({ username: 'older-account', password: PASSWORD });
  f.app.store.db.exec('DROP TABLE auth_registration_acceptance');
  // Existing epoch-2 storage acquires only the empty feature-owned table.
  createAuth({ db: f.app.store.db, config: f.config, now: () => START });
  assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM auth_registration_acceptance').get().n, 0);
  const result = await f.register({ username: 'reader', password: PASSWORD, acceptance: acceptance() });
  assert.equal(result.status, 201);
  const before = f.app.store.db.prepare('SELECT * FROM auth_registration_acceptance').get();
  const reopenedDb = new DatabaseSync(f.config.dbPath);
  t.after(() => reopenedDb.close());
  const reopened = createAuth({ db: reopenedDb, config: f.config, now: () => START });
  assert.deepEqual(reopenedDb.prepare('SELECT * FROM auth_registration_acceptance').get(), before);
  assert.deepEqual(f.app.store.db.prepare('SELECT * FROM auth_registration_acceptance').get(), before);
  assert.equal(f.app.store.db.prepare('SELECT * FROM auth_registration_acceptance WHERE account_id=?').get(older.account.id), undefined);
  reopened.invalidateAllSessions();
  assert.deepEqual(f.app.store.db.prepare('SELECT * FROM auth_registration_acceptance').get(), before);
  const owner = await f.app.auth.login({ username: 'reader', password: PASSWORD });
  const priorGeneration = readFileSync(privateGenerationPath, 'utf8');
  writeFileSync(join(backupDir, 'failed-delete.sqlite'), 'synthetic earlier bytes', { mode: 0o600 });
  const failingDelete = createAuth({ db: f.app.store.db, config: f.config, now: () => START,
    deleteAccountData: accountId => {
      f.app.beforePrivateDelete();
      f.app.store.db.prepare('DELETE FROM auth_registration_acceptance WHERE account_id=?').run(accountId);
      throw new Error('Synthetic synchronous deletion failure.');
    } });
  await assert.rejects(failingDelete.deleteAccount(owner.token, PASSWORD), /Synthetic synchronous deletion failure/);
  f.app.afterPrivateTransaction();
  assert.deepEqual(f.app.store.db.prepare('SELECT * FROM auth_registration_acceptance').get(), before);
  assert.ok(f.app.auth.session(owner.token));
  assert.notEqual(readFileSync(privateGenerationPath, 'utf8'), priorGeneration);
  assert.deepEqual(readdirSync(backupDir), []);
  const generation = readFileSync(privateGenerationPath, 'utf8');
  writeFileSync(join(backupDir, 'prior.sqlite'), 'synthetic earlier bytes', { mode: 0o600 });
  await f.app.auth.deleteAccount(owner.token, PASSWORD);
  f.app.afterPrivateTransaction();
  assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM auth_registration_acceptance').get().n, 0);
  assert.notEqual(readFileSync(privateGenerationPath, 'utf8'), generation);
  assert.deepEqual(readdirSync(backupDir), []);
});
