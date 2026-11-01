// Shared setup, current-entitlement priority and protected operator boundaries.
// Real SQLite and local files only; no provider, host or crawler execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,writeFileSync,chmodSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {openStore} from './store.mjs';
import {createFeed} from './feed.mjs';
import {createTasks} from './tasks.mjs';
import {createEntitlements,createAccessReader} from './entitlements.mjs';
import {createCompanyService} from './companies.mjs';
import {createReadingPreferencesService} from './reading-preferences.mjs';
import {createCompanyProgress} from './company-progress.mjs';
import {companySetupCommand} from '../scripts/company-requests/setup.mjs';
import {createHandler} from './http.mjs';

const AT=Date.parse('2026-11-01T12:00:00Z');
function fixture(t,{path=':memory:'}={}) {
  const store=openStore(path);let clock=AT;t.after(()=>store.close());const db=store.db;
  db.exec("CREATE TABLE auth_accounts(id TEXT PRIMARY KEY,account_expires_at INTEGER) STRICT; INSERT INTO auth_accounts VALUES('alice',NULL),('bob',NULL);");
  createEntitlements({db,now:()=>clock});const access=createAccessReader({db,now:()=>clock});
  let policy=true;
  const authority=(id,{allowUnavailable=false,locale}={})=>{const current=access(id);return current&&(allowUnavailable||policy&&locale==='fr')?{account:{id},access:current}:null;};
  const feed=createFeed({db,now:()=>clock}),tasks=createTasks({db,now:()=>clock}),reading=createReadingPreferencesService({db,feed,ownerAuthority:authority,now:()=>clock});
  const companies=createCompanyService({db,feed,tasks,ownerAuthority:authority,readingPreferences:reading,now:()=>clock,beforePrivateDelete:()=>{},model:{resolveCompany(){assert.fail('Published-company priority never invokes a model.');}}});
  const progress=createCompanyProgress({db,now:()=>clock,canonicalCompanyId:feed.canonicalCompanyId,accessForAccount:access});
  const id=feed.publishCompany({name:'Shared Company',domain:'shared.example.org',websiteUrl:'https://shared.example.org/',evidenceUrls:['https://shared.example.org/about']});
  const otherId=feed.publishCompany({name:'Other Company',domain:'other.example.org',websiteUrl:'https://other.example.org/',evidenceUrls:['https://other.example.org/about']});
  const ctx=(method,path,body,owner='alice',extra={})=>({method,path,url:new URL(`https://preview.example/api/v1${path}`),body,accountId:owner,viewer:{account:{id:owner},access:{premium:true}},interfaceLocale:'fr',...extra});
  const priority=(key='priority',owner='alice',companyId=id)=>companies.route(ctx('POST',`/account/companies/${companyId}/priority`,{requestKey:key},owner));
  function paid(owner,until=clock+60_000) {db.prepare("INSERT INTO access_subscriptions VALUES(?,?,1,'active','monthly',?,0) ON CONFLICT(subscription_hash) DO UPDATE SET paid_through_at=excluded.paid_through_at,status='active'").run(`subscription-${owner}`,owner,until);}
  async function accept(owner='bob') {
    const request=(await companies.route(ctx('POST','/company-requests',{input:'Shared Company',requestKey:`ordinary-${owner}`},owner))).body.request;
    return (await companies.route(ctx('POST',`/company-requests/${request.id}/accept`,{candidateId:request.candidate.id,previewRevision:request.previewRevision},owner,{idempotencyKey:`accept-${owner}`}))).body.request;
  }
  return {store,db,feed,tasks,reading,companies,progress,id,otherId,ctx,priority,paid,accept,advance:ms=>clock+=ms,pause:()=>policy=false};
}

