// Durable matching integration tests with isolated SQLite and synthetic evidence.
// The core task queue owns lease mechanics; this suite proves its feature boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { createMatchingService } from './matching.mjs';

const START = Date.parse('2026-10-31T16:00:00Z');
const owner = 'owner-1';
const viewer = { account: { id: owner }, expiresAt: new Date(START + 86_400_000).toISOString(), access: { kind: 'demo', fullAccess: true } };
const configuration = { schemaVersion: 1, filters: { titleAny: ['engineer'] }, residualAi: { condition: 'A documented four day week.', requirementIds: ['r1'] } };
function makeJob(i, extra = {}) {
  const bodyText = 'The job offers a documented four day working week, with regular office hours. '.repeat(4);
  return { id: `synthetic-${String(i).padStart(4, '0')}`, title: 'Synthetic engineer', companyName: 'Example',
    firstObserved: new Date(START - i * 60_000).toISOString(), bodyText,
    evidenceHash: createHash('sha256').update(bodyText + i).digest('hex'), evidence: { aiEligible: true, truncated: false }, ...extra };
}
function setup(t, { count = 10, decisions = () => 'accepted', matching = {}, provider: suppliedProvider } = {}) {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON;'); t.after(() => db.close());
  let time = START, generation = 'import-1', stale = false;
  let jobs = Array.from({ length: count }, (_, i) => makeJob(i));
  let calls = 0;
  const tasksMap = new Map();
  const tasks = {
    enqueue(input) {
      const existing = [...tasksMap.values()].find((x) => x.requestKey === input.requestKey);
      if (existing) return structuredClone(existing);
      const value = { ...structuredClone(input), id: randomUUID(), status: 'pending', leaseToken: null, leaseUntil: null };
      tasksMap.set(value.id, value); return structuredClone(value);
    },
    get(ownerId, id) { const value = tasksMap.get(id); return value?.ownerId === ownerId ? structuredClone(value) : null; },
    claim() { const value = [...tasksMap.values()].find((x) => x.status === 'pending'); if (!value) return null;
      Object.assign(value, { status: 'running', leaseToken: randomUUID(), leaseUntil: time + 30_000 }); return structuredClone(value); },
    complete(id, token, result) { const value = tasksMap.get(id);
      if (!value || value.status !== 'running' || value.leaseToken !== token || value.leaseUntil <= time) return false;
      Object.assign(value, result); return true; },
    delete(ownerId, id) { if (tasksMap.get(id)?.ownerId === ownerId) return tasksMap.delete(id); return false; },
  };
  const feed = { generation: () => generation, coverage: () => ({ kind: 'imported_snapshot', verifiedAt: new Date(START).toISOString(), stale }),
    eligibleJobs: () => stale ? [] : jobs.filter((j) => Date.parse(j.firstObserved) >= time - 14 * 86_400_000),
    publicJob: (j) => ({ id: j.id, title: j.title, firstObserved: j.firstObserved }) };
  const provider = suppliedProvider ?? { available: () => true, classify: async ({ jobs: batch }) => { calls++;
    return { decisions: [...batch].reverse().map((j) => ({ id: j.id, decision: decisions(j) })),
      usage: { inputTokens: 100, outputTokens: 24 }, costNanodollars: 4200, attempts: 1, ambiguousAttempts: 0 }; } };
  const service = createMatchingService({ db, feed, tasks, provider, config: { matching }, now: () => time });
  const page = (overrides = {}) => service.page({ ownerId: owner, searchId: 'search-1', revision: 1,
    configuration, jobs: feed.eligibleJobs(), viewer, coverage: feed.coverage(), generation, ...overrides });
  const run = async () => { const task = tasks.claim(); assert(task, 'expected queued work'); return service.runTask(task); };
  return { db, service, page, run, tasks, tasksMap, provider, feed, calls: () => calls,
    time: () => time, advance: (ms) => { time += ms; }, setJobs: (value) => { jobs = value; },
    jobs: () => jobs, setGeneration: (v) => { generation = v; }, setStale: (v) => { stale = v; } };
}

