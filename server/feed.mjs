// Public projections and time/access filtering for the isolated imported feed.
// Search implementations must use eligibleJobs, then project with publicJob.
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DAY_MS, problem } from './store.mjs';
import { initializeCompanyIdentities,canonicalCompanyId } from './company-identities.mjs';

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
  db.exec('CREATE TABLE IF NOT EXISTS justup_requested_companies(id TEXT PRIMARY KEY,domain TEXT NOT NULL UNIQUE,data_json TEXT NOT NULL) STRICT');
  initializeCompanyIdentities(db);
  const canonicalId=id=>canonicalCompanyId(db,id);
  const latest = () => db.prepare('SELECT * FROM demo_imports ORDER BY rowid DESC LIMIT 1').get() ?? null;
  const access = (viewer) => viewer?.account?.id && viewer.access?.fullAccess === true ? 'account' : 'guest';
  function coverageAt(at) {
    const row = latest();
    const stale = !row || at - row.verified_at >= verificationTtlMs;
    return { kind: 'imported_snapshot', verifiedAt: row ? new Date(row.verified_at).toISOString() : null,
      stale, ...(stale ? { state: 'import_unavailable', description: 'Imported listings need verification.' } : {}) };
  }
  const coverage = () => coverageAt(now());
  function eligibleAt(viewer, at, restrictedLatest=false) {
    if (coverageAt(at).stale) return [];
    const upper = restrictedLatest?at:at - (access(viewer) === 'guest' ? 2 * DAY_MS : 0);
    const lower=at-(restrictedLatest?2:14)*DAY_MS;
    return db.prepare(`SELECT * FROM demo_jobs WHERE active=1 AND reserved=0 AND first_seen_at${restrictedLatest?'>':'>='}? AND first_seen_at<=?
      AND verified_at>? AND verified_at<=? ORDER BY first_seen_at DESC, id ASC`).all(lower, upper, at - verificationTtlMs, at)
      .map((r) => ({ ...JSON.parse(r.data_json), companyId:canonicalId(r.company_id),bodyText: r.body_text, evidenceHash: r.evidence_hash,
        verifiedAt: new Date(r.verified_at).toISOString() }));
  }
  const eligibleJobs = ({ viewer = null } = {}) => eligibleAt(viewer, now());
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
    const at = now(), currentCoverage = coverageAt(at);
    if (currentCoverage.stale) return { asOf: new Date(at).toISOString(), items: [],
      continuation: { cursor, state: 'paused', retryAfterMs: 5000 }, ai: { status: 'not_required' }, coverage: currentCoverage };
    const jobs = eligibleAt(viewer, at).filter((j) => !position
      || Date.parse(j.firstObserved) < position.first || (Date.parse(j.firstObserved) === position.first && j.id > position.id));
    const page = jobs.slice(0, limit), last = page.at(-1), more = jobs.length > limit;
    return { asOf: new Date(at).toISOString(), items: page.map(publicJob), continuation: {
      cursor: more ? encode({ v: 1, generation: latest().generation, access: access(viewer),
        createdAt: position?.createdAt ?? at, first: Date.parse(last.firstObserved), id: last.id }) : null,
      state: more ? 'open' : 'exhausted', retryAfterMs: null,
    }, ai: { status: 'not_required' }, coverage: currentCoverage };
  }
  function companyRows() {
    return db.prepare('SELECT company_id, data_json FROM demo_jobs ORDER BY first_seen_at DESC, id ASC').all();
  }
  function companyDto(job) {
    const id=canonicalId(job.companyId),requested=db.prepare('SELECT data_json FROM justup_requested_companies WHERE id=?').get(id);
    const known=requested?JSON.parse(requested.data_json):null;
    return { id, name:known?.name??job.companyName, slug: job.companySlug, logoUrl: null,
      websiteUrl:known?.websiteUrl??null, coverage: { state: 'imported_snapshot' }, history: null,
      evidence: [...(known?.evidence??[]),{ source: 'jobseek_public', url: typeof job.companySlug === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(job.companySlug)
        ? `https://jseek.co/en/company/${job.companySlug}` : 'https://jseek.co/' }] };
  }
  function companies({ q = '' } = {}) {
    if (typeof q !== 'string' || q.length > 100) throw problem('invalid_query');
    const needle = q.trim().toLocaleLowerCase('en');
    const found = new Map();
    for (const row of companyRows()) {
      const j = JSON.parse(row.data_json);
      const id=canonicalId(j.companyId),dto=companyDto(j);
      if (!found.has(id) && dto.name.toLocaleLowerCase('en').includes(needle)) found.set(id,dto);
    }
    for(const row of db.prepare('SELECT data_json FROM justup_requested_companies').all()) {
      const company=JSON.parse(row.data_json);
      if(!found.has(company.id)&&company.name.toLocaleLowerCase('en').includes(needle))found.set(company.id,company);
    }
    return { items: [...found.values()].sort((a, b) => a.name.localeCompare(b.name, 'en') || a.id.localeCompare(b.id)).slice(0, 50), coverage: coverage() };
  }
  function company(id) {
    id=canonicalId(id);
    const row = db.prepare('SELECT data_json FROM demo_jobs WHERE company_id=? OR company_id IN (SELECT source_company_id FROM justup_company_aliases WHERE company_id=?) ORDER BY first_seen_at DESC, id ASC LIMIT 1').get(id,id);
    if(row)return companyDto(JSON.parse(row.data_json));
    const requested=db.prepare('SELECT data_json FROM justup_requested_companies WHERE id=?').get(id);
    if(!requested)throw problem('not_found',404,'Not found.');
    return JSON.parse(requested.data_json);
  }
  function publishCompany(candidate) {
    if(candidate.companyId)return company(candidate.companyId).id;
    // Older previews predate companyId. Recover an unambiguous imported identity
    // without inventing an official domain or replacing its source catalogue ID.
    const known=new Set(candidate.coverage?.state==='imported_snapshot'?companyRows().filter(r=>JSON.parse(r.data_json).companyName===candidate.name).map(r=>r.company_id):[]);
    if(known.size===1)return [...known][0];
    if(!candidate.domain)throw problem('preview_conflict',409);
    const prior=db.prepare('SELECT id FROM justup_requested_companies WHERE domain=?').get(candidate.domain);
    if(prior)return prior.id;
    const existingSource=db.prepare('SELECT company_id FROM justup_company_aliases WHERE official_domain=? ORDER BY verified_at,source_company_id LIMIT 1').get(candidate.domain);
    const id=existingSource?.company_id??randomUUID(),value={id,name:candidate.name,slug:null,logoUrl:null,websiteUrl:candidate.websiteUrl,
      coverage:{state:'requested'},history:null,evidence:candidate.evidenceUrls.map(url=>({source:'company_request',url}))};
    db.prepare('INSERT INTO justup_requested_companies VALUES(?,?,?)').run(id,candidate.domain,JSON.stringify(value));return id;
  }
  return { list, companies, company, publishCompany,canonicalCompanyId:canonicalId, requestedCompanies:()=>db.prepare('SELECT data_json FROM justup_requested_companies ORDER BY id').all().map(r=>JSON.parse(r.data_json)), coverage, eligibleJobs, restrictedLatestJobs:()=>eligibleAt(null,now(),true), publicJob, generation: () => latest()?.generation ?? null };
}
