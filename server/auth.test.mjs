// Observable account/session contracts using isolated SQLite and a fixed clock.
// Run with Node 24: node --test server/auth.test.mjs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createAuth } from './auth.mjs';

const PASSWORD = 'only-a-test-password';
const INVITE = 'only-a-test-invitation';
const START = Date.UTC(2026, 9, 31, 12);
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  let timestamp = START;
  const auth = createAuth({
    db,
    now: () => timestamp,
    config: { inviteCode: INVITE, ...options.config },
    deleteAccountData: options.deleteAccountData?.(db),
  });
  t.after(() => db.close());
  return {
    db, auth,
    setTime: (value) => { timestamp = value; },
    register: (username = 'tester') => auth.register({ username, password: PASSWORD, inviteCode: INVITE }),
  };
}

function errorWith(code, status) {
  return (error) => {
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  };
}

test('registration and case-insensitive login issue opaque sessions with demo-only access', async (t) => {
  const { db, auth, register } = fixture(t);
  const signedUp = await register('  TeStEr  ');
  assert.equal(signedUp.account.username, 'tester');
  assert.match(signedUp.account.id, /^[a-f0-9-]{36}$/);
  assert.match(signedUp.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(signedUp.token, 'base64url').length, 32);
  assert.equal(signedUp.expiresAt, START + SEVEN_DAYS);
  const signedIn = await auth.login({ username: 'TESTER', password: PASSWORD });
  assert.deepEqual(signedIn.account, signedUp.account);
  assert.notEqual(signedIn.token, signedUp.token);
  assert.deepEqual(auth.session(signedIn.token), {
    account: signedUp.account,
    expiresAt: START + SEVEN_DAYS,
    access: { kind: 'demo', fullAccess: true, legacy: false, billingEnabled: false, until: null },
  });

  const stored = db.prepare('SELECT * FROM auth_accounts').get();
  assert.equal(stored.password_salt.length, 16);
  assert.equal(stored.password_hash.length, 64);
  assert.notEqual(Buffer.from(stored.password_hash).toString(), PASSWORD);
  const sessionHashes = db.prepare('SELECT token_hash FROM auth_sessions').all();
  assert.equal(sessionHashes.length, 2);
  assert.ok(sessionHashes.some((row) => Buffer.from(row.token_hash).equals(
    createHash('sha256').update(signedIn.token).digest(),
  )));
  assert.ok(sessionHashes.every((row) => Buffer.from(row.token_hash).toString() !== signedIn.token));
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM auth_accounts').all()).includes(INVITE));
});

test('a session expires at its fixed deadline and cannot be extended by reads', async (t) => {
  const { auth, register, setTime } = fixture(t);
  const { token, expiresAt } = await register();
  setTime(expiresAt - 1);
  assert.equal(auth.session(token).expiresAt, expiresAt);
  setTime(expiresAt);
  assert.equal(auth.session(token), null);
  await assert.rejects(auth.deleteAccount(token, PASSWORD), errorWith('unauthenticated', 401));
  const next = await auth.login({ username: 'tester', password: PASSWORD });
  assert.equal(next.expiresAt, expiresAt + SEVEN_DAYS);
});

test('logout revokes only its own session and repeated or invalid logout is harmless', async (t) => {
  const { auth, register } = fixture(t);
  const first = await register();
  const second = await auth.login({ username: 'tester', password: PASSWORD });
  auth.logout(first.token);
  auth.logout(first.token);
  auth.logout(undefined);
  assert.equal(auth.session(first.token), null);
  assert.ok(auth.session(second.token));
  for (const token of [undefined, null, '', 'invalid', 'x'.repeat(43), {}, 1]) {
    assert.equal(auth.session(token), null);
  }
});

test('registration fails closed without a configured invitation', async (t) => {
  for (const inviteCode of [undefined, '']) {
    const { auth, db } = fixture(t, { config: { inviteCode } });
    await assert.rejects(auth.register({ username: 'tester', password: PASSWORD, inviteCode: INVITE }),
      errorWith('registration_closed', 403));
    assert.equal(db.prepare('SELECT count(*) AS n FROM auth_accounts').get().n, 0);
  }
});

