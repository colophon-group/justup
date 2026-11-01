// Deterministic public company reports from eligible structured listings and
// published frozen source history. This reader never opens source files or queues work.
import { DAY_MS, problem } from './store.mjs';
import { compileWireSnapshot, digest } from './hiring-wire-facts.mjs';

const iso = value => new Date(value).toISOString();
const WEEK = 7 * DAY_MS;
const METHODOLOGY = Object.freeze({
  version: 'company-hiring-report-v1',
  activity: 'Distinct newly observed listings on the recorded career-page scopes. Missing or interrupted coverage is unknown; listing activity does not measure hires or headcount.',
  monitoring: 'Earliest tracked-since evidence among the scopes in this historical snapshot; this does not establish uninterrupted company-wide monitoring.',
  roles: 'Source occupation labels among currently eligible public sample listings; unlabelled listings remain unknown.',
  salaries: 'Reported numeric salary bounds among currently eligible public sample listings, grouped by currency and period without conversion or annualization. Crossed aggregate bounds remain unknown. These are listing values, not employee pay.',
});

function roles(jobs) {
  const found = new Map();
  let labelledSampleSize = 0;
  for (const job of jobs) {
    if (!job.occupation?.id || !job.occupation.name) continue;
    labelledSampleSize++;
    const previous = found.get(job.occupation.id);
    if (previous) previous.count++;
    else found.set(job.occupation.id, { ...job.occupation, count: 1 });
  }
  return { sampleSize: jobs.length, labelledSampleSize, unknownSampleSize: jobs.length - labelledSampleSize,
    items: [...found.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)) };
}

function salaries(jobs) {
  const found = new Map();
  let reportedSampleSize = 0, groupedSampleSize = 0;
  for (const { salary } of jobs) {
    if (!salary || salary.min == null && salary.max == null) continue;
    reportedSampleSize++;
    if (!salary.currency || !salary.period || salary.min != null && salary.max != null && salary.min > salary.max) continue;
    groupedSampleSize++;
    const key = JSON.stringify([salary.currency, salary.period]), previous = found.get(key);
    if (!previous) found.set(key, { currency: salary.currency, period: salary.period, sampleSize: 1, min: salary.min, max: salary.max });
    else {
      previous.sampleSize++;
      if (salary.min != null) previous.min = previous.min == null ? salary.min : Math.min(previous.min, salary.min);
      if (salary.max != null) previous.max = previous.max == null ? salary.max : Math.max(previous.max, salary.max);
    }
  }
  // Bounds from separate one-sided observations cannot always form a band.
  // Keep their group/count evidence without inventing numeric endpoints.
  for (const group of found.values()) {
    if (group.min != null && group.max != null && group.min > group.max) group.min = group.max = null;
  }
  return { sampleSize: jobs.length, reportedSampleSize, groupedSampleSize,
    incompleteSampleSize: reportedSampleSize - groupedSampleSize, unknownSampleSize: jobs.length - reportedSampleSize,
    groups: [...found.values()].sort((a, b) => a.currency.localeCompare(b.currency) || a.period.localeCompare(b.period)) };
}

function point(snapshot, scopes, start, end) {
  const reasons = new Set();
  let completeScopeCount = 0;
  for (const scope of scopes) {
    const scopeReasons = new Set();
    if (Date.parse(scope.trackedSince) > start) scopeReasons.add('new_scope');
    if (scope.lastVerifiedAt == null) scopeReasons.add('unverified_scope');
    else if (Date.parse(scope.lastVerifiedAt) < end) scopeReasons.add('stale_scope');
    let cursor = start;
    for (const interval of scope.coverage) {
      const a = Math.max(start, Date.parse(interval.start)), b = Math.min(end, Date.parse(interval.end));
      if (a >= b) continue;
      if (a !== cursor) scopeReasons.add('missing_history');
      if (interval.state !== 'complete') scopeReasons.add(interval.state === 'interrupted' ? 'interrupted_scope' : 'missing_history');
      cursor = b;
    }
    if (cursor !== end) scopeReasons.add('missing_history');
    if (!scopeReasons.size) completeScopeCount++;
    for (const reason of scopeReasons) reasons.add(reason);
  }
  const scopeIds = new Set(scopes.map(scope => scope.id)), ids = new Set();
  for (const posting of snapshot.postings) {
    const observed = Date.parse(posting.firstObserved);
    if (scopeIds.has(posting.scopeId) && observed >= start && observed < end) ids.add(posting.id);
  }
  const complete = scopes.length > 0 && completeScopeCount === scopes.length;
  return { start: iso(start), end: iso(end), state: complete ? 'complete' : ids.size || completeScopeCount ? 'partial' : 'unknown',
    newListings: complete ? ids.size : null, observedListings: ids.size,
    completeScopeCount, scopeCount: scopes.length, reasons: [...reasons].sort() };
}

