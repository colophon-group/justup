// Availability is a bounded same-build file contract; these tests have no provider
// configuration and never connect to the broker or send a network request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,writeFileSync,chmodSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiServices,createApiReadiness,readRunnerStatus } from './composition.mjs';
import { writeRunnerStatus,readRunnerConfig } from './runner-adapter.mjs';
import { syntheticPolicyProof } from './policy-test-fixtures.mjs';
const AT=Date.parse('2026-10-31T16:00:00Z'),sourceCommit='a'.repeat(40),buildIdentity='sha256:immutable';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'justup-composition-')),path=join(dir,'runner-status.json');t.after(()=>rmSync(dir,{recursive:true,force:true}));return {dir,path,config:{sourceCommit,buildIdentity,runnerStatusPath:path},write(extra={}){const value={schemaVersion:1,identity:'queue-build',sourceCommit,buildIdentity,ready:true,updatedAt:new Date(AT).toISOString(),capabilities:{search:true,companyRequests:true,aiMatching:false},...extra};writeFileSync(path,JSON.stringify(value),{mode:0o640});return value;}};}
test('missing/stale/wrong-build or malformed heartbeat fails closed without model access',t=>{
  const f=fixture(t),read=()=>createApiReadiness({config:f.config,now:()=>AT})();assert.equal(read().runner.ready,false);
  for(const patch of [{updatedAt:new Date(AT-30001).toISOString()},{updatedAt:new Date(AT+1001).toISOString()},{sourceCommit:'b'.repeat(40)},{buildIdentity:'other'},{capabilities:{search:true}},{identity:'invalid identity'},{schemaVersion:2}]){f.write(patch);assert.equal(read().ready,false);assert.equal(read().capabilities.search,false);}
  f.write();chmodSync(f.path,0o644);assert.equal(read().ready,false);
});
test('fresh exact-build heartbeat exposes actual runner metadata and bounded boolean capabilities',t=>{
  const f=fixture(t);f.write();const r=createApiReadiness({config:f.config,now:()=>AT})();assert.equal(r.ready,true);assert.equal(r.runner.identity,'queue-build');assert.equal(r.runner.sourceCommit,sourceCommit);assert.equal(r.runner.buildIdentity,buildIdentity);assert.equal(r.runner.lastHeartbeat,new Date(AT).toISOString());assert.deepEqual(r.capabilities,{search:true,companyRequests:true,aiMatching:false});
});
test('API advertises queue availability and enqueues work without constructing inference providers',async t=>{
  const f=fixture(t);f.write();const db=new DatabaseSync(':memory:');t.after(()=>db.close());let serial=0;const queued=new Map();
  const tasks={enqueue(input){const task={...input,id:`task-${++serial}`,status:'pending',createdAt:new Date(AT).toISOString(),updatedAt:new Date(AT).toISOString()};queued.set(task.id,task);return task;},get:(owner,id)=>queued.get(id)?.ownerId===owner?queued.get(id):null,delete:(owner,id)=>queued.delete(id),complete:()=>false,publicView:task=>({id:task.id,status:task.status,result:null,error:null})};
  const feed={eligibleJobs:()=>[],publicJob:j=>j,companies:()=>({items:[]}),company:id=>({id}),generation:()=>null,coverage:()=>({stale:true})};
  const config={...f.config,dbPath:':memory:',allowedOrigin:'https://preview.example',policiesReviewed:true,privacyUrl:'https://preview.example/privacy.html',usageUrl:'https://preview.example/usage.html',policyVersion:'fixture',policyAssetProof:syntheticPolicyProof({origin:'https://preview.example',sourceCommit,version:'fixture'}),get model(){throw Error('API read model config');},get jev(){throw Error('API read provider key');},get hiringWire(){throw Error('API read Wire proof/socket');},get sourceCoverage(){throw Error('API read source history path');}};
  const services=createApiServices({db,feed,tasks,config,visitorAvailability:()=>true,accessForAccount:()=>({kind:'paid',fullAccess:true}),now:()=>AT,beforePrivateDelete:()=>{}}),intent=services[0],company=services[1];
  assert.equal(intent.capabilities().search,true);assert.equal(company.capabilities().companyRequests,true);
  assert.deepEqual(services.at(-1).publicRoute({method:'GET',path:'/hiring-wire'}),{status:200,body:{state:'unavailable',edition:null}});
  const ctx={method:'POST',path:'/searches',url:new URL('https://preview.example/searches'),body:{query:'backend',requestKey:'one'},viewer:{account:{id:'owner'}},accountId:'owner'};
  const response=await intent.route(ctx);assert.equal(response.status,202);assert.equal(JSON.stringify(response).includes('provider'),false);
  const task=queued.get(response.body.task.id);Object.assign(task,{status:'running',leaseToken:'lease',leaseUntil:AT+30000});assert.equal((await intent.runTask(task)).errorCode,'dependency_unavailable');
  f.write({ready:false});assert.equal(intent.capabilities().search,false);await assert.rejects(()=>intent.route({...ctx,body:{query:'different',requestKey:'two'}}),{code:'dependency_unavailable'});
});
test('queue status writes atomic non-secret metadata and shutdown removes availability',t=>{
  const f=fixture(t);writeRunnerStatus({path:f.path,identity:'queue-build',config:f.config,capabilities:{search:false,companyRequests:false,aiMatching:false},now:()=>AT});assert.equal(readRunnerStatus({config:f.config,now:()=>AT}).ready,true);
  writeRunnerStatus({path:f.path,identity:'queue-build',config:f.config,ready:false,capabilities:{search:false,companyRequests:false,aiMatching:false},now:()=>AT});assert.equal(readRunnerStatus({config:f.config,now:()=>AT}).ready,false);
});
test('queue configuration refuses an ordinary contributor-owned config',t=>{const f=fixture(t);f.write();assert.throws(()=>readRunnerConfig(f.path),/unavailable/);});
test('assembled core/auth/matching API consumes heartbeat, exposes real services and deletes accounts without model secrets',async t=>{
  let createConfiguredApplication,createAuth;
  try{({createConfiguredApplication}=await import('./main.mjs'));({createAuth}=await import('./auth.mjs'));await import('./matching.mjs');}
  catch(error){if(error.code==='ERR_MODULE_NOT_FOUND'){t.skip('Core/auth/matching dependency PRs must be assembled for this cross-module contract.');return;}throw error;}
  const f=fixture(t);f.write();const origin='http://127.0.0.1:18787',password='Synthetic-password-123!';
  const application=await createConfiguredApplication({config:{...f.config,dbPath:':memory:',servicesEnabled:true,allowedOrigin:origin,allowInsecureLocalhost:true,policiesReviewed:true,privacyUrl:origin+'/privacy.html',usageUrl:origin+'/usage.html',policyVersion:'fixture',policyAssetProof:syntheticPolicyProof({origin,sourceCommit,version:'fixture'}),inviteCode:'fixture-invite',jev:{token:'must-never-enter-api-response'}},now:()=>AT,authFactory:createAuth});
  t.after(()=>application.close());await new Promise(resolve=>application.server.listen(0,'127.0.0.1',resolve));const endpoint=`http://127.0.0.1:${application.server.address().port}/api/v1`;
  const account=await application.auth.register({username:'fixtureuser',password,inviteCode:'fixture-invite'}),headers={cookie:`justup_session=${account.token}`};
  // Cookie name is part of the core boundary, not a provider/session substitute.
  const coreSession=await application.auth.session(account.token);assert.ok(coreSession.account.id);
  const call=(path,options={})=>fetch(endpoint+path,{...options,headers:{...headers,...options.headers}});
  const publicCounts=()=>['justup_visitors','justup_workspaces','justup_tasks'].map(table=>application.store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n);
  const beforePublic=publicCounts();
  const publicWire=await fetch(`${endpoint}/hiring-wire`);assert.equal(publicWire.status,200);assert.deepEqual(await publicWire.json(),{state:'unavailable',edition:null});
  assert.deepEqual(publicCounts(),beforePublic);assert.equal(publicWire.headers.getSetCookie().some(cookie=>cookie.includes('justup_visitor=')),false);
  const response=await call('/session');let session=await response.json();
  assert.ok(session.user);assert.equal(session.capabilities.search,true);assert.equal(JSON.stringify(session).includes('must-never'),false);
  assert.deepEqual(await (await call('/searches')).json(),{items:[]});assert.deepEqual(await (await call('/company-requests')).json(),{items:[]});
  f.write({updatedAt:new Date(AT-30001).toISOString()});session=await (await call('/session')).json();assert.ok(session.user);assert.equal(session.capabilities.search,false);
  assert.equal((await call('/health')).status,503);
  const mutationHeaders={origin,'content-type':'application/json','x-csrf-token':session.csrfToken};
  assert.equal((await call('/searches',{method:'POST',headers:mutationHeaders,body:JSON.stringify({query:'backend',requestKey:'unavailable'})})).status,503);
  const deleted=await call('/account',{method:'DELETE',headers:mutationHeaders,body:JSON.stringify({password})});assert.equal(deleted.status,200);assert.equal(application.auth.session(account.token),null);
});

