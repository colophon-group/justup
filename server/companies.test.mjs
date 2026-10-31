// Company service contracts with isolated SQLite and a fake queue/provider.
// The queue's own lease implementation is covered by its integration suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createCompanyService, validateCompanyUrl } from './companies.mjs';
import { resolveCompanyIdentity } from './model-broker.mjs';

const AT = Date.parse('2026-10-31T16:00:00Z');
const COMPANY = { id: 'source-company', name: 'Known Company', websiteUrl: null,
  evidence: [{ source: 'jobseek_public', url: 'https://jseek.co/' }] };
function fixture(t, { companies = [], model = null, beforePrivateDelete = () => {}, maxPerOwner = 32 } = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let clock = AT, serial = 0;
  const records = new Map();
  const tasks = {
    enqueue({ ownerId, kind, requestKey, payload }) {
      const task = { id: `task-${++serial}`, ownerId, kind, requestKey, payload, output: null, status: 'pending',
        createdAt: new Date(clock).toISOString(), updatedAt: new Date(clock).toISOString(), leaseToken: null, leaseUntil: null };
      records.set(task.id, task); return { ...task };
    },
    get(ownerId, id) { const task = records.get(id); return task?.ownerId === ownerId ? { ...task } : null; },
    publicView(task, result = null) { return { id: task.id, kind: task.kind, status: task.status,
      createdAt: task.createdAt, updatedAt: task.updatedAt, result, error: null }; },
    cancel(ownerId, id) { const task = records.get(id); if (task?.ownerId === ownerId) task.status = 'cancelled'; },
    delete(ownerId, id) { if (records.get(id)?.ownerId === ownerId) records.delete(id); },
    complete(id, leaseToken, outcome) {
      const task = records.get(id);
      if (task?.status !== 'running' || task.leaseToken !== leaseToken || task.leaseUntil <= clock) return false;
      Object.assign(task, outcome, { leaseToken: null, leaseUntil: null }); return true;
    },
  };
  const feed = { companies: () => ({ items: companies }) };
  const service = createCompanyService({ db, feed, tasks, model, beforePrivateDelete, now: () => clock,
    config: { maxCompanyRequestsPerOwner: maxPerOwner } });
  const ctx = (method, path = '/company-requests', body, ownerId = 'owner-a', extra = {}) => ({ method, path, body,
    viewer: ownerId ? { account: { id: ownerId } } : null, accountId: ownerId, ...extra });
  const create = (body, ownerId) => service.route(ctx('POST', '/company-requests', body, ownerId));
  const claim = (id) => {
    const task = records.get(id); Object.assign(task, { status: 'running', leaseToken: `lease-${id}`, leaseUntil: clock + 60_000 });
    return { ...task };
  };
  const finish = (id, outcome) => Object.assign(records.get(id), outcome);
  return { db, tasks, records, service, ctx, create, claim, finish, advance: (ms) => { clock += ms; } };
}
const body = (requestKey = 'create-1', extra = {}) => ({ input: 'New Company', requestKey, ...extra });
const candidate = () => ({ data: { status: 'candidate', candidate: { name: 'New Company', domain: 'newcompany.com',
  websiteUrl: 'https://newcompany.com/', evidenceUrls: ['https://newcompany.com/about'] }, clarification: null }, evidenceVerified: true });
const rejectCode = (code, status) => (error) => error.code === code && (status == null || error.status === status);

test('known imported identity resolves without provider calls and retains an unknown official site', async (t) => {
  const f = fixture(t, { companies: [COMPANY], model: { resolveCompany() { assert.fail('Known identities must not invoke a model.'); } } });
  const response = await f.create(body('known', { input: '  Known Company  ', scope: 'Switzerland' }));
  assert.equal(response.status, 201);
  assert.equal(response.body.request.status, 'candidate');
  assert.deepEqual(response.body.request.candidate.coverage, { state: 'imported_snapshot' });
  assert.equal(response.body.request.candidate.domain, null);
  assert.equal(response.body.request.candidate.websiteUrl, null);
  assert.equal(response.body.request.taskId, null);
  assert.equal(response.body.request.scope, 'Switzerland');
  assert.equal(f.records.size, 0);
});