test('registration bounds its input and denies a wrong invitation without storing data', async (t) => {
  const { auth, db } = fixture(t);
  const valid = { username: 'tester', password: PASSWORD, inviteCode: INVITE };
  for (const input of [null, {}, { ...valid, username: 'ab' }, { ...valid, username: 'x'.repeat(33) },
    { ...valid, username: 'a@example.com' }, { ...valid, username: 'téstér' },
    { ...valid, password: 'short' }, { ...valid, password: 'x'.repeat(257) },
    { ...valid, password: '😀'.repeat(65) }, { ...valid, inviteCode: '' },
    { ...valid, inviteCode: 'x'.repeat(257) }]) {
    await assert.rejects(auth.register(input), errorWith('invalid_input', 400));
  }
  await assert.rejects(auth.register({ ...valid, inviteCode: 'another-test-invite' }),
    errorWith('invalid_credentials', 401));
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_accounts').get().n, 0);
});

test('login gives one fixed failure for missing users and wrong or malformed passwords', async (t) => {
  const { auth, register } = fixture(t);
  await register();
  const failures = [];
  for (const input of [
    { username: 'tester', password: 'different-test-password' },
    { username: 'unknown', password: PASSWORD },
    { username: 'tester', password: 'short' }, null,
  ]) {
    await assert.rejects(auth.login(input), (error) => {
      errorWith('invalid_credentials', 401)(error);
      failures.push(error.message);
      return true;
    });
  }
  assert.equal(new Set(failures).size, 1);
  assert.ok(failures.every((message) => !message.includes(PASSWORD)));
});

test('duplicate usernames are case-insensitive and the account cap holds during concurrent registration', async (t) => {
  const { auth, register, db } = fixture(t, { config: { maxAccounts: 2 } });
  await register('first');
  await assert.rejects(register('FIRST'), errorWith('username_taken', 409));
  const results = await Promise.allSettled([register('second'), register('third'), register('fourth')]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  for (const result of results.filter((entry) => entry.status === 'rejected')) {
    errorWith('account_limit', 403)(result.reason);
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_accounts').get().n, 2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_sessions').get().n, 2);
});

test('each account gets its own password salt even with the same password', async (t) => {
  const { db, register } = fixture(t);
  await register('first');
  await register('second');
  const rows = db.prepare('SELECT password_salt, password_hash FROM auth_accounts').all();
  assert.notDeepEqual(rows[0].password_salt, rows[1].password_salt);
  assert.notDeepEqual(rows[0].password_hash, rows[1].password_hash);
});

test('account deletion requires the current password, removes private rows and revokes all sessions', async (t) => {
  const removed = [];
  const { db, auth, register } = fixture(t, {
    deleteAccountData: (database) => {
      database.exec('CREATE TABLE private_rows (account_id TEXT NOT NULL, value TEXT) STRICT');
      return (id) => {
        // The callback participates in the same database transaction.
        assert.equal(database.prepare('SELECT count(*) AS n FROM auth_sessions WHERE account_id = ?').get(id).n, 0);
        database.prepare('DELETE FROM private_rows WHERE account_id = ?').run(id);
        removed.push(id);
      };
    },
  });
  const signedUp = await register();
  const second = await auth.login({ username: 'tester', password: PASSWORD });
  db.prepare('INSERT INTO private_rows VALUES (?, ?)').run(signedUp.account.id, 'test-private-data');
  await assert.rejects(auth.deleteAccount(signedUp.token, 'incorrect-test-password'), errorWith('invalid_credentials', 401));
  await assert.rejects(auth.deleteAccount(signedUp.token, 'short'), errorWith('invalid_credentials', 401));
  assert.ok(auth.session(signedUp.token));
  assert.ok(auth.session(second.token));
  assert.equal(db.prepare('SELECT count(*) AS n FROM private_rows').get().n, 1);
  assert.deepEqual(await auth.deleteAccount(signedUp.token, PASSWORD), { deleted: true });
  assert.deepEqual(removed, [signedUp.account.id]);
  assert.equal(auth.session(signedUp.token), null);
  assert.equal(auth.session(second.token), null);
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_accounts').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_sessions').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM private_rows').get().n, 0);
  await assert.rejects(auth.login({ username: 'tester', password: PASSWORD }), errorWith('invalid_credentials', 401));
  await assert.rejects(auth.deleteAccount(signedUp.token, PASSWORD), errorWith('unauthenticated', 401));
  assert.ok((await register()).account.id !== signedUp.account.id);
});

