// Contract tests for verified free periods and replay-safe paid access.
// Run with Node 24: node --test server/entitlements.test.mjs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createAuth } from './auth.mjs';
import { createAccessReader } from './entitlements.mjs';
import { createFeed } from './feed.mjs';
import { openStore } from './store.mjs';

const START = Date.UTC(2026, 9, 31, 12);
const DAY = 86_400_000;
const PASSWORD = 'only-a-test-password';
const key = (value) => createHash('sha256').update(value).digest('base64url');

function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  let at = START;
  const auth = createAuth({ db, now: () => at, config: { requiresInvitation: false, ...options.config },
    identityProofVerifier: options.identityProofVerifier ?? (async (proof) => proof),
    billingEventVerifier: options.billingEventVerifier ?? (async (event) => event) });
  t.after(() => db.close());
  const register = async (username = 'tester') => auth.register({ username, password: PASSWORD });
  const verify = (accountId, subjectId = 'person-subject-0001', legacyProofId = null) =>
    auth.recordIdentityProof({ accountId, subjectKey: key(subjectId),
      legacyKey: legacyProofId == null ? null : key(legacyProofId), verifiedAt: at });
  const event = (accountId, overrides = {}) => {
    const { snapshot = {}, reconcile, ...envelope } = overrides;
    const verified = { eventId: 'event-confirmed-0001', subscriptionId: 'subscription-0001', accountId, ...envelope };
    return auth.applyBillingEvent({ ...verified, reconcile: reconcile ?? (async () => ({
      accountId: verified.accountId, subscriptionId: verified.subscriptionId, observedAt: at, status: 'active',
      plan: 'weekly', paidThroughAt: at + 7 * DAY, ...snapshot })) });
  };
  return { db, auth, register, verify, event, advance: (ms) => { at += ms; }, setTime: (value) => { at = value; }, now: () => at };
}

test('signup is limited until trusted proof and deliberate free-period activation', async (t) => {
  const f = fixture(t);
  const { account, token } = await f.register();
  assert.deepEqual(f.auth.session(token).access, {
    kind: 'limited', fullAccess: false, legacy: false, premium: false, billingEnabled: false,
    until: null, canActivateFreePeriod: false, description: 'Verify your account to start your free period.',
  });
  assert.throws(() => f.auth.activateFreePeriod(token), { code: 'identity_unverified', status: 403 });
  await f.verify(account.id);
  assert.equal(f.auth.session(token).access.kind, 'ready');
  assert.equal(f.auth.session(token).access.canActivateFreePeriod, true);
  const activated = f.auth.activateFreePeriod(token);
  assert.equal(activated.kind, 'free');
  assert.equal(activated.fullAccess, true);
  assert.equal(activated.premium, false);
  assert.equal(activated.until, new Date(START + 7 * DAY).toISOString());
  f.advance(3 * DAY);
  assert.deepEqual(f.auth.activateFreePeriod(token), f.auth.session(token).access);
  assert.equal(f.db.prepare('SELECT count(*) n FROM access_free_periods').get().n, 1);
  f.advance(4 * DAY);
  assert.equal(f.auth.session(token), null, 'session expiry remains independent');
  const signedIn = await f.auth.login({ username: 'tester', password: PASSWORD });
  assert.equal(f.auth.session(signedIn.token).access.kind, 'expired');
  assert.equal(f.auth.session(signedIn.token).access.fullAccess, false);
  assert.deepEqual(f.auth.activateFreePeriod(signedIn.token), f.auth.session(signedIn.token).access);
  assert.equal(f.db.prepare('SELECT count(*) n FROM access_free_periods').get().n, 1);
});

test('verified former Jobseek ownership gives one calendar month with month-end clamping', async (t) => {
  const f = fixture(t);
  const first = await f.register();
  await f.verify(first.account.id, 'person-subject-0001', 'old-jobseek-account-0001');
  const access = f.auth.activateFreePeriod(first.token);
  assert.equal(access.legacy, true);
  assert.equal(access.until, '2026-11-30T12:00:00.000Z');
  assert.equal(f.db.prepare('SELECT kind FROM access_free_periods').get().kind, 'legacy');
  const other = await f.register('second');
  await assert.rejects(f.verify(other.account.id, 'person-subject-0002', 'old-jobseek-account-0001'),
    { code: 'verification_conflict', status: 409 });
  assert.equal(f.auth.accessForAccount(other.account.id).kind, 'limited');
});