test('submission retries and duplicate inputs keep one request while changed request-key bodies conflict', async (t) => {
  const f = fixture(t);
  const first = await f.create(body());
  const retry = await f.create(body());
  const duplicate = await f.create(body('create-2', { input: 'new company' }));
  assert.equal(first.status, 202);
  assert.equal(retry.body.request.id, first.body.request.id);
  assert.equal(duplicate.body.request.id, first.body.request.id);
  assert.equal(f.records.size, 1);
  assert.equal(first.body.task.status, 'pending');
  assert.equal(first.body.task.result, null);
  await assert.rejects(f.create(body('create-1', { scope: 'Europe' })), rejectCode('idempotency_conflict', 409));
  const anotherOwner = await f.create(body(), 'owner-b');
  assert.notEqual(anotherOwner.body.request.id, first.body.request.id);
});

test('company request routes enforce ownership and reject user-supplied identity metadata', async (t) => {
  const f = fixture(t, { companies: [COMPANY] });
  await assert.rejects(f.service.route(f.ctx('GET', '/company-requests', undefined, null)), rejectCode('unauthenticated', 401));
  await assert.rejects(f.create(body('bad', { candidate: { name: 'fake' } })), rejectCode('invalid_input', 400));
  const created = await f.create(body('known', { input: 'Known Company' }));
  const id = created.body.request.id;
  assert.deepEqual((await f.service.route(f.ctx('GET', '/company-requests', undefined, 'owner-b'))).body, { items: [] });
  await assert.rejects(f.service.route(f.ctx('DELETE', `/company-requests/${id}`, {}, 'owner-b')), rejectCode('not_found', 404));
  assert.equal((await f.service.route(f.ctx('GET'))).body.items.length, 1);
});

