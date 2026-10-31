// Isolated demo SQLite storage and allowlisted imports. Read when changing the
// snapshot format or its freshness/source-identity rules; never point at production.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';

export const SCHEMA_VERSION = 1;
export const DAY_MS = 86_400_000;
export const MAX_BODY_BYTES = 512 * 1024;
export function problem(code, status = 400, message = 'Invalid request.') {
  return Object.assign(new Error(message), { code, status });
}
export function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    if (result && typeof result.then === 'function') throw new TypeError('Transactions must be synchronous.');
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
export function boundedJson(value, maxBytes = 65_536) {
  let json;
  try { json = JSON.stringify(value); } catch { throw problem('invalid_input'); }
  if (typeof json !== 'string' || Buffer.byteLength(json) > maxBytes) throw problem('invalid_input');
  return json;
}
function string(value, max = 256, optional = false) {
  if (optional && (value == null || value === '')) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw problem('invalid_import');
  return value.trim();
}
function timestamp(value) {
  const result = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(result)) throw problem('invalid_import');
  return result;
}
function url(value) {
  let parsed;
  try { parsed = new URL(string(value, 2048)); } catch { throw problem('invalid_import'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw problem('invalid_import');
  return parsed.href;
}
function strings(value, max = 32) {
  if (!Array.isArray(value) || value.length > max) throw problem('invalid_import');
  return [...new Set(value.map((v) => string(v, 200)))];
}
function number(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
const EMPLOYMENT = new Set(['full_time', 'part_time', 'contract', 'temporary', 'volunteer', 'full_or_part']);
function normalizedJob(raw, snapshotAt, verifiedAt) {
  if (!raw || raw.active !== true || raw.reserved !== false || raw.hasContent !== true) throw problem('invalid_import');
  const first = timestamp(raw.firstObserved);
  if (first > snapshotAt || first < snapshotAt - 14 * DAY_MS) throw problem('invalid_import');
  const last = raw.lastObserved == null ? null : timestamp(raw.lastObserved);
  if (!Array.isArray(raw.locations) || raw.locations.length > 64) throw problem('invalid_import');
  const bodyText = raw.bodyText == null ? null : (string(raw.bodyText, MAX_BODY_BYTES), raw.bodyText);
  if (bodyText && Buffer.byteLength(bodyText) > MAX_BODY_BYTES) throw problem('invalid_import');
  const textHash = bodyText ? createHash('sha256').update(bodyText).digest('hex') : null;
  const evidence = raw.evidence;
  if (!evidence || evidence.source !== 'jobseek_public' || evidence.normalizationVersion !== 1
      || evidence.textSha256 !== textHash || !Number.isInteger(evidence.bodyBytes)
      || evidence.bodyBytes < 0 || evidence.bodyBytes > MAX_BODY_BYTES || typeof evidence.truncated !== 'boolean'
      || (evidence.truncated && bodyText != null)) throw problem('invalid_import');
  const metadataFetchedAt = timestamp(evidence.metadataFetchedAt);
  const bodyFetchedAt = evidence.bodyFetchedAt == null ? null : timestamp(evidence.bodyFetchedAt);
  if (metadataFetchedAt > verifiedAt || (bodyFetchedAt != null && bodyFetchedAt > verifiedAt)) throw problem('invalid_import');
  if (evidence.bodySha256 != null && !/^[a-f0-9]{64}$/.test(evidence.bodySha256)) throw problem('invalid_import');
  const locales = strings(raw.locales).filter((l) => l !== '_none');
  const employmentTypes = strings(raw.employmentTypes).filter((t) => EMPLOYMENT.has(t));
  const job = {
    id: string(raw.id, 128), companyId: string(raw.companyId, 128), companyName: string(raw.companyName),
    companySlug: string(raw.companySlug, 200, true), title: string(raw.title, 1000), sourceUrl: url(raw.sourceUrl),
    firstObserved: new Date(first).toISOString(), lastObserved: last == null ? null : new Date(last).toISOString(),
    locales, locations: raw.locations.map((l) => ({ id: string(l.id, 200, true), name: string(l.name, 200, true),
      workplace: ['onsite', 'remote', 'hybrid'].includes(l.workplace) ? l.workplace : null,
      geoType: string(l.geoType, 100, true) })), employmentTypes,
    seniority: raw.seniority == null ? null : { id: string(raw.seniority.id, 100, true), name: string(raw.seniority.name, 200, true) },
    salary: raw.salary == null ? null : { min: number(raw.salary.min), max: number(raw.salary.max), currency: string(raw.salary.currency, 10, true), period: string(raw.salary.period, 30, true) },
    experience: { min: number(raw.experience?.min), max: raw.experience?.max === 99 ? null : number(raw.experience?.max), openEnded: raw.experience?.openEnded === true || raw.experience?.max === 99 },
    evidence: { source: 'jobseek_public', metadataFetchedAt: new Date(metadataFetchedAt).toISOString(),
      bodyFetchedAt: bodyFetchedAt == null ? null : new Date(bodyFetchedAt).toISOString(), bodyUrl: evidence.bodyUrl == null ? null : url(evidence.bodyUrl),
      bodySha256: evidence.bodySha256 ?? null, textSha256: textHash, normalizationVersion: 1,
      bodyBytes: evidence.bodyBytes, truncated: evidence.truncated, aiEligible: Boolean(bodyText && [...bodyText].length >= 200 && bodyFetchedAt != null),
      bodyError: evidence.bodyError == null ? null : string(evidence.bodyError, 100) },
  };
  return { job, first, bodyText, textHash };
}
export function openStore(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA max_page_count = 262144;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > SCHEMA_VERSION) { db.close(); throw new Error('Unsupported demo database schema.'); }
  db.exec(`
    CREATE TABLE IF NOT EXISTS demo_imports (
      generation TEXT PRIMARY KEY, snapshot_at INTEGER NOT NULL, verified_at INTEGER NOT NULL,
      selection_json TEXT NOT NULL, imported_count INTEGER NOT NULL, unknown_count INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS demo_jobs (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, first_seen_at INTEGER NOT NULL,
      active INTEGER NOT NULL CHECK (active IN (0,1)), reserved INTEGER NOT NULL CHECK (reserved IN (0,1)),
      verified_at INTEGER NOT NULL, closed_observed_at INTEGER, evidence_hash TEXT,
      data_json TEXT NOT NULL, body_text TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS demo_jobs_order ON demo_jobs(first_seen_at DESC, id);
    CREATE INDEX IF NOT EXISTS demo_jobs_company ON demo_jobs(company_id);
    PRAGMA user_version = 1;
  `);
  function generation() {
    return db.prepare('SELECT * FROM demo_imports ORDER BY rowid DESC LIMIT 1').get() ?? null;
  }
  function importSnapshot(snapshot) {
    if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.jobs) || snapshot.jobs.length > 1000
        || !Array.isArray(snapshot.observations ?? []) || (snapshot.observations ?? []).length > 1000
        || !Array.isArray(snapshot.unknownIds ?? []) || (snapshot.unknownIds ?? []).length > 1000) throw problem('invalid_import');
    const snapshotAt = timestamp(snapshot.snapshotAt), verifiedAt = timestamp(snapshot.verifiedAt);
    if (verifiedAt < snapshotAt || verifiedAt > Date.now() + 60_000) throw problem('invalid_import');
    const jobs = snapshot.jobs.map((r) => normalizedJob(r, snapshotAt, verifiedAt));
    const ids = new Set(jobs.map((j) => j.job.id));
    if (ids.size !== jobs.length) throw problem('invalid_import');
    const observations = (snapshot.observations ?? []).map((o) => {
      if (o.active !== false && o.reserved !== true) throw problem('invalid_import');
      const id = string(o.id, 128), observedAt = timestamp(o.observedAt);
      if (ids.has(id) || observedAt > verifiedAt) throw problem('invalid_import');
      ids.add(id);
      return { id, active: o.active !== false, reserved: o.reserved === true, observedAt };
    });
    const selection = boundedJson(snapshot.selection ?? {}, 8192);
    const generationId = randomUUID();
    return transaction(db, () => {
      if ((generation()?.verified_at ?? -1) > verifiedAt) throw problem('stale_import', 409, 'A newer import is already present.');
      const existing = db.prepare('SELECT first_seen_at FROM demo_jobs WHERE id = ?');
      const insert = db.prepare(`INSERT INTO demo_jobs (id, company_id, first_seen_at, active, reserved, verified_at, closed_observed_at, evidence_hash, data_json, body_text)
        VALUES (?, ?, ?, 1, 0, ?, NULL, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
        company_id=excluded.company_id,active=1,reserved=0,verified_at=excluded.verified_at,closed_observed_at=NULL,
        evidence_hash=excluded.evidence_hash,data_json=excluded.data_json,body_text=excluded.body_text`);
      for (const { job, first, bodyText, textHash } of jobs) {
        const row = existing.get(job.id);
        if (row && row.first_seen_at !== first) throw problem('source_identity_conflict', 409, 'Source discovery time changed.');
        insert.run(job.id, job.companyId, first, Date.parse(job.evidence.metadataFetchedAt), textHash, boundedJson(job, 16_384), bodyText);
      }
      const close = db.prepare(`UPDATE demo_jobs SET active=?,reserved=?,verified_at=?,closed_observed_at=? WHERE id=?`);
      for (const o of observations) close.run(o.active ? 1 : 0, o.reserved ? 1 : 0, o.observedAt, o.active ? null : o.observedAt, o.id);
      db.prepare('INSERT INTO demo_imports VALUES (?, ?, ?, ?, ?, ?)').run(generationId, snapshotAt, verifiedAt, selection, jobs.length, snapshot.unknownIds?.length ?? 0);
      // Old import metadata is not needed for cursor validity or public evidence.
      db.prepare('DELETE FROM demo_imports WHERE rowid NOT IN (SELECT rowid FROM demo_imports ORDER BY rowid DESC LIMIT 32)').run();
      db.prepare('DELETE FROM demo_jobs WHERE first_seen_at < ?').run(snapshotAt - 30 * DAY_MS);
      db.prepare('DELETE FROM demo_jobs WHERE id NOT IN (SELECT id FROM demo_jobs ORDER BY first_seen_at DESC,id ASC LIMIT 1000)').run();
      return { generation: generationId, imported: jobs.length, observed: observations.length, unknown: snapshot.unknownIds?.length ?? 0 };
    });
  }
  return { db, transaction: (fn) => transaction(db, fn), generation, importSnapshot, close: () => db.close() };
}
