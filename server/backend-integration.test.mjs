// Cross-feature contracts through the fixed API composition, real auth/SQLite
// and a local fake queue interpreter. No native model or provider is invoked.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createConfiguredApplication} from './main.mjs';
import {createIntentService} from './intent.mjs';
import {createCompanyProgress} from './company-progress.mjs';
import {syntheticPolicyProof} from './policy-test-fixtures.mjs';

const AT=Date.parse('2026-11-01T12:00:00Z'),DAY=86_400_000,ORIGIN='http://127.0.0.1:18787';
const FILTERS=['companyInclude','companyExclude','titleAny','bodyAll','bodyNone','locations','workplaces','employmentTypes','postingLanguages','seniority'];
async function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'justup-backend-integration-')),statusPath=join(dir,'runner-status.json'),sourceCommit='a'.repeat(40),buildIdentity='synthetic-build';
  writeFileSync(statusPath,JSON.stringify({schemaVersion:1,identity:'fixture-queue',sourceCommit,buildIdentity,ready:true,updatedAt:new Date(AT).toISOString(),capabilities:{search:true,companyRequests:true,aiMatching:false}}),{mode:0o640});
  const policy={privacyUrl:ORIGIN+'/privacy.html',usageUrl:ORIGIN+'/usage.html',version:'synthetic-reviewed',reviewed:true};
  const app=await createConfiguredApplication({config:{dbPath:':memory:',servicesEnabled:true,allowedOrigin:ORIGIN,allowInsecureLocalhost:true,requiresInvitation:false,
    sourceCommit,buildIdentity,runnerStatusPath:statusPath,policiesReviewed:true,policyLocales:{en:policy},policyAssetProof:syntheticPolicyProof({origin:ORIGIN,sourceCommit,version:policy.version}),liveResults:{pollMs:10,heartbeatMs:30}},now:()=>AT});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{app.server.closeAllConnections();await app.close();rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}/api/v1`,db=app.store.db;
  const records=app.services.find(service=>typeof service.onModelMetric==='function'),reading=app.services.find(service=>typeof service.preferences==='function'),identity=app.services.find(service=>service.identity)?.identity;
  let modelCalls=0;
  const worker=createIntentService({db,feed:app.feed,tasks:app.tasks,now:()=>AT,ownerAuthority:identity.principal,visitorIdentity:identity,readingPreferences:reading,records,
    model:{interpretIntent:async()=>{modelCalls++;records.onModelMetric({kind:'search_intent',model:'gpt-6-luna',usage:{inputTokens:10,outputTokens:3}});
      return {title:'Engineering',configuration:{schemaVersion:1,filters:{...Object.fromEntries(FILTERS.map(key=>[key,null])),titleAny:['engineer']},residualAi:null},requirements:[{id:'role',text:'Engineer',handling:'primary',reason:'Title evidence.',bindings:[{field:'titleAny',values:['engineer']}],companyReference:null}]};}}});
  function client(){const jar=new Map();let csrf;
    return {snapshot:()=>({jar:[...jar],csrf}),restore:snapshot=>{jar.clear();for(const [key,value]of snapshot.jar)jar.set(key,value);csrf=snapshot.csrf;},
      async call(path,method='GET',body,headers={}){
        const response=await fetch(base+path,{method,headers:{cookie:[...jar].map(([key,value])=>`${key}=${value}`).join('; '),'X-Justup-Locale':'en',
          ...(method==='GET'?{}:{Origin:ORIGIN,'Content-Type':'application/json','X-CSRF-Token':csrf}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
        for(const cookie of response.headers.getSetCookie()){const pair=cookie.split(';')[0],index=pair.indexOf('=');jar.set(pair.slice(0,index),pair.slice(index+1));}
        const value=await response.json();if(value.csrfToken)csrf=value.csrfToken;return {status:response.status,body:value};
      },cookie:()=>[...jar].map(([key,value])=>`${key}=${value}`).join('; ')};
  }
  async function work(){const task=app.tasks.claim({workerId:'fixture',kinds:['search_intent']});assert(task);const result=await records.runTask(task,worker.runTask);if(!result.committed)app.tasks.complete(task.id,task.leaseToken,result);records.taskFinished(task);return result;}
  function load(){app.store.importSnapshot({schemaVersion:1,snapshotAt:new Date(AT).toISOString(),verifiedAt:new Date(AT).toISOString(),observations:[],unknownIds:[],jobs:[['english','en'],['french','fr']].map(([id,locale])=>({
    id,companyId:'existing',companyName:'Existing Company',companySlug:'existing',title:'Engineer',sourceUrl:`https://example.org/jobs/${id}`,active:true,reserved:false,hasContent:true,
    firstObserved:new Date(AT-3*DAY).toISOString(),lastObserved:null,locales:[locale],locations:[],employmentTypes:[],seniority:null,salary:null,bodyText:null,
    evidence:{source:'jobseek_public',metadataFetchedAt:new Date(AT).toISOString(),bodyFetchedAt:null,bodyUrl:null,bodySha256:null,textSha256:null,bodyBytes:0,normalizationVersion:1,truncated:false}}))});}
  async function stream(c,id,revision){const controller=new AbortController(),response=await fetch(`${base}/workspace/events?searchId=${id}&revision=${revision}&locale=en`,{headers:{cookie:c.cookie()},signal:controller.signal});assert.equal(response.status,200);
    const reader=response.body.getReader();let buffer='';
    return {close:()=>controller.abort(),async next(type){let timer;try{return await Promise.race([(async()=>{while(true){const end=buffer.indexOf('\n\n');if(end>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);if(frame.includes(`event: ${type}\n`))return JSON.parse(frame.split('\n').find(line=>line.startsWith('data: ')).slice(6));continue;}const chunk=await reader.read();if(chunk.done)throw Error('Stream ended before event');buffer+=new TextDecoder().decode(chunk.value);}})(),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Stream event deadline')),3000))]);}finally{clearTimeout(timer);}}};
  }
  const count=table=>db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
  const privateCounts=()=>['justup_journey_events','justup_model_executions','justup_evaluation_candidates'].map(count);
  return {app,db,records,reading,identity,policy,client,work,load,stream,count,privateCounts,modelCalls:()=>modelCalls};
}

test('composed draft, retry, sign-in, language/follow, live-policy and deletion paths preserve private evidence lifecycle',async t=>{
  const f=await fixture(t),c=f.client();f.load();await c.call('/session');
  assert.equal((await c.call('/visitor/workspace')).body.revision,0);assert.deepEqual((await c.call('/visitor/searches')).body,{items:[]});assert.equal(f.count('justup_visitors'),0);
  const raw='  Engineer  ',saved=await c.call('/visitor/workspace','PATCH',{expectedRevision:0,activeSearchId:null,drafts:{new:raw}});assert.equal(saved.status,200);assert.equal(saved.body.revision,1);assert.equal(f.modelCalls(),0);
  const prior=c.snapshot(),submission={query:raw.trim(),requestKey:'first'},created=await c.call('/visitor/searches','POST',submission),id=created.body.search.id;assert.equal(created.status,202);
  assert.deepEqual((await c.call('/visitor/workspace')).body.state,{activeSearchId:id,drafts:{[id]:raw}});
  c.restore(prior);const retry=await c.call('/visitor/searches','POST',submission);assert.equal(retry.body.task.id,created.body.task.id);assert.equal(f.count('justup_tasks'),1);assert.equal(f.count('justup_journey_events'),1);
  await f.work();assert.equal(f.modelCalls(),1);assert.equal(f.count('justup_model_executions'),1);
  assert.equal((await c.call(`/visitor/searches/${id}/results?revision=1`)).body.items.length,2);
  const before=f.count('justup_journey_events'),visitor=f.db.prepare('SELECT id FROM justup_visitors').get().id,password='Synthetic composed account password';
  const registered=await c.call('/auth/register','POST',{acceptance:{usageVersion:'synthetic-reviewed',locale:'en',adultAndCapable:true},username:'composed-account',password});assert.equal(registered.status,201);assert.equal(registered.body.visitorHandoff.status,'complete');
  assert.equal(f.db.prepare('SELECT count(*) n FROM justup_journey_events WHERE owner_id=?').get(visitor).n,0);assert.equal(f.count('justup_journey_events'),before+1);
  assert.equal((await c.call('/follows/existing','PATCH',{followed:true,expectedRevision:0})).status,200);
  const options=await c.call(`/searches/${id}/options`,'PATCH',{expectedRevision:1,followedOnly:true,postingLanguages:['fr']});assert.equal(options.status,200);assert.equal(options.body.search.revision,2);
  assert.deepEqual((await c.call(`/searches/${id}/results?revision=2`)).body.items.map(job=>job.id),['french']);assert.equal(f.modelCalls(),1);
  const events=await f.stream(c,id,2);assert.deepEqual((await events.next('snapshot')).searches[0].items.map(job=>job.id),['french']);
  f.policy.reviewed=false;assert.equal((await events.next('unavailable')).reason,'dependency_unavailable');events.close();
  const evidence=f.privateCounts();for(const path of ['/workspace','/company-requests','/companies','/companies/existing/report'])assert.equal((await c.call(path)).status,200);
  assert.deepEqual(f.privateCounts(),evidence);assert.equal((await c.call('/searches','POST',{query:'Blocked text',requestKey:'paused'})).status,503);
  assert.equal((await c.call('/account','DELETE',{password})).status,200);assert.deepEqual(f.privateCounts(),[0,0,0]);assert.equal(f.count('justup_searches'),0);
  f.policy.reviewed=true;const next=f.client();await next.call('/session');const direct=await next.call('/visitor/searches','POST',{query:'Engineer',requestKey:'reclaim'});assert.equal(direct.status,202);assert(f.count('justup_journey_events')>0);
  assert.equal((await next.call(`/visitor/searches/${direct.body.search.id}`,'DELETE',{})).status,200);
  assert.equal(f.count('justup_visitors'),0);assert.equal(f.count('justup_workspaces'),0);assert.deepEqual(f.privateCounts(),[0,0,0]);
});

test('composed known-company priority stores its access grant and measures setup revisions without inference',async t=>{
  const f=await fixture(t),a=f.client(),b=f.client();await a.call('/session');await b.call('/session');
  const account=(await a.call('/auth/register','POST',{acceptance:{usageVersion:'synthetic-reviewed',locale:'en',adultAndCapable:true},username:'priority-owner',password:'Synthetic priority account password'})).body.user;
  await b.call('/auth/register','POST',{acceptance:{usageVersion:'synthetic-reviewed',locale:'en',adultAndCapable:true},username:'other-owner',password:'Synthetic other account password'});
  let target;for(let i=0;i<25;i++)target=f.app.feed.publishCompany({name:`Company ${String(i).padStart(2,'0')}`,domain:`company${i}.example.org`,websiteUrl:`https://company${i}.example.org/`,evidenceUrls:[]});
  const path=`/account/companies/${target}/priority`;assert.equal((await a.call(path,'POST',{requestKey:'known'})).status,403);
  f.db.prepare("INSERT INTO access_subscriptions VALUES(?,?,1,'active','monthly',?,0)").run('synthetic-paid',account.id,AT+DAY);
  const priority=await a.call(path,'POST',{requestKey:'known'});assert.equal(priority.status,200);assert.equal(priority.body.request.setup.priority,'premium');assert.equal(priority.body.request.setup.state,'queued');
  assert.equal((await a.call(path,'POST',{requestKey:'known-retry'})).body.request.id,priority.body.request.id);assert.equal(f.count('justup_tasks'),0);assert.equal(f.modelCalls(),0);
  const page=await a.call('/account/companies?view=requested&q=company&limit=1');assert.deepEqual(page.body.items.map(company=>company.id),[target]);assert.equal(page.body.accountId,account.id);
  assert.deepEqual((await b.call('/account/companies?view=requested')).body.items,[]);
  await a.call('/company-requests');await a.call('/company-requests');
  const progress=createCompanyProgress({db:f.db,canonicalCompanyId:f.app.feed.canonicalCompanyId,accessForAccount:f.app.auth.accessForAccount,now:()=>AT});
  progress.update({companyId:target,expectedRevision:1,state:'in_progress',reason:'source_validation_pending'});await a.call('/company-requests');await a.call('/company-requests');
  assert.equal(f.db.prepare("SELECT count(*) n FROM justup_journey_events WHERE owner_id=? AND event='company_progress'").get(account.id).n,2);
  const publicCompany=(await a.call(`/companies/${target}`)).body;assert.equal(publicCompany.setup.state,'in_progress');for(const word of ['priority','premium','scope',account.id])assert.equal(JSON.stringify(publicCompany).includes(word),false);
  f.policy.reviewed=false;const before=f.privateCounts();await a.call('/company-requests');await a.call('/account/companies?view=requested');await a.call(`/companies/${target}/report`);assert.deepEqual(f.privateCounts(),before);
  f.policy.reviewed=true;f.db.prepare("UPDATE access_subscriptions SET status='ended',paid_through_at=NULL WHERE account_id=?").run(account.id);
  assert.equal((await a.call(path,'POST',{requestKey:'expired'})).status,403);
  assert.equal((await a.call(path,'POST',{requestKey:'known'})).body.request.id,priority.body.request.id);
  assert.equal((await a.call('/company-requests')).body.items[0].setup.priority,'premium');assert.equal(progress.pending().items[0].priority,'premium');
  assert.equal(progress.snapshot(target).state,'in_progress');assert.equal(f.count('justup_tasks'),0);assert.equal(f.modelCalls(),0);
});
