// Local Node HTTP and real SQLite contracts for workspace live-result delivery.
// Models are deterministic fixtures; this suite makes no provider or edge calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from './main.mjs';
import { createIntentService } from './intent.mjs';
import { createMatchingService } from './matching.mjs';
import { createVisitorIdentity, createVisitorService } from './visitor.mjs';
import { createLiveResultsService } from './live-results.mjs';

const DAY = 86_400_000, AT = Date.parse('2026-11-01T12:00:00Z'), ORIGIN = 'https://preview.example.org';
const FILTERS = ['companyInclude','companyExclude','titleAny','bodyAll','bodyNone','locations','workplaces','employmentTypes','postingLanguages','seniority'];
const paid = { kind: 'paid', fullAccess: true, premium: false, until: null };
function job(id, first = AT - 3 * DAY, title = 'Engineer') {
  const bodyText = `Synthetic posting ${id}. ` + 'The role provides a documented four day working week with full compensation. '.repeat(5);
  return { id, companyId: 'example', companyName: 'Example', companySlug: 'example', title,
    sourceUrl: `https://example.org/jobs/${id}`, active: true, reserved: false, hasContent: true,
    firstObserved: new Date(first).toISOString(), lastObserved: null, locales: ['en'], locations: [], employmentTypes: [], seniority: null, salary: null, bodyText,
    evidence: { source: 'jobseek_public', metadataFetchedAt: new Date(AT).toISOString(), bodyFetchedAt: new Date(AT).toISOString(),
      bodyUrl: `https://example.org/jobs/${id}`, bodySha256: null, textSha256: createHash('sha256').update(bodyText).digest('hex'),
      bodyBytes: Buffer.byteLength(bodyText), normalizationVersion: 1, truncated: false, aiEligible: true } };
}
async function setup(t, options = {}) {
  const { verificationTtlMs, persistent = false, ...transportOptions } = options;
  const directory = persistent ? mkdtempSync(join(tmpdir(), 'justup-live-results-')) : null;
  const storage = directory ? { dbPath: join(directory, 'store.sqlite'), privateGenerationPath: join(directory, 'private-generation'), backupDir: join(directory, 'backups') } : {};
  if (directory) { mkdirSync(storage.backupDir, { mode: 0o700 }); writeFileSync(storage.privateGenerationPath, `${randomUUID()}\n`, { mode: 0o600 }); }
  let time = AT, intent, matching, identity, live, providerAvailable = true;
  const accounts = new Map();
  const app = await createApplication({ now: () => time, config: { allowedOrigin: ORIGIN, policiesReviewed: true,
    privacyUrl: `${ORIGIN}/privacy`, usageUrl: `${ORIGIN}/usage`, policyVersion: 'fixture',
    dbPath: ':memory:', sourceCommit: 'a'.repeat(40), buildIdentity: 'fixture-build',
    ...storage, requiresInvitation: false, verificationTtlMs, liveResults: { pollMs: 10, heartbeatMs: 30, ...transportOptions } },
    serviceFactories: [deps => {
      identity = createVisitorIdentity(deps);
      const ownership = { ownerAuthority: identity.principal, visitorIdentity: identity, taskAdmission: identity.admitMatching };
      matching = createMatchingService({ ...deps, ...ownership, provider: { available: () => providerAvailable,
        classify: async ({ jobs }) => ({ decisions: jobs.map(j => ({ id: j.id, decision: 'accepted' })) }) } });
      intent = createIntentService({ ...deps, ...ownership, matching });
      const visitor = createVisitorService({ ...deps, identity, intent, matching });
      live = createLiveResultsService({ ...deps, intent });
      return [intent, matching, visitor, live];
    }] });
  for (const name of ['a','b']) {
    const created = await app.auth.register({ username: `fixture-${name}`, password: 'Synthetic-password-123!' });
    accounts.set(name, created);
    app.store.db.prepare("INSERT INTO access_subscriptions VALUES(?,?,1,'active','monthly',?,0)").run(`fixture-${name}`, created.account.id, AT + DAY);
  }
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  t.after(async () => { app.server.closeAllConnections(); await app.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
  function importJobs(jobs, extra = {}) { app.store.importSnapshot({ schemaVersion: 1, snapshotAt: new Date(time).toISOString(),
    verifiedAt: new Date(time).toISOString(), jobs, observations: [], unknownIds: [], ...extra }); }
  function search(owner = 'a', id = 'search-a', residual = false) {
    const accepted = { id, revision: 1, query: 'Engineer', title: 'Engineering', description: 'Engineer', requirements: [], warnings: [],
      configuration: { schemaVersion: 1, filters: { ...Object.fromEntries(FILTERS.map(k => [k, null])), titleAny: ['engineer'] },
        residualAi: residual ? { condition: 'A documented four day working week.', requirementIds: ['ai'] } : null } };
    app.store.db.prepare('INSERT INTO demo_searches(id,owner_id,revision,accepted_json,created_at,updated_at) VALUES(?,?,1,?,?,?)').run(id, accounts.get(owner)?.account.id ?? owner, JSON.stringify(accepted), time, time);
    return accepted;
  }
  async function connect(owner = 'a', { headers = {}, visitorToken, searchId = visitorToken ? 'visitor-search' : `search-${owner}`, revision = 1, ...requestOptions } = {}) {
    const controller = new AbortController(); t.after(() => controller.abort());
    const path = visitorToken ? '/visitor/workspace/events' : '/workspace/events';
    const res = await fetch(`${base}${path}?searchId=${encodeURIComponent(searchId)}&revision=${revision}`, {
      ...requestOptions, signal: controller.signal, headers: { Cookie: visitorToken ? `__Host-justup_visitor=${visitorToken}` : `__Host-justup_session=${accounts.get(owner)?.token}`, ...headers } });
    if (res.status !== 200) return { res, body: await res.json(), close: () => controller.abort() };
    const reader = res.body.getReader(); let buffer = '';
    async function next(type = 'snapshot') {
      let timeout;
      const read = async () => {
        while (true) {
          const boundary = buffer.indexOf('\n\n');
          if (boundary >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const lines = Object.fromEntries(frame.split('\n').map(line => { const i = line.indexOf(':'); return [line.slice(0, i), line.slice(i + 1).trim()]; }));
            if (lines.event === type) return { id: lines.id, data: JSON.parse(lines.data) };
            continue;
          }
          const chunk = await reader.read(); if (chunk.done) throw Error('Stream closed before expected event');
          buffer += new TextDecoder().decode(chunk.value);
        }
      };
      try { return await Promise.race([read(), new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Timed out waiting for event')), 3000); })]); }
      finally { clearTimeout(timeout); }
    }
    return { res, next, close: () => controller.abort() };
  }
  async function work() { const task = app.tasks.claim({ workerId: 'fixture', kinds: ['ai_match'] }); assert(task); return matching.runTask(task); }
  return { app, live, intent, matching, identity, importJobs, search, connect, work,
    blockDeletion: () => writeFileSync(`${storage.privateGenerationPath}.pending`, 'fixture-pending', { mode: 0o600 }),
    downgrade: owner => app.store.db.prepare("UPDATE access_subscriptions SET status='ended',paid_through_at=NULL WHERE account_id=?").run(accounts.get(owner).account.id),
    pauseProvider: () => { providerAvailable = false; },
    advance: ms => time += ms, logout: () => app.auth.invalidateAllSessions() };
}
const ids = event => event.data.searches[0].items.map(j => j.id);

test('local HTTP streams incremental canonical arrivals and recovers bound opaque identities on reconnect', async t => {
  const s = await setup(t); s.importJobs([job('older')]); s.search();
  const stream = await s.connect(); assert.equal(stream.res.status, 200);
  assert.match(stream.res.headers.get('content-type'), /^text\/event-stream/);
  assert.equal(stream.res.headers.get('cache-control'), 'private, no-store, no-transform');
  assert.equal(stream.res.headers.get('x-accel-buffering'), 'no');
  const first = await stream.next(); assert.deepEqual(ids(first), ['older']); assert.match(first.id, /^[\w-]{43}$/); assert.equal(first.data.reason, 'initial');
  assert.equal(first.data.scope, 'active_search'); assert.equal(first.data.searchId, 'search-a'); assert.equal(JSON.stringify(first).includes('bodyText'), false);
  s.importJobs([job('newer', AT - 2 * DAY), job('older')]);
  const changed = await stream.next(); assert.deepEqual(ids(changed), ['newer','older']); assert.notEqual(changed.id, first.id); stream.close();
  const resumed = await s.connect('a', { headers: { 'Last-Event-ID': changed.id } });
  assert.equal((await resumed.next()).data.reason, 'resumed'); resumed.close();
  const missed = await s.connect('a', { headers: { 'Last-Event-ID': 'z'.repeat(43) } }); assert.equal((await missed.next()).data.reason, 'recovery');
  const bad = await s.connect('a', { headers: { 'Last-Event-ID': 'invalid' } }); assert.equal(bad.res.status, 400);
});

test('closure, fourteen-day expiry and paid downgrade remove now-ineligible identities while fresh zero differs from outage', async t => {
  const s = await setup(t); s.importJobs([job('latest', AT - DAY), job('closed'), job('expiring', AT - 14 * DAY + 1000)]); s.search();
  const stream = await s.connect(); assert.deepEqual(ids(await stream.next()), ['latest','closed','expiring']);
  s.importJobs([], { observations: [{ id: 'closed', active: false, observedAt: new Date(AT).toISOString() }] });
  const closed = await stream.next(); assert.deepEqual(ids(closed), ['latest','expiring']); assert(!JSON.stringify(closed).includes('"closed"'));
  s.advance(2000); s.downgrade('a');
  const expired = await stream.next(); assert.deepEqual(ids(expired), []); assert.equal(expired.data.searches[0].continuation.state, 'exhausted');
  assert(!JSON.stringify(expired).includes('"latest"')); assert(!JSON.stringify(expired).includes('"expiring"'));
  s.advance(DAY); const unavailable = await stream.next('unavailable'); assert.equal(unavailable.data.reason, 'reconnect');
});

test('residual snapshots wait for newest resolution, retain older accepted matches and never move ordinary delivery', async t => {
  const s = await setup(t); s.importJobs([job('first', AT - 3 * DAY), job('second', AT - 4 * DAY), job('excluded', AT - 5 * DAY, 'Designer')]); s.search('a', 'search-a', true);
  const stream = await s.connect(); const pending = await stream.next(); assert.deepEqual(ids(pending), []); assert.equal(pending.data.searches[0].continuation.state, 'pending');
  const scan = s.app.store.db.prepare("SELECT id FROM demo_match_scans WHERE cohort='visible'").get();
  s.app.store.db.prepare("UPDATE demo_match_jobs SET decision='accepted' WHERE scan_id=? AND position=1").run(scan.id);
  // Seed the durable decision a completed older batch would commit, while the
  // newer candidate remains unresolved. Import reconciliation must reuse it.
  s.app.store.db.prepare(`INSERT INTO demo_match_cache
    SELECT j.cache_key,s.owner_id,s.condition_hash,j.evidence_hash,s.classifier,'accepted',?,?
    FROM demo_match_jobs j JOIN demo_match_scans s ON s.id=j.scan_id WHERE s.id=? AND j.position=1`).run(AT, AT + DAY, scan.id);
  const late = await stream.next(); assert.deepEqual(ids(late), []); assert(late.data.searches[0].reconciliation.retainedItemIds.includes('second'));
  assert.equal(s.app.store.db.prepare('SELECT delivered FROM demo_match_scans WHERE id=?').get(scan.id).delivered, 0);
  await s.work(); const resolved = await stream.next(); assert.deepEqual(ids(resolved), ['first','second']);
  assert(!JSON.stringify(resolved).includes('excluded')); assert.equal(s.app.store.db.prepare('SELECT delivered FROM demo_match_scans WHERE id=?').get(scan.id).delivered, 0);
  assert.equal(s.app.store.db.prepare('SELECT count(*) AS n FROM demo_match_cursors').get().n, 0);
  s.importJobs([job('newest', AT - 2 * DAY), job('first', AT - 3 * DAY), job('second', AT - 4 * DAY)]);
  const refreshed = await stream.next(); assert.deepEqual(ids(refreshed), []);
  assert.equal(refreshed.data.searches[0].continuation.state, 'pending');
  assert.equal(refreshed.data.searches[0].reconciliation.complete, true);
  assert.deepEqual(new Set(refreshed.data.searches[0].reconciliation.retainedItemIds), new Set(['first','second']));
});

test('search revision, cross-owner identity and logout cannot authorize stale rows', async t => {
  const s = await setup(t); s.importJobs([job('engineer')]); s.search(); s.search('b', 'search-b');
  const a = await s.connect(), first = await a.next(); a.close();
  const b = await s.connect('b', { headers: { 'Last-Event-ID': first.id } }); const foreign = await b.next(); assert.equal(foreign.data.reason, 'recovery'); assert.equal(foreign.data.searches[0].searchId, 'search-b'); b.close();
  assert.equal((await s.connect('b', { searchId: 'search-a' })).res.status, 404);
  const row = s.app.store.db.prepare('SELECT accepted_json FROM demo_searches WHERE id=?').get('search-a');
  const accepted = JSON.parse(row.accepted_json); accepted.revision = 2; accepted.configuration.filters.titleAny = ['nonexistent'];
  s.app.store.db.prepare('UPDATE demo_searches SET revision=2,accepted_json=? WHERE id=?').run(JSON.stringify(accepted), 'search-a');
  const staleRequest = await s.connect('a', { headers: { 'Last-Event-ID': first.id } }); assert.equal(staleRequest.res.status, 409);
  const stale = await s.connect('a', { revision: 2, headers: { 'Last-Event-ID': first.id } }); const revised = await stale.next(); assert.equal(revised.data.reason, 'recovery'); assert.equal(revised.data.searches[0].revision, 2); assert.deepEqual(ids(revised), []);
  s.logout(); assert.equal((await stale.next('unavailable')).data.reason, 'authority_lost');
});

test('visitor cookies, same-origin checks, connection caps and service close enforce the transport boundary', async t => {
  const s = await setup(t, { maxConnectionsPerOwner: 1 }); s.importJobs([job('hidden', AT - DAY), job('eligible')]);
  const visitor = s.identity.open(null); s.search(visitor.principal.visitor.id, 'visitor-search');
  const stream = await s.connect('a', { visitorToken: visitor.token }); const first = await stream.next(); assert.deepEqual(ids(first), ['eligible']); assert(!JSON.stringify(first).includes('"hidden"'));
  const capped = await s.connect('a', { visitorToken: visitor.token }); assert.equal(capped.res.status, 429); stream.close();
  const origin = await s.connect('a', { headers: { Origin: 'https://elsewhere.example' } }); assert.equal(origin.res.status, 403);
  const crossSite = await s.connect('a', { headers: { 'Sec-Fetch-Site': 'cross-site' } }); assert.equal(crossSite.res.status, 403);
  s.search(); const account = await s.connect(); await account.next();
  s.live.close(); await assert.rejects(() => account.next());
  assert.equal((await s.connect()).res.status, 503);
});

test('fresh zero and stale import remain distinct over an open connection', async t => {
  const s = await setup(t, { verificationTtlMs: 1000 }); s.importJobs([job('designer', AT - 3 * DAY, 'Designer')]); s.search();
  const stream = await s.connect(); const zero = await stream.next(); assert.deepEqual(ids(zero), []); assert.equal(zero.data.searches[0].continuation.state, 'exhausted');
  s.advance(5001); const outage = await stream.next(); assert.deepEqual(ids(outage), []); assert.equal(outage.data.searches[0].coverage.stale, true); assert.equal(outage.data.searches[0].continuation.state, 'paused');
});

test('an unavailable classifier produces a paused active search without inventing a real zero', async t => {
  const s = await setup(t); s.importJobs([job('eligible')]); s.search('a', 'search-a', true); s.pauseProvider();
  const stream = await s.connect(); const paused = await stream.next(); assert.deepEqual(ids(paused), []);
  assert.equal(paused.data.searches[0].continuation.state, 'paused'); assert.equal(paused.data.searches[0].ai.status, 'dependency_unavailable');
});

test('a newly pending private-deletion barrier stops an existing persistent HTTP stream before another listing write', async t => {
  const s = await setup(t, { persistent: true }); s.importJobs([job('eligible')]); s.search();
  const stream = await s.connect(); await stream.next(); s.blockDeletion();
  assert.equal((await stream.next('unavailable')).data.reason, 'dependency_unavailable');
  assert.equal((await s.connect()).res.status, 503);
  assert.equal(s.app.store.db.isTransaction, false);
});

test('an active revision change closes the stream and cannot initialize work for inactive saved tabs', async t => {
  const s = await setup(t); s.importJobs([job('eligible')]); s.search(); s.search('a', 'inactive-ai', true);
  const stream = await s.connect(); await stream.next();
  assert.equal(s.app.store.db.prepare('SELECT count(*) AS n FROM demo_match_scans').get().n, 0);
  s.app.store.db.prepare('DELETE FROM demo_searches WHERE id=?').run('search-a');
  assert.equal((await stream.next('unavailable')).data.reason, 'search_changed');
  assert.equal(s.app.store.db.prepare('SELECT count(*) AS n FROM demo_match_scans').get().n, 0);
});

test('oversize canonical events close safely without publishing a partial snapshot', async t => {
  const s = await setup(t, { maxEventBytes: 1024 }); s.importJobs(Array.from({ length: 8 }, (_, i) => job(`eligible-${i}`, AT - (3 + i / 10) * DAY))); s.search();
  const stream = await s.connect(); assert.equal((await stream.next('unavailable')).data.reason, 'dependency_unavailable');
});

test('slow consumers retain one bounded frame and release their connection after the drain deadline', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE demo_searches(id TEXT,owner_id TEXT,revision INTEGER,accepted_json TEXT)');
  db.exec("INSERT INTO demo_searches VALUES('search-a','a',1,'{}')");
  let reads = 0;
  const live = createLiveResultsService({ db, feed: { generation: () => null }, intent: { snapshot() { reads++; return { searches: [], generation: null, revisionKey: '[]' }; } },
    config: { liveResults: { pollMs: 10, drainMs: 20 } } }); t.after(() => live.close());
  const req = new EventEmitter(), res = new EventEmitter(); const writes = [];
  Object.assign(res, { writeHead() {}, flushHeaders() {}, write(frame) { writes.push(frame); return false; },
    end() {}, destroy() { this.destroyed = true; this.emit('destroyed'); } });
  const destroyed = new Promise(resolve => res.once('destroyed', resolve));
  live.openStream({ req, res, readAuthority: () => ({ account: { id: 'a' }, access: paid }), authorityKey: 'test', searchId: 'search-a', revision: 1 });
  let timeout;
  try { await Promise.race([destroyed, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Drain deadline did not close the stream')), 1000); })]); }
  finally { clearTimeout(timeout); }
  assert.equal(writes.length, 1); assert.equal(reads, 0); assert.equal(res.destroyed, true);
});
