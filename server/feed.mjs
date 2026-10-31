// Public projections and time/access filtering for the isolated imported feed.
// Search implementations must use eligibleJobs, then project with publicJob.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DAY_MS, problem } from './store.mjs';

export function publicJob(job) {
  return {
    id: job.id, title: job.title, company: { id: job.companyId, name: job.companyName, logoUrl: null },
    sourceUrl: job.sourceUrl, firstObserved: job.firstObserved,
    locations: job.locations.map((l) => ({ name: l.name, workplace: l.workplace })),
    employmentTypes: job.employmentTypes, postingLanguages: job.locales,
    seniority: job.seniority, salary: job.salary,
  };
}
export function createFeed({ db, now = Date.now, cursorSecret = randomBytes(32), verificationTtlMs = DAY_MS, cursorTtlMs = 10 * 60_000 }) {
  if (!db || !Number.isSafeInteger(verificationTtlMs) || verificationTtlMs < 1 || verificationTtlMs > DAY_MS
      || !Number.isSafeInteger(cursorTtlMs) || cursorTtlMs < 1 || cursorTtlMs > DAY_MS
      || Buffer.byteLength(cursorSecret) < 32) throw new TypeError('Invalid feed configuration.');
  const latest = () => db.prepare('SELECT * FROM demo_imports ORDER BY rowid DESC LIMIT 1').get() ?? null;
  const access = (viewer) => viewer?.account?.id ? 'demo' : 'guest';
  function coverage() {
    const row = latest();
    return { kind: 'imported_snapshot', verifiedAt: row ? new Date(row.verified_at).toISOString() : null,
      stale: !row || now() - row.verified_at >= verificationTtlMs };
  }
  function eligibleJobs({ viewer = null } = {}) {
    const at = now();
    if (coverage().stale) return [];
    const upper = at - (access(viewer) === 'guest' ? 2 * DAY_MS : 0);
    return db.prepare(`SELECT * FROM demo_jobs WHERE active=1 AND reserved=0 AND first_seen_at>=? AND first_seen_at<=?
      AND verified_at>? AND verified_at<=? ORDER BY first_seen_at DESC, id ASC`).all(at - 14 * DAY_MS, upper, at - verificationTtlMs, at)
      .map((r) => ({ ...JSON.parse(r.data_json), bodyText: r.body_text, evidenceHash: r.evidence_hash,
        verifiedAt: new Date(r.verified_at).toISOString() }));
  }
  function sign(value) { return createHmac('sha256', cursorSecret).update(value).digest('base64url'); }
  function encode(value) {
    const data = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${data}.${sign(data)}`;
  }
  function decode(cursor, viewer) {
    if (typeof cursor !== 'string' || cursor.length > 2048) throw problem('invalid_cursor');
    const [data, signature, extra] = cursor.split('.');
    if (!data || !signature || extra) throw problem('invalid_cursor');
    const expected = Buffer.from(sign(data)), actual = Buffer.from(signature);
    if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) throw problem('invalid_cursor');
    let parsed;
    try { parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')); } catch { throw problem('invalid_cursor'); }
    if (parsed.v !== 1 || typeof parsed.id !== 'string' || !Number.isFinite(parsed.first)
        || !Number.isSafeInteger(parsed.createdAt)) throw problem('invalid_cursor');
    if (parsed.generation !== latest()?.generation || parsed.access !== access(viewer)
        || now() - parsed.createdAt >= cursorTtlMs || parsed.createdAt > now()) {
      throw problem('stale_cursor', 409, 'This feed changed. Reload it and try again.');
    }
    return parsed;
  }
  function list({ viewer = null, cursor = null, limit = 12 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw problem('invalid_limit');
    const position = cursor == null ? null : decode(cursor, viewer);
    const jobs = eligibleJobs({ viewer }).filter((j) => !position
      || Date.parse(j.firstObserved) < position.first || (Date.parse(j.firstObserved) === position.first && j.id > position.id));
    const page = jobs.slice(0, limit), last = page.at(-1), more = jobs.length > limit;
    return { asOf: new Date(now()).toISOString(), items: page.map(publicJob), continuation: {
      cursor: more ? encode({ v: 1, generation: latest().generation, access: access(viewer),
        createdAt: position?.createdAt ?? now(), first: Date.parse(last.firstObserved), id: last.id }) : null,
      state: more ? 'open' : 'exhausted', retryAfterMs: null,
    }, ai: { status: 'not_required' }, coverage: coverage() };
  }
  function companyRows() {
    return db.prepare('SELECT company_id, data_json FROM demo_jobs ORDER BY first_seen_at DESC, id ASC').all();
  }
  function companyDto(job) {
    return { id: job.companyId, name: job.companyName, slug: job.companySlug, logoUrl: null,
      websiteUrl: null, coverage: { state: 'imported_snapshot' }, history: null,
      evidence: [{ source: 'jobseek_public', url: 'https://jseek.co/' }] };
  }
  function companies({ q = '' } = {}) {
    if (typeof q !== 'string' || q.length > 100) throw problem('invalid_query');
    const needle = q.trim().toLocaleLowerCase('en');
    const found = new Map();
    for (const row of companyRows()) {
      const j = JSON.parse(row.data_json);
      if (!found.has(j.companyId) && j.companyName.toLocaleLowerCase('en').includes(needle)) found.set(j.companyId, companyDto(j));
    }
    return { items: [...found.values()].sort((a, b) => a.name.localeCompare(b.name, 'en') || a.id.localeCompare(b.id)).slice(0, 50), coverage: coverage() };
  }
  function company(id) {
    const row = db.prepare('SELECT data_json FROM demo_jobs WHERE company_id=? ORDER BY first_seen_at DESC, id ASC LIMIT 1').get(id);
    if (!row) throw problem('not_found', 404, 'Not found.');
    return companyDto(JSON.parse(row.data_json));
  }
  return { list, companies, company, coverage, eligibleJobs, publicJob, generation: () => latest()?.generation ?? null };
}
