// Read-only private aggregate for the fixed host-local alert-signals CLI.
// The CLI is source-only; no collector or Grafana alert is active yet.

export function readForegroundTaskAge({ db, now = Date.now } = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof now !== 'function') {
    throw new TypeError('Alert signal needs an initialized task store and clock.');
  }
  const at = now();
  if (!Number.isSafeInteger(at) || at < 0) throw new TypeError('Alert signal clock is invalid.');
  // One SQLite statement gives the count and oldest timestamp from one snapshot.
  // Missing tables and database failures propagate; they must never look healthy.
  // The runner uses this same foreground boundary when it yields to customer
  // work; Hiring Wire is the only background kind.
  const row = db.prepare(`SELECT COUNT(*) AS active_count, MIN(created_at) AS oldest_at
    FROM justup_tasks WHERE kind<>'hiring_wire' AND status IN ('pending','running')`).get();
  if (!Number.isSafeInteger(row?.active_count) || row.active_count < 0) {
    throw new Error('Interactive task count is invalid.');
  }
  if (row.active_count === 0) {
    if (row.oldest_at !== null) throw new Error('Interactive task age is inconsistent.');
    return { activeCount: 0, oldestAgeSeconds: null };
  }
  if (!Number.isSafeInteger(row.oldest_at) || row.oldest_at < 0 || row.oldest_at > at) {
    throw new Error('Interactive task timestamp is invalid.');
  }
  return { activeCount: row.active_count, oldestAgeSeconds: Math.floor((at - row.oldest_at) / 1000) };
}