test('a deletion callback failure rolls back its data writes, session revocation and account deletion', async (t) => {
  const { db, auth, register } = fixture(t, {
    deleteAccountData: (database) => {
      database.exec('CREATE TABLE private_rows (account_id TEXT NOT NULL) STRICT');
      return (id) => {
        database.prepare('DELETE FROM private_rows WHERE account_id = ?').run(id);
        throw new Error('Deliberate test callback failure.');
      };
    },
  });
  const { account, token } = await register();
  db.prepare('INSERT INTO private_rows VALUES (?)').run(account.id);
  await assert.rejects(auth.deleteAccount(token, PASSWORD), /Deliberate test callback failure/);
  assert.ok(auth.session(token));
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_accounts').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM private_rows').get().n, 1);
});

test('an asynchronous deletion callback is rejected and its synchronous data writes roll back', async (t) => {
  const { auth, db, register } = fixture(t, {
    deleteAccountData: (database) => {
      database.exec('CREATE TABLE private_rows (account_id TEXT NOT NULL) STRICT');
      return (id) => {
        database.prepare('DELETE FROM private_rows WHERE account_id = ?').run(id);
        return Promise.resolve();
      };
    },
  });
  const { account, token } = await register();
  db.prepare('INSERT INTO private_rows VALUES (?)').run(account.id);
  await assert.rejects(auth.deleteAccount(token, PASSWORD), /must be synchronous/);
  assert.ok(auth.session(token));
  assert.equal(db.prepare('SELECT count(*) AS n FROM private_rows').get().n, 1);
});

test('a logout while password verification is in flight prevents account deletion', async (t) => {
  let deletions = 0;
  const { auth, register } = fixture(t, { deleteAccountData: () => () => { deletions += 1; } });
  const { token } = await register();
  const deletion = auth.deleteAccount(token, PASSWORD);
  auth.logout(token);
  await assert.rejects(deletion, errorWith('unauthenticated', 401));
  assert.equal(deletions, 0);
  assert.ok(await auth.login({ username: 'tester', password: PASSWORD }));
});

test('deletion while login verification is in flight cannot create an orphan session', async (t) => {
  const { auth, db, register } = fixture(t);
  const { account } = await register();
  const login = auth.login({ username: 'tester', password: PASSWORD });
  db.prepare('DELETE FROM auth_sessions WHERE account_id = ?').run(account.id);
  db.prepare('DELETE FROM auth_accounts WHERE id = ?').run(account.id);
  await assert.rejects(login, errorWith('invalid_credentials', 401));
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_sessions').get().n, 0);
});

test('auth can reopen the same schema and an explicitly configured session lifetime is enforced', async (t) => {
  const { auth, db, register, setTime } = fixture(t, { config: { sessionTtlMs: 1000 } });
  const { token, expiresAt } = await register();
  const reopened = createAuth({ db, now: () => START, config: { inviteCode: INVITE } });
  assert.deepEqual(reopened.session(token), auth.session(token));
  assert.equal(expiresAt, START + 1000);
  setTime(expiresAt);
  assert.equal(auth.session(token), null);
});

test('invalid configuration fails before accepting authentication work', (t) => {
  for (const config of [{ maxAccounts: 0 }, { maxAccounts: 1.5 }, { sessionTtlMs: -1 },
    { sessionTtlMs: Infinity }, { accountTtlMs: 0 }, { accountTtlMs: THIRTY_DAYS + 1 },
    { accountTtlMs: Infinity }, { inviteCode: true }, { inviteCode: 'x'.repeat(257) }]) {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    assert.throws(() => createAuth({ db, config }), /Invalid authentication configuration/);
  }
});

test('accounts deny login and session access at 30 days before cleanup, including in-flight login', async (t) => {
  const { auth, db, register, setTime } = fixture(t);
  await register();
  setTime(START + THIRTY_DAYS - 1);
  const signedIn = await auth.login({ username: 'tester', password: PASSWORD });
  assert.equal(signedIn.expiresAt, START + THIRTY_DAYS);
  assert.ok(auth.session(signedIn.token));
  // Even a session row with a later deadline cannot extend the account's life.
  db.prepare('UPDATE auth_sessions SET expires_at = ?').run(START + THIRTY_DAYS + SEVEN_DAYS);
  const pendingLogin = auth.login({ username: 'tester', password: PASSWORD });
  setTime(START + THIRTY_DAYS);
  assert.equal(auth.session(signedIn.token), null);
  await assert.rejects(pendingLogin, errorWith('invalid_credentials', 401));
  await assert.rejects(auth.login({ username: 'tester', password: PASSWORD }), errorWith('invalid_credentials', 401));
  await assert.rejects(auth.deleteAccount(signedIn.token, PASSWORD), errorWith('unauthenticated', 401));
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_accounts').get().n, 1);
});