test('only supplied primary candidates are evaluated and public pages preserve newest-first order', async (t) => {
  const s = setup(t, { count: 8 });
  const selected = [s.jobs()[5], s.jobs()[1], s.jobs()[3]];
  const first = s.page({ jobs: selected }); assert.equal(first.continuation.state, 'pending'); assert.deepEqual(first.items, []);
  const task = await s.run(); assert.equal(task.committed, true); assert.equal(task.output.evaluated, 3);
  const second = s.page({ jobs: selected, cursor: first.continuation.cursor });
  assert.deepEqual(second.items.map((j) => j.id), [1, 3, 5].map((i) => makeJob(i).id));
  assert.equal(second.continuation.state, 'exhausted'); assert(!JSON.stringify(second).includes('bodyText'));
});

test('an older accepted row waits for the newest unresolved row', async (t) => {
  const s = setup(t, { count: 3 }); const first = s.page();
  const scan = s.db.prepare('SELECT id FROM demo_match_scans').get();
  s.db.prepare("UPDATE demo_match_jobs SET decision='accepted' WHERE scan_id=? AND position=2").run(scan.id);
  const waiting = s.page({ cursor: first.continuation.cursor }); assert.deepEqual(waiting.items, []); assert.equal(waiting.continuation.state, 'pending');
  await s.run();
  assert.deepEqual(s.page({ cursor: waiting.continuation.cursor }).items.map((j) => j.id), s.jobs().map((j) => j.id));
});

test('zero-yield work resumes until the scan ends, then drains its accepted buffer', async (t) => {
  const s = setup(t, { count: 80, matching: { batchSize: 12, maxBatchesPerTask: 2 },
    decisions: (j) => Number(j.id.slice(-4)) >= 72 ? 'accepted' : 'rejected' });
  let result = s.page(); let zeroPages = 0;
  for (let i = 0; i < 5 && result.continuation.state !== 'exhausted'; i++) {
    await s.run(); result = s.page({ cursor: result.continuation.cursor, limit: 3 });
    if (!result.items.length) { zeroPages++; assert.notEqual(result.continuation.state, 'exhausted'); }
    if (!s.tasksMap.size || ![...s.tasksMap.values()].some((x) => x.status === 'pending')) break;
  }
  assert.equal(zeroPages, 3); assert.equal(result.items[0].id, makeJob(72).id); assert.equal(result.continuation.state, 'open');
  const next = s.page({ cursor: result.continuation.cursor, limit: 50 });
  assert.equal(next.items.length, 5); assert.equal(next.continuation.state, 'exhausted');
});

test('weak, missing, oversized and truncated evidence cannot be confidently accepted', async (t) => {
  const s = setup(t, { count: 0 });
  s.setJobs([makeJob(0, { evidence: { aiEligible: true, truncated: true } }), makeJob(1, { bodyText: null }),
    makeJob(2, { bodyText: 'x'.repeat(20_000) }), makeJob(3, { evidence: { aiEligible: true, truncated: false, quality: 'weak' } }), makeJob(4)]);
  const result = s.page(); await s.run();
  const end = s.page({ cursor: result.continuation.cursor });
  assert.deepEqual(end.items.map((j) => j.id), [makeJob(4).id]); assert.equal(end.continuation.state, 'exhausted');
});

