// Persist verified identity, free periods and reconciled subscription access.
// Read when changing access or adding a signed-event/current-state billing adapter.
import { createHash } from 'node:crypto';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const BILLING_WINDOW_MS = 62 * DAY_MS;

function failure(code, status, message) {
  return Object.assign(new Error(message), { code, status });
}

function validTime(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_TIMESTAMP;
}

function opaqueHash(kind, value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) {
    throw failure('invalid_input', 400, 'Invalid verified event.');
  }
  return createHash('sha256').update(`${kind}:`).update(value).digest('hex');
}

function verifiedKeyHash(kind, value) {
  // The trusted adapter must supply a keyed, high-entropy pseudonymous value,
  // never an email address or a provider token. Hash again for storage.
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(value)) {
    throw failure('invalid_input', 400, 'Invalid verified identity.');
  }
  return opaqueHash(kind, value);
}

function calendarMonthAfter(at) {
  const date = new Date(at);
  const year = date.getUTCFullYear(), month = date.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 2, 0)).getUTCDate();
  return Date.UTC(year, month + 1, Math.min(date.getUTCDate(), lastDay),
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds());
}

function limited(kind, description, canActivateFreePeriod = false) {
  return { kind, fullAccess: false, legacy: false, premium: false, billingEnabled: false,
    until: null, canActivateFreePeriod, description };
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
}

// Read-only callers, including background workers, must re-read this projection
// at use time. Missing tables or an expired/deleted account never imply access.
export function createAccessReader({ db, now = Date.now } = {}) {
  if (!db || typeof now !== 'function') throw new TypeError('Access reader needs a database and clock.');
  const hasAccounts = tableExists(db, 'auth_accounts');
  const hasDeadline = hasAccounts && db.prepare('PRAGMA table_info(auth_accounts)').all().some((column) => column.name === 'account_expires_at');
  const account = hasAccounts ? db.prepare(`SELECT id${hasDeadline ? ', account_expires_at' : ''} FROM auth_accounts WHERE id=?`) : null;
  const identity = tableExists(db, 'access_identities') ? db.prepare('SELECT legacy_hash FROM access_identities WHERE account_id=?') : null;
  const freePeriod = tableExists(db, 'access_free_periods') ? db.prepare('SELECT kind, ends_at FROM access_free_periods WHERE account_id=?') : null;
  const subscriptions = tableExists(db, 'access_subscriptions')
    ? db.prepare('SELECT status, paid_through_at, reconcile_pending FROM access_subscriptions WHERE account_id=? ORDER BY paid_through_at DESC') : null;

  return function accessForAccount(accountId) {
    if (typeof accountId !== 'string' || !accountId || !account) return null;
    const at = now(), owner = account.get(accountId);
    if (!owner || !validTime(at) || (owner.account_expires_at != null && owner.account_expires_at <= at)) return null;
    const ceiling = owner.account_expires_at ?? Infinity;
    const identityRow = identity?.get(accountId) ?? null;
    const trial = freePeriod?.get(accountId) ?? null;
    const paymentRows = subscriptions?.all(accountId) ?? [];
    const paid = paymentRows.find((row) => !row.reconcile_pending && row.status !== 'ended'
      && row.paid_through_at != null && row.paid_through_at > at);
    if (paid) {
      const until = new Date(Math.min(paid.paid_through_at, ceiling)).toISOString();
      const cancelled = paid.status === 'cancelled', pastDue = paid.status === 'past_due';
      return { kind: cancelled ? 'cancelled' : pastDue ? 'past_due' : 'paid', fullAccess: true,
        legacy: false, premium: true, billingEnabled: false, until, canActivateFreePeriod: false,
        description: cancelled ? 'Paid access remains active until the paid period ends.'
          : pastDue ? 'Payment needs attention; access remains active until the paid period ends.' : 'Paid access is active.' };
    }
    if (trial?.ends_at > at) return { kind: 'free', fullAccess: true, legacy: trial.kind === 'legacy',
      premium: false, billingEnabled: false, until: new Date(Math.min(trial.ends_at, ceiling)).toISOString(),
      canActivateFreePeriod: false, description: 'Free access is active.' };
    if (paymentRows.some((row) => row.reconcile_pending)) return limited('pending', 'Payment status is being checked.');
    if (trial) return limited('expired', 'Your free period has ended.');
    if (paymentRows.length) return limited('expired', 'Paid access has ended.');
    if (identityRow) return limited('ready', 'Your free period is ready to start.', true);
    return limited('limited', 'Verify your account to start your free period.');
  };
}