test('new candidate requires trusted evidence and returns only a safe request projection', async (t) => {
  let sent;
  const f = fixture(t, { model: { async resolveCompany(input) { sent = input; return candidate(); } } });
  const created = await f.create(body('new', { domain: 'newcompany.com', careerUrl: 'https://jobs.greenhouse.io/newcompany', scope: 'Zurich' }));
  const task = f.claim(created.body.task.id), outcome = await f.service.runTask(task);
  assert.equal(outcome.status, 'succeeded');
  assert.equal(outcome.committed, true);
  f.finish(task.id, outcome);
  const result = f.service.taskResult(f.tasks.get('owner-a', task.id), { accountId: 'owner-a' });
  assert.equal(result.request.status, 'candidate');
  assert.equal(result.request.previewRevision, 1);
  assert.equal(result.request.candidate.domain, 'newcompany.com');
  assert.deepEqual(result.request.candidate.coverage, { state: 'requested' });
  assert.deepEqual(Object.keys(sent).sort(), ['careerUrl', 'domain', 'input', 'scope']);
  assert.equal(JSON.stringify(sent).includes('owner-a'), false);
  assert.equal(f.service.taskResult(f.tasks.get('owner-a', task.id), { accountId: 'owner-b' }), null);
  assert.deepEqual(Object.keys(outcome.output).sort(), ['previewRevision', 'requestId']);
});
test('browser input/scope-only website submissions reach one grounded decision without a domain proposal',async t=>{
  for(const raw of ['https://newcompany.com/about','newcompany.com']){
    let inferences=0;
    const f=fixture(t,{model:{resolveCompany(input){
      assert.deepEqual(input,{input:raw,scope:'European roles',domain:null,careerUrl:null});
      return resolveCompanyIdentity(input,{
        fetchPage:async url=>{const text='<title>Cloud Collective</title><h1>Cloud Collective</h1>Official company website.';return {url,finalUrl:url,status:200,text,bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex')};},
        executeStage:async({stage})=>{inferences++;assert.equal(stage,'grounded_decision');const result=candidate();result.data.candidate.name='Cloud Collective';result.data.candidate.evidenceUrls=['https://newcompany.com/'];return {data:result.data,usage:{inputTokens:100,cachedInputTokens:0,outputTokens:50,reasoningOutputTokens:0}};}
      }).then(({data,evidenceVerified,evidenceProvenance})=>({data,evidenceVerified,evidenceProvenance}));
    }}});
    const created=await f.create({input:raw,scope:'European roles',requestKey:'ui-shaped'}),task=f.claim(created.body.task.id),outcome=await f.service.runTask(task);
    assert.equal(outcome.status,'succeeded');assert.equal(inferences,1);
    const result=f.service.taskResult(f.tasks.get('owner-a',task.id),{accountId:'owner-a'});
    assert.equal(result.request.candidate.name,'Cloud Collective');assert.equal(result.request.input,raw);assert.equal(result.request.scope,'European roles');
  }
});

test('ambiguous research returns a warning and clarification without a guessed candidate', async (t) => {
  const f = fixture(t, { model: { async resolveCompany() { return { data: { status: 'clarification', candidate: null,
    clarification: 'Which Acme company and country do you mean?' }, evidenceVerified: false }; } } });
  const created = await f.create(body()), task = f.claim(created.body.task.id);
  const outcome = await f.service.runTask(task); f.finish(task.id, outcome);
  const projected = f.service.taskResult(f.tasks.get('owner-a', task.id), { accountId: 'owner-a' });
  assert.equal(outcome.status, 'warning');
  assert.equal(projected.request.status, 'clarification');
  assert.equal(projected.request.candidate, null);
  assert.match(projected.request.clarification, /Which Acme/u);
});

test('acceptance requires the exact candidate, revision and idempotency key and records one effect', async (t) => {
  const f = fixture(t, { companies: [COMPANY] });
  const created = await f.create(body('known', { input: 'Known Company' })), request = created.body.request;
  const acceptBody = { candidateId: request.candidate.id, previewRevision: request.previewRevision };
  const accept = (payload, key = 'accept-1') => f.service.route(f.ctx('POST', `/company-requests/${request.id}/accept`, payload, 'owner-a', { idempotencyKey: key }));
  await assert.rejects(accept({ ...acceptBody, candidateId: 'another' }), rejectCode('preview_conflict', 409));
  await assert.rejects(accept({ ...acceptBody, previewRevision: 2 }), rejectCode('preview_conflict', 409));
  await assert.rejects(accept(acceptBody, null), rejectCode('invalid_input', 400));
  const accepted = await accept(acceptBody), retry = await accept(acceptBody);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.request.status, 'accepted');
  assert.deepEqual(retry, accepted);
  assert.deepEqual(accepted.body.request.candidate.coverage, { state: 'imported_snapshot' });
  await assert.rejects(accept(acceptBody, 'accept-2'), rejectCode('idempotency_conflict', 409));
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM demo_company_requests WHERE status='accepted'").get().n, 1);
});

test('public URL validation rejects private and executable URLs and ATS official domains', async (t) => {
  for (const url of ['http://newcompany.com', 'https://localhost/a', 'https://127.0.0.1/', 'https://2130706433/', 'https://[::1]/',
    'https://internal.local/a', 'https://user:pass@newcompany.com', 'https://newcompany.com:8443/', 'file:///etc/passwd',
    'https://newcompany.com/#secret', 'javascript:alert(1)', `https://newcompany.com/${'é'.repeat(400)}`]) {
    assert.throws(() => validateCompanyUrl(url), rejectCode('invalid_input'));
  }
  assert.equal(validateCompanyUrl('https://jobs.greenhouse.io/newcompany'), 'https://jobs.greenhouse.io/newcompany');
  assert.throws(() => validateCompanyUrl('https://jobs.greenhouse.io/newcompany', { official: true }), rejectCode('invalid_input'));
  const f = fixture(t);
  await assert.rejects(f.create(body('ats', { domain: 'greenhouse.io' })), rejectCode('invalid_input'));
});

test('invalid or unverified candidate evidence fails safely and keeps original input', async (t) => {
  for (const mutate of [
    (value) => { value.evidenceVerified = false; },
    (value) => { value.data.candidate.domain = 'greenhouse.io'; value.data.candidate.websiteUrl = 'https://greenhouse.io/newcompany'; },
    (value) => { value.data.candidate.websiteUrl = 'https://anothercompany.com/'; },
    (value) => { value.data.candidate.evidenceUrls = ['https://127.0.0.1/']; },
    (value) => { value.data.candidate.evidenceUrls = ['https://unrelated.com/']; },
    (value) => { value.data.candidate.privateBoardConfig = {}; },
  ]) {
    const f = fixture(t, { model: { async resolveCompany() { const value = candidate(); mutate(value); return value; } } });
    const created = await f.create(body()), outcome = await f.service.runTask(f.claim(created.body.task.id));
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.errorCode, 'invalid_output');
    assert.equal(outcome.output, null);
    const saved = (await f.service.route(f.ctx('GET'))).body.items[0];
    assert.equal(saved.status, 'unresolved');
    assert.equal(saved.input, 'New Company');
    assert.equal(saved.candidate, null);
    assert.equal(saved.clarification, 'The company evidence could not be verified.');
  }
});

