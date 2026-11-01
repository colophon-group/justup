// Residual-only matching over an already authorized, primary-filtered candidate
// list. Read when changing durable scans, chronological delivery or private cleanup.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { canonicalCondition, CLASSIFIER_VERSION, createJevClient, evidenceEligible, planJevBatch } from './jev.mjs';

const DAY = 86_400_000, CURSOR_TTL = 600_000, RETENTION = 7 * DAY;
const sha = (v) => createHash('sha256').update(typeof v === 'string' ? v : canonical(v)).digest('hex');
function canonical(v) { return JSON.stringify(v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, JSON.parse(canonical(v[k]))]))
  : Array.isArray(v) ? v.map((x) => JSON.parse(canonical(x))) : v); }
const err = (code, status = 400) => Object.assign(new Error('Matching request could not finish.'), { code, status });
const tx = (db, fn) => { db.exec('BEGIN IMMEDIATE'); try { const v = fn(); db.exec('COMMIT'); return v; } catch (e) { db.exec('ROLLBACK'); throw e; } };
const fingerprint = (j) => sha({ title: j.title, companyName: j.companyName, bodyText: j.bodyText ?? null,
  evidenceHash: j.evidenceHash ?? null, evidence: { normalizationVersion: j.evidence?.normalizationVersion ?? null,
    aiEligible: j.evidence?.aiEligible ?? false, truncated: j.evidence?.truncated ?? true, quality: j.evidence?.quality ?? null } });
const order = (a, b) => Date.parse(b.firstObserved) - Date.parse(a.firstObserved) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const terminal = (t) => !t || ['succeeded', 'warning', 'failed', 'cancelled'].includes(t.status);

