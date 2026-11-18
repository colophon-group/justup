// Public projections and time/access filtering for the isolated imported feed.
// Search implementations must use eligibleJobs, then project with publicJob.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DAY_MS, problem } from './store.mjs';
import { initializeCompanyIdentities,canonicalCompanyId } from './company-identities.mjs';
import {initializeCompanyProgress,createCompanyProgress} from './company-progress.mjs';
import { ORIGIN_POLICY_VERSION } from './posting-origin.mjs';

export function publicJob(job) {
  return {
    id: job.id, title: job.title, company: { id: job.companyId, name: job.companyName, logoUrl: null },
    sourceUrl: job.sourceUrl, firstObserved: job.firstObserved,
    locations: job.locations.map((l) => ({ name: l.name, workplace: l.workplace })),
    employmentTypes: job.employmentTypes, postingLanguages: job.locales,
    seniority: job.seniority, salary: job.salary,
  };
}
function verifiedImportTime(row, selection) {
  if (selection?.source !== 'jobseek_feed_v1') return row.verified_at;
  if (selection.feed?.complete !== true) return null;
  const full = selection.feed.fullSnapshotAt;
  if (typeof full !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(full)) return null;
  const parsed = Date.parse(full);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== full || parsed > row.verified_at) return null;
  return parsed;
}
export function importedCoverage(row, at, ttl = DAY_MS, countRetainedScope = () => undefined) {
  let selection, verifiedAt = null;
  if (row) {
    try { selection = JSON.parse(row.selection_json); } catch { /* Unreadable import metadata. */ }
    if (selection !== undefined) verifiedAt = verifiedImportTime(row, selection);
  }
  const stale = verifiedAt == null || verifiedAt > at || at - verifiedAt >= ttl;
  const coverage = { kind: 'imported_snapshot', verifiedAt: verifiedAt == null ? null : new Date(verifiedAt).toISOString(), stale };
  if (stale) return { ...coverage, state: 'import_unavailable', description: 'Imported listings need verification.' };

  const origin = selection?.postingOriginReview;
  const reviewedAt = Date.parse(origin?.reviewedAt);
  if (selection?.source === 'jobseek_feed_v1' && origin?.policyVersion === ORIGIN_POLICY_VERSION
      && origin.manifestSha256 === selection.feed?.manifestSha256 && Number.isFinite(reviewedAt)
      && row.verified_at <= reviewedAt && reviewedAt <= at && at - reviewedAt < ttl) {
    coverage.postingOrigin = origin.unknown === false ? 'reviewed_direct_only' : 'reviewed_with_unknowns';
    coverage.postingOriginExpiresAt = new Date(verifiedAt + ttl).toISOString();
  }

  const entireSourceScope = selection?.source === 'jobseek_feed_v1' && selection.limitedCoverage === false
    && selection.feed.scope?.kind === 'all_eligible' && selection.sourceScopeRowCount === row.imported_count
    && row.unknown_count === 0 && countRetainedScope(row) === row.imported_count;
  return entireSourceScope ? coverage : { ...coverage, state: 'limited_coverage' };
}
export function createFeed({ db, now = Date.now, cursorSecret = randomBytes(32), verificationTtlMs = DAY_MS, cursorTtlMs = 10 * 60_000 }) {
  if (!db || !Number.isSafeInteger(verificationTtlMs) || verificationTtlMs < 1 || verificationTtlMs > DAY_MS
      || !Number.isSafeInteger(cursorTtlMs) || cursorTtlMs < 1 || cursorTtlMs > DAY_MS
      || Buffer.byteLength(cursorSecret) < 32) throw new TypeError('Invalid feed configuration.');
  db.exec('CREATE TABLE IF NOT EXISTS justup_requested_companies(id TEXT PRIMARY KEY,domain TEXT NOT NULL UNIQUE,data_json TEXT NOT NULL) STRICT');
  initializeCompanyIdentities(db);
  const canonicalId=id=>canonicalCompanyId(db,id);
  initializeCompanyProgress(db);
  const setup=createCompanyProgress({db,canonicalCompanyId:canonicalId,now});
  const latest = () => db.prepare('SELECT * FROM justup_imports ORDER BY rowid DESC LIMIT 1').get() ?? null;
  const generation = () => latest()?.generation ?? null;
  const access = (viewer) => viewer?.account?.id && viewer.access?.fullAccess === true ? 'account' : 'guest';
  // The import receipt counts candidate rows. Durable closure or omission
  // evidence may keep some of those rows out of the committed selection.
  const retainedScope = db.prepare(`SELECT (SELECT count(*) FROM justup_jobs
    WHERE active=1 AND reserved=0 AND first_seen_at>=justup_imports.snapshot_at-?
      AND first_seen_at<=justup_imports.snapshot_at AND verified_at>0 AND verified_at>? AND verified_at<=?) AS count
    FROM justup_imports WHERE generation=? AND rowid=(SELECT max(rowid) FROM justup_imports)`);
  const coverageAt = at => importedCoverage(latest(), at, verificationTtlMs,
    row => retainedScope.get(14 * DAY_MS, at - verificationTtlMs, at, row.generation)?.count);
  const coverage = () => coverageAt(now());
  function eligibleAt(viewer, at, restrictedLatest=false) {
    if (coverageAt(at).stale) return [];
    const upper = restrictedLatest?at:at - (access(viewer) === 'guest' ? 2 * DAY_MS : 0);
    const lower=at-(restrictedLatest?2:14)*DAY_MS;
    return db.prepare(`SELECT * FROM justup_jobs WHERE active=1 AND reserved=0 AND first_seen_at${restrictedLatest?'>':'>='}? AND first_seen_at<=?
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
  function decode(cursor, viewer, companyId, companyScope) {
    if (typeof cursor !== 'string' || cursor.length > 2048) throw problem('invalid_cursor');
    const [data, signature, extra] = cursor.split('.');
    if (!data || !signature || extra) throw problem('invalid_cursor');
    const expected = Buffer.from(sign(data)), actual = Buffer.from(signature);
    if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) throw problem('invalid_cursor');
    let parsed;
    try { parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')); } catch { throw problem('invalid_cursor'); }
    if (parsed.v !== 1 || typeof parsed.id !== 'string' || !Number.isFinite(parsed.first)
        || !Number.isSafeInteger(parsed.createdAt)) throw problem('invalid_cursor');
    if ((parsed.companyId ?? null) !== companyId || (parsed.companyScope ?? null) !== companyScope
        || parsed.generation !== generation() || parsed.access !== access(viewer)
        || now() - parsed.createdAt >= cursorTtlMs || parsed.createdAt > now()) {
      throw problem('stale_cursor', 409, 'This feed changed. Reload it and try again.');
    }
    return parsed;
  }
  function list({ viewer = null, cursor = null, limit = 12 } = {}, company = null) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw problem('invalid_limit');
    const importGeneration = generation();
    const at = now(), currentCoverage = coverageAt(at);
    const companyId = company?.id ?? null;
    const sourceIds = company ? setup.positionSources(companyId, at) : [];
    const companyScope = company ? createHash('sha256').update(JSON.stringify(sourceIds)).digest('hex') : null;
    const position = cursor == null ? null : decode(cursor, viewer, companyId, companyScope);
    const allowedIds = company ? new Set([companyId,...sourceIds]) : null;
    const jobs = currentCoverage.stale ? [] : eligibleAt(viewer, at);
    if (generation() !== importGeneration) throw problem('stale_cursor', 409, 'This feed changed. Reload it and try again.');
    if (currentCoverage.stale) return { asOf: new Date(at).toISOString(), items: [],
      continuation: { cursor, state: 'paused', retryAfterMs: 5000 }, ai: { status: 'not_required' }, coverage: currentCoverage };
    const matches = jobs.filter(j => (!allowedIds || allowedIds.has(j.companyId)) && (!position
      || Date.parse(j.firstObserved) < position.first || (Date.parse(j.firstObserved) === position.first && j.id > position.id)));
    const page = matches.slice(0, limit), last = page.at(-1), more = matches.length > limit;
    const items = page.map(job => publicJob(company && job.companyId !== companyId
      ? {...job, companyId, companyName:company.name} : job));
    return { asOf: new Date(at).toISOString(), items, continuation: {
      cursor: more ? encode({ v: 1, generation: importGeneration, access: access(viewer), ...(company ? {companyId,companyScope} : {}),
        createdAt: position?.createdAt ?? at, first: Date.parse(last.firstObserved), id: last.id }) : null,
      state: more ? 'open' : 'exhausted', retryAfterMs: null,
    }, ai: { status: 'not_required' }, coverage: currentCoverage };
  }
  function companyRows() {
    return db.prepare('SELECT company_id, data_json FROM justup_jobs ORDER BY first_seen_at DESC, id ASC').all();
  }
  function companyDto(job,readSetup=setup.publicSnapshot) {
    const id=canonicalId(job.companyId),requested=db.prepare('SELECT data_json FROM justup_requested_companies WHERE id=?').get(id);
    const known=requested?JSON.parse(requested.data_json):null;
    return { id, name:known?.name??job.companyName, slug: job.companySlug, logoUrl: null,
      websiteUrl:known?.websiteUrl??null, coverage: { state: 'imported_snapshot' }, setup:readSetup(id), history: null,
      evidence: [...(known?.evidence??[]),{ source: 'jobseek_public', url: typeof job.companySlug === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(job.companySlug)
        ? `https://jseek.co/en/company/${job.companySlug}` : 'https://jseek.co/' }] };
  }
  function catalogue() {
    const found = new Map(),readSetup=setup.publicReader();
    for (const row of companyRows()) {
      const j = JSON.parse(row.data_json);
      const id=canonicalId(j.companyId),dto=companyDto(j,readSetup);
      if (!found.has(id)) found.set(id,dto);
    }
    for(const row of db.prepare('SELECT data_json FROM justup_requested_companies').all()) {
      const company=JSON.parse(row.data_json);
      if(!found.has(company.id))found.set(company.id,{...company,setup:readSetup(company.id)});
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name, 'en') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  function companyPage({ q = '', cursor = null, limit = 20, privateScope = null } = {}) {
    if (typeof q !== 'string' || q.length > 100 || /[\u0000-\u001f\u007f]/u.test(q)) throw problem('invalid_query');
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw problem('invalid_limit');
    const needle = q.trim().toLocaleLowerCase('en'), all = catalogue(), at = now();
    // Accepted public identities can change between imports. Bind the cursor to
    // both the import and the allowlisted catalogue, never to account state.
    const generation = createHash('sha256').update(JSON.stringify([latest()?.generation ?? null, all])).digest('hex');
    const scope = privateScope ? 'account_companies' : 'public_companies';
    const owner = privateScope ? sign(`account_companies:${privateScope.ownerId}`) : null;
    const membership = privateScope ? new Set(privateScope.companyIds.map(canonicalId)) : null;
    const membershipGeneration = membership ? createHash('sha256').update(JSON.stringify([...membership].sort())).digest('hex') : null;
    let position = null;
    if (cursor != null) {
      if (typeof cursor !== 'string' || cursor.length > 2048) throw problem('invalid_cursor');
      const [data, signature, extra] = cursor.split('.');
      if (!data || !signature || extra) throw problem('invalid_cursor');
      const actual = Buffer.from(signature), expected = Buffer.from(sign(data));
      if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) throw problem('invalid_cursor');
      try { position = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')); } catch { throw problem('invalid_cursor'); }
      if (position?.v !== 1 || position.scope !== scope || typeof position.id !== 'string'
          || typeof position.q !== 'string' || !Number.isSafeInteger(position.createdAt)) throw problem('invalid_cursor');
      if (privateScope && (position.owner !== owner || position.view !== privateScope.view)) throw problem('invalid_cursor');
      if (position.generation !== generation || position.q !== needle || position.membershipGeneration !== (membershipGeneration ?? undefined)
          || at - position.createdAt >= cursorTtlMs || position.createdAt > at) throw problem('stale_cursor', 409);
    }
    const matching = all.filter(company => (!membership || membership.has(company.id)) && company.name.toLocaleLowerCase('en').includes(needle));
    const start = position ? matching.findIndex(company => company.id === position.id) + 1 : 0;
    if (position && !start) throw problem('invalid_cursor');
    const items = matching.slice(start, start + limit), more = matching.length > start + limit;
    return { items, coverage: coverageAt(at), nextCursor: more ? encode({ v: 1, scope,
      ...(privateScope ? {owner,view:privateScope.view,membershipGeneration} : {}),
      generation, q: needle, createdAt: position?.createdAt ?? at, id: items.at(-1).id }) : null };
  }
  const companies = ({q='',cursor=null,limit=20}={}) => companyPage({q,cursor,limit});
  function accountCompanies({ownerId,view,companyIds,...options}) {
    if(typeof ownerId!=='string'||!ownerId||!['followed','requested'].includes(view)||!Array.isArray(companyIds))throw problem('invalid_input');
    return companyPage({...options,privateScope:{ownerId,view,companyIds}});
  }
  function company(id) {
    id=canonicalId(id);
    const row = db.prepare('SELECT data_json FROM justup_jobs WHERE company_id=? OR company_id IN (SELECT source_company_id FROM justup_company_aliases WHERE company_id=?) ORDER BY first_seen_at DESC, id ASC LIMIT 1').get(id,id);
    if(row)return companyDto(JSON.parse(row.data_json));
    const requested=db.prepare('SELECT data_json FROM justup_requested_companies WHERE id=?').get(id);
    if(!requested)throw problem('not_found',404,'Not found.');
    return {...JSON.parse(requested.data_json),setup:setup.publicSnapshot(id)};
  }
  function publishCompany(candidate) {
    if(candidate.companyId)return company(candidate.companyId).id;
    // A confirmed catalogue ID establishes reuse. Names and official hosts do
    // not bind a newly researched request to any imported source identity.
    if(!candidate.domain)throw problem('preview_conflict',409);
    const prior=db.prepare('SELECT id,data_json FROM justup_requested_companies WHERE domain=?').get(candidate.domain);
    if(prior){
      const known=JSON.parse(prior.data_json),fold=value=>value.normalize('NFKC').trim().toLocaleLowerCase('en');
      if(fold(known.name)!==fold(candidate.name)||known.websiteUrl!==candidate.websiteUrl)throw problem('preview_conflict',409);
      return prior.id;
    }
    const id=randomUUID(),value={id,name:candidate.name,slug:null,logoUrl:null,websiteUrl:candidate.websiteUrl,
      coverage:{state:'requested'},history:null,evidence:candidate.evidenceUrls.map(url=>({source:'company_request',url}))};
    db.prepare('INSERT INTO justup_requested_companies VALUES(?,?,?)').run(id,candidate.domain,JSON.stringify(value));return id;
  }
  const companyPositions = (id, options) => list(options,company(id));
  return { list, companies, accountCompanies, company, companyPositions, publishCompany,companySetup:setup.snapshot,ensureCompanySetup:setup.ensure,canonicalCompanyId:canonicalId, requestedCompanies:()=>db.prepare('SELECT data_json FROM justup_requested_companies ORDER BY id').all().map(r=>JSON.parse(r.data_json)), coverage, eligibleJobs, restrictedLatestJobs:()=>eligibleAt(null,now(),true), publicJob, generation };
}
