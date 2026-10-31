// Invite-only demo accounts and SQLite sessions. Read when wiring authentication
// or account deletion; HTTP cookie, origin and rate-limit protections live upstream.
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SCRYPT_OPTIONS = Object.freeze({ N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
const ERROR_DETAILS = {
  invalid_input: [400, 'Invalid account input.'],
  invalid_credentials: [401, 'Invalid username, password or invite code.'],
  registration_closed: [403, 'Demo registration is closed.'],
  account_limit: [403, 'The demo account limit has been reached.'],
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
  return { id: row.id, username: row.username };
}

export function createAuth({ db, config = {}, now = Date.now, deleteAccountData = () => {} }) {
  const maxAccounts = config.maxAccounts ?? 30;
  const sessionTtlMs = config.sessionTtlMs ?? SESSION_TTL_MS;
  if (!Number.isSafeInteger(maxAccounts) || maxAccounts < 1
      || !Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1
      || typeof now !== 'function' || typeof deleteAccountData !== 'function') {
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
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash BLOB PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS auth_sessions_account ON auth_sessions(account_id);
    CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);
  `);

  const byUsername = db.prepare('SELECT * FROM auth_accounts WHERE username = ?');
  const byId = db.prepare('SELECT * FROM auth_accounts WHERE id = ?');
  const sessionRow = db.prepare(`
    SELECT a.id, a.username, s.expires_at
    FROM auth_sessions s JOIN auth_accounts a ON a.id = s.account_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `);
  const insertSession = db.prepare(`
    INSERT INTO auth_sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)
  `);
  const removeSession = db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?');
  const removeExpired = db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?');
  const removeAccountSessions = db.prepare('DELETE FROM auth_sessions WHERE account_id = ?');
  const removeAccount = db.prepare('DELETE FROM auth_accounts WHERE id = ?');
  const accountCount = db.prepare('SELECT count(*) AS count FROM auth_accounts');
  const insertAccount = db.prepare(`
    INSERT INTO auth_accounts (id, username, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?)
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
    const expiresAt = timestamp + sessionTtlMs;
    removeExpired.run(timestamp);
    insertSession.run(digest(token), account.id, timestamp, expiresAt);
    return { account: publicAccount(account), token, expiresAt };
  }

  async function register(input) {
    if (!inviteDigest) throw failure('registration_closed');
    const username = usernameValue(input?.username);
    const password = input?.password;
    const inviteCode = input?.inviteCode;
    if (!username || !validPassword(password) || !boundedInvite(inviteCode)) throw failure('invalid_input');
    if (!timingSafeEqual(digest(inviteCode), inviteDigest)) throw failure('invalid_credentials');

    const salt = randomBytes(16);
    const hash = await passwordHash(password, salt);
    return transaction(() => {
      if (byUsername.get(username)) throw failure('username_taken');
      if (accountCount.get().count >= maxAccounts) throw failure('account_limit');
      const account = { id: randomUUID(), username };
      const timestamp = now();
      insertAccount.run(account.id, username, salt, hash, timestamp);
      return issueSession(account, timestamp);
    });
  }

  async function login(input) {
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
      // A deletion may finish while the password hash runs outside the transaction.
      if (!byId.get(account.id)) throw failure('invalid_credentials');
      return issueSession(account, now());
    });
  }

  function session(token) {
    const hash = tokenHash(token);
    if (!hash) return null;
    const row = sessionRow.get(hash, now());
    if (!row) return null;
    return {
      account: publicAccount(row),
      expiresAt: row.expires_at,
      access: { kind: 'demo', fullAccess: true, legacy: false, billingEnabled: false, until: null },
    };
  }

  function logout(token) {
    const hash = tokenHash(token);
    if (hash) removeSession.run(hash);
  }

  async function deleteAccount(token, password) {
    const currentSession = session(token);
    if (!currentSession) throw failure('unauthenticated');
    if (!validPassword(password)) throw failure('invalid_credentials');
    const account = byId.get(currentSession.account.id);
    const hash = await passwordHash(password, account.password_salt);
    if (!timingSafeEqual(hash, account.password_hash)) throw failure('invalid_credentials');
    return transaction(() => {
      if (!session(token)) throw failure('unauthenticated');
      removeAccountSessions.run(account.id);
      const result = deleteAccountData(account.id);
      if (result && typeof result.then === 'function') {
        throw new TypeError('Account deletion callback must be synchronous.');
      }
      removeAccount.run(account.id);
      return { deleted: true };
    });
  }

  return { register, login, session, logout, deleteAccount };
}