export function createCompanyReports({ db, feed, now = Date.now } = {}) {
  if (!db || !feed?.eligibleJobs || !feed?.company || typeof now !== 'function') throw new TypeError('Invalid company report configuration.');
  function history(companyId, at) {
    const unavailable = { monitoringSince: null, provenance: null, freshness: 'unavailable',
      sourceChecks: { state: 'unavailable', items: [] },
      hiringHistory: { state: 'unavailable', scopeCount: 0, points: [] } };
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='hiring_wire_editions'").get()) return unavailable;
    const row = db.prepare("SELECT period_id,period_end,published_at,snapshot_json,snapshot_sha256 FROM hiring_wire_editions WHERE status='published' AND period_end<=? ORDER BY period_end DESC LIMIT 1").get(iso(at));
    if (!row?.snapshot_json || Buffer.byteLength(row.snapshot_json) > 4 * 1024 * 1024) return unavailable;
    let snapshot;
    try {
      snapshot = JSON.parse(row.snapshot_json);
      const generatedAt = Date.parse(snapshot.generatedAt);
      if (!['jobseek-coverage-v1','jobseek-coverage-v2'].includes(snapshot.sourceVersion) || digest(snapshot) !== row.snapshot_sha256
          || snapshot.asOf !== row.period_end || row.period_id !== snapshot.asOf.slice(0, 10)
          || !Number.isSafeInteger(row.published_at) || generatedAt > row.published_at || row.published_at > at) return unavailable;
      // Validation uses the frozen observation time. Old attributable history
      // remains historical evidence, while freshness is reported independently.
      snapshot = compileWireSnapshot(snapshot, { periodEnd: snapshot.asOf, now: Date.parse(snapshot.generatedAt) }).snapshot;
    } catch { return unavailable; }
    const scopes = snapshot.scopes.filter(scope => feed.canonicalCompanyId(scope.companyId) === companyId);
    if (!scopes.length) return unavailable;
    const end = Date.parse(snapshot.asOf), points = [point(snapshot, scopes, end - 2 * WEEK, end - WEEK), point(snapshot, scopes, end - WEEK, end)];
    const items = scopes.map(scope => ({ publicLink: scope.publicLink ?? null,
      trackedSince: scope.trackedSince, lastVerifiedAt: scope.lastVerifiedAt }));
    const linked = items.filter(item => item.publicLink !== null).length;
    return { monitoringSince: iso(Math.min(...scopes.map(scope => Date.parse(scope.trackedSince)))),
      provenance: { source: 'jobseek_public_coverage', sourceVersion: snapshot.sourceVersion, snapshotId: snapshot.snapshotId,
        asOf: snapshot.asOf, generatedAt: snapshot.generatedAt, publishedAt: iso(row.published_at), sha256: row.snapshot_sha256 },
      freshness: at - end >= WEEK ? 'stale' : 'fresh',
      // Availability describes approved link evidence, independently of page
      // health, verification recency or complete historical coverage.
      sourceChecks: { state: linked === 0 ? 'unavailable' : linked === items.length ? 'available' : 'partial', items },
      hiringHistory: { state: points.every(value => value.state === 'complete') ? 'available' : 'partial', scopeCount: scopes.length, points } };
  }
  function report(id) {
    const company = feed.company(id), at = now();
    const coverage = feed.coverage(), jobs = feed.eligibleJobs().filter(job => job.companyId === company.id), recorded = history(company.id, at);
    const observations = jobs.map(job => Date.parse(job.verifiedAt));
    return { companyId: company.id, asOf: iso(at),
      provenance: { source: 'jobseek_public', importVerifiedAt: coverage.verifiedAt, importGeneration: feed.generation(),
        sampleObservedFrom: observations.length ? iso(Math.min(...observations)) : null,
        sampleObservedThrough: observations.length ? iso(Math.max(...observations)) : null, history: recorded.provenance },
      scope: { kind: 'eligible_public_listing_sample', firstObservedFrom: iso(at - 14 * DAY_MS), firstObservedThrough: iso(at - 2 * DAY_MS), completeCompanyCoverage: false },
      freshness: { listings: coverage.stale ? 'unavailable' : 'fresh', history: recorded.freshness },
      monitoringSince: recorded.monitoringSince, sourceChecks: recorded.sourceChecks, hiringHistory: recorded.hiringHistory,
      hiringRoles: { state: coverage.stale ? 'unavailable' : 'available', ...roles(jobs) },
      reportedSalaries: { state: coverage.stale ? 'unavailable' : 'available', ...salaries(jobs) }, methodology: METHODOLOGY };
  }
  function publicRoute(ctx) {
    const match = /^\/companies\/([^/]+)\/report$/u.exec(ctx.path);
    if (ctx.method !== 'GET' || !match) return null;
    if ([...ctx.url.searchParams].length) throw problem('invalid_query');
    let id; try { id = decodeURIComponent(match[1]); } catch { throw problem('invalid_input'); }
    return { status: 200, body: report(id) };
  }
  return Object.freeze({ report, publicRoute });
}