test('identity proofs cannot be swapped and later legacy evidence never restarts a used week', async (t) => {
  const f = fixture(t);
  const first = await f.register();
  await f.verify(first.account.id);
  await f.verify(first.account.id);
  await assert.rejects(f.verify(first.account.id, 'different-subject-0002'), { code: 'verification_conflict' });
  f.auth.activateFreePeriod(first.token);
  await f.verify(first.account.id, 'person-subject-0001', 'old-jobseek-account-0001');
  assert.equal(f.auth.session(first.token).access.until, new Date(START + 7 * DAY).toISOString());
  const second = await f.register('second');
  await assert.rejects(f.verify(second.account.id), { code: 'verification_conflict' });
});

test('payment confirmation, cancellation and failure preserve only paid-through access', async (t) => {
  const f = fixture(t);
  const { account, token } = await f.register();
  const paid = await f.event(account.id);
  assert.equal(paid.applied, true);
  assert.equal(paid.access.kind, 'paid');
  assert.equal(paid.access.premium, true);
  assert.equal(paid.access.until, new Date(START + 7 * DAY).toISOString());
  assert.equal((await f.event(account.id)).applied, false, 'exact callback retry is idempotent');
  await assert.rejects(f.event(account.id, { subscriptionId: 'different-subscription' }), { code: 'billing_conflict' });
  f.advance(2 * DAY);
  const cancelled = await f.event(account.id, { eventId: 'event-cancelled-0002',
    snapshot: { status: 'cancelled', paidThroughAt: START + 7 * DAY } });
  assert.equal(cancelled.access.kind, 'cancelled');
  assert.equal(cancelled.access.fullAccess, true);
  await f.event(account.id, { eventId: 'event-failed-0003',
    snapshot: { status: 'past_due', paidThroughAt: START + 7 * DAY } });
  assert.equal(f.auth.session(token).access.kind, 'past_due');
  const old = await f.event(account.id, { eventId: 'event-old-0004',
    snapshot: { status: 'past_due', paidThroughAt: START + 7 * DAY } });
  assert.equal(old.applied, true, 'older webhook still reconciles current state');
  assert.equal(old.access.kind, 'past_due');
  const sameSecond = await f.event(account.id, { eventId: 'event-same-second-0006',
    snapshot: { status: 'past_due', paidThroughAt: START + 7 * DAY } });
  assert.equal(sameSecond.applied, true, 'distinct events in the same second need no guessed ordering');
  f.advance(5 * DAY);
  const nextSession = await f.auth.login({ username: 'tester', password: PASSWORD });
  assert.equal(f.auth.session(nextSession.token).access.fullAccess, false);
  assert.equal(f.auth.session(nextSession.token).access.kind, 'expired');
  const renewed = await f.event(account.id, { eventId: 'event-renewed-0005',
    snapshot: { paidThroughAt: f.now() + 7 * DAY } });
  assert.equal(renewed.access.kind, 'paid');
  assert.equal(renewed.access.fullAccess, true);
});

test('a stale concurrent snapshot cannot overwrite a newer cancellation', async (t) => {
  const f = fixture(t);
  const { account, token } = await f.register();
  await f.event(account.id);
  f.advance(2 * DAY);
  let enterReconcile, finishReconcile;
  const entered = new Promise((resolve) => { enterReconcile = resolve; });
  const held = new Promise((resolve) => { finishReconcile = resolve; });
  const stale = f.event(account.id, { eventId: 'event-stale', reconcile: async () => {
    enterReconcile();
    return held;
  } });
  await entered;
  assert.equal(f.auth.session(token).access.kind, 'pending');
  assert.equal(f.auth.session(token).access.fullAccess, false);
  const cancelled = await f.event(account.id, { eventId: 'event-cancelled',
    snapshot: { status: 'cancelled', paidThroughAt: START + 7 * DAY } });
  assert.equal(cancelled.access.kind, 'cancelled');
  finishReconcile({ accountId: account.id, subscriptionId: 'subscription-0001', observedAt: f.now(),
    status: 'active', plan: 'weekly', paidThroughAt: START + 7 * DAY });
  await assert.rejects(stale, { code: 'billing_reconcile_required', status: 409 });
  assert.equal(f.db.prepare('SELECT status FROM access_subscriptions').get().status, 'cancelled');
  assert.equal(f.db.prepare('SELECT count(*) n FROM access_billing_events').get().n, 2);
  assert.equal(f.auth.session(token).access.kind, 'cancelled');
  const retried = await f.event(account.id, { eventId: 'event-stale',
    snapshot: { status: 'cancelled', paidThroughAt: START + 7 * DAY } });
  assert.equal(retried.access.kind, 'cancelled');
  assert.equal(f.db.prepare('SELECT count(*) n FROM access_billing_events').get().n, 3);
});