export function createMatchingService({ db, feed, tasks, config = {}, now = Date.now, provider,
  availability, readOnlyProvider = false } = {}) {
  if (!db || !feed?.eligibleJobs || !feed?.publicJob || !tasks?.enqueue || !tasks?.get || !tasks?.complete) throw new TypeError('Matching dependencies are required.');
  if (typeof readOnlyProvider !== 'boolean' || (availability != null && typeof availability !== 'function')) throw new TypeError('Invalid matching role configuration.');
  provider ??= createJevClient({ db, config: config.jev ?? {}, now });
  const version = config.matching?.classifierVersion ?? CLASSIFIER_VERSION;
  const batchSize = config.matching?.batchSize ?? 24, maxBatches = config.matching?.maxBatchesPerTask ?? 4;
  const readyLimit = config.matching?.readyLimit ?? 48, workMs = config.matching?.workMs ?? 60_000;
  if (typeof version !== 'string' || version.length > 200 || !version || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 24
      || !Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > 4 || !Number.isInteger(readyLimit) || readyLimit < 12 || readyLimit > 96
      || !Number.isInteger(workMs) || workMs < 1 || workMs > 60_000) throw new TypeError('Invalid matching bounds.');
  db.exec(`CREATE TABLE IF NOT EXISTS demo_match_scans (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, search_id TEXT NOT NULL, revision INTEGER NOT NULL,
    config_hash TEXT NOT NULL, condition_hash TEXT NOT NULL, condition TEXT NOT NULL, classifier TEXT NOT NULL,
    generation TEXT NOT NULL, access_hash TEXT NOT NULL, state TEXT NOT NULL, pause_code TEXT,
    retry_at INTEGER, task_id TEXT, round INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(owner_id,search_id,revision,config_hash,classifier,generation,access_hash)) STRICT;
    CREATE TABLE IF NOT EXISTS demo_match_jobs (
    scan_id TEXT NOT NULL REFERENCES demo_match_scans(id) ON DELETE CASCADE,
    position INTEGER NOT NULL, job_id TEXT NOT NULL, evidence_hash TEXT NOT NULL, cache_key TEXT NOT NULL,
    decision TEXT CHECK(decision IN ('accepted','rejected','insufficient_evidence') OR decision IS NULL),
    PRIMARY KEY(scan_id,position), UNIQUE(scan_id,job_id)) STRICT;
    CREATE TABLE IF NOT EXISTS demo_match_cursors (
    token_hash TEXT PRIMARY KEY, scan_id TEXT NOT NULL REFERENCES demo_match_scans(id) ON DELETE CASCADE,
    position INTEGER NOT NULL, created_at INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS demo_match_cache (
    cache_key TEXT PRIMARY KEY, owner_id TEXT NOT NULL, condition_hash TEXT NOT NULL,
    evidence_hash TEXT NOT NULL, classifier TEXT NOT NULL, decision TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL) STRICT;
    CREATE INDEX IF NOT EXISTS demo_match_cache_owner ON demo_match_cache(owner_id);
    CREATE TABLE IF NOT EXISTS demo_match_cache_links (
    owner_id TEXT NOT NULL, search_id TEXT NOT NULL,
    cache_key TEXT NOT NULL REFERENCES demo_match_cache(cache_key) ON DELETE CASCADE,
    PRIMARY KEY(owner_id,search_id,cache_key)) STRICT;`);
  const scanById = (id) => db.prepare('SELECT * FROM demo_match_scans WHERE id=?').get(id);
  const rows = (id) => db.prepare('SELECT * FROM demo_match_jobs WHERE scan_id=? ORDER BY position').all(id);
  const executionAvailable = () => !readOnlyProvider && provider.available?.() === true && typeof provider.classify === 'function';
  function available() {
    // The API has no provider key. Its trusted same-build runner heartbeat can
    // authorize enqueueing, never execution; missing/stale/failed reads close it.
    if (!readOnlyProvider) return executionAvailable();
    try { return availability?.() === true; } catch { return false; }
  }
  function deleteScan(scan) {
    if (scan.task_id) tasks.delete(scan.owner_id, scan.task_id);
    db.prepare('DELETE FROM demo_match_scans WHERE id=?').run(scan.id);
  }
  function cleanup() {
    for (const s of db.prepare('SELECT * FROM demo_match_scans WHERE created_at<=?').all(now() - RETENTION)) deleteScan(s);
    db.prepare('DELETE FROM demo_match_cursors WHERE created_at<=?').run(now() - CURSOR_TTL);
    db.prepare('DELETE FROM demo_match_cache WHERE expires_at<=?').run(now());
    provider.cleanup?.();
  }
  function deleteSearchData(ownerId, searchId) {
    for (const s of db.prepare('SELECT * FROM demo_match_scans WHERE owner_id=? AND search_id=?').all(ownerId, searchId)) deleteScan(s);
    db.prepare('DELETE FROM demo_match_cache WHERE owner_id=? AND cache_key IN (SELECT cache_key FROM demo_match_cache_links WHERE owner_id=? AND search_id=?)').run(ownerId, ownerId, searchId);
    db.prepare('DELETE FROM demo_match_cache_links WHERE owner_id=? AND search_id=?').run(ownerId, searchId);
  }
  function deleteAccountData(ownerId) {
    for (const s of db.prepare('SELECT * FROM demo_match_scans WHERE owner_id=?').all(ownerId)) deleteScan(s);
    db.prepare('DELETE FROM demo_match_cache WHERE owner_id=?').run(ownerId);
    db.prepare('DELETE FROM demo_match_cache_links WHERE owner_id=?').run(ownerId);
    provider.deleteAccountData?.(ownerId);
  }
  function cacheDecision(scan, row, decision) {
    db.prepare(`INSERT INTO demo_match_cache VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET
      decision=excluded.decision,created_at=excluded.created_at,expires_at=excluded.expires_at`)
      .run(row.cache_key, scan.owner_id, scan.condition_hash, row.evidence_hash, scan.classifier, decision, now(), now() + RETENTION);
    db.prepare('INSERT OR IGNORE INTO demo_match_cache_links VALUES(?,?,?)').run(scan.owner_id, scan.search_id, row.cache_key);
  }
  function cached(scan, row) {
    const r = db.prepare('SELECT decision FROM demo_match_cache WHERE cache_key=? AND owner_id=? AND classifier=? AND expires_at>?').get(row.cache_key, scan.owner_id, scan.classifier, now());
    if (r) db.prepare('INSERT OR IGNORE INTO demo_match_cache_links VALUES(?,?,?)').run(scan.owner_id, scan.search_id, row.cache_key);
    return r?.decision ?? null;
  }
  function refresh(scan) {
    for (const row of rows(scan.id)) if (row.decision == null) {
      const decision = cached(scan, row);
      if (decision) db.prepare('UPDATE demo_match_jobs SET decision=? WHERE scan_id=? AND position=?').run(decision, scan.id, row.position);
    }
  }
  function readyCount(scan) {
    const pending = db.prepare('SELECT min(position) AS n FROM demo_match_jobs WHERE scan_id=? AND decision IS NULL').get(scan.id).n;
    return db.prepare("SELECT count(*) AS n FROM demo_match_jobs WHERE scan_id=? AND position>=? AND position<? AND decision='accepted'")
      .get(scan.id, scan.delivered, pending ?? 1001).n;
  }
  function pendingCount(scan) { return db.prepare('SELECT count(*) AS n FROM demo_match_jobs WHERE scan_id=? AND decision IS NULL').get(scan.id).n; }
  function schedule(scan) {
    if (!pendingCount(scan) || readyCount(scan) >= readyLimit || !available()) return;
    const previous = scan.task_id ? tasks.get(scan.owner_id, scan.task_id) : null;
    if (!terminal(previous) || (scan.retry_at != null && scan.retry_at > now())) return;
    try {
      const round = scan.round + 1;
      const task = tasks.enqueue({ ownerId: scan.owner_id, kind: 'ai_match', requestKey: `match:${scan.id}:${round}`, payload: { scanId: scan.id } });
      db.prepare("UPDATE demo_match_scans SET task_id=?,round=?,state='pending',pause_code=NULL,retry_at=NULL,updated_at=? WHERE id=?")
        .run(task.id, round, now(), scan.id);
    } catch (e) {
      if (e.code !== 'task_limit') throw e;
      db.prepare("UPDATE demo_match_scans SET state='paused',pause_code='task_limit',retry_at=?,updated_at=? WHERE id=?").run(now() + 60_000, now(), scan.id);
    }
  }
  function cursorFor(scanId, position) {
    const token = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO demo_match_cursors VALUES(?,?,?,?)').run(sha(token), scanId, position, now());
    db.prepare('DELETE FROM demo_match_cursors WHERE scan_id=? AND token_hash NOT IN (SELECT token_hash FROM demo_match_cursors WHERE scan_id=? ORDER BY created_at DESC,rowid DESC LIMIT 64)').run(scanId, scanId);
    return token;
  }
  function page({ ownerId, searchId, revision, configuration, jobs, viewer, cursor = null, limit = 12,
    coverage = feed.coverage(), generation = feed.generation() } = {}) {
    const sessionDeadline = typeof viewer?.expiresAt === 'number' ? viewer.expiresAt : Date.parse(viewer?.expiresAt);
    if (!viewer?.account?.id || (viewer.expiresAt != null && (!Number.isFinite(sessionDeadline) || sessionDeadline <= now()))) throw err('unauthenticated', 401);
    if (viewer.account.id !== ownerId) throw err('forbidden', 403);
    if (typeof searchId !== 'string' || !searchId || searchId.length > 128 || !Number.isSafeInteger(revision) || revision < 1
        || !Array.isArray(jobs) || jobs.length > 1000 || (generation != null && (typeof generation !== 'string' || generation.length > 128))) throw err('invalid_input');
    generation ??= 'unavailable';
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw err('invalid_limit');
    let condition;
    try { condition = canonicalCondition(configuration?.residualAi?.condition); } catch { throw err('invalid_input'); }
    const configHash = sha(configuration), conditionHash = sha(condition), accessHash = sha({ ownerId, access: viewer.access ?? null });
    cleanup();
    let scan, position = 0;
    if (cursor != null) {
      if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(cursor)) throw err('invalid_cursor');
      const c = db.prepare('SELECT * FROM demo_match_cursors WHERE token_hash=?').get(sha(cursor));
      scan = c ? scanById(c.scan_id) : null;
      if (!scan || scan.owner_id !== ownerId || scan.search_id !== searchId || scan.revision !== revision
          || scan.config_hash !== configHash || scan.condition_hash !== conditionHash || scan.classifier !== version
          || scan.generation !== generation || scan.access_hash !== accessHash || c.created_at > now()
          || now() - c.created_at >= CURSOR_TTL) throw err('stale_cursor', 409);
      position = c.position;
    } else {
      // Old revisions cannot continue background spending after the first read of
      // a replacement revision. Cached exact decisions remain reusable.
      for (const s of db.prepare('SELECT * FROM demo_match_scans WHERE owner_id=? AND search_id=? AND (revision<>? OR generation<>? OR classifier<>?)').all(ownerId, searchId, revision, generation, version)) deleteScan(s);
      scan = db.prepare('SELECT * FROM demo_match_scans WHERE owner_id=? AND search_id=? AND revision=? AND config_hash=? AND classifier=? AND generation=? AND access_hash=?')
        .get(ownerId, searchId, revision, configHash, version, generation, accessHash);
      if (!scan) {
        if (db.prepare('SELECT count(*) AS n FROM demo_match_scans').get().n >= 96
            || db.prepare('SELECT count(*) AS n FROM demo_match_scans WHERE owner_id=?').get(ownerId).n >= 16) throw err('task_limit', 429);
        const id = randomUUID(), seen = new Set();
        const current = new Map(feed.eligibleJobs({ viewer }).map((j) => [j.id, j]));
        // Defend the module boundary again: supplied primary candidates may only
        // narrow the current eligible feed, never reintroduce hidden records.
        const eligible = jobs.filter((j) => current.has(j.id) && fingerprint(current.get(j.id)) === fingerprint(j)).sort(order);
        tx(db, () => {
          db.prepare('INSERT INTO demo_match_scans VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(id, ownerId, searchId, revision, configHash, conditionHash, condition, version, generation, accessHash, 'pending', null, null, null, 0, 0, now(), now());
          for (const [index, j] of eligible.entries()) {
            if (seen.has(j.id)) throw err('invalid_input'); seen.add(j.id);
            const evidence = fingerprint(j), key = sha({ ownerId, conditionHash, evidence, version });
            db.prepare('INSERT INTO demo_match_jobs VALUES(?,?,?,?,?,NULL)').run(id, index, j.id, evidence, key);
          }
        });
        scan = scanById(id);
      }
    }
    refresh(scan);
    const current = new Map(feed.eligibleJobs({ viewer }).map((j) => [j.id, j]));
    const supplied = new Map(jobs.map((j) => [j.id, j]));
    const items = []; let next = position;
    for (const row of rows(scan.id)) {
      if (row.position < position) continue;
      if (row.decision == null) break;
      const j = current.get(row.job_id), primary = supplied.get(row.job_id);
      next = row.position + 1;
      if (row.decision === 'accepted' && j && primary && fingerprint(j) === row.evidence_hash
          && fingerprint(primary) === row.evidence_hash) items.push(feed.publicJob(j));
      if (items.length >= limit) break;
    }
    db.prepare('UPDATE demo_match_scans SET delivered=max(delivered,?),updated_at=? WHERE id=?').run(next, now(), scan.id);
    scan = scanById(scan.id);
    if (!coverage.stale) schedule(scan);
    scan = scanById(scan.id);
    const all = rows(scan.id), remaining = all.filter((r) => r.position >= next), pending = remaining.some((r) => r.decision == null);
    let state, status, retryAfterMs = null;
    if (coverage.stale) { state = 'paused'; status = 'import_unavailable'; retryAfterMs = 5000; }
    else if (!remaining.length) { state = 'exhausted'; status = 'complete'; }
    else if (!pending || remaining[0].decision != null) { state = 'open'; status = 'matching'; }
    else if (!available()) { state = 'paused'; status = 'dependency_unavailable'; retryAfterMs = 5000; }
    else if (scan.state === 'paused' && scan.retry_at > now()) { state = 'paused'; status = scan.pause_code; retryAfterMs = scan.retry_at - now(); }
    else { state = 'pending'; status = 'matching'; retryAfterMs = 1000; }
    return { searchId, revision, asOf: new Date(now()).toISOString(), items,
      continuation: { cursor: state === 'exhausted' ? null : cursorFor(scan.id, next), state, retryAfterMs }, ai: { status }, coverage };
  }
  function taskLive(task) {
    const actual = tasks.get(task.ownerId, task.id);
    return actual?.kind === 'ai_match' && actual.status === 'running' && actual.leaseToken === task.leaseToken && actual.leaseUntil > now();
  }
  async function runTask(task, { signal } = {}) {
    if (task?.kind !== 'ai_match' || typeof task.payload?.scanId !== 'string') return { status: 'failed', errorCode: 'invalid_output', output: null };
    const scan = scanById(task.payload.scanId);
    if (!scan || scan.owner_id !== task.ownerId || scan.task_id !== task.id || !taskLive(task)) return { status: 'failed', errorCode: 'revision_conflict', output: null };
    let pause = null, batches = 0, evaluated = 0, cacheHits = 0, insufficient = 0;
    const started = now(), usage = { inputTokens: 0, outputTokens: 0, costNanodollars: 0, attempts: 0, ambiguousAttempts: 0 };
    const alive = () => !signal?.aborted && taskLive(task) && scanById(scan.id)?.task_id === task.id;
    while (alive() && now() - started < workMs && batches < maxBatches) {
      if ((feed.generation() ?? 'unavailable') !== scan.generation || feed.coverage().stale) { pause = 'import_unavailable'; break; }
      if (!executionAvailable()) {
        const reason = readOnlyProvider ? null : provider.readiness?.().reason;
        pause = ['budget_exhausted', 'budget_unavailable', 'budget_locked'].includes(reason) ? reason : 'dependency_unavailable'; break;
      }
      const pending = rows(scan.id).filter((r) => r.decision == null);
      if (!pending.length || readyCount(scanById(scan.id)) >= readyLimit) break;
      const current = new Map(feed.eligibleJobs({ viewer: { account: { id: scan.owner_id } } }).map((j) => [j.id, j]));
      const candidates = [], candidateKeys = new Set();
      // Resolve missing/weak evidence and cache hits without a provider call.
      tx(db, () => {
        if (!alive()) return;
        for (const row of pending) {
          const j = current.get(row.job_id), hit = cached(scan, row);
          if (hit) {
            db.prepare('UPDATE demo_match_jobs SET decision=? WHERE scan_id=? AND position=?').run(hit, scan.id, row.position); cacheHits++;
          } else if (!j || fingerprint(j) !== row.evidence_hash || !evidenceEligible(j)) {
            db.prepare("UPDATE demo_match_jobs SET decision='insufficient_evidence' WHERE scan_id=? AND position=?").run(scan.id, row.position);
            insufficient++;
          } else if (!candidateKeys.has(row.cache_key)) { candidateKeys.add(row.cache_key); candidates.push({ row, job: j }); }
        }
      });
      if (!candidates.length) break;
      const plan = planJevBatch(scan.condition, candidates.map((c) => c.job), { maxCandidates: batchSize });
      if (plan.skipped.length) tx(db, () => {
        if (!alive()) return;
        for (const id of plan.skipped) {
          const c = candidates.find((x) => x.job.id === id);
          insufficient += db.prepare("UPDATE demo_match_jobs SET decision='insufficient_evidence' WHERE scan_id=? AND cache_key=? AND decision IS NULL").run(scan.id, c.row.cache_key).changes;
        }
      });
      if (!plan.selected.length) { if (plan.skipped.length) continue; pause = 'invalid_evidence'; break; }
      let result;
      try {
        const controller = new AbortController(), abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true });
        let timer;
        try {
          const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
            controller.abort(); reject(err('provider_timeout'));
          }, Math.max(1, workMs - (now() - started))); });
          result = await Promise.race([provider.classify({ ownerId: scan.owner_id, condition: scan.condition,
            jobs: plan.selected.map((j) => j.job), signal: controller.signal }), deadline]);
        } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
        const expected = new Set(plan.selected.map((j) => j.id));
        if (!Array.isArray(result?.decisions) || result.decisions.length !== expected.size
            || result.decisions.some((d) => !expected.delete(d.id) || !['accepted', 'rejected', 'insufficient_evidence'].includes(d.decision)) || expected.size) throw err('invalid_response');
      } catch (e) {
        usage.attempts += e.attempts ?? 0; usage.ambiguousAttempts += e.ambiguousAttempts ?? 0;
        pause = ['budget_exhausted', 'budget_unavailable', 'budget_locked', 'usage_overrun', 'dependency_unavailable'].includes(e.code) ? e.code : 'provider_unavailable'; break;
      }
      if (!alive()) return { status: 'failed', errorCode: 'task_interrupted', output: null };
      tx(db, () => {
        if (!alive()) return;
        for (const d of result.decisions) {
          const c = candidates.find((x) => x.job.id === d.id);
          cacheDecision(scan, c.row, d.decision);
          db.prepare('UPDATE demo_match_jobs SET decision=? WHERE scan_id=? AND cache_key=? AND decision IS NULL').run(d.decision, scan.id, c.row.cache_key);
        }
      });
      batches++; evaluated += result.decisions.length;
      for (const key of ['inputTokens', 'outputTokens']) usage[key] += result.usage?.[key] ?? 0;
      for (const key of ['costNanodollars', 'attempts', 'ambiguousAttempts']) usage[key] += result[key] ?? 0;
    }
    if (!alive()) return { status: 'failed', errorCode: 'task_interrupted', output: null };
    const output = { schemaVersion: 1, classifierVersion: version, batches, evaluated, cacheHits, insufficient,
      ...usage, latencyMs: Math.max(0, now() - started), pause };
    return tx(db, () => {
      if (!alive()) return { status: 'failed', errorCode: 'task_interrupted', output: null };
      const status = pause ? 'warning' : 'succeeded';
      db.prepare('UPDATE demo_match_scans SET state=?,pause_code=?,retry_at=?,updated_at=? WHERE id=?')
        .run(pause ? 'paused' : 'pending', pause, pause ? now() + (pause === 'budget_exhausted' ? 60_000 : 5000) : null, now(), scan.id);
      // Bound persistent decisions independently of queue and snapshot sizes.
      db.prepare('DELETE FROM demo_match_cache WHERE owner_id=? AND cache_key NOT IN (SELECT cache_key FROM demo_match_cache WHERE owner_id=? ORDER BY created_at DESC,rowid DESC LIMIT 4096)').run(scan.owner_id, scan.owner_id);
      db.prepare('DELETE FROM demo_match_cache WHERE cache_key NOT IN (SELECT cache_key FROM demo_match_cache ORDER BY created_at DESC,rowid DESC LIMIT 32768)').run();
      if (!tasks.complete(task.id, task.leaseToken, { status, output })) throw err('revision_conflict', 409);
      return { status, output, committed: true };
    });
  }
  return { available, page, runTask, deleteSearchData, deleteAccountData, cleanup,
    capabilities: () => ({ aiMatching: available() }), readiness: () => {
      const ready = available();
      return { ...provider.readiness?.(), available: ready, reason: ready ? null : 'dependency_unavailable',
        role: readOnlyProvider ? 'queue' : 'worker', executionAvailable: executionAvailable() };
    },
    taskResult: () => undefined };
}
