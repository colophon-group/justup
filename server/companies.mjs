// Private company identity requests. Read when changing identity evidence,
// exact-preview acceptance or account/request deletion; this never configures a crawler.
import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

const KEY = /^[A-Za-z0-9_.:-]{1,128}$/;
const ATS = ['greenhouse.io', 'lever.co', 'workdayjobs.com', 'myworkdayjobs.com', 'smartrecruiters.com', 'ashbyhq.com', 'bamboohr.com', 'recruitee.com', 'personio.com', 'personio.de', 'teamtailor.com', 'icims.com', 'jobvite.com', 'successfactors.com', 'oraclecloud.com'];
const problem = (code, status = 400, message = 'Invalid request.') => Object.assign(new Error(message), { code, status });
const fold = (value) => value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en');
const plain = (value) => value != null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
function exactKeys(value, required, optional = []) {
  if (!plain(value) || required.some((key) => !Object.hasOwn(value, key))
      || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) throw problem('invalid_input');
}
function text(value, max, optional = false) {
  if (optional && (value == null || value === '')) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw problem('invalid_input');
  return value.trim().replace(/\s+/gu, ' ');
}
function publicHost(host) {
  const bare = host.toLowerCase().replace(/\.$/u, '');
  if (!bare.includes('.') || isIP(bare) || bare.includes(':') || !/^[a-z0-9.-]+$/u.test(bare)
      || bare.split('.').some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label))
      || /(?:^|\.)(?:localhost|local|internal|home|lan|invalid|test)$/u.test(bare)
      || /(?:^|\.)localhost\./u.test(bare)) throw problem('invalid_input');
  return bare;
}
const isAts = (host) => ATS.some((domain) => host === domain || host.endsWith(`.${domain}`));
export function validateCompanyUrl(value, { official = false } = {}) {
  let parsed;
  try { parsed = new URL(text(value, 2048)); } catch { throw problem('invalid_input'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hash) throw problem('invalid_input');
  const host = publicHost(parsed.hostname);
  if (official && isAts(host)) throw problem('invalid_input');
  parsed.hostname = host;
  if (parsed.href.length > 2048) throw problem('invalid_input');
  return parsed.href;
}
function domain(value, optional = false) {
  if (optional && (value == null || value === '')) return null;
  const valueText = text(value, 253);
  if (valueText.includes('/') || valueText.includes('@') || valueText.includes(':')) throw problem('invalid_input');
  const host = publicHost(valueText);
  if (isAts(host)) throw problem('invalid_input');
  return host;
}
const withinDomain = (host, root) => host === root || host.endsWith(`.${root}`);
function candidateData(value) {
  exactKeys(value, ['name', 'domain', 'websiteUrl', 'evidenceUrls']);
  const root = domain(value.domain), websiteUrl = validateCompanyUrl(value.websiteUrl, { official: true });
  if (!withinDomain(new URL(websiteUrl).hostname, root) || !Array.isArray(value.evidenceUrls)
      || value.evidenceUrls.length < 1 || value.evidenceUrls.length > 8) throw problem('invalid_input');
  const evidenceUrls = [...new Set(value.evidenceUrls.map((url) => validateCompanyUrl(url)))];
  if (!evidenceUrls.some((url) => withinDomain(new URL(url).hostname, root))) throw problem('invalid_input');
  return { name: text(value.name, 200), domain: root, websiteUrl, evidenceUrls };
}
function resolutionData(wrapper) {
  let encoded;
  try { encoded = JSON.stringify(wrapper); } catch { throw problem('invalid_input'); }
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 65_536) throw problem('invalid_input');
  exactKeys(wrapper, ['data', 'evidenceVerified'], ['evidenceProvenance']);
  const value = wrapper.data;
  exactKeys(value, ['status', 'candidate', 'clarification']);
  if (!['candidate', 'clarification', 'unresolved'].includes(value.status) || typeof wrapper.evidenceVerified !== 'boolean') throw problem('invalid_input');
  if (value.status === 'candidate') {
    if (wrapper.evidenceVerified !== true || value.clarification !== null) throw problem('invalid_input');
    const candidate={ id: randomUUID(), companyId:null, ...candidateData(value.candidate), coverage: { state: 'requested' } };
    const provenance=wrapper.evidenceProvenance??[];
    if(!Array.isArray(provenance)||provenance.length>2)throw problem('invalid_input');
    for(const proof of provenance){exactKeys(proof,['url','finalUrl','status','bytes','sha256']);if(!candidate.evidenceUrls.includes(validateCompanyUrl(proof.url,{official:true}))||new URL(proof.url).origin!==new URL(validateCompanyUrl(proof.finalUrl,{official:true})).origin||proof.status!==200||!Number.isInteger(proof.bytes)||proof.bytes<1||proof.bytes>131072||typeof proof.sha256!=='string'||!/^[a-f0-9]{64}$/.test(proof.sha256))throw problem('invalid_input');}
    return { status: 'candidate', candidate, clarification: null,provenance };
  }
  if (value.candidate !== null) throw problem('invalid_input');
  return { status: value.status, candidate: null, clarification: text(value.clarification, 500) };
}
let transactionSerial = 0;
function transaction(db, fn) {
  const name = `company_write_${++transactionSerial}`;
  db.exec(`SAVEPOINT ${name}`);
  try { const result = fn(); db.exec(`RELEASE ${name}`); return result; } catch (error) {
    db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error;
  }
}
function normalizedInput(body) {
  exactKeys(body, ['input', 'requestKey'], ['domain', 'careerUrl', 'scope']);
  if (typeof body.requestKey !== 'string' || !KEY.test(body.requestKey)) throw problem('invalid_input');
  return { input: text(body.input, 300), domain: domain(body.domain, true),
    careerUrl: body.careerUrl == null || body.careerUrl === '' ? null : validateCompanyUrl(body.careerUrl),
    scope: text(body.scope, 500, true) };
}
function importedCandidate(company) {
  let websiteUrl = null, root = null;
  if (company.websiteUrl) {
    try { websiteUrl = validateCompanyUrl(company.websiteUrl, { official: true }); root = new URL(websiteUrl).hostname; } catch { /* Unknown official site remains unknown. */ }
  }
  const evidenceUrls = [];
  for (const evidence of company.evidence ?? []) {
    try { evidenceUrls.push(validateCompanyUrl(evidence.url)); } catch { /* Ignore unsupported imported links. */ }
  }
  return { id: randomUUID(), companyId:company.id, name: text(company.name, 200), domain: root, websiteUrl,
    evidenceUrls: [...new Set(evidenceUrls)].slice(0, 8), coverage: { state: company.coverage?.state??'imported_snapshot' } };
}