test('composed public reads allocate no visitors and localized first-search retries retain one policy-bound owner',async t=>{
  const {createConfiguredApplication}=await import('./main.mjs');
  const f=fixture(t);f.write();const origin='http://127.0.0.1:18787';
  const de={privacyUrl:origin+'/privacy.de.html',usageUrl:origin+'/usage.de.html',version:'reviewed-de',reviewed:true};
  const policyAssetProof={origin,sourceCommit,assetsSha256:'b'.repeat(64),locales:{de:{version:de.version,privacySha256:'c'.repeat(64),usageSha256:'d'.repeat(64)}}};
  const app=await createConfiguredApplication({config:{...f.config,dbPath:':memory:',servicesEnabled:true,
    allowedOrigin:origin,allowInsecureLocalhost:true,policiesReviewed:true,policyLocales:{de},
    policyAssetProof},now:()=>AT});
  t.after(async()=>{app.server.closeAllConnections();await app.close();});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const endpoint=`http://127.0.0.1:${app.server.address().port}/api/v1`;
  const companyId=app.feed.publishCompany({name:'Example',domain:'example.org',websiteUrl:'https://example.org/',evidenceUrls:[]});
  const counts=()=>['justup_visitors','justup_searches','justup_tasks'].map(table=>app.store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n);
  for(const path of ['/hiring-wire','/companies?limit=1',`/companies/${companyId}/report`]){
    const response=await fetch(endpoint+path);assert.equal(response.status,200);await response.json();
    assert.equal(response.headers.get('set-cookie'),null);assert.deepEqual(counts(),[0,0,0]);
  }
  const sessionResponse=await fetch(endpoint+'/session',{headers:{cookie:'justup_interface_locale=de'}}),session=await sessionResponse.json();
  assert.equal(session.policies.locale,'de');assert.equal(session.policies.version,de.version);assert.equal(session.policies.reviewed,true);
  assert.equal(session.capabilities.visitorSearch,true);assert.equal(session.capabilities.sse,true);assert.deepEqual(counts(),[0,0,0]);
  const ownership=sessionResponse.headers.getSetCookie().find(cookie=>cookie.startsWith('justup_visitor='));assert(ownership.includes('HttpOnly'));
  const cookie=['justup_interface_locale=de',...sessionResponse.headers.getSetCookie().map(value=>value.split(';')[0])].join('; ');
  const submit=()=>fetch(endpoint+'/visitor/searches',{method:'POST',headers:{cookie,origin,'content-type':'application/json','x-csrf-token':session.csrfToken},
    body:JSON.stringify({query:'Original English query',presentationLocale:'de',requestKey:'recover-localized-first-response'})});
  const firstResponse=await submit(),first=await firstResponse.json();assert.equal(firstResponse.status,202);
  // Retry with only the cookies from GET /session, as if every POST response byte
  // disappeared. The generic policy proof and persisted visitor locale coexist.
  const retryResponse=await submit(),retry=await retryResponse.json();assert.equal(retryResponse.status,202);
  assert.equal(retry.search.id,first.search.id);assert.equal(retry.task.id,first.task.id);assert.deepEqual(counts(),[1,1,1]);
  const visitor=app.store.db.prepare('SELECT id,interface_locale FROM justup_visitors').get();assert.equal(visitor.interface_locale,'de');
  const task=app.tasks.get(visitor.id,first.task.id);assert.equal(task.payload.presentationLocale,'de');assert.match(task.payload.policyKey,/^[a-f0-9]{64}$/);
  assert.equal(app.store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='justup_visitor_admission'").get(),undefined);
  assert.equal(JSON.parse(app.store.db.prepare('SELECT policy_scope FROM justup_processing_admission').get().policy_scope).de.reviewed,true);
  policyAssetProof.locales.de.privacySha256='e'.repeat(64);app.services.find(service=>typeof service.refreshAvailability==='function').refreshAvailability();
  const intent=app.services.find(service=>typeof service.runTask==='function'&&typeof service.snapshot==='function');
  const claimed=app.tasks.claim({workerId:'fixture',kinds:['search_intent']});
  assert.equal((await intent.runTask(claimed)).errorCode,'processing_unavailable');
  assert.equal(app.store.db.prepare('SELECT accepted_json FROM justup_searches').get().accepted_json,null);
});