test('free acceptance and paid known-company priority share setup while current entitlement governs private and aggregate priority',async t=>{
  const f=fixture(t),free=await f.accept();
  assert.equal(free.setup.state,'queued');assert.equal(free.setup.priority,'standard');assert.equal(free.setup.revision,1);
  await assert.rejects(f.priority(),{code:'access_denied',status:403}); // Copied viewer premium does not grant access.
  f.paid('alice');const paid=(await f.priority()).body.request;
  assert.equal(paid.status,'accepted');assert.equal(paid.companyId,free.companyId);assert.equal(paid.setup.priority,'premium');
  assert.equal(f.progress.pending().items.length,1);assert.equal(f.progress.pending().items[0].priority,'premium');
  assert.equal(f.db.prepare('SELECT count(*) n FROM justup_company_setups').get().n,1);assert.equal(f.tasks.get('alice',paid.taskId),null);
  const shared=f.progress.update({companyId:f.id,expectedRevision:1,state:'in_progress',reason:'source_validation_pending'});
  assert.equal(shared.revision,2);
  for(const owner of ['alice','bob'])assert.equal((await f.companies.route(f.ctx('GET','/company-requests',undefined,owner))).body.items[0].setup.state,'in_progress');
  const publicCompany=f.feed.company(f.id);assert.deepEqual(publicCompany.setup,{state:'in_progress',reason:'source_validation_pending',nextAction:'await_validation',updatedAt:new Date(AT).toISOString()});
  for(const forbidden of ['alice','bob','premium','scope','requester'])assert.equal(JSON.stringify(publicCompany).includes(forbidden),false);
  assert.equal(publicCompany.coverage.state,'requested');
  f.advance(60_001);
  assert.equal((await f.companies.route(f.ctx('GET','/company-requests',undefined,'alice'))).body.items[0].setup.priority,'standard');
  assert.equal(f.progress.pending().items[0].priority,'standard');await assert.rejects(f.priority(),{code:'access_denied'});
  assert.equal(f.feed.company(f.otherId).setup.state,'blocked');assert.equal(f.feed.company(f.otherId).setup.updatedAt,null);
});

test('priority retries reuse confirmed relationships and explicit unfollow, reject conflicts and enforce current policy locale',async t=>{
  const f=fixture(t);f.paid('alice');const first=(await f.priority()).body.request;
  assert.equal((await f.priority()).body.request.id,first.id);assert.equal((await f.priority('another-key')).body.request.id,first.id);
  assert.equal(f.db.prepare("SELECT count(*) n FROM justup_company_requests WHERE owner_id='alice'").get().n,1);
  assert.equal(f.reading.follows('alice').revision,1);
  f.reading.route(f.ctx('PATCH',`/follows/${f.id}`,{followed:false,expectedRevision:1}));
  await f.priority();await f.priority('new-key');assert.deepEqual(f.reading.follows('alice').items,[]);
  await assert.rejects(f.priority('priority','alice',f.otherId),{code:'idempotency_conflict'});
  await assert.rejects(f.priority('missing','alice','missing'),{code:'not_found'});
  await assert.rejects(f.companies.route(f.ctx('POST',`/account/companies/${f.id}/priority`,{requestKey:'bad',premium:true})),{code:'invalid_input'});
  await assert.rejects(f.companies.route({...f.ctx('POST',`/account/companies/${f.id}/priority`,{requestKey:'english'}),interfaceLocale:'en'}),{code:'policy_unavailable'});
  f.pause();await assert.rejects(f.priority('paused'),{code:'policy_unavailable'});
  assert.equal((await f.companies.route(f.ctx('GET','/company-requests'))).body.items[0].setup.priority,'premium');
});

test('progress CAS is idempotent, rejects stale changes and cannot manufacture monitoring from a boolean or weekly history',async t=>{
  const f=fixture(t);await f.accept();
  const input={companyId:f.id,expectedRevision:1,state:'blocked',reason:'source_validation_pending'},first=f.progress.update(input);
  assert.deepEqual(f.progress.update(input),first);assert.equal(first.revision,2);
  assert.throws(()=>f.progress.update({...input,state:'queued',reason:'operator_handoff_pending'}),{code:'revision_conflict'});
  for(const bad of [{state:'monitoring',reason:null},{state:'blocked',reason:'arbitrary private configuration'},{state:'active',reason:'source_validation_pending'}])assert.throws(()=>f.progress.update({...input,expectedRevision:2,...bad}),{code:'invalid_input'});
  f.db.exec('CREATE TABLE hiring_wire_editions(snapshot_json TEXT) STRICT');f.db.prepare('INSERT INTO hiring_wire_editions VALUES(?)').run(JSON.stringify({sourceVersion:'jobseek-coverage-v2',active:true,companyId:f.id}));
  assert.equal(f.feed.company(f.id).setup.state,'blocked');assert.equal(f.feed.company(f.id).coverage.state,'requested');
  f.companies.deleteAccountData('bob');assert.equal(f.progress.pending().items.length,0);assert.equal(f.feed.company(f.id).setup.state,'blocked');
  assert.throws(()=>f.progress.update({...input,expectedRevision:2,state:'queued',reason:'operator_handoff_pending'}),{code:'not_found'});
});