test('failed provider reconciliation pauses paid access until the event is retried', async (t) => {
  const f = fixture(t);
  const { account, token } = await f.register();
  await f.event(account.id);
  f.advance(DAY);
  await assert.rejects(f.event(account.id, { eventId: 'event-provider-error',
    reconcile: async () => { throw new Error('provider unavailable'); } }), /provider unavailable/);
  assert.equal(f.auth.session(token).access.kind, 'pending');
  assert.equal(f.auth.session(token).access.fullAccess, false);
  assert.equal(f.db.prepare('SELECT count(*) n FROM access_billing_events').get().n, 1);
  const recovered = await f.event(account.id, { eventId: 'event-provider-error',
    snapshot: { paidThroughAt: START + 7 * DAY } });
  assert.equal(recovered.access.kind, 'paid');
  assert.equal(f.db.prepare('SELECT count(*) n FROM access_billing_events').get().n, 2);
});

test('deletion during provider reconciliation cannot recreate account access', async (t) => {
  const f = fixture(t);
  const { account, token } = await f.register();
  let enterReconcile, finishReconcile;
  const entered = new Promise((resolve) => { enterReconcile = resolve; });
  const held = new Promise((resolve) => { finishReconcile = resolve; });
  const pending = f.event(account.id, { reconcile: async () => {
    enterReconcile();
    return held;
  } });
  await entered;
  assert.equal(f.auth.session(token).access.kind, 'pending');
  await f.auth.deleteAccount(token, PASSWORD);
  finishReconcile({ accountId: account.id, subscriptionId: 'subscription-0001',
    observedAt: f.now(), status: 'active', plan: 'weekly', paidThroughAt: f.now() + 7 * DAY });
  await assert.rejects(pending, { code: 'unauthenticated' });
  assert.equal(f.auth.accessForAccount(account.id), null);
  assert.equal(f.db.prepare('SELECT count(*) n FROM access_subscriptions').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM access_billing_events').get().n, 0);
});

test('competing verified claims cannot assign one former-user proof to two accounts', async (t) => {
  const f = fixture(t);
  const first = await f.register('first');
  const second = await f.register('second');
  const claims = await Promise.allSettled([
    f.verify(first.account.id, 'first-subject', 'shared-jobseek-owner'),
    f.verify(second.account.id, 'second-subject', 'shared-jobseek-owner'),
  ]);
  assert.equal(claims.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(claims.filter((result) => result.status === 'rejected'
    && result.reason.code === 'verification_conflict').length, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM access_identities').get().n, 1);
});

test('unverified adapters cannot award access, while an authoritative end revokes paid access', async (t) => {
  const f = fixture(t, { identityProofVerifier: async () => ({ legacyKey: 'not-a-proof' }),
    billingEventVerifier: async () => ({ kind: 'payment_succeeded' }) });
  const { account, token } = await f.register();
  await assert.rejects(f.auth.recordIdentityProof({}), { code: 'invalid_input' });
  await assert.rejects(f.auth.applyBillingEvent({}), { code: 'invalid_input' });
  assert.equal(f.auth.session(token).access.fullAccess, false);
  assert.equal(f.db.prepare('SELECT count(*) n FROM access_billing_events').get().n, 0);

  const raw = fixture(t);
  const unverified = await raw.register();
  await assert.rejects(raw.auth.recordIdentityProof({ accountId: unverified.account.id,
    subjectKey: 'person@example.org', verifiedAt: START }), { code: 'invalid_input' });
  assert.equal(raw.db.prepare('SELECT count(*) n FROM access_identities').get().n, 0);

  const g = fixture(t);
  const buyer = await g.register();
  await g.event(buyer.account.id);
  await assert.rejects(g.event(buyer.account.id, { eventId: 'event-wrong-binding',
    snapshot: { subscriptionId: 'other-subscription' } }), { code: 'invalid_input' });
  assert.equal(g.auth.session(buyer.token).access.kind, 'pending');
  await assert.rejects(g.event(buyer.account.id, { eventId: 'event-invalid-window',
    snapshot: { paidThroughAt: START + 63 * DAY } }), { code: 'invalid_input' });
  const revoked = await g.event(buyer.account.id, { eventId: 'event-ended',
    snapshot: { status: 'ended', plan: null, paidThroughAt: null } });
  assert.equal(revoked.access.fullAccess, false);
  assert.equal(g.auth.session(buyer.token).access.kind, 'expired');
});

test('deletion removes identity, free-period and billing records; restore revokes sessions only', async (t) => {
  const f = fixture(t);
  const { account, token } = await f.register();
  await f.verify(account.id);
  f.auth.activateFreePeriod(token);
  await f.event(account.id);
  assert.deepEqual(f.auth.invalidateAllSessions(), { sessionsDeleted: 1 });
  assert.equal(f.auth.session(token), null);
  const signedIn = await f.auth.login({ username: 'tester', password: PASSWORD });
  assert.equal(f.auth.session(signedIn.token).access.kind, 'paid');
  assert.deepEqual(await f.auth.deleteAccount(signedIn.token, PASSWORD), { deleted: true });
  assert.equal(f.auth.accessForAccount(account.id), null);
  for (const table of ['access_identities','access_free_periods','access_subscriptions','access_billing_events']) {
    assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  }
});

test('a temporary account deadline removes entitlement rows through ordinary cleanup', async (t) => {
  const f = fixture(t, { config: { accountTtlMs: 1000 } });
  const { account, token } = await f.register();
  await f.verify(account.id);
  f.auth.activateFreePeriod(token);
  await f.event(account.id);
  f.advance(1000);
  assert.equal(f.auth.session(token), null);
  assert.equal(f.auth.accessForAccount(account.id), null);
  assert.deepEqual(f.auth.cleanup(), { accountsDeleted: 1, sessionsDeleted: 1 });
  for (const table of ['access_identities','access_free_periods','access_subscriptions','access_billing_events']) {
    assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  }
});

test('read-only lookup fails closed for a migrated account without entitlement tables', (t) => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE auth_accounts (id TEXT PRIMARY KEY, account_expires_at INTEGER) STRICT');
  db.prepare('INSERT INTO auth_accounts VALUES (?,?)').run('old-account', null);
  const read = createAccessReader({ db, now: () => START });
  assert.equal(read('old-account').kind, 'limited');
  assert.equal(read('old-account').fullAccess, false);
  assert.equal(read('missing'), null);
  db.prepare('UPDATE auth_accounts SET account_expires_at=?').run(START);
  assert.equal(read('old-account'), null);
});

test('unconfigured proof and billing adapters cannot grant a new account full access', async (t) => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const auth = createAuth({ db, now: () => START, config: { requiresInvitation: false } });
  const { account, token } = await auth.register({ username: 'tester', password: PASSWORD });
  await assert.rejects(auth.recordIdentityProof({ accountId: account.id }), { code: 'verification_unavailable', status: 503 });
  await assert.rejects(auth.applyBillingEvent({ accountId: account.id }), { code: 'billing_unavailable', status: 503 });
  assert.equal(auth.session(token).access.fullAccess, false);
  assert.throws(() => auth.activateFreePeriod(token), { code: 'identity_unverified', status: 403 });
});

test('the same feed withholds fresh jobs until verified free access is activated', async (t) => {
  const store = openStore(); t.after(() => store.close());
  const at = START, iso = (value) => new Date(value).toISOString();
  const job = (id, ageDays) => ({ id, companyId: 'company', companyName: 'Example', companySlug: 'example',
    title: `Role ${id}`, sourceUrl: `https://example.org/${id}`, active: true, reserved: false, hasContent: true,
    firstObserved: iso(at - ageDays * DAY), lastObserved: null, locales: ['en'],
    locations: [{ name: null, workplace: null }], employmentTypes: [], seniority: null, salary: null, bodyText: null,
    evidence: { source: 'jobseek_public', metadataFetchedAt: iso(at), bodyFetchedAt: null, bodyUrl: null,
      bodySha256: null, textSha256: null, bodyBytes: 0, normalizationVersion: 1, truncated: false } });
  store.importSnapshot({ schemaVersion: 1, snapshotAt: iso(at), verifiedAt: iso(at),
    jobs: [job('fresh', 1), job('older', 3)], observations: [], unknownIds: [] });
  const auth = createAuth({ db: store.db, now: () => at, config: { requiresInvitation: false },
    identityProofVerifier: async (proof) => proof });
  const feed = createFeed({ db: store.db, now: () => at, cursorSecret: 'x'.repeat(32) });
  const { account, token } = await auth.register({ username: 'tester', password: PASSWORD });
  assert.deepEqual(feed.list({ viewer: auth.session(token) }).items.map((row) => row.id), ['older']);
  await auth.recordIdentityProof({ accountId: account.id, subjectKey: key('verified-person-0001'), verifiedAt: at });
  assert.deepEqual(feed.list({ viewer: auth.session(token) }).items.map((row) => row.id), ['older']);
  auth.activateFreePeriod(token);
  assert.deepEqual(feed.list({ viewer: auth.session(token) }).items.map((row) => row.id), ['fresh', 'older']);
});