export function createEntitlements({ db, now = Date.now, identityProofVerifier = null, billingEventVerifier = null } = {}) {
  if (!db || typeof now !== 'function' || (identityProofVerifier !== null && typeof identityProofVerifier !== 'function')
      || (billingEventVerifier !== null && typeof billingEventVerifier !== 'function')) {
    throw new TypeError('Invalid entitlement dependencies.');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS access_identities (
      account_id TEXT PRIMARY KEY REFERENCES auth_accounts(id) ON DELETE CASCADE,
      subject_hash TEXT NOT NULL UNIQUE,
      legacy_hash TEXT UNIQUE,
      verified_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS access_free_periods (
      account_id TEXT PRIMARY KEY REFERENCES auth_accounts(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('standard','legacy')),
      started_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL CHECK(ends_at > started_at)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS access_subscriptions (
      subscription_hash TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,
      state_version INTEGER NOT NULL CHECK(state_version > 0),
      status TEXT NOT NULL CHECK(status IN ('unknown','active','cancelled','past_due','ended')),
      plan TEXT CHECK(plan IN ('weekly','monthly')),
      paid_through_at INTEGER,
      reconcile_pending INTEGER NOT NULL CHECK(reconcile_pending IN (0,1))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS access_subscriptions_account ON access_subscriptions(account_id);
    CREATE TABLE IF NOT EXISTS access_billing_events (
      event_hash TEXT PRIMARY KEY,
      canonical_hash TEXT NOT NULL,
      account_id TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,
      subscription_hash TEXT NOT NULL,
      applied_version INTEGER NOT NULL,
      received_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS access_billing_events_account ON access_billing_events(account_id);
  `);
  const accessForAccount = createAccessReader({ db, now });
  const account = db.prepare('SELECT id, account_expires_at FROM auth_accounts WHERE id=?');
  const identity = db.prepare('SELECT * FROM access_identities WHERE account_id=?');
  const subjectOwner = db.prepare('SELECT account_id FROM access_identities WHERE subject_hash=? OR legacy_hash=?');
  const insertIdentity = db.prepare('INSERT INTO access_identities (account_id,subject_hash,legacy_hash,verified_at) VALUES (?,?,?,?)');
  const addLegacy = db.prepare('UPDATE access_identities SET legacy_hash=? WHERE account_id=? AND legacy_hash IS NULL');
  const freePeriod = db.prepare('SELECT * FROM access_free_periods WHERE account_id=?');
  const insertPeriod = db.prepare('INSERT INTO access_free_periods (account_id,kind,started_at,ends_at) VALUES (?,?,?,?)');
  const subscription = db.prepare('SELECT * FROM access_subscriptions WHERE subscription_hash=?');
  const insertSubscription = db.prepare('INSERT INTO access_subscriptions VALUES (?,?,?,?,?,?,?)');
  const reserveSubscription = db.prepare('UPDATE access_subscriptions SET state_version=?,reconcile_pending=1 WHERE subscription_hash=?');
  const updateSubscription = db.prepare('UPDATE access_subscriptions SET status=?,plan=?,paid_through_at=?,reconcile_pending=0 WHERE subscription_hash=?');
  const billingEvent = db.prepare('SELECT canonical_hash FROM access_billing_events WHERE event_hash=?');
  const insertBillingEvent = db.prepare('INSERT INTO access_billing_events VALUES (?,?,?,?,?,?)');
  const deleteIdentity = db.prepare('DELETE FROM access_identities WHERE account_id=?');
  const deletePeriod = db.prepare('DELETE FROM access_free_periods WHERE account_id=?');
  const deleteSubscriptions = db.prepare('DELETE FROM access_subscriptions WHERE account_id=?');
  const deleteBillingEvents = db.prepare('DELETE FROM access_billing_events WHERE account_id=?');

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function liveAccount(accountId) {
    const owner = account.get(accountId), at = now();
    if (!owner || (owner.account_expires_at !== null && owner.account_expires_at <= at)) {
      throw failure('unauthenticated', 401, 'Sign in to continue.');
    }
    return owner;
  }
  async function recordIdentityProof(rawProof) {
    if (!identityProofVerifier) throw failure('verification_unavailable', 503, 'Account verification is unavailable.');
    const proof = await identityProofVerifier(rawProof);
    if (!proof || typeof proof.accountId !== 'string' || !validTime(proof.verifiedAt) || proof.verifiedAt > now()
        || (proof.legacyKey != null && typeof proof.legacyKey !== 'string')) {
      throw failure('invalid_input', 400, 'Invalid verified identity.');
    }
    const subjectHash = verifiedKeyHash('identity', proof.subjectKey);
    const legacyHash = proof.legacyKey == null ? null : verifiedKeyHash('legacy', proof.legacyKey);
    return transaction(() => {
      liveAccount(proof.accountId);
      const owners = subjectOwner.all(subjectHash, legacyHash);
      if (owners.some((owner) => owner.account_id !== proof.accountId)) {
        throw failure('verification_conflict', 409, 'This identity is already linked.');
      }
      const prior = identity.get(proof.accountId);
      if (prior) {
        if (prior.subject_hash !== subjectHash || (prior.legacy_hash && legacyHash && prior.legacy_hash !== legacyHash)) {
          throw failure('verification_conflict', 409, 'This identity is already linked.');
        }
        if (!prior.legacy_hash && legacyHash) addLegacy.run(legacyHash, proof.accountId);
      } else insertIdentity.run(proof.accountId, subjectHash, legacyHash, proof.verifiedAt);
      return { accountId: proof.accountId, legacyEligible: Boolean(identity.get(proof.accountId)?.legacy_hash) };
    });
  }
  function activateFreePeriod(accountId) {
    return transaction(() => {
      liveAccount(accountId);
      const prior = freePeriod.get(accountId);
      if (prior) return accessForAccount(accountId);
      const verified = identity.get(accountId);
      if (!verified) throw failure('identity_unverified', 403, 'Verify your account before starting free access.');
      if (db.prepare('SELECT 1 FROM access_subscriptions WHERE account_id=? LIMIT 1').get(accountId)) {
        throw failure('free_period_unavailable', 409, 'This free period is unavailable.');
      }
      const startedAt = now(), legacy = Boolean(verified.legacy_hash);
      const endsAt = legacy ? calendarMonthAfter(startedAt) : startedAt + WEEK_MS;
      if (!validTime(endsAt) || endsAt <= startedAt) throw new TypeError('Invalid free-period deadline.');
      insertPeriod.run(accountId, legacy ? 'legacy' : 'standard', startedAt, endsAt);
      return accessForAccount(accountId);
    });
  }
  async function applyBillingEvent(rawEvent) {
    if (!billingEventVerifier) throw failure('billing_unavailable', 503, 'Billing is unavailable.');
    const event = await billingEventVerifier(rawEvent);
    if (!event || typeof event.accountId !== 'string' || typeof event.reconcile !== 'function') {
      throw failure('invalid_input', 400, 'Invalid verified billing event.');
    }
    const eventHash = opaqueHash('billing-event', event.eventId);
    const subscriptionHash = opaqueHash('subscription', event.subscriptionId);
    const canonical = { accountId: event.accountId, subscriptionHash };
    const canonicalHash = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
    // Reserve a version and pause this subscription before any network read.
    // If reconciliation fails, retrying the event can clear the pause.
    const reservation = transaction(() => {
      liveAccount(event.accountId);
      const oldEvent = billingEvent.get(eventHash);
      if (oldEvent) {
        if (oldEvent.canonical_hash !== canonicalHash) throw failure('billing_conflict', 409, 'Billing event conflict.');
        return { duplicate: true };
      }
      const current = subscription.get(subscriptionHash);
      if (current && current.account_id !== event.accountId) throw failure('billing_conflict', 409, 'Billing event conflict.');
      const version = (current?.state_version ?? 0) + 1;
      if (current) reserveSubscription.run(version, subscriptionHash);
      else insertSubscription.run(subscriptionHash, event.accountId, version, 'unknown', null, null, 1);
      return { version };
    });
    if (reservation.duplicate) return { applied: false, access: accessForAccount(event.accountId) };
    const startedAt = now();
    // The trusted adapter must retrieve the provider's current subscription,
    // prove its account binding and settled paid-through period. A webhook's
    // event time is not a version, even when the event was signed.
    const snapshot = await event.reconcile();
    if (!snapshot || snapshot.accountId !== event.accountId || snapshot.subscriptionId !== event.subscriptionId
        || !validTime(snapshot.observedAt) || snapshot.observedAt < startedAt
        || snapshot.observedAt > now() + 5 * 60_000
        || !['active','cancelled','past_due','ended'].includes(snapshot.status)
        || (snapshot.plan != null && !['weekly','monthly'].includes(snapshot.plan))
        || (snapshot.paidThroughAt != null && (!validTime(snapshot.paidThroughAt)
          || snapshot.plan == null || snapshot.paidThroughAt > snapshot.observedAt + BILLING_WINDOW_MS))
        || (snapshot.status === 'ended' && snapshot.paidThroughAt != null)) {
      throw failure('invalid_input', 400, 'Invalid verified billing state.');
    }
    return transaction(() => {
      liveAccount(event.accountId);
      const recordedEvent = billingEvent.get(eventHash);
      if (recordedEvent) {
        if (recordedEvent.canonical_hash !== canonicalHash) throw failure('billing_conflict', 409, 'Billing event conflict.');
        return { applied: false, access: accessForAccount(event.accountId) };
      }
      const current = subscription.get(subscriptionHash);
      if (current && current.account_id !== event.accountId) throw failure('billing_conflict', 409, 'Billing event conflict.');
      // Another attempt started while this provider snapshot was read. Its
      // reservation has paused access; retry this event with a fresh snapshot.
      if (!current?.reconcile_pending || current.state_version !== reservation.version) {
        throw failure('billing_reconcile_required', 409, 'Billing state changed; retry reconciliation.');
      }
      updateSubscription.run(snapshot.status, snapshot.plan ?? null, snapshot.paidThroughAt ?? null, subscriptionHash);
      insertBillingEvent.run(eventHash, canonicalHash, event.accountId, subscriptionHash, reservation.version, now());
      return { applied: true, access: accessForAccount(event.accountId) };
    });
  }
  function deleteAccount(accountId) {
    deleteBillingEvents.run(accountId);
    deleteSubscriptions.run(accountId);
    deletePeriod.run(accountId);
    deleteIdentity.run(accountId);
  }
  return { accessForAccount, recordIdentityProof, activateFreePeriod, applyBillingEvent, deleteAccount };
}