test('removing one requester drops its current priority while preserving shared progress and another free requester',async t=>{
  const f=fixture(t),free=await f.accept();f.paid('alice');const paid=(await f.priority()).body.request;
  f.progress.update({companyId:f.id,expectedRevision:1,state:'in_progress',reason:'source_validation_pending'});
  await f.companies.route(f.ctx('DELETE',`/company-requests/${paid.id}`,undefined,'alice'));
  assert.equal(f.progress.pending().items[0].priority,'standard');assert.equal(f.progress.pending().items[0].state,'in_progress');
  assert.equal((await f.companies.route(f.ctx('GET','/company-requests',undefined,'bob'))).body.items[0].id,free.id);
  await f.priority('new-relationship');f.db.prepare("UPDATE auth_accounts SET account_expires_at=? WHERE id='alice'").run(AT);
  assert.equal(f.progress.pending().items[0].priority,'standard');
  f.companies.deleteAccountData('alice');f.reading.deleteAccountData('alice');f.db.prepare("DELETE FROM auth_accounts WHERE id='alice'").run();
  assert.equal(f.feed.company(f.id).setup.state,'in_progress');assert.equal(f.progress.pending().items.length,1);
});

test('operator handoff bounds scopes and rows and orders current premium groups before earlier free requests',async t=>{
  const f=fixture(t),other=(await f.companies.route(f.ctx('POST','/company-requests',{input:'Other Company',requestKey:'other'},'bob'))).body.request;
  await f.companies.route(f.ctx('POST',`/company-requests/${other.id}/accept`,{candidateId:other.candidate.id,previewRevision:1},'bob',{idempotencyKey:'other-accept'}));
  f.advance(1);f.paid('alice');await f.priority();
  for(let i=0;i<12;i++) {
    const request=(await f.companies.route(f.ctx('POST','/company-requests',{input:'Shared Company',requestKey:`scope-${i}`,scope:`Region ${i}`},'bob'))).body.request;
    await f.companies.route(f.ctx('POST',`/company-requests/${request.id}/accept`,{candidateId:request.candidate.id,previewRevision:1},'bob',{idempotencyKey:`scope-accept-${i}`}));
  }
  const publicCursor=f.feed.companies({limit:1}).nextCursor,first=f.progress.pending({limit:1});
  assert.equal(first.truncated,true);assert.equal(first.items[0].companyId,f.id);assert.equal(first.items[0].requestedScopeCount,12);assert.equal(first.items[0].requestedScopes.length,8);
  f.progress.update({companyId:f.id,expectedRevision:1,state:'in_progress',reason:'source_validation_pending'});
  assert.throws(()=>f.feed.companies({cursor:publicCursor}),{code:'stale_cursor'});
  f.advance(60_001);assert.equal(f.progress.pending({limit:1}).items[0].companyId,f.otherId);
  assert.throws(()=>f.progress.pending({limit:51}),{code:'invalid_limit'});
});

test('shared website metadata keeps source-company priority separate from an earlier request',async t=>{
  const f=fixture(t);await f.accept();const iso=new Date(AT).toISOString();
  f.store.importSnapshot({schemaVersion:1,snapshotAt:iso,verifiedAt:iso,observations:[],unknownIds:[],companyIdentities:[{companyId:'source-alias',officialDomain:'shared.example.org'}],jobs:[{
    id:'source-job',companyId:'source-alias',companyName:'Shared Company',companySlug:'shared-company',title:'Engineer',sourceUrl:'https://shared.example.org/jobs/1',active:true,reserved:false,hasContent:true,
    firstObserved:new Date(AT-3*86_400_000).toISOString(),lastObserved:null,locales:[],locations:[],employmentTypes:[],seniority:null,salary:null,bodyText:null,
    evidence:{source:'jobseek_public',metadataFetchedAt:iso,bodyFetchedAt:null,bodyUrl:null,bodySha256:null,textSha256:null,bodyBytes:0,normalizationVersion:1,truncated:false}
  }]});
  f.paid('alice');const first=(await f.priority('alias-key','alice','source-alias')).body.request;
  assert.equal(first.companyId,'source-alias');assert.notEqual((await f.priority('parent-key')).body.request.id,first.id);
  assert.equal((await f.priority('alias-key','alice','source-alias')).body.request.id,first.id);
  assert.equal((await f.priority('other-key','alice','source-alias')).body.request.id,first.id);assert.equal(f.progress.pending().items.length,2);
  assert.equal(f.db.prepare('SELECT count(*) n FROM justup_company_setups').get().n,2);
  assert.equal(f.feed.company('source-alias').setup.state,'queued');assert.equal(f.feed.company('source-alias').coverage.state,'imported_snapshot');
});