test('provider failure is distinct from ambiguity and leaks no provider text', async (t) => {
  const f = fixture(t, { model: { async resolveCompany() { throw new Error('secret provider raw trace'); } } });
  const created = await f.create(body()), outcome = await f.service.runTask(f.claim(created.body.task.id));
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.errorCode, 'provider_unavailable');
  assert.equal(outcome.output, null);
  const result = await f.service.route(f.ctx('GET'));
  assert.equal(result.body.items[0].status, 'unresolved');
  assert.equal(JSON.stringify(result).includes('secret'), false);
});
test('new request key retries unresolved research and deletion purges every attempt',async t=>{
  let down=true;const f=fixture(t,{model:{resolveCompany:async()=>{if(down)throw Error('offline');return candidate();}}});
  const first=await f.create(body('first'));await f.service.runTask(f.claim(first.body.task.id));down=false;
  const retry=await f.create(body('retry'));assert.equal(retry.status,202);assert.equal(retry.body.request.id,first.body.request.id);assert.notEqual(retry.body.task.id,first.body.task.id);
  await f.service.runTask(f.claim(retry.body.task.id));assert.equal((await f.service.route(f.ctx('GET'))).body.items[0].previewRevision,2);
  await f.service.route(f.ctx('DELETE',`/company-requests/${retry.body.request.id}`));assert.equal(f.records.size,0);assert.equal(f.db.prepare('SELECT count(*) n FROM demo_company_request_tasks').get().n,0);
});
test('direct company deletion holds the injected private transaction through the barrier',async t=>{
  const f=fixture(t),created=await f.create(body());let released=0;
  const service=createCompanyService({db:f.db,feed:{companies:()=>({items:[]})},tasks:f.tasks,beforePrivateDelete:()=>assert.equal(f.db.isTransaction,true),withPrivateTransaction:fn=>{f.db.exec('BEGIN');try{const result=fn();f.db.exec('COMMIT');return result;}catch(error){f.db.exec('ROLLBACK');throw error;}finally{assert.equal(f.db.isTransaction,false);released++;}}});
  await service.route(f.ctx('DELETE',`/company-requests/${created.body.request.id}`));assert.equal(released,1);assert.equal(f.records.size,0);
});

test('request deletion purges private tasks and a late model response cannot recreate it', async (t) => {
  let resolve, barrierCalls = 0;
  const f = fixture(t, { beforePrivateDelete() { barrierCalls++; }, model: { resolveCompany() { return new Promise((done) => { resolve = done; }); } } });
  const created = await f.create(body()), task = f.claim(created.body.task.id);
  const pending = f.service.runTask(task);
  const deleted = await f.service.route(f.ctx('DELETE', `/company-requests/${created.body.request.id}`, {}));
  assert.deepEqual(deleted, { status: 200, body: { deleted: true } });
  assert.equal(barrierCalls, 1);
  assert.equal(f.records.size, 0);
  resolve(candidate());
  assert.equal((await pending).errorCode, 'preview_conflict');
  assert.deepEqual((await f.service.route(f.ctx('GET'))).body, { items: [] });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM demo_company_request_keys').get().n, 0);
});