export function createCompanyService({ db, feed, tasks, config = {}, now = Date.now, beforePrivateDelete, afterPrivateTransaction, withPrivateTransaction, model = null, availability, readingPreferences } = {}) {
  if (!db || !feed?.companies || !tasks?.enqueue || (beforePrivateDelete != null && typeof beforePrivateDelete !== 'function')) throw new TypeError('Invalid company service configuration.');
  const maxPerOwner = config.maxCompanyRequestsPerOwner ?? 32;
  if (!Number.isSafeInteger(maxPerOwner) || maxPerOwner < 1 || maxPerOwner > 96) throw new TypeError('Invalid company request limit.');
  db.exec(`CREATE TABLE IF NOT EXISTS demo_company_requests (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, input_text TEXT NOT NULL, domain TEXT, career_url TEXT, scope TEXT,
    fingerprint TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','candidate','clarification','unresolved','accepted')),
    candidate_json TEXT, preview_revision INTEGER NOT NULL, clarification TEXT, task_id TEXT, created_at INTEGER NOT NULL,
    accept_key TEXT, UNIQUE(owner_id,fingerprint)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS demo_company_requests_owner ON demo_company_requests(owner_id);
  CREATE TABLE IF NOT EXISTS demo_company_request_keys (
    owner_id TEXT NOT NULL, request_key TEXT NOT NULL, input_json TEXT NOT NULL, request_id TEXT NOT NULL,
    PRIMARY KEY(owner_id,request_key)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS demo_company_evidence (
    request_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,preview_revision INTEGER NOT NULL,provenance_json TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS demo_company_request_tasks (
    owner_id TEXT NOT NULL,request_id TEXT NOT NULL,task_id TEXT NOT NULL,PRIMARY KEY(owner_id,request_id,task_id)
  ) STRICT;
  INSERT OR IGNORE INTO demo_company_request_tasks SELECT owner_id,id,task_id FROM demo_company_requests WHERE task_id IS NOT NULL;`);
  const row = (ownerId, id) => db.prepare('SELECT * FROM demo_company_requests WHERE owner_id=? AND id=?').get(ownerId, id);
  function view(found) {
    return { id: found.id, input: found.input_text, scope: found.scope, status: found.status,
      companyId:found.candidate_json?JSON.parse(found.candidate_json).companyId??null:null,
      candidate: found.candidate_json == null ? null : JSON.parse(found.candidate_json), previewRevision: found.preview_revision,
      clarification: found.clarification, taskId: found.task_id, createdAt: new Date(found.created_at).toISOString() };
  }
  const requireOwner = (ctx) => {
    if (!ctx.viewer || typeof ctx.accountId !== 'string' || !ctx.accountId) throw problem('unauthenticated', 401, 'Sign in to continue.');
    return ctx.accountId;
  };
  function result(found, status = 200) {
    const task = found.task_id ? tasks.get(found.owner_id, found.task_id) : null;
    return { status, body: { request: view(found), ...(status === 202 && task ? { task: tasks.publicView(task, taskResult(task, { accountId: found.owner_id })) } : {}) } };
  }
  function insertKey(ownerId, requestKey, json, id) {
    db.prepare('INSERT INTO demo_company_request_keys VALUES (?,?,?,?)').run(ownerId, requestKey, json, id);
  }
  function create(ownerId, body) {
    const input = normalizedInput(body), json = JSON.stringify(input);
    const key = db.prepare('SELECT * FROM demo_company_request_keys WHERE owner_id=? AND request_key=?').get(ownerId, body.requestKey);
    if (key) {
      if (key.input_json !== json) throw problem('idempotency_conflict', 409, 'This request key was already used.');
      const found = row(ownerId, key.request_id);
      if (!found) throw problem('not_found', 404, 'Not found.');
      return result(found, found.status === 'pending' ? 202 : 201);
    }
    if (db.prepare('SELECT count(*) AS n FROM demo_company_request_keys WHERE owner_id=?').get(ownerId).n >= maxPerOwner * 4) {
      throw Object.assign(problem('task_limit', 429, 'The request limit has been reached.'), { retryAfter: 60 });
    }
    const fingerprint = createHash('sha256').update(JSON.stringify({ ...input, input: fold(input.input) })).digest('hex');
    const duplicate = db.prepare('SELECT * FROM demo_company_requests WHERE owner_id=? AND fingerprint=?').get(ownerId, fingerprint);
    if (duplicate) {
      if(duplicate.status==='unresolved'){
        const retry=tasks.enqueue({ownerId,kind:'company_resolution',requestKey:body.requestKey,payload:{requestId:duplicate.id}});
        try{transaction(db,()=>{
          db.prepare("UPDATE demo_company_requests SET status='pending',candidate_json=NULL,clarification=NULL,task_id=? WHERE id=? AND owner_id=? AND status='unresolved'").run(retry.id,duplicate.id,ownerId);
          insertKey(ownerId,body.requestKey,json,duplicate.id);
          db.prepare('INSERT INTO demo_company_request_tasks VALUES(?,?,?)').run(ownerId,duplicate.id,retry.id);
        });}catch(error){tasks.delete(ownerId,retry.id);throw error;}
        return result(row(ownerId,duplicate.id),202);
      }
      insertKey(ownerId, body.requestKey, json, duplicate.id);
      return result(duplicate, duplicate.status === 'pending' ? 202 : 201);
    }
    if (db.prepare('SELECT count(*) AS n FROM demo_company_requests WHERE owner_id=?').get(ownerId).n >= maxPerOwner) {
      throw Object.assign(problem('task_limit', 429, 'The request limit has been reached.'), { retryAfter: 60 });
    }
    const companies = feed.companies({ q: input.input }).items;
    const exact = companies.filter((company) => fold(company.name) === fold(input.input)).filter((company) => {
      if (!input.domain && !input.careerUrl) return true;
      try {
        const knownHost = new URL(validateCompanyUrl(company.websiteUrl, { official: true })).hostname;
        return (!input.domain || withinDomain(knownHost, input.domain))
          && (!input.careerUrl || withinDomain(new URL(input.careerUrl).hostname, knownHost));
      } catch { return false; }
    });
    const known = exact.length === 1 ? importedCandidate(exact[0]) : null;
    if(!known&&typeof availability==='function'&&availability()!==true)throw problem('dependency_unavailable',503,'Company research is temporarily unavailable.');
    const id = randomUUID();
    let task = null;
    try {
      if (!known) task = tasks.enqueue({ ownerId, kind: 'company_resolution', requestKey: body.requestKey, payload: { requestId: id } });
      transaction(db, () => {
        db.prepare(`INSERT INTO demo_company_requests (id,owner_id,input_text,domain,career_url,scope,fingerprint,status,candidate_json,preview_revision,clarification,task_id,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, ownerId, input.input, input.domain, input.careerUrl, input.scope, fingerprint,
          known ? 'candidate' : 'pending', known ? JSON.stringify(known) : null, known ? 1 : 0, null, task?.id ?? null, now());
        insertKey(ownerId, body.requestKey, json, id);
        if(task)db.prepare('INSERT INTO demo_company_request_tasks VALUES(?,?,?)').run(ownerId,id,task.id);
      });
    } catch (error) { if (task) tasks.delete(ownerId, task.id); throw error; }
    return result(row(ownerId, id), known ? 201 : 202);
  }
  function accept(ownerId, id, body, idempotencyKey) {
    exactKeys(body, ['candidateId', 'previewRevision']);
    if (typeof idempotencyKey !== 'string' || !KEY.test(idempotencyKey) || typeof body.candidateId !== 'string'
        || body.candidateId.length > 128 || !Number.isSafeInteger(body.previewRevision) || body.previewRevision < 1) throw problem('invalid_input');
    return transaction(db, () => {
      const found = row(ownerId, id);
      if (!found) throw problem('not_found', 404, 'Not found.');
      const candidate = found.candidate_json ? JSON.parse(found.candidate_json) : null;
      if (!candidate || candidate.id !== body.candidateId || found.preview_revision !== body.previewRevision
          || !['candidate', 'accepted'].includes(found.status)) throw problem('preview_conflict', 409, 'This preview changed. Reload it and try again.');
      if (found.status === 'accepted') {
        if (found.accept_key !== idempotencyKey) throw problem('idempotency_conflict', 409, 'This preview was already accepted.');
        // An exact retry of a preview accepted by an older server can establish
        // its catalogue identity once. Existing explicit follow choices win.
        if(!candidate.companyId&&feed.publishCompany){
          candidate.companyId=feed.publishCompany(candidate);
          db.prepare('UPDATE demo_company_requests SET candidate_json=? WHERE owner_id=? AND id=?').run(JSON.stringify(candidate),ownerId,id);
          readingPreferences?.followAcceptedCompany(ownerId,candidate.companyId);
          return result(row(ownerId,id));
        }
        return result(found);
      }
      const used = db.prepare('SELECT id FROM demo_company_requests WHERE owner_id=? AND accept_key=?').get(ownerId, idempotencyKey);
      if (used) throw problem('idempotency_conflict', 409, 'This request key was already used.');
      if(feed.publishCompany)candidate.companyId=feed.publishCompany(candidate);
      if(readingPreferences&&!candidate.companyId)throw problem('dependency_unavailable',503);
      db.prepare("UPDATE demo_company_requests SET status='accepted',accept_key=?,candidate_json=? WHERE owner_id=? AND id=? AND status='candidate' AND preview_revision=?")
        .run(idempotencyKey,JSON.stringify(candidate),ownerId,id,body.previewRevision);
      if(candidate.companyId)readingPreferences?.followAcceptedCompany(ownerId,candidate.companyId);
      return result(row(ownerId, id));
    });
  }
  function deleteRecord(ownerId, id) {
    const found = row(ownerId, id);
    if (!found) return false;
    for(const {task_id} of db.prepare('SELECT task_id FROM demo_company_request_tasks WHERE owner_id=? AND request_id=?').all(ownerId,id)){tasks.cancel(ownerId,task_id);tasks.delete(ownerId,task_id);}
    if(found.task_id)tasks.delete(ownerId,found.task_id);
    db.prepare('DELETE FROM demo_company_request_tasks WHERE owner_id=? AND request_id=?').run(ownerId,id);
    db.prepare('DELETE FROM demo_company_request_keys WHERE owner_id=? AND request_id=?').run(ownerId, id);
    db.prepare('DELETE FROM demo_company_evidence WHERE owner_id=? AND request_id=?').run(ownerId, id);
    db.prepare('DELETE FROM demo_company_requests WHERE owner_id=? AND id=?').run(ownerId, id);
    return true;
  }
  function deleteAccountData(ownerId) {
    for (const found of db.prepare('SELECT id FROM demo_company_requests WHERE owner_id=?').all(ownerId)) deleteRecord(ownerId, found.id);
    db.prepare('DELETE FROM demo_company_request_keys WHERE owner_id=?').run(ownerId);
  }
  async function route(ctx) {
    if (ctx.path !== '/company-requests' && !/^\/company-requests\/[^/]+(?:\/accept)?$/u.test(ctx.path)) return null;
    const ownerId = requireOwner(ctx);
    if (ctx.path === '/company-requests') {
      if (ctx.method === 'GET') return { status: 200, body: { items: db.prepare('SELECT * FROM demo_company_requests WHERE owner_id=? ORDER BY created_at DESC,id').all(ownerId).map(view) } };
      if (ctx.method === 'POST') return create(ownerId, ctx.body);
      return null;
    }
    let id;
    try { id = decodeURIComponent(ctx.path.split('/')[2]); } catch { throw problem('invalid_input'); }
    if (!id || id.length > 128 || id.includes('/')) throw problem('invalid_input');
    if (ctx.path.endsWith('/accept') && ctx.method === 'POST') return accept(ownerId, id, ctx.body, ctx.idempotencyKey);
    if (!ctx.path.endsWith('/accept') && ctx.method === 'DELETE') {
      const remove=() => {
        if (!row(ownerId, id)) throw problem('not_found', 404, 'Not found.');
        if (typeof beforePrivateDelete !== 'function') throw problem('deletion_unavailable', 503, 'Deletion is temporarily unavailable.');
        const barrier = beforePrivateDelete();
        if (barrier && typeof barrier.then === 'function') throw new TypeError('Deletion barrier must be synchronous.');
        deleteRecord(ownerId, id);
      };
      if(withPrivateTransaction)withPrivateTransaction(remove);
      else try{transaction(db,remove);}finally{if(!db.isTransaction)afterPrivateTransaction?.();}
      return { status: 200, body: { deleted: true } };
    }
    return null;
  }
  function taskResult(task, ctx) {
    if (task.kind !== 'company_resolution') return undefined;
    if (ctx?.accountId !== task.ownerId || !['succeeded', 'warning'].includes(task.status)) return null;
    if (typeof task.output?.requestId !== 'string' || !Number.isSafeInteger(task.output?.previewRevision)) return null;
    const found = row(task.ownerId, task.output?.requestId);
    if (!found || found.task_id !== task.id || found.preview_revision !== task.output?.previewRevision) return null;
    return { request: view(found) };
  }
  function live(task, signal) {
    const current = tasks.get(task.ownerId, task.id);
    return !signal?.aborted && task.kind === 'company_resolution' && typeof task.leaseToken === 'string' && current?.status === 'running'
      && current.leaseToken === task.leaseToken && current.leaseUntil > now();
  }
  async function runTask(task, { signal = task.signal } = {}) {
    if (task.kind !== 'company_resolution' || typeof task.payload?.requestId !== 'string' || task.payload.requestId.length > 128) return { status: 'failed', output: null, errorCode: 'invalid_output' };
    const found = row(task.ownerId, task.payload?.requestId);
    if (!found || found.task_id !== task.id || found.status !== 'pending' || !live(task, signal)) return { status: 'failed', output: null, errorCode: 'preview_conflict' };
    let resolution, failure = null;
    try {
      if (typeof model?.resolveCompany !== 'function' || (typeof model.available === 'function' && !model.available('company_resolution'))) throw problem('dependency_unavailable', 503);
      resolution = resolutionData(await model.resolveCompany({ input: found.input_text, domain: found.domain, careerUrl: found.career_url, scope: found.scope }, { signal }));
    } catch (error) {
      failure = error.code === 'dependency_unavailable' ? 'dependency_unavailable' : error.code === 'invalid_input' || error.code === 'invalid_output' ? 'invalid_output' : 'provider_unavailable';
      resolution = { status: 'unresolved', candidate: null, clarification: failure === 'invalid_output' ? 'The company evidence could not be verified.' : 'Company research is temporarily unavailable. Try again later.' };
    }
    try {
      return transaction(db, () => {
        if (!live(task, signal)) return { status: 'failed', output: null, errorCode: 'preview_conflict' };
        const current = row(task.ownerId, found.id);
        if (!current || current.task_id !== task.id || current.status !== 'pending') return { status: 'failed', output: null, errorCode: 'preview_conflict' };
        db.prepare('UPDATE demo_company_requests SET status=?,candidate_json=?,preview_revision=preview_revision+1,clarification=? WHERE owner_id=? AND id=? AND task_id=? AND status=\'pending\'')
          .run(resolution.status, resolution.candidate ? JSON.stringify(resolution.candidate) : null, resolution.clarification, task.ownerId, found.id, task.id);
        if(resolution.provenance?.length)db.prepare('INSERT OR REPLACE INTO demo_company_evidence VALUES(?,?,?,?)').run(found.id,task.ownerId,current.preview_revision+1,JSON.stringify(resolution.provenance));
        const outcome = { status: failure ? 'failed' : resolution.status === 'candidate' ? 'succeeded' : 'warning',
          output: failure ? null : { requestId: found.id, previewRevision: current.preview_revision + 1 }, ...(failure ? { errorCode: failure } : {}) };
        if (!tasks.complete(task.id, task.leaseToken, outcome)) throw problem('preview_conflict', 409);
        return { ...outcome, committed: true };
      });
    } catch (error) {
      if (error.code === 'preview_conflict') return { status: 'failed', output: null, errorCode: 'preview_conflict' };
      throw error;
    }
  }
  return { capabilities: ()=>({ companyRequests: typeof availability==='function'?availability()===true:true }), route, taskResult, deleteAccountData, runTask };
}
