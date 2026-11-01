// Durable local accounts and SQLite sessions. Read when wiring authentication
// or retention cleanup; HTTP cookie, origin and rate-limit protections live upstream.
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { createEntitlements } from './entitlements.mjs';

const deriveKey = promisify(scrypt);
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SCRYPT_OPTIONS = Object.freeze({ N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
const ERROR_DETAILS = {
  invalid_input: [400, 'Invalid account input.'],
  invalid_credentials: [401, 'Invalid username, password or invite code.'],
  registration_closed: [403, 'Registration is closed.'],
  account_limit: [403, 'The account limit has been reached.'],
  username_taken: [409, 'That username is unavailable.'],
  unauthenticated: [401, 'Sign in to continue.'],
};

// Bound expensive work across all auth instances in this process. The HTTP
// boundary must rate-limit requests before they can join this queue.
let activeHashes = 0;
const hashWaiters = [];

async function passwordHash(password, salt) {
  if (activeHashes < 2) activeHashes += 1;
  else await new Promise((resolve) => hashWaiters.push(resolve));
  try {
    return await deriveKey(password, salt, 64, SCRYPT_OPTIONS);
  } finally {
    if (hashWaiters.length) hashWaiters.shift()();
    else activeHashes -= 1;
  }
}

function failure(code) {
  const [status, message] = ERROR_DETAILS[code];
  return Object.assign(new Error(message), { code, status });
}

function digest(value) {
  return createHash('sha256').update(value).digest();
}

function usernameValue(value) {
  if (typeof value !== 'string' || value.length > 128) return null;
  const username = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{2,31}$/.test(username) ? username : null;
}

function validPassword(value) {
  return typeof value === 'string' && value.length <= 256
    && Buffer.byteLength(value, 'utf8') <= 256 && [...value].length >= 12;
}

function boundedInvite(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && Buffer.byteLength(value, 'utf8') <= 256;
}

function tokenHash(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token) ? digest(token) : null;
}

function publicAccount(row) {
  return { id: row.id, username: row.username, expiresAt: row.account_expires_at == null ? null : new Date(row.account_expires_at).toISOString() };
}

export function createAuth({ db, config = {}, now = Date.now, deleteAccountData = () => {},
  identityProofVerifier = null, billingEventVerifier = null, onAccessTransition, beforeAccountDelete = () => true }) {
  const maxAccounts = config.maxAccounts === null ? null : config.maxAccounts ?? 30;
  const requiresInvitation = config.requiresInvitation ?? true;
  const sessionTtlMs = config.sessionTtlMs ?? SESSION_TTL_MS;
  const accountTtlMs = config.accountTtlMs ?? null;
  const accountExpiresAt = config.accountExpiresAt ?? null;
  if ((maxAccounts !== null && (!Number.isSafeInteger(maxAccounts) || maxAccounts < 1))
      || typeof requiresInvitation !== 'boolean'
      || !Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1 || sessionTtlMs > MAX_TIMESTAMP
      || (accountTtlMs !== null && (!Number.isSafeInteger(accountTtlMs) || accountTtlMs < 1 || accountTtlMs > MAX_TIMESTAMP))
      || (accountExpiresAt !== null && (!Number.isSafeInteger(accountExpiresAt) || accountExpiresAt < 1 || accountExpiresAt > MAX_TIMESTAMP))
      || typeof now !== 'function' || typeof deleteAccountData !== 'function' || typeof beforeAccountDelete !== 'function') {
    throw new TypeError('Invalid authentication configuration.');
  }
  if (config.inviteCode != null && config.inviteCode !== '' && !boundedInvite(config.inviteCode)) {
    throw new TypeError('Invalid authentication configuration.');
  }
  const inviteDigest = boundedInvite(config.inviteCode) ? digest(config.inviteCode) : null;
  const dummySalt = randomBytes(16);
  const dummyHash = randomBytes(64);

  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_accounts (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_salt BLOB NOT NULL,
      password_hash BLOB NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS auth_accounts_expiry ON auth_accounts(created_at);
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash BLOB PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS auth_sessions_account ON auth_sessions(account_id);
    CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);
  `);

  // Additive migration: existing identities become durable. A deployment policy
  // applies only when creating an account; reopening never invents a deadline.
  if (!db.prepare('PRAGMA table_info(auth_accounts)').all().some((column) => column.name === 'account_expires_at')) {
    db.exec('ALTER TABLE auth_accounts ADD COLUMN account_expires_at INTEGER CHECK(account_expires_at IS NULL OR account_expires_at > created_at)');
  }
  db.exec('CREATE INDEX IF NOT EXISTS auth_accounts_deadline ON auth_accounts(account_expires_at)');
  const entitlements = createEntitlements({ db, now, identityProofVerifier, billingEventVerifier, onAccessTransition });
  const byUsername = db.prepare('SELECT * FROM auth_accounts WHERE username = ?');
  const byId = db.prepare('SELECT * FROM auth_accounts WHERE id = ?');
  const sessionRow = db.prepare(`
    SELECT a.id, a.username, a.created_at, a.account_expires_at, s.expires_at
    FROM auth_sessions s JOIN auth_accounts a ON a.id = s.account_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND (a.account_expires_at IS NULL OR a.account_expires_at > ?)
  `);
  const insertSession = db.prepare(`
    INSERT INTO auth_sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)
  `);
  const removeSession = db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?');
  const removeExpired = db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?');
  const expiredAccounts = db.prepare('SELECT id FROM auth_accounts WHERE account_expires_at <= ? ORDER BY account_expires_at, id');
  const removeAllSessions = db.prepare('DELETE FROM auth_sessions');
  const removeAccountSessions = db.prepare('DELETE FROM auth_sessions WHERE account_id = ?');
  const removeAccount = db.prepare('DELETE FROM auth_accounts WHERE id = ?');
  const accountCount = db.prepare('SELECT count(*) AS count FROM auth_accounts');
  const insertAccount = db.prepare(`
    INSERT INTO auth_accounts (id, username, password_salt, password_hash, created_at, account_expires_at) VALUES (?, ?, ?, ?, ?, ?)
  `);

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function issueSession(account, timestamp) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Math.min(timestamp + sessionTtlMs, account.account_expires_at ?? Infinity);
    if (!Number.isSafeInteger(expiresAt) || expiresAt > MAX_TIMESTAMP) throw new TypeError('Invalid session deadline.');
    removeExpired.run(timestamp);
    insertSession.run(digest(token), account.id, timestamp, expiresAt);
    return { account: publicAccount(account), token, expiresAt };
  }

  function authenticatedCallback(options, accountId, phase) {
    const callback = options?.afterAuthenticated;
    if (callback == null) return;
    if (typeof callback !== 'function') throw new TypeError('Authentication handoff must be a function.');
    // The caller supplies this callback outside request JSON. It must use this
    // exact SQLite connection and finish before the account/session commit.
    const result = callback({ db, accountId, phase });
    if (result && typeof result.then === 'function') throw new TypeError('Authentication handoff must be synchronous.');
  }

  async function register(input, options = {}) {
    if ((requiresInvitation && !inviteDigest) || (accountExpiresAt !== null && accountExpiresAt <= now())) throw failure('registration_closed');
    const username = usernameValue(input?.username);
    const password = input?.password;
    const inviteCode = input?.inviteCode;
    if (!username || !validPassword(password) || (requiresInvitation && !boundedInvite(inviteCode))) throw failure('invalid_input');
    if (requiresInvitation && !timingSafeEqual(digest(inviteCode), inviteDigest)) throw failure('invalid_credentials');

    const salt = randomBytes(16);
    const hash = await passwordHash(password, salt);
    return transaction(() => {
      if (byUsername.get(username)) throw failure('username_taken');
      if (maxAccounts !== null && accountCount.get().count >= maxAccounts) throw failure('account_limit');
      const timestamp = now();
      const deadline = Math.min(accountTtlMs === null ? Infinity : timestamp + accountTtlMs, accountExpiresAt ?? Infinity);
      if (deadline !== Infinity && (!Number.isSafeInteger(deadline) || deadline > MAX_TIMESTAMP || deadline <= timestamp)) throw failure('registration_closed');
      const account = { id: randomUUID(), username, created_at: timestamp, account_expires_at: deadline === Infinity ? null : deadline };
      insertAccount.run(account.id, username, salt, hash, timestamp, account.account_expires_at);
      const issued = issueSession(account, timestamp);
      authenticatedCallback(options, account.id, 'register');
      return issued;
    });
  }

  async function login(input, options = {}) {
    const username = usernameValue(input?.username);
    const password = input?.password;
    if (!username || !validPassword(password)) throw failure('invalid_credentials');
    const account = byUsername.get(username);
    // Unknown usernames pay the same scrypt cost and constant-time comparison as
    // wrong passwords. The returned error never reveals which credential failed.
    const hash = await passwordHash(password, account?.password_salt ?? dummySalt);
    const matches = timingSafeEqual(hash, account?.password_hash ?? dummyHash);
    if (!account || !matches) throw failure('invalid_credentials');
    return transaction(() => {
      // Deletion or hard account expiry may finish during password verification.
      const currentAccount = byId.get(account.id);
      const timestamp = now();
      if (!currentAccount || (currentAccount.account_expires_at !== null && currentAccount.account_expires_at <= timestamp)) {
        throw failure('invalid_credentials');
      }
      const issued = issueSession(currentAccount, timestamp);
      authenticatedCallback(options, currentAccount.id, 'login');
      return issued;
    });
  }

  function session(token) {
    const hash = tokenHash(token);
    if (!hash) return null;
    const timestamp = now();
    const row = sessionRow.get(hash, timestamp, timestamp);
    if (!row) return null;
    return {
      account: publicAccount(row),
      expiresAt: Math.min(row.expires_at, row.account_expires_at ?? Infinity),
      access: entitlements.accessForAccount(row.id),
    };
  }

  function logout(token) {
    const hash = tokenHash(token);
    if (hash) removeSession.run(hash);
  }

  // The caller owns any filesystem privacy barrier. It must run in this hook
  // before private SQL deletes and may throw to abort the whole SQL transaction.
  function deleteStoredAccount(accountId) {
    const sessionsDeleted = removeAccountSessions.run(accountId).changes;
    const result = deleteAccountData(accountId);
    if (result && typeof result.then === 'function') {
      throw new TypeError('Account deletion callback must be synchronous.');
    }
    entitlements.deleteAccount(accountId);
    removeAccount.run(accountId);
    return sessionsDeleted;
  }

  async function deleteAccount(token, password) {
    const currentSession = session(token);
    if (!currentSession) throw failure('unauthenticated');
    if (!validPassword(password)) throw failure('invalid_credentials');
    const account = byId.get(currentSession.account.id);
    const hash = await passwordHash(password, account.password_salt);
    if (!timingSafeEqual(hash, account.password_hash)) throw failure('invalid_credentials');
    // Provider termination is outside SQL and may require an explicit queue
    // retry. Correct-password proof must precede any durable billing closure.
    if(!session(token))throw failure('unauthenticated');
    if(await beforeAccountDelete({accountId:account.id,token})!==true)throw new Error('Account deletion precondition failed.');
    return transaction(() => {
      if (!session(token)) throw failure('unauthenticated');
      deleteStoredAccount(account.id);
      return { deleted: true };
    });
  }

  function cleanup() {
    const timestamp = now();
    return transaction(() => {
      let sessionsDeleted = removeExpired.run(timestamp).changes;
      const expired = expiredAccounts.all(timestamp);
      for (const account of expired) sessionsDeleted += deleteStoredAccount(account.id);
      return { accountsDeleted: expired.length, sessionsDeleted };
    });
  }

  function invalidateAllSessions() {
    // Restored one-time challenges must never remain actionable after logout.
    if(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='justup_email_challenges'").get())db.prepare('DELETE FROM justup_email_challenges').run();
    if(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='justup_billing_accounts'").get())db.prepare('UPDATE justup_billing_accounts SET termination_verified_at=NULL,termination_revision=NULL').run();
    if(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='justup_billing_operations'").get())db.prepare('UPDATE justup_billing_operations SET url=NULL').run();
    return { sessionsDeleted: removeAllSessions.run().changes };
  }

  function registrationState() {
    if ((requiresInvitation && !inviteDigest) || (accountExpiresAt !== null && accountExpiresAt <= now())) return { enabled: false, reason: 'registration_closed' };
    if (maxAccounts !== null && accountCount.get().count >= maxAccounts) return { enabled: false, reason: 'account_limit' };
    return { enabled: true, reason: null };
  }

  function activateFreePeriod(token) {
    const current = session(token);
    if (!current) throw failure('unauthenticated');
    return entitlements.activateFreePeriod(current.account.id);
  }

  return { register, login, session, logout, deleteAccount, cleanup, invalidateAllSessions, registrationState,
    activateFreePeriod, accessForAccount: entitlements.accessForAccount,
    recordIdentityProof: entitlements.recordIdentityProof, applyBillingEvent: entitlements.applyBillingEvent };
}
