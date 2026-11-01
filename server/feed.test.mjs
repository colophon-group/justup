import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore, DAY_MS } from './store.mjs';
import { createFeed } from './feed.mjs';
const AT = Date.parse('2026-10-31T12:00:00Z'), iso = (v) => new Date(v).toISOString();
const viewer = { account: { id: 'account-a' }, access: { fullAccess: true } };
function setup(t, options = {}) {
  const s = openStore(); t.after(() => s.close()); let at = AT;
  const feed = createFeed({ db: s.db, now: () => at, cursorSecret: 'x'.repeat(32), ...options });
  function add(rows, observedAt = AT) {
    s.importSnapshot({ schemaVersion: 1, snapshotAt: iso(observedAt), verifiedAt: iso(observedAt), jobs: rows.map(([id, age]) => ({
      id, companyId: 'company', companyName: 'Example', companySlug: 'example', title: `Role ${id}`, sourceUrl: `https://example.org/${id}`,
      active: true, reserved: false, hasContent: true, firstObserved: iso(AT - age * DAY_MS), lastObserved: null,
      locales: ['en'], locations: [{ name: null, workplace: null }], employmentTypes: [], seniority: null, salary: null, bodyText: null,
      evidence: { source: 'jobseek_public', metadataFetchedAt: iso(observedAt), bodyFetchedAt: null, bodyUrl: null, bodySha256: null, textSha256: null, bodyBytes: 0, normalizationVersion: 1, truncated: false },
    })), observations: [], unknownIds: [] });
  }
  return { s, feed, add, advance: (ms) => { at += ms; } };
}
test('guest 48h boundary and signed-in 14d boundary are enforced before projection', (t) => {
  const { feed, add } = setup(t); add([['fresh', 1], ['boundary', 2], ['older', 14]]);
  assert.deepEqual(feed.list().items.map((j) => j.id), ['boundary', 'older']);
  assert.deepEqual(feed.list({ viewer }).items.map((j) => j.id), ['fresh', 'boundary', 'older']);
  const text = JSON.stringify(feed.list());
  for (const forbidden of ['fresh', 'bodyText', 'evidenceHash', 'bodyUrl', 'evidence']) assert.ok(!text.includes(forbidden));
  assert.equal(feed.list().items[0].locations[0].workplace, null);
});
test('independent age expiry and verification TTL never invent closure', (t) => {
  const { s, feed, add, advance } = setup(t); add([['expiry', 14], ['valid', 3]]);
  advance(1); assert.deepEqual(feed.list().items.map((j) => j.id), ['valid']);
  advance(DAY_MS); assert.equal(feed.list().items.length, 0); assert.equal(feed.coverage().stale, true);
  assert.equal(s.db.prepare("SELECT active FROM demo_jobs WHERE id='valid'").get().active, 1);
});
test('missing evidence pauses the feed while a fresh eligible zero completes', (t) => {
  const { feed, add } = setup(t);
  const unavailable = feed.list();
  assert.deepEqual(unavailable.items, []);
  assert.deepEqual(unavailable.continuation, { cursor: null, state: 'paused', retryAfterMs: 5000 });
  assert.deepEqual(unavailable.coverage, { kind: 'imported_snapshot', verifiedAt: null, stale: true,
    state: 'import_unavailable', description: 'Imported listings need verification.' });
  assert.equal(unavailable.ai.status, 'not_required');
  add([['too-recent-for-guest', 1]]);
  const completed = feed.list();
  assert.deepEqual(completed.items, []);
  assert.equal(completed.continuation.state, 'exhausted');
  assert.equal(completed.continuation.retryAfterMs, null);
  assert.equal(completed.coverage.stale, false);
});
test('stale evidence pauses after cursor validation and a refreshed import recovers without exposing old rows', (t) => {
  const ttl = 5 * 60_000, { feed, add, advance, s } = setup(t, { verificationTtlMs: ttl });
  const rows = [['first', 3], ['second', 4]]; add(rows);
  const cursor = feed.list({ limit: 1 }).continuation.cursor;
  advance(ttl);
  const paused = feed.list({ cursor });
  assert.deepEqual(paused.items, []);
  assert.deepEqual(paused.continuation, { cursor, state: 'paused', retryAfterMs: 5000 });
  assert.equal(paused.coverage.stale, true);
  assert.equal(paused.coverage.state, 'import_unavailable');
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM demo_jobs WHERE active=1').get().n, 2);
  assert.throws(() => feed.list({ cursor: cursor + 'x' }), { code: 'invalid_cursor' });
  assert.throws(() => feed.list({ viewer, cursor }), { code: 'stale_cursor' });
  add(rows, AT + ttl);
  assert.throws(() => feed.list({ cursor }), { code: 'stale_cursor' });
  const refreshed = feed.list();
  assert.deepEqual(refreshed.items.map(j => j.id), ['first', 'second']);
  assert.equal(refreshed.coverage.stale, false);
  assert.equal(refreshed.continuation.state, 'exhausted');
});
test('cursor preserves source ordering and rejects generation/access/tamper changes', (t) => {
  const { feed, add } = setup(t); add([['b', 3], ['a', 3], ['c', 4]]);
  const first = feed.list({ limit: 1 }); assert.equal(first.items[0].id, 'a');
  assert.equal(feed.list({ limit: 1, cursor: first.continuation.cursor }).items[0].id, 'b');
  assert.throws(() => feed.list({ viewer, cursor: first.continuation.cursor }), { code: 'stale_cursor' });
  assert.throws(() => feed.list({ cursor: first.continuation.cursor + 'x' }), { code: 'invalid_cursor' });
  add([['d', 5]]); assert.throws(() => feed.list({ cursor: first.continuation.cursor }), { code: 'stale_cursor' });
});
test('company catalogue exposes imported identity without inventing monitoring or website', (t) => {
  const { feed, add } = setup(t); add([['hidden', 1]]);
  const co = feed.company('company'); assert.equal(co.websiteUrl, null); assert.equal(co.coverage.state, 'imported_snapshot');
  assert.equal(co.history, null); assert.equal(co.evidence[0].url, 'https://jseek.co/en/company/example'); assert.ok(!JSON.stringify(co).includes('/hidden'));
  assert.equal(feed.companies({ q: 'EXAM' }).items.length, 1);
  assert.throws(() => feed.company('absent'), { status: 404 });
});

test('signed-in accounts without full access receive only the guest slice', (t) => {
  const { feed } = setup(t);
  for (const access of [undefined, {fullAccess:false}]) {
    assert.deepEqual(feed.list({viewer:{account:{id:'restricted'},access}}).items.map(j=>j.id), feed.list().items.map(j=>j.id));
  }
});