test('provider failure pauses and retains the condition, cursor, scan position and unresolved rows', async (t) => {
  let failing = true;
  const provider = { available: () => true, classify: async ({ jobs }) => {
    if (failing) throw Object.assign(new Error('safe fake outage'), { code: 'provider_unavailable' });
    return { decisions: jobs.map((j) => ({ id: j.id, decision: 'accepted' })) };
  } };
  const s = setup(t, { count: 2, provider }); const first = s.page(); const task = await s.run();
  assert.equal(task.status, 'warning'); assert.equal(task.output.pause, 'provider_unavailable');
  const paused = s.page({ cursor: first.continuation.cursor }); assert.equal(paused.continuation.state, 'paused'); assert.deepEqual(paused.items, []);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM demo_match_jobs WHERE decision IS NULL').get().n, 2);
  assert.equal(s.db.prepare('SELECT condition FROM demo_match_scans').get().condition, configuration.residualAi.condition);
  failing = false; s.advance(5001); s.page({ cursor: paused.continuation.cursor }); await s.run();
  assert.equal(s.page({ cursor: paused.continuation.cursor }).items.length, 2);
});

test('disabled providers and stale imports report paused rather than fabricated rejection/exhaustion', (t) => {
  const s = setup(t, { provider: { available: () => false } }); const result = s.page();
  assert.equal(result.continuation.state, 'paused'); assert.equal(result.ai.status, 'dependency_unavailable'); assert.equal(s.tasksMap.size, 0);
  s.setStale(true); const stale = s.page({ cursor: result.continuation.cursor });
  assert.equal(stale.continuation.state, 'paused'); assert.equal(stale.ai.status, 'import_unavailable');
});

test('API heartbeat readiness queues without credentials and cannot enable provider execution', async (t) => {
  let requests = 0, ready = true;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('HTTP forbidden in API role'); });
  const s = setup(t, { count: 2 });
  const api = createMatchingService({ db: s.db, feed: s.feed, tasks: s.tasks, now: s.time,
    readOnlyProvider: true, availability: () => ready });
  const args = { ownerId: owner, searchId: 'api-search', revision: 1, configuration, jobs: s.jobs(), viewer };
  assert.equal(api.available(), true); assert.equal(api.readiness().executionAvailable, false);
  assert.equal(api.readiness().role, 'queue');
  const initial = api.page(args); assert.equal(initial.continuation.state, 'pending');
  const task = s.tasks.claim(); assert.equal(task.kind, 'ai_match');
  const result = await api.runTask(task);
  assert.equal(result.output.pause, 'dependency_unavailable'); assert.equal(requests, 0);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM demo_match_jobs WHERE decision IS NULL').get().n, 2);
  ready = false;
  const paused = api.page({ ...args, cursor: initial.continuation.cursor });
  assert.equal(paused.continuation.state, 'paused'); assert.equal(paused.ai.status, 'dependency_unavailable');
  assert.equal(api.available(), false);
  const brokenHeartbeat = createMatchingService({ db: s.db, feed: s.feed, tasks: s.tasks,
    readOnlyProvider: true, availability: () => { throw new Error('heartbeat unavailable'); } });
  assert.equal(brokenHeartbeat.available(), false);
});

test('API role prohibits execution even if a provider is accidentally injected and purges private provider ledgers', async (t) => {
  let executed = 0;
  const s = setup(t, { count: 1 });
  // The default keyless API provider creates and cleans its accounting schema.
  const api = createMatchingService({ db: s.db, feed: s.feed, tasks: s.tasks, now: s.time,
    readOnlyProvider: true, availability: () => true });
  s.db.prepare('INSERT INTO demo_jev_usage VALUES(?,?,?,?,?,?,?,?)').run('account', owner, START, 1, 100, 10, 4200, 0);
  s.db.prepare('INSERT INTO demo_jev_usage VALUES(?,?,?,?,?,?,?,?)').run('project', 'project', START, 1, 100, 10, 4200, 0);
  s.db.prepare('INSERT INTO demo_jev_reservations VALUES(?,?,?,?,?,?,?,?,?)').run('reservation', owner, 'project', START, 100, 10, 4200, 'reserved', START);
  const guarded = createMatchingService({ db: s.db, feed: s.feed, tasks: s.tasks, now: s.time,
    readOnlyProvider: true, availability: () => true,
    provider: { available: () => true, classify: async () => { executed++; return { decisions: [] }; } } });
  guarded.page({ ownerId: owner, searchId: 'guarded', revision: 1, configuration, jobs: s.jobs(), viewer });
  const task = s.tasks.claim(), result = await guarded.runTask(task);
  assert.equal(result.output.pause, 'dependency_unavailable'); assert.equal(executed, 0);
  s.db.exec('BEGIN IMMEDIATE'); api.deleteAccountData(owner); s.db.exec('COMMIT');
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM demo_jev_usage WHERE scope='account'").get().n, 0);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM demo_jev_reservations').get().n, 0);
  assert.equal(s.db.prepare("SELECT calls FROM demo_jev_usage WHERE scope='project'").get().calls, 1);
});