test('expired or superseded leases cannot apply a candidate', async (t) => {
  for (const mode of ['expiry', 'new-lease', 'abort']) {
    let resolve;
    const f = fixture(t, { model: { resolveCompany() { return new Promise((done) => { resolve = done; }); } } });
    const created = await f.create(body()), task = f.claim(created.body.task.id), controller = new AbortController();
    const pending = f.service.runTask(task, { signal: controller.signal });
    if (mode === 'expiry') f.advance(60_000);
    if (mode === 'new-lease') f.records.get(task.id).leaseToken = 'new-lease';
    if (mode === 'abort') controller.abort();
    resolve(candidate());
    assert.equal((await pending).errorCode, 'preview_conflict');
    const saved = (await f.service.route(f.ctx('GET'))).body.items[0];
    assert.equal(saved.status, 'pending');
    assert.equal(saved.candidate, null);
  }
});

test('terminal task completion and preview acceptance share one database transaction', async (t) => {
  const f = fixture(t, { model: { async resolveCompany() { return candidate(); } } });
  const created = await f.create(body()), task = f.claim(created.body.task.id);
  f.tasks.complete = () => false;
  const outcome = await f.service.runTask(task);
  assert.equal(outcome.errorCode, 'preview_conflict');
  const saved = (await f.service.route(f.ctx('GET'))).body.items[0];
  assert.equal(saved.previewRevision, 0);
  assert.equal(saved.status, 'pending');
  assert.equal(saved.candidate, null);
});

test('provided identity evidence cannot be silently ignored by a known-name match', async (t) => {
  const f = fixture(t, { companies: [COMPANY] });
  const response = await f.create(body('contradiction', { input: 'Known Company', careerUrl: 'https://anothercompany.com/jobs' }));
  assert.equal(response.status, 202);
  assert.equal(response.body.request.candidate, null);
});

test('account deletion composes synchronously and barrier failure preserves a request', async (t) => {
  const f = fixture(t, { beforePrivateDelete() { throw new Error('restore generation unavailable'); } });
  const created = await f.create(body());
  await assert.rejects(f.service.route(f.ctx('DELETE', `/company-requests/${created.body.request.id}`, {})), /restore generation/u);
  assert.equal((await f.service.route(f.ctx('GET'))).body.items.length, 1);
  assert.equal(f.records.size, 1);
  f.db.exec('BEGIN IMMEDIATE');
  assert.equal(f.service.deleteAccountData('owner-a'), undefined);
  f.db.exec('COMMIT');
  assert.equal(f.records.size, 0);
  assert.deepEqual((await f.service.route(f.ctx('GET'))).body.items, []);
});

test('missing deletion barrier leaves private state intact and advertises temporary unavailability', async (t) => {
  const f = fixture(t, { beforePrivateDelete: null });
  const created = await f.create(body());
  await assert.rejects(f.service.route(f.ctx('DELETE', `/company-requests/${created.body.request.id}`, {})), rejectCode('deletion_unavailable', 503));
  assert.equal((await f.service.route(f.ctx('GET'))).body.items.length, 1);
  assert.equal(f.records.size, 1);
});

test('bounded requests and malformed task projections fail without publishing private payloads', async (t) => {
  const f = fixture(t, { maxPerOwner: 1 });
  const created = await f.create(body());
  await assert.rejects(f.create(body('new', { input: 'Another Company' })), rejectCode('task_limit', 429));
  const task = f.claim(created.body.task.id);
  assert.equal(f.service.taskResult({ ...task, status: 'succeeded', output: null }, { accountId: 'owner-a' }), null);
  assert.equal(f.service.taskResult({ ...task, kind: 'search_intent' }, { accountId: 'owner-a' }), undefined);
  assert.equal((await f.service.runTask({ ...task, payload: {} })).errorCode, 'invalid_output');
});
