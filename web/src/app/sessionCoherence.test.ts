// Lifecycle timing and in-memory principal identity; no browser, API or provider needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeSession } from '../api/decode.ts';
import { sessionOwner } from '../api/sessionOwner.ts';
import { confirmsCredentialRecovery, expiredSessionSnapshot, keepsOwnedVisitorEditor, nextSessionDeadline, sessionDeadlineRemaining } from './sessionCoherence.ts';

const AT = Date.parse('2026-11-01T12:00:00Z');
const iso = (offset: number) => new Date(AT + offset).toISOString();
const wire = () => ({ user: { id: 'one', username: 'reader' }, csrfToken: 'test-csrf', serverTime: iso(0), expiresAt: iso(60_000),
  access: { kind: 'paid', fullAccess: true, billingEnabled: false, until: iso(30_000) }, capabilities: {},
  authentication: { method: 'username_password', loginEnabled: false, registrationEnabled: false, reason: null },
  policies: { locale: 'en', reviewedLocale: null, fallback: false, reviewed: false, version: null, privacyUrl: null, usageUrl: null } });

test('nearest deadline follows server time and includes the complete request elapsed time', () => {
  const session = decodeSession(wire());
  assert.equal(nextSessionDeadline(session, 10_000, 12_000), 28_000);
  assert.equal(expiredSessionSnapshot(session, 10_000, 40_000), true);
  assert.equal(expiredSessionSnapshot(session, 10_000, 39_999), false);
  assert.equal(nextSessionDeadline(session, 10_000, 50_000), 0);
});

test('a capped early wake leaves the real long-lived deadline unconsumed', () => {
  const session = decodeSession({ ...wire(), expiresAt: iso(30 * 86_400_000), access: { ...wire().access, fullAccess: false, until: null } });
  const cap = 2_147_483_647;
  assert.equal(nextSessionDeadline(session, 0, 0), cap);
  assert.equal(sessionDeadlineRemaining(session, 0, cap), 30 * 86_400_000 - cap);
  assert.equal(expiredSessionSnapshot(session, 0, cap), false);
  assert.equal(nextSessionDeadline(session, 0, cap), 30 * 86_400_000 - cap);
  assert.equal(sessionDeadlineRemaining(session, 0, 30 * 86_400_000), 0);
});

test('wire deadlines reject malformed values while nullable absent legacy fields remain compatible', () => {
  for (const patch of [{ serverTime: 'yesterday' }, { expiresAt: 'soon' }, { access: { ...wire().access, until: 123 } }])
    assert.throws(() => decodeSession({ ...wire(), ...patch }));
  const value = wire();
  assert.equal(decodeSession({ ...value, expiresAt: null }).expiresAt, null);
  const { serverTime: _clock, expiresAt: _expiry, ...legacy } = value;
  assert.equal(decodeSession(legacy).serverTime, undefined);
});

test('same-account token rotation preserves ownership but equal-expiry replacement visitors do not', () => {
  const session = decodeSession(wire());
  assert.equal(sessionOwner(session), sessionOwner({ ...session, csrfToken: 'rotated' }));
  const visitor = { ...session, user: null, visitor: { expiresAt: iso(60_000) } };
  assert.notEqual(sessionOwner(visitor), sessionOwner({ ...visitor, csrfToken: 'different-guest' }));
  assert.notEqual(sessionOwner({ ...visitor, visitor: null }), sessionOwner({ ...visitor, visitor: null, csrfToken: 'different-guest' }));
});

test('a lost credential acknowledgement is local only when the authoritative username matches', () => {
  const session = decodeSession(wire());
  assert.equal(confirmsCredentialRecovery(session, ' READER '), true);
  assert.equal(confirmsCredentialRecovery(session, 'another-account'), false);
  assert.equal(confirmsCredentialRecovery({ ...session, user: null }, 'reader'), false);
  assert.equal(confirmsCredentialRecovery(session, undefined), false);
  assert.equal(confirmsCredentialRecovery(session, 'reader', session), false);
  assert.equal(confirmsCredentialRecovery({ ...session, csrfToken: 'rotated' }, 'reader', session), true);
});

test('only an owned visitor renewal keeps editing available, never an external identity barrier', () => {
  const account = decodeSession(wire());
  const visitor = { ...account, user: null, capabilities: { visitorSearch: true } };
  assert.equal(keepsOwnedVisitorEditor(visitor, true, false), true);
  assert.equal(keepsOwnedVisitorEditor(visitor, false, false), false);
  assert.equal(keepsOwnedVisitorEditor(visitor, true, true), false);
  assert.equal(keepsOwnedVisitorEditor(account, true, false), false);
  assert.equal(keepsOwnedVisitorEditor(null, true, false), false);
});