test('operator CLI reads bounded private handoff and CAS progress only from protected current-epoch storage',async t=>{
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'company-setup-')));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const path=join(directory,'application.sqlite'),generation=join(directory,'private-generation');writeFileSync(generation,'11111111-1111-1111-1111-111111111111\n',{mode:0o600});
  const f=fixture(t,{path});await f.accept();f.paid('alice');await f.priority();
  const env={JUSTUP_DB_PATH:path,JUSTUP_PRIVATE_GENERATION_PATH:generation},pending=()=>companySetupCommand({env,args:['pending','--limit','1'],now:()=>AT});
  const first=pending();assert.equal(first.items.length,1);assert.equal(first.items[0].priority,'premium');assert.equal(first.truncated,false);
  assert.equal(JSON.stringify(first).includes('alice'),false);assert.equal(JSON.stringify(first).includes('bob'),false);
  const args=['update','--company',f.id,'--revision','1','--state','in_progress','--reason','source_validation_pending'];
  assert.equal(companySetupCommand({env,args,now:()=>AT}).revision,2);assert.equal(pending().items[0].state,'in_progress');
  assert.throws(()=>companySetupCommand({env,args:['pending','--limit','51']}));
  assert.throws(()=>companySetupCommand({env,args:['update','--company',f.id,'--revision','2','--state','monitoring','--reason','source_validation_pending']}));
  chmodSync(path,0o644);assert.throws(pending);chmodSync(path,0o600);
  const link=join(directory,'link.sqlite');symlinkSync(path,link);assert.throws(()=>companySetupCommand({env:{...env,JUSTUP_DB_PATH:link},args:['pending']}));
  chmodSync(directory,0o755);assert.throws(pending);chmodSync(directory,0o700);
  writeFileSync(generation+'.pending','foreign deletion marker',{mode:0o600});assert.throws(pending);rmSync(generation+'.pending');
  assert.equal(f.db.prepare('PRAGMA user_version').get().user_version,2);
});

test('known-company priority HTTP enforces session, Origin, CSRF, current premium and exact locale policy',async t=>{
  const f=fixture(t),origin='https://preview.example',token='a'.repeat(43);
  const config={allowedOrigin:origin,sourceCommit:'a'.repeat(40),csrfSecret:'x'.repeat(32),policiesReviewed:true,
    policyLocales:{fr:{privacyUrl:origin+'/privacy.fr.html',usageUrl:origin+'/usage.fr.html',version:'reviewed-fr',reviewed:true}},
    policyAssetProof:{origin,sourceCommit:'a'.repeat(40),assetsSha256:'b'.repeat(64),locales:{fr:{version:'reviewed-fr',privacySha256:'c'.repeat(64),usageSha256:'d'.repeat(64)}}}};
  const auth={cleanup:()=>{},session:value=>value===token?{account:{id:'alice'},expiresAt:AT+100_000,access:{premium:true,fullAccess:true}}:null};
  const server=createServer(createHandler({auth,db:f.db,feed:f.feed,tasks:f.tasks,services:[f.companies,f.reading],config,now:()=>AT}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const base=`http://127.0.0.1:${server.address().port}/api/v1`,cookie=`__Host-justup_session=${token}`;
  const session=await (await fetch(base+'/session',{headers:{Cookie:cookie,'X-Justup-Locale':'fr'}})).json();
  const headers={Cookie:cookie,Origin:origin,'X-CSRF-Token':session.csrfToken,'Content-Type':'application/json','X-Justup-Locale':'fr'};
  const post=extra=>fetch(`${base}/account/companies/${f.id}/priority`,{method:'POST',headers:{...headers,...extra},body:JSON.stringify({requestKey:'http-priority'})});
  assert.equal((await post({Cookie:''})).status,401);
  assert.equal((await post({Origin:'https://other.example'})).status,403);
  assert.equal((await post({'X-CSRF-Token':'b'.repeat(43)})).status,403);
  const free=await post();assert.equal(free.status,403);assert.equal((await free.json()).error.code,'access_denied');
  f.paid('alice');assert.equal((await post({'X-Justup-Locale':'en'})).status,503);
  const accepted=await post();assert.equal(accepted.status,200);const request=(await accepted.json()).request;assert.equal(request.setup.priority,'premium');
  assert.equal((await post()).status,200);assert.equal(f.db.prepare('SELECT count(*) n FROM justup_company_requests').get().n,1);
  f.advance(60_001);assert.equal((await post()).status,403);
});