test('cursors bind owner, revision, condition, access, import generation and ten-minute expiry', (t) => {
  const s = setup(t); const result = s.page(); const cursor = result.continuation.cursor;
  assert(!cursor.includes('synthetic')); assert.equal(cursor.length, 43);
  for (const changes of [{ revision: 2 }, { configuration: { ...configuration, residualAi: { condition: 'Another requirement' } } },
    { viewer: { ...viewer, access: { kind: 'demo', fullAccess: false } } }, { generation: 'import-2' }]) {
    assert.throws(() => s.page({ ...changes, cursor }), { code: 'stale_cursor', status: 409 });
  }
  assert.throws(() => s.page({ ownerId: 'other', cursor }), { code: 'forbidden' });
  assert.throws(() => s.page({ viewer: null, cursor }), { code: 'unauthenticated' });
  s.advance(600_000); assert.throws(() => s.page({ cursor }), { code: 'stale_cursor', status: 409 });
});

test('delivery rechecks eligible/primary membership and evidence before serializing', async (t) => {
  const s = setup(t, { count: 4 }); const result = s.page(); await s.run();
  s.setJobs([s.jobs()[1], s.jobs()[2], { ...s.jobs()[3], bodyText: 'Changed evidence. '.repeat(30) }]);
  const end = s.page({ cursor: result.continuation.cursor, jobs: [s.jobs()[0], s.jobs()[2]] });
  assert.deepEqual(end.items.map((j) => j.id), [makeJob(1).id]);
});

test('exact decisions deduplicate repeated searches but invalidate changed condition/evidence/version', async (t) => {
  const s = setup(t, { count: 3 }); s.page(); await s.run(); assert.equal(s.calls(), 1);
  const other = s.page({ searchId: 'search-2' }); assert.equal(other.items.length, 3); assert.equal(s.calls(), 1);
  s.page({ searchId: 'search-3', configuration: { ...configuration, residualAi: { condition: 'A different condition' } } }); await s.run(); assert.equal(s.calls(), 2);
  s.setJobs(s.jobs().map((j) => ({ ...j, bodyText: j.bodyText + ' New evidence.' })));
  s.page({ searchId: 'search-4' }); await s.run(); assert.equal(s.calls(), 3);
  const upgraded = createMatchingService({ db: s.db, feed: s.feed, tasks: s.tasks, provider: s.provider,
    now: s.time, config: { matching: { classifierVersion: 'test-next-classifier' } } });
  assert.equal(upgraded.page({ ownerId: owner, searchId: 'search-4', revision: 1, configuration, jobs: s.jobs(), viewer }).items.length, 0);
});