test('a shorter account deadline caps sessions and cleanup revokes tokens and deletes only expired private data', async (t) => {
  const removed = [];
  const { auth, db, register, setTime } = fixture(t, {
    config: { accountTtlMs: 1000, sessionTtlMs: 500 },
    deleteAccountData: (database) => {
      database.exec('CREATE TABLE private_rows (account_id TEXT NOT NULL) STRICT');
      return (id) => {
        assert.equal(database.prepare('SELECT count(*) AS n FROM auth_sessions WHERE account_id = ?').get(id).n, 0);
        database.prepare('DELETE FROM private_rows WHERE account_id = ?').run(id);
        removed.push(id);
      };
    },
  });
  const old = await register('older');
  setTime(START + 500);
  const live = await register('newer');
  for (const account of [old.account, live.account]) db.prepare('INSERT INTO private_rows VALUES (?)').run(account.id);
  setTime(START + 999);
  const oldSession = await auth.login({ username: 'older', password: PASSWORD });
  const liveSession = await auth.login({ username: 'newer', password: PASSWORD });
  assert.equal(oldSession.expiresAt, START + 1000);
  assert.deepEqual(auth.cleanup(), { accountsDeleted: 0, sessionsDeleted: 0 });
  setTime(START + 1000);
  assert.deepEqual(auth.cleanup(), { accountsDeleted: 1, sessionsDeleted: 2 });
  assert.deepEqual(removed, [old.account.id]);
  assert.equal(auth.session(oldSession.token), null);
  assert.equal(auth.session(live.token), null);
  assert.ok(auth.session(liveSession.token));
  assert.deepEqual(db.prepare('SELECT account_id FROM private_rows').all().map((row) => row.account_id), [live.account.id]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_accounts').get().n, 1);
  assert.deepEqual(auth.cleanup(), { accountsDeleted: 0, sessionsDeleted: 0 });
});

test('cleanup rolls back all accounts, private SQL and expired-session purges if a privacy barrier fails', async (t) => {
  let calls = 0;
  let fail = true;
  const { auth, db, register, setTime } = fixture(t, {
    config: { accountTtlMs: 1000 },
    deleteAccountData: (database) => {
      database.exec('CREATE TABLE private_rows (account_id TEXT NOT NULL) STRICT');
      return (id) => {
        calls += 1;
        if (fail && calls === 2) throw new Error('Deliberate test privacy barrier failure.');
        database.prepare('DELETE FROM private_rows WHERE account_id = ?').run(id);
      };
    },
  });
  const first = await register('first');
  setTime(START + 1);
  const second = await register('second');
  for (const account of [first.account, second.account]) db.prepare('INSERT INTO private_rows VALUES (?)').run(account.id);
  setTime(START + 2000);
  assert.throws(() => auth.cleanup(), /Deliberate test privacy barrier failure/);
  for (const table of ['auth_accounts', 'auth_sessions', 'private_rows']) {
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 2);
  }
  assert.equal(auth.session(first.token), null);
  fail = false;
  assert.deepEqual(auth.cleanup(), { accountsDeleted: 2, sessionsDeleted: 2 });
  assert.equal(db.prepare('SELECT count(*) AS n FROM private_rows').get().n, 0);
});

test('restore session invalidation returns only counts, revokes every token and preserves accounts', async (t) => {
  const { auth, db, register } = fixture(t);
  const first = await register('first');
  const second = await register('second');
  assert.deepEqual(auth.invalidateAllSessions(), { sessionsDeleted: 2 });
  assert.equal(auth.session(first.token), null);
  assert.equal(auth.session(second.token), null);
  assert.deepEqual(auth.invalidateAllSessions(), { sessionsDeleted: 0 });
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_accounts').get().n, 2);
  assert.ok(await auth.login({ username: 'first', password: PASSWORD }));
});

test('registration state exposes only availability and reflects invitation, cap and cleanup', async (t) => {
  const closed = fixture(t, { config: { inviteCode: '' } });
  assert.deepEqual(closed.auth.registrationState(), { enabled: false, reason: 'registration_closed' });
  const { auth, register, setTime } = fixture(t, { config: { maxAccounts: 1, accountTtlMs: 1000 } });
  assert.deepEqual(auth.registrationState(), { enabled: true, reason: null });
  await register();
  assert.deepEqual(auth.registrationState(), { enabled: false, reason: 'account_limit' });
  setTime(START + 1000);
  auth.cleanup();
  assert.deepEqual(auth.registrationState(), { enabled: true, reason: null });
});
