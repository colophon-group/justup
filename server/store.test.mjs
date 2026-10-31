import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openStore, DAY_MS } from './store.mjs';

const AT = Date.parse('2026-10-31T12:00:00Z');
const iso = (v) => new Date(v).toISOString();
function fixture(id = 'job-1', first = AT - 3 * DAY_MS) {
  const text = 'Evidence for an ordinary example role. '.repeat(10);
  return { id, companyId: 'co-1', companyName: 'Example', companySlug: 'example', title: 'Engineer',
    sourceUrl: `https://example.org/jobs/${id}`, active: true, reserved: false, hasContent: true,
    firstObserved: iso(first), lastObserved: iso(AT), locales: ['en'], locations: [{ id: '1', name: 'Zurich', workplace: 'onsite', geoType: 'city' }],
    employmentTypes: ['full_time'], seniority: null, salary: null, experience: { min: -1, max: 99 }, bodyText: text,
    evidence: { source: 'jobseek_public', metadataFetchedAt: iso(AT), bodyFetchedAt: iso(AT), bodyUrl: 'https://jobseek-assets.colophon-group.org/job/example/en/latest.html',
      bodySha256: 'a'.repeat(64), textSha256: createHash('sha256').update(text).digest('hex'), normalizationVersion: 1, bodyBytes: 400, truncated: false } };
}
const snapshot = (jobs = [fixture()], extra = {}) => ({ schemaVersion: 1, snapshotAt: iso(AT), verifiedAt: iso(AT), selection: { rule: 'fixture' }, jobs, observations: [], unknownIds: [], ...extra });

test('store isolates SQLite settings and strips unapproved imported fields', (t) => {
  const s = openStore(); t.after(() => s.close());
  const raw = fixture(); raw.privateBoardConfig = { password: 'never' };
  s.importSnapshot(snapshot([raw]));
  const row = s.db.prepare('SELECT * FROM demo_jobs').get();
  assert.equal(s.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(s.db.prepare('PRAGMA synchronous').get().synchronous, 2);
  assert.equal(s.db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  assert.equal(row.first_seen_at, AT - 3 * DAY_MS);
  assert.ok(!row.data_json.includes('privateBoardConfig'));
  assert.deepEqual(JSON.parse(row.data_json).experience, { min: null, max: null, openEnded: true });
});
test('source discovery changes reject the whole import without resetting first observed', (t) => {
  const s = openStore(); t.after(() => s.close()); s.importSnapshot(snapshot()); const generation = s.generation().generation;
  assert.throws(() => s.importSnapshot(snapshot([fixture('new'), fixture('job-1', AT - DAY_MS)])), { code: 'source_identity_conflict' });
  assert.equal(s.generation().generation, generation);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM demo_jobs').get().n, 1);
});
test('missing refresh stays unknown while inactive and reserved observations suppress independently', (t) => {
  const s = openStore(); t.after(() => s.close()); s.importSnapshot(snapshot([fixture('unknown'), fixture('closed'), fixture('reserved')]));
  s.importSnapshot(snapshot([], { observations: [{ id: 'closed', active: false, observedAt: iso(AT) }, { id: 'reserved', active: true, reserved: true, observedAt: iso(AT) }], unknownIds: ['unknown'] }));
  const row = (id) => s.db.prepare('SELECT * FROM demo_jobs WHERE id=?').get(id);
  assert.equal(row('unknown').active, 1);
  assert.equal(row('closed').active, 0); assert.equal(row('closed').closed_observed_at, AT);
  assert.equal(row('reserved').reserved, 1); assert.equal(row('reserved').closed_observed_at, null);
});
test('unsafe links, body hash mismatches and oversize content fail closed', (t) => {
  const s = openStore(); t.after(() => s.close());
  for (const edit of [(j) => { j.sourceUrl = 'javascript:alert(1)'; }, (j) => { j.evidence.textSha256 = 'a'.repeat(64); }, (j) => { j.bodyText = 'x'.repeat(524289); }]) {
    const job = fixture(); edit(job); assert.throws(() => s.importSnapshot(snapshot([job])), { code: 'invalid_import' });
  }
  assert.equal(s.generation(), null);
});
test('asynchronous transaction work rolls back writes', (t) => {
  const s = openStore(); t.after(() => s.close());
  assert.throws(() => s.transaction(() => { s.db.exec('CREATE TABLE transient(x)'); return Promise.resolve(); }), /synchronous/);
  assert.equal(s.db.prepare("SELECT name FROM sqlite_master WHERE name='transient'").get(), undefined);
});