test('identical evidence is evaluated once within a batch and refresh timestamps retain cached decisions', async (t) => {
  const s = setup(t, { count: 3 });
  s.setJobs(s.jobs().map((j) => ({ ...j, evidenceHash: 'same-semantic-evidence', evidence: { ...j.evidence, metadataFetchedAt: '2026-10-31T15:00:00Z' } })));
  const initial = s.page(), result = await s.run(); assert.equal(result.output.evaluated, 1);
  assert.equal(s.page({ cursor: initial.continuation.cursor }).items.length, 3);
  s.setJobs(s.jobs().map((j) => ({ ...j, evidence: { ...j.evidence, metadataFetchedAt: '2026-10-31T16:00:00Z' } })));
  const cached = s.page({ searchId: 'search-2' }); assert.equal(cached.items.length, 3); assert.equal(s.calls(), 1);
});

test('concurrent page requests share one pending task and a canceled lease cannot commit late results', async (t) => {
  let finish;
  const s = setup(t, { count: 2, provider: { available: () => true, classify: ({ jobs }) => new Promise((resolve) => {
    finish = () => resolve({ decisions: jobs.map((j) => ({ id: j.id, decision: 'accepted' })) });
  }) } });
  const first = s.page(); s.page(); s.page({ cursor: first.continuation.cursor }); assert.equal(s.tasksMap.size, 1);
  const task = s.tasks.claim(), promise = s.service.runTask(task);
  s.service.deleteSearchData(owner, 'search-1'); finish(); const result = await promise;
  assert.equal(result.committed, undefined); assert.equal(s.db.prepare('SELECT count(*) AS n FROM demo_match_cache').get().n, 0);
  assert.equal(s.tasksMap.size, 0); assert.throws(() => s.page({ cursor: first.continuation.cursor }), { code: 'stale_cursor' });
});

test('search/account cleanup removes private scans, cursors, cache links, decisions and tasks', async (t) => {
  const s = setup(t, { count: 2 }); s.page(); await s.run(); s.page({ searchId: 'search-2' });
  s.service.deleteSearchData(owner, 'search-1');
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM demo_match_cache').get().n, 0);
  s.service.deleteAccountData(owner);
  for (const table of ['demo_match_scans', 'demo_match_jobs', 'demo_match_cursors', 'demo_match_cache', 'demo_match_cache_links'])
    assert.equal(s.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
  assert.equal(s.tasksMap.size, 0);
});

test('malformed provider result remains pending and exposes only safe provider status', async (t) => {
  const s = setup(t, { count: 2, provider: { available: () => true, classify: async () => ({ decisions: [{ id: 'unexpected', decision: 'accepted' }] }) } });
  const first = s.page(); await s.run(); const end = s.page({ cursor: first.continuation.cursor });
  assert.equal(end.ai.status, 'provider_unavailable'); assert.deepEqual(end.items, []);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM demo_match_cache').get().n, 0);
});

test('fake 5/12/24 candidate matrix measures scan progress and buffer starvation without model claims', async (t) => {
  const report = [];
  for (const batchSize of [5, 12, 24]) {
    const s = setup(t, { count: 120, matching: { batchSize }, decisions: (j) => Number(j.id.slice(-4)) >= 108 ? 'accepted' : 'rejected' });
    let page = s.page(), workCycles = 0, emptyAfterWork = 0, accepted = 0, evaluated = 0;
    while (page.continuation.state !== 'exhausted' && workCycles < 10) {
      const task = await s.run(); workCycles++; evaluated += task.output.evaluated;
      page = s.page({ cursor: page.continuation.cursor, limit: 50 });
      accepted += page.items.length; if (!page.items.length) emptyAfterWork++;
    }
    assert.equal(evaluated, 120); assert.equal(accepted, 12); assert.equal(page.continuation.state, 'exhausted');
    report.push({ batchSize, providerCalls: s.calls(), workCycles, emptyAfterWork, accepted, evaluated });
  }
  assert.deepEqual(report.map((r) => [r.providerCalls, r.workCycles, r.emptyAfterWork]), [[24, 6, 5], [10, 3, 2], [5, 2, 1]]);
  t.diagnostic(`Fake deterministic scan measurements: ${JSON.stringify(report)}; no real-provider quality, latency or cost measured.`);
});
