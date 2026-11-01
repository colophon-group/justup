// Durable task queue, owner isolation and compare-and-set leases. This module
// stores bounded private data; HTTP exposes only a feature-specific projection.
import { randomUUID } from 'node:crypto';
import { boundedJson, problem, transaction, DAY_MS } from './store.mjs';

const SAFE_TASK_ERRORS = new Set(['processing_unavailable', 'task_failed', 'task_interrupted', 'dependency_unavailable', 'provider_unavailable', 'provider_down', 'task_timeout', 'timeout', 'rate_limit', 'provider_rate_limit', 'invalid_output', 'unsupported_requirements', 'revision_conflict', 'preview_conflict']);
const RETRYABLE_TASK_ERRORS = new Set(['dependency_unavailable', 'provider_unavailable', 'provider_down', 'task_timeout', 'timeout', 'rate_limit', 'provider_rate_limit']);
const TERMINAL = new Set(['succeeded', 'warning', 'failed', 'cancelled']);
const KIND = /^[a-z][a-z0-9_.-]{0,63}$/;
const LEASE_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WIRE_KIND = 'hiring_wire', WIRE_OWNER = '__hiring_wire__';
export function createTasks({ db, now = Date.now, maxTasks = 96, maxPendingPerOwner = 4, maxAttempts = 3, retentionMs = 30 * DAY_MS } = {}) {
  if (!db || ![maxTasks, maxPendingPerOwner, maxAttempts, retentionMs].every((n) => Number.isSafeInteger(n) && n > 0)
      || maxTasks > 96 || retentionMs > 30 * DAY_MS) throw new TypeError('Invalid task configuration.');
  db.exec(`CREATE TABLE IF NOT EXISTS justup_tasks (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL, request_key TEXT NOT NULL,
    payload_json TEXT NOT NULL, output_json TEXT, status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','warning','failed','cancelled')),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, lease_until INTEGER, lease_token TEXT, worker_id TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, error_code TEXT, UNIQUE(owner_id,kind,request_key)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS hiring_wire_cleanup_halt (
    id INTEGER PRIMARY KEY CHECK(id=1),task_id TEXT NOT NULL,created_at INTEGER NOT NULL,
    reason TEXT NOT NULL CHECK(reason='cleanup_unproven')
  ) STRICT;
  CREATE INDEX IF NOT EXISTS justup_tasks_owner ON justup_tasks(owner_id);
  CREATE INDEX IF NOT EXISTS justup_tasks_queue ON justup_tasks(status,created_at);`);
  function hydrate(row) {
    return row ? { id: row.id, ownerId: row.owner_id, kind: row.kind, requestKey: row.request_key,
      payload: JSON.parse(row.payload_json), output: row.output_json == null ? null : JSON.parse(row.output_json),
      status: row.status, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
      leaseUntil: row.lease_until, leaseToken: row.lease_token, workerId: row.worker_id, attempts: row.attempts,
      errorCode: row.error_code } : null;
  }
  const byId = (id) => hydrate(db.prepare('SELECT * FROM justup_tasks WHERE id=?').get(id));
  function get(ownerId, id) {
    const task = byId(id);
    return task?.ownerId === ownerId ? task : null;
  }
  function enqueue({ ownerId, kind, requestKey, payload }) {
    if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 128 || !KIND.test(kind ?? '')
        || typeof requestKey !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(requestKey)
        || (kind === WIRE_KIND) !== (ownerId === WIRE_OWNER)) throw problem('invalid_input');
    const json = boundedJson(payload, 16_384);
    const work=() => {
      const existing = db.prepare('SELECT * FROM justup_tasks WHERE owner_id=? AND kind=? AND request_key=?').get(ownerId, kind, requestKey);
      if (existing) {
        if (existing.payload_json !== json) throw problem('idempotency_conflict', 409, 'This request key was already used.');
        return hydrate(existing);
      }
      db.prepare('DELETE FROM justup_tasks WHERE updated_at<=? AND status IN (\'succeeded\',\'warning\',\'failed\',\'cancelled\')').run(now() - retentionMs);
      if (db.prepare('SELECT count(*) AS n FROM justup_tasks').get().n >= maxTasks
          || db.prepare('SELECT count(*) AS n FROM justup_tasks WHERE owner_id=? AND status IN (\'pending\',\'running\')').get(ownerId).n >= maxPendingPerOwner) {
        throw Object.assign(problem('task_limit', 429, 'The task limit has been reached.'), { retryAfter: 60 });
      }
      const id = randomUUID(), at = now();
      db.prepare('INSERT INTO justup_tasks (id,owner_id,kind,request_key,payload_json,status,created_at,updated_at) VALUES (?,?,?,?,?,\'pending\',?,?)').run(id, ownerId, kind, requestKey, json, at, at);
      return byId(id);
    };
    return db.isTransaction?work():transaction(db,work);
  }
  function recoverWithinTransaction() {
    if(halted())return;
    db.prepare(`UPDATE justup_tasks SET status=CASE WHEN attempts>=? THEN 'failed' ELSE 'pending' END,
      error_code=CASE WHEN attempts>=? THEN 'task_interrupted' ELSE NULL END,updated_at=?,lease_until=NULL,lease_token=NULL,worker_id=NULL
      WHERE status='running' AND kind<>'hiring_wire' AND lease_until<=?`).run(maxAttempts, maxAttempts, now(), now());
  }
  function recover() { return transaction(db, recoverWithinTransaction); }
  function claim({ workerId, kinds = null, leaseMs = 60_000 } = {}) {
    if (typeof workerId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(workerId)
        || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300_000
        || (kinds != null && (!Array.isArray(kinds) || kinds.length > 32 || kinds.some((k) => !KIND.test(k))))) throw problem('invalid_input');
    return transaction(db, () => {
      if(halted())return null;
      recoverWithinTransaction();
      if (db.prepare("SELECT 1 FROM justup_tasks WHERE status='running' LIMIT 1").get()) return null;
      const priority = "CASE WHEN kind='hiring_wire' THEN 1 ELSE 0 END,created_at,id";
      const row = kinds == null ? db.prepare(`SELECT id FROM justup_tasks WHERE status='pending' ORDER BY ${priority} LIMIT 1`).get()
        : kinds.length ? db.prepare(`SELECT id FROM justup_tasks WHERE status='pending' AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY ${priority} LIMIT 1`).get(...kinds) : null;
      if (!row) return null;
      db.prepare("UPDATE justup_tasks SET status='running',worker_id=?,lease_token=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=?")
        .run(workerId, randomUUID(), now() + leaseMs, now(), row.id);
      return byId(row.id);
    });
  }
  function heartbeat(id, leaseToken, leaseMs = 60_000) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300_000) throw problem('invalid_input');
    return db.prepare("UPDATE justup_tasks SET lease_until=?,updated_at=? WHERE id=? AND status='running' AND lease_token=? AND lease_until>?")
      .run(now() + leaseMs, now(), id, leaseToken, now()).changes === 1;
  }
  function complete(id, leaseToken, { status, output = null, errorCode = null }) {
    if (!TERMINAL.has(status) || status === 'cancelled' || (errorCode != null && !KIND.test(errorCode))) throw problem('invalid_input');
    const json = boundedJson(output);
    return db.prepare(`UPDATE justup_tasks SET status=?,output_json=?,error_code=?,lease_until=NULL,lease_token=NULL,worker_id=NULL,updated_at=?
      WHERE id=? AND status='running' AND lease_token=? AND lease_until>?
      AND NOT EXISTS (SELECT 1 FROM hiring_wire_cleanup_halt WHERE id=1)`).run(status, json, errorCode, now(), id, leaseToken, now()).changes === 1;
  }
  function hasForeground() {
    return !!db.prepare("SELECT 1 FROM justup_tasks WHERE status='pending' AND kind<>'hiring_wire' LIMIT 1").get();
  }
  function halted() {
    const check=()=>{
      if(db.prepare('SELECT 1 FROM hiring_wire_cleanup_halt WHERE id=1').get())return true;
      // A queue TTL cannot prove native cleanup. Seal the uncertainty before
      // readiness, scheduling or recovery can admit another shared-slot task.
      const expired=db.prepare("SELECT id FROM justup_tasks WHERE kind='hiring_wire' AND owner_id=? AND status='running' AND lease_until<=? ORDER BY created_at,id LIMIT 1")
        .get(WIRE_OWNER,now());
      if(!expired)return false;
      db.prepare("INSERT INTO hiring_wire_cleanup_halt VALUES (1,?,?,'cleanup_unproven')").run(expired.id,now());
      return true;
    };
    return db.isTransaction?check():transaction(db,check);
  }
  // No automatic clear operation exists. A reviewed operator recovery must
  // prove native cleanup and idle broker state before ending this durable halt.
  function haltWire(id,leaseToken) {
    if(typeof id!=='string'||!id||id.length>128||typeof leaseToken!=='string'||!LEASE_TOKEN.test(leaseToken))return false;
    return transaction(db,()=>{
      // Only the trusted runner reports cleanup uncertainty. Its old claim can
      // have expired or been superseded; current lease CAS is not permission
      // to ignore a potentially live native invocation from that known task.
      const claimed=db.prepare("SELECT 1 FROM justup_tasks WHERE id=? AND kind='hiring_wire' AND owner_id=? AND attempts>0")
        .get(id,WIRE_OWNER);
      if(!claimed)return false;
      db.prepare("INSERT OR IGNORE INTO hiring_wire_cleanup_halt VALUES (1,?,?,'cleanup_unproven')").run(id,now());
      return true;
    });
  }
  // Called only after the runner has awaited Wire cancellation and native
  // cleanup. Keep the same task/period and bound repeated interruptions.
  function pauseWire(id, leaseToken) {
    return db.prepare(`UPDATE justup_tasks SET status=CASE WHEN attempts>=? THEN 'failed' ELSE 'pending' END,
      error_code=CASE WHEN attempts>=? THEN 'task_preempted' ELSE NULL END,
      output_json=NULL,lease_until=NULL,lease_token=NULL,worker_id=NULL,updated_at=?
      WHERE id=? AND kind='hiring_wire' AND owner_id=? AND status='running' AND lease_token=? AND lease_until>?
      AND NOT EXISTS (SELECT 1 FROM hiring_wire_cleanup_halt WHERE id=1)`)
      .run(maxAttempts,maxAttempts,now(),id,WIRE_OWNER,leaseToken,now()).changes === 1;
  }
  // These helpers deliberately do not open transactions: auth and feature deletion
  // compose them inside their existing transaction, making late completions inert.
  function deleteOwner(ownerId) { db.prepare('DELETE FROM justup_tasks WHERE owner_id=?').run(ownerId); }
  function deleteTask(ownerId, id) { return db.prepare('DELETE FROM justup_tasks WHERE owner_id=? AND id=?').run(ownerId, id).changes === 1; }
  function cancelOwner(ownerId) {
    db.prepare("UPDATE justup_tasks SET status='cancelled',payload_json='null',output_json=NULL,lease_until=NULL,lease_token=NULL,worker_id=NULL,updated_at=? WHERE owner_id=? AND status IN ('pending','running')").run(now(), ownerId);
  }
  function cancel(ownerId, id) {
    return db.prepare("UPDATE justup_tasks SET status='cancelled',payload_json='null',output_json=NULL,lease_until=NULL,lease_token=NULL,worker_id=NULL,updated_at=? WHERE owner_id=? AND id=? AND status IN ('pending','running')").run(now(), ownerId, id).changes === 1;
  }
  function publicView(task, result = null) {
    if (task.kind === WIRE_KIND || task.ownerId === WIRE_OWNER) throw problem('not_found',404,'Task not found.');
    const failed = task.status === 'failed';
    const completed = task.status === 'succeeded' || task.status === 'warning';
    if (result != null && (!result || typeof result !== 'object' || Array.isArray(result)
        || Object.keys(result).length !== 1 || !['search', 'request', 'proposal'].includes(Object.keys(result)[0]))) throw new TypeError('Task projections must contain one typed result.');
    return { id: task.id, kind: task.kind, status: task.status, createdAt: task.createdAt, updatedAt: task.updatedAt,
      result: completed ? result : null,
      error: failed ? { code: SAFE_TASK_ERRORS.has(task.errorCode) ? task.errorCode : 'task_failed', message: task.errorCode==='processing_unavailable'?'Processing is paused until current policy and data protections are available.':'This task could not finish.', retryable: RETRYABLE_TASK_ERRORS.has(task.errorCode) } : null };
  }
  return { enqueue, get, claim, heartbeat, complete, recover, hasForeground, pauseWire, halted, haltWire, cancel, cancelOwner, deleteOwner, delete: deleteTask, publicView };
}
