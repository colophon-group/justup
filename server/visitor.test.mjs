// API/queue contracts for ephemeral visitor searches. All models, identities and
// postings are synthetic; only localhost HTTP is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,createHash } from 'node:crypto';
import { createApplication } from './main.mjs';
import { createIntentService } from './intent.mjs';
import { createMatchingService } from './matching.mjs';
import { createVisitorIdentity,createVisitorService,visitorPrivateGeneration } from './visitor.mjs';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync,unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccessReader } from './entitlements.mjs';

const START=Date.parse('2026-10-31T12:00:00Z'),DAY=86_400_000,ORIGIN='https://preview.example.org';
const FILTERS=['companyInclude','companyExclude','titleAny','bodyAll','bodyNone','locations','workplaces','employmentTypes','postingLanguages','seniority'];
function interpretation({residual=false,filters={titleAny:['engineer']}}={}) {
  const bindings=Object.entries(filters).map(([field,values])=>({field,values}));
  return {title:'Engineering',configuration:{schemaVersion:1,filters:{...Object.fromEntries(FILTERS.map(k=>[k,null])),...filters},residualAi:residual?{condition:'A documented four day working week.',requirementIds:['ai']}:null},requirements:[{id:'role',text:Object.values(filters).flat().join(' ')||'Any job',handling:'primary',reason:'Stated criteria.',bindings,companyReference:null},...(residual?[{id:'ai',text:'A documented four day working week.',handling:'ai',reason:'Needs posting evidence.',bindings:[],companyReference:null}]:[])]};
}
async function setup(t,{model,provider,residual=false,visitor:visitorConfig,policiesReviewed=true,realAuth=false,runtime={}}={}) {
  let time=START,modelCalls=0,providerCalls=0,failNextHandoff=false;
  const accounts=new Map(['one','two'].map(id=>[id,{id,username:`test-${id}`,expiresAt:null,access:{kind:'paid',fullAccess:true,legacy:false,premium:false,billingEnabled:false,until:null}}]));
  const sessions=new Map();let identity,intent,matching,visitor;
  const config={dbPath:':memory:',sourceCommit:'a'.repeat(40),buildIdentity:'synthetic-build',allowedOrigin:ORIGIN,policiesReviewed,privacyUrl:`${ORIGIN}/privacy`,usageUrl:`${ORIGIN}/usage`,policyVersion:'test-reviewed',visitor:visitorConfig,...(realAuth?{requiresInvitation:false}:{}),...runtime};
  const app=await createApplication({now:()=>time,config,
    authFactory:realAuth?undefined:({db,deleteAccountData})=>({cleanup:()=>{},registrationState:()=>({enabled:true,reason:null}),accessForAccount:id=>accounts.get(id)?.access??null,
      session:token=>{const id=sessions.get(token),a=accounts.get(id);return a?{account:{id:a.id,username:a.username,expiresAt:null},expiresAt:time+DAY,access:a.access}:null;},
      async login(body,{afterAuthenticated}={}) {const a=accounts.get(body.username);if(!a)throw Object.assign(new Error('safe'),{code:'invalid_credentials',status:401});const token=randomBytes(32).toString('base64url');db.exec('BEGIN IMMEDIATE');try{sessions.set(token,a.id);const result={token,account:a,expiresAt:time+DAY};const visitorHandoff=afterAuthenticated?.({db,accountId:a.id,phase:'login'});if(failNextHandoff){failNextHandoff=false;throw Object.assign(new Error('safe'),{code:'dependency_unavailable',status:503});}db.exec('COMMIT');return {...result,visitorHandoff};}catch(error){db.exec('ROLLBACK');sessions.delete(token);throw error;}},
      logout:token=>sessions.delete(token),
      deleteAccount:token=>{const id=sessions.get(token);db.exec('BEGIN IMMEDIATE');try{deleteAccountData(id);accounts.delete(id);sessions.delete(token);db.exec('COMMIT');return {deleted:true};}catch(e){db.exec('ROLLBACK');throw e;}},
    }),serviceFactories:[deps=>{
      identity=createVisitorIdentity(deps);
      const ownership={ownerAuthority:identity.principal,visitorIdentity:identity,taskAdmission:identity.admitMatching};
      matching=createMatchingService({...deps,...ownership,provider:{available:()=>true,classify:async args=>{providerCalls++;return provider?provider(args):{decisions:args.jobs.map(j=>({id:j.id,decision:j.id.includes('rejected')?'rejected':'accepted'}))};}}});
      intent=createIntentService({...deps,...ownership,matching,model:{interpretIntent:async args=>{modelCalls++;return model?model(args):interpretation({residual});}}});
      visitor=createVisitorService({...deps,identity,intent,matching});return [intent,matching,visitor];
    }]});
  const rows=[['hidden-accepted',1,'Engineer'],['hidden-rejected',1.2,'Engineer'],['hidden-primary-excluded',1.5,'Designer'],['visible-accepted',3,'Engineer'],['visible-rejected',4,'Engineer']];
  app.store.importSnapshot({schemaVersion:1,snapshotAt:new Date(time).toISOString(),verifiedAt:new Date(time).toISOString(),jobs:rows.map(([id,age,title])=>{
    const bodyText=`Synthetic evidence ${id}. `+'The role provides a documented four day working week with full compensation. '.repeat(5);
    return {id,companyId:'example',companyName:'Example',companySlug:'example',title,sourceUrl:`https://example.org/careers/${id}`,active:true,reserved:false,hasContent:true,firstObserved:new Date(time-age*DAY).toISOString(),lastObserved:null,locales:['en'],locations:[{name:'Zurich, Switzerland',workplace:'onsite'}],employmentTypes:['full_time'],seniority:null,salary:null,bodyText,evidence:{source:'jobseek_public',metadataFetchedAt:new Date(time).toISOString(),bodyFetchedAt:new Date(time).toISOString(),bodyUrl:`https://example.org/careers/${id}`,bodySha256:null,textSha256:createHash('sha256').update(bodyText).digest('hex'),bodyBytes:Buffer.byteLength(bodyText),normalizationVersion:1,truncated:false,aiEligible:true}};}),observations:[],unknownIds:[]});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>{app.server.closeAllConnections();return app.close();});
  const base=`http://127.0.0.1:${app.server.address().port}/api/v1`;
  function client(){const jar=new Map();let csrf;
    async function request(path,{method='GET',body,headers={}}={}){const res=await fetch(base+path,{method,headers:{Cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; '),...(method==='GET'?{}:{Origin:ORIGIN,'X-CSRF-Token':csrf,'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});for(const item of res.headers.getSetCookie()){const pair=item.split(';')[0],i=pair.indexOf('=');jar.set(pair.slice(0,i),pair.slice(i+1));}const value=await res.json();if(value.csrfToken)csrf=value.csrfToken;return {status:res.status,body:value,res};}
    return {request,jar,snapshot:()=>({jar:[...jar],csrf}),restore:snapshot=>{jar.clear();for(const [k,v]of snapshot.jar)jar.set(k,v);csrf=snapshot.csrf;},session:()=>request('/session'),login:username=>request('/auth/login',{method:'POST',body:{username}})};
  }
  async function work(kind){const task=app.tasks.claim({workerId:'test-runner',kinds:[kind]});assert(task,`expected ${kind}`);const result=await (kind==='search_intent'?intent:matching).runTask(task);if(!result.committed)app.tasks.complete(task.id,task.leaseToken,result);return result;}
  async function create(c,key='create',query='Engineer'){const reply=await c.request('/visitor/searches',{method:'POST',body:{query,requestKey:key}});assert.equal(reply.status,202,JSON.stringify(reply.body));await work('search_intent');return reply.body.search.id;}
  const results=(c,id,suffix='')=>c.request(`/visitor/searches/${id}/results?revision=1${suffix}`);
  return {app,config,client,work,create,results,time:()=>time,identity,intent,matching,visitor,accounts,sessions,advance:ms=>time+=ms,modelCalls:()=>modelCalls,providerCalls:()=>providerCalls,failHandoff:()=>failNextHandoff=true};
}

test('visitor submits, edits and retries its own search with filtered exact hidden count',async t=>{
  const s=await setup(t),a=s.client(),b=s.client();const session=await a.session();await b.session();
  assert.equal(session.body.user,null);assert.equal(session.body.access.fullAccess,false);assert.equal(session.body.capabilities.visitorSearch,true);assert.equal(session.body.visitor,null);assert.equal(a.jar.has('__Host-justup_visitor'),false);
  const id=await s.create(a),current=await a.session(),token=a.jar.get('__Host-justup_visitor');assert(token);assert(!JSON.stringify(current.body).includes(token));assert.deepEqual(Object.keys(current.body.visitor),['expiresAt']);
  const page=await s.results(a,id);assert.deepEqual(page.body.items.map(j=>j.id),['visible-accepted','visible-rejected']);assert.deepEqual(page.body.hiddenMatches,{status:'exact',count:2});
  assert.equal(JSON.stringify(page.body).includes('hidden-'),false);assert.equal(page.res.headers.get('x-robots-tag'),'noindex');
  const retry=await a.request('/visitor/searches',{method:'POST',body:{query:'Engineer',requestKey:'create'}});assert.equal(retry.status,202);assert.equal(s.modelCalls(),1);
  await s.create(b,'other-owner');assert.equal((await b.request(`/visitor/searches/${id}/results?revision=1`)).status,404);assert.equal((await a.request('/searches')).status,401);
  const edit=await a.request(`/visitor/searches/${id}`,{method:'PATCH',body:{query:'Engineer refined',requestKey:'edit',expectedRevision:1}});assert.equal(edit.status,202);await s.work('search_intent');assert.equal((await a.request('/visitor/searches')).body.items[0].revision,2);
});

test('visitor policy, Origin, CSRF, bounded admission and lifetime submission controls run before models',async t=>{
  const s=await setup(t,{visitor:{maxVisitors:1,maxSubmissions:1}}),a=s.client();const first=await a.session();
  const invalid=await a.request('/visitor/searches',{method:'POST',body:{query:'Engineer',requestKey:'bad'},headers:{Origin:'https://elsewhere.example'}});assert.equal(invalid.status,403);
  const csrf=await a.request('/visitor/searches',{method:'POST',body:{query:'Engineer',requestKey:'bad'},headers:{'X-CSRF-Token':'x'.repeat(43)}});assert.equal(csrf.status,403);
  await s.create(a);assert.equal((await a.request('/visitor/searches',{method:'POST',body:{query:'Engineer',requestKey:'another'}})).status,429);
  const b=s.client();assert.equal((await b.session()).status,200);assert.equal((await b.request('/visitor/searches',{method:'POST',body:{query:'Engineer',requestKey:'first'}})).status,429);assert.equal(s.modelCalls(),1);assert.equal(first.body.user,null);
  const closed=await setup(t,{policiesReviewed:false}),c=closed.client();const session=await c.session();assert.equal(session.body.capabilities.visitorSearch,false);assert.equal(session.body.visitor,null);assert.equal((await c.request('/visitor/searches',{method:'POST',body:{query:'Engineer',requestKey:'first'}})).status,503);assert.equal(closed.modelCalls(),0);
});

test('residual hidden counts wait for confirmed decisions and never include restricted DTOs',async t=>{
  const s=await setup(t,{residual:true}),c=s.client();await c.session();const id=await s.create(c);const initial=await s.results(c,id);
  assert.deepEqual(initial.body.items,[]);assert.deepEqual(initial.body.hiddenMatches,{status:'pending',count:null});assert.equal(initial.body.continuation.state,'pending');
  await s.work('ai_match');const visible=await s.results(c,id);assert.deepEqual(visible.body.items.map(j=>j.id),['visible-accepted']);assert.equal(visible.body.hiddenMatches.status,'pending');
  await s.work('ai_match');const complete=await s.results(c,id);assert.deepEqual(complete.body.hiddenMatches,{status:'exact',count:1});assert.equal(JSON.stringify(complete.body).includes('hidden-'),false);assert.equal(s.providerCalls(),2);
});

test('invalid interpretation preserves prior search and stale evidence differs from a fresh zero',async t=>{
  let broken=false;const s=await setup(t,{visitor:{ttlMs:2*DAY},model:()=>broken?{}:interpretation({filters:{titleAny:['none']}})}),c=s.client();await c.session();const id=await s.create(c);
  const zero=await s.results(c,id);assert.equal(zero.body.continuation.state,'exhausted');assert.deepEqual(zero.body.hiddenMatches,{status:'exact',count:0});broken=true;
  await c.request(`/visitor/searches/${id}`,{method:'PATCH',body:{query:'Changed query',requestKey:'broken',expectedRevision:1}});await s.work('search_intent');const list=await c.request('/visitor/searches');assert.equal(list.body.items[0].revision,1);assert.equal(list.body.items[0].draft.query,'Changed query');
  s.advance(DAY);const stale=await s.results(c,id);assert.equal(stale.body.continuation.state,'paused');assert.deepEqual(stale.body.hiddenMatches,{status:'unavailable',count:null});
});

test('verified sign-in appends searches and transfers draft and viewed state idempotently',async t=>{
  const s=await setup(t),account=s.client();await account.session();await account.login('one');
  const existing=await account.request('/searches',{method:'POST',body:{query:'Existing account search',requestKey:'account-search'}});assert.equal(existing.status,202);await s.work('search_intent');
  const c=s.client();await c.session();const id=await s.create(c);const visitorToken=c.jar.get('__Host-justup_visitor');
  await c.request('/visitor/workspace',{method:'PATCH',body:{expectedRevision:0,activeSearchId:id,drafts:{[id]:'Unsent refinement',new:'New draft'}}});await c.request('/visitor/viewed',{method:'POST',body:{jobId:'visible-accepted'}});
  const before=s.modelCalls(),login=await c.login('one');assert.equal(login.status,200);assert.equal(login.body.visitorHandoff.status,'complete');assert.equal(c.jar.get('__Host-justup_visitor'),'');assert.equal(s.modelCalls(),before);
  const list=await c.request('/searches');assert.equal(list.body.items.length,2);assert.equal(list.body.items.find(j=>j.id===id).configuration.schemaVersion,1);
  const workspace=await c.request('/workspace');assert.equal(workspace.body.state.drafts[id],'Unsent refinement');assert.equal(workspace.body.viewed[0].jobId,'visible-accepted');
  assert.deepEqual(s.app.withPrivateTransaction(()=>s.visitor.handoff(visitorToken,{db:s.app.store.db,accountId:'one'})),{status:'complete'});assert.deepEqual(s.app.withPrivateTransaction(()=>s.visitor.handoff(visitorToken,{db:s.app.store.db,accountId:'two'})),{status:'none'});
  assert.equal(s.identity.fromToken(visitorToken),null);await c.request('/session/logout',{method:'POST',body:{}});assert.equal((await c.session()).body.visitor,null);assert.equal((await c.request('/visitor/searches')).status,401);assert.equal((await c.request('/visitor/workspace')).status,401);
});

test('sign-in cancels pending anonymous inference and a late reply cannot recreate or change state',async t=>{
  let release;const s=await setup(t,{model:()=>new Promise(resolve=>{release=resolve;})}),c=s.client();await c.session();
  const submitted=await c.request('/visitor/searches',{method:'POST',body:{query:'Engineer',requestKey:'pending'}});const work=s.work('search_intent');await Promise.resolve();
  await c.login('one');release(interpretation());await work;
  const searches=(await c.request('/searches')).body.items;assert.equal(searches.length,1);assert.equal(searches[0].revision,0);assert.equal(searches[0].draft.query,'Engineer');assert.equal(searches[0].draft.taskId,null);
  assert.equal(s.app.store.db.prepare('SELECT count(*) n FROM demo_tasks WHERE owner_id LIKE ?').get('visitor:%').n,0);assert.equal(submitted.status,202);
});

test('temporary deletion and expiry invalidate old cookies and late queued work',async t=>{
  const s=await setup(t),c=s.client();await c.session();const id=await s.create(c),token=c.jar.get('__Host-justup_visitor');
  assert.equal((await c.request('/visitor/session',{method:'DELETE',body:{}})).status,200);assert.equal(s.identity.fromToken(token),null);assert.equal(s.app.store.db.prepare('SELECT 1 FROM demo_searches WHERE id=?').get(id),undefined);
  await c.session();await s.create(c,'second');s.advance(DAY+1);assert.equal((await c.request('/visitor/searches')).status,401);await c.session();assert.equal(s.app.store.db.prepare('SELECT count(*) n FROM demo_searches').get().n,0);
});

test('paid queued matching uses current full access and discards a downgrade during provider wait',async t=>{
  let release,seen;const s=await setup(t,{residual:true,provider:args=>{seen=args.jobs.map(j=>j.id);return new Promise(resolve=>release=()=>resolve({decisions:args.jobs.map(j=>({id:j.id,decision:'accepted'}))}));}}),c=s.client();await c.session();await c.login('one');
  const created=await c.request('/searches',{method:'POST',body:{query:'Engineer four day week',requestKey:'paid'}});await s.work('search_intent');const id=created.body.search.id,path=`/searches/${id}/results?revision=1`;
  const pending=await c.request(path);const work=s.work('ai_match');await Promise.resolve();assert(seen.includes('hidden-accepted'),'the live paid authority includes latest candidates');
  s.accounts.get('one').access={...s.accounts.get('one').access,kind:'expired',fullAccess:false};release();const discarded=await work;assert.equal(discarded.committed,undefined);assert.equal(s.app.store.db.prepare("SELECT count(*) n FROM demo_match_jobs WHERE decision='accepted'").get().n,0);
  assert.equal((await c.request(`${path}&cursor=${pending.body.continuation.cursor}`)).status,409);const downgraded=await c.request(path);assert.equal(downgraded.body.items.length,0);assert.equal(JSON.stringify(downgraded.body).includes('hidden-accepted'),false);
});

test('workspace CAS preserves concurrent edits and durable sign-in draft recovery survives a lost response',async t=>{
  const s=await setup(t),account=s.client();await account.session();await account.login('one');
  let accountWorkspace=(await account.request('/workspace')).body;
  await account.request('/workspace',{method:'PATCH',body:{expectedRevision:accountWorkspace.revision,activeSearchId:null,drafts:{new:'Member draft'}}});
  const c=s.client();await c.session();await s.create(c);await c.request('/visitor/workspace',{method:'PATCH',body:{expectedRevision:0,activeSearchId:null,drafts:{new:'Visitor draft'}}});
  const stale=await c.request('/visitor/workspace',{method:'PATCH',body:{expectedRevision:0,activeSearchId:null,drafts:{new:'Stale tab draft'}}});assert.equal(stale.status,409);
  const beforeResponse=c.snapshot();const login=await c.login('one');assert.equal(login.status,200);assert(login.body.visitorHandoff.recoveredDraftId);assert(!Object.hasOwn(login.body.visitorHandoff,'draft'));
  // Simulate losing the entire credential response: the browser still holds its
  // previous cookies and CSRF value when it repeats the verified login.
  c.restore(beforeResponse);const retry=await c.login('one');assert.equal(retry.status,200);assert.equal(retry.body.visitorHandoff.status,'complete');
  accountWorkspace=(await c.request('/workspace')).body;assert.equal(accountWorkspace.state.drafts.new,'Member draft');assert.deepEqual(accountWorkspace.recoveredDrafts.map(d=>d.text),['Visitor draft']);
  const saved=await c.request('/workspace',{method:'PATCH',body:{expectedRevision:accountWorkspace.revision,activeSearchId:null,drafts:{new:'Member autosave'}}});assert.equal(saved.body.recoveredDrafts.length,1);
  const recovered=saved.body.recoveredDrafts[0],used=await c.request(`/workspace/recovered-drafts/${recovered.id}`,{method:'POST',body:{expectedRevision:saved.body.revision,action:'use'}});assert.equal(used.status,200);assert.equal(used.body.state.drafts.new,'Visitor draft');assert.equal(used.body.recoveredDrafts[0].text,'Member autosave');
  const other=s.client();await other.session();await other.login('two');const otherRevision=(await other.request('/workspace')).body.revision;assert.equal((await other.request(`/workspace/recovered-drafts/${recovered.id}`,{method:'POST',body:{expectedRevision:otherRevision,action:'discard'}})).status,404);
  const discarded=await c.request(`/workspace/recovered-drafts/${recovered.id}`,{method:'POST',body:{expectedRevision:used.body.revision,action:'discard'}});assert.equal(discarded.body.recoveredDrafts.length,0);
});

test('a handoff failure rolls back visitor movement, task cancellation, workspace and session insertion',async t=>{
  const s=await setup(t),c=s.client();await c.session();const id=await s.create(c),token=c.jar.get('__Host-justup_visitor');
  await c.request('/visitor/workspace',{method:'PATCH',body:{expectedRevision:0,activeSearchId:id,drafts:{[id]:'Unsent'}}});s.failHandoff();const failed=await c.login('one');assert.equal(failed.status,503);assert.equal(s.sessions.size,0);assert(s.identity.fromToken(token));
  assert.equal(s.app.store.db.prepare('SELECT owner_id FROM demo_searches WHERE id=?').get(id).owner_id,s.identity.fromToken(token).visitor.id);
  assert.equal((await c.request('/visitor/workspace')).body.state.drafts[id],'Unsent');assert.equal((await c.login('one')).status,200);assert.equal((await c.request('/searches')).body.items[0].id,id);
});

test('insufficient or unavailable hidden classification never claims a final count',async t=>{
  const s=await setup(t,{residual:true,provider:async({jobs})=>({decisions:jobs.map(j=>({id:j.id,decision:j.id.startsWith('hidden')?'insufficient_evidence':'accepted'}))})}),c=s.client();await c.session();const id=await s.create(c);await s.results(c,id);await s.work('ai_match');await s.results(c,id);await s.work('ai_match');const partial=await s.results(c,id);assert.deepEqual(partial.body.hiddenMatches,{status:'lower_bound',count:0});assert(!JSON.stringify(partial.body).includes('hidden-'));
  const failed=await setup(t,{residual:true,provider:async()=>{throw new Error('private synthetic failure');}}),b=failed.client();await b.session();const other=await failed.create(b);await failed.results(b,other);await failed.work('ai_match');const paused=await failed.results(b,other);assert.equal(paused.body.continuation.state,'paused');assert.equal(paused.body.hiddenMatches.status,'pending');assert.equal(JSON.stringify(paused.body).includes('private synthetic failure'),false);
});

test('real password registration commits the visitor search and private draft in its auth transaction',async t=>{
  const s=await setup(t,{realAuth:true}),c=s.client();await c.session();const id=await s.create(c);await c.request('/visitor/workspace',{method:'PATCH',body:{expectedRevision:0,activeSearchId:id,drafts:{[id]:'Keep this unsent draft'}}});
  const result=await c.request('/auth/register',{method:'POST',body:{username:'visitor-handoff',password:randomBytes(24).toString('base64url')}});assert.equal(result.status,201);assert.equal(result.body.visitorHandoff.status,'complete');assert.equal(result.body.access.fullAccess,false);assert.equal(result.body.user.expiresAt,null);
  const searches=await c.request('/searches');assert.equal(searches.body.items[0].id,id);assert.equal((await c.request('/workspace')).body.state.drafts[id],'Keep this unsent draft');
  const page=await c.request(`/searches/${id}/results?revision=1`);assert.deepEqual(page.body.items.map(j=>j.id),['visible-accepted','visible-rejected']);assert.deepEqual(page.body.hiddenMatches,{status:'exact',count:2});
  assert.equal((await c.request('/access/activate',{method:'POST',body:{}})).status,403);assert.equal(s.modelCalls(),1);
});

test('the independent queue reader honors persisted paid and free periods and rechecks expiry after inference',async t=>{
  for(const kind of ['paid','free'])await t.test(kind,async t=>{
    const s=await setup(t,{realAuth:true,residual:true}),c=s.client();await c.session();const registration=await c.request('/auth/register',{method:'POST',body:{username:`current-${kind}`,password:randomBytes(24).toString('base64url')}});assert.equal(registration.status,201);const owner=registration.body.user.id,db=s.app.store.db;
    if(kind==='paid')db.prepare('INSERT INTO access_subscriptions (subscription_hash,account_id,state_version,status,plan,paid_through_at,reconcile_pending) VALUES(?,?,?,?,?,?,?)').run('synthetic-subscription',owner,START,'active','weekly',START+1000,0);
    else db.prepare('INSERT INTO access_free_periods VALUES(?,?,?,?)').run(owner,'standard',START,START+1000);
    const created=await c.request('/searches',{method:'POST',body:{query:'Engineer four day week',requestKey:'persisted'}});await s.work('search_intent');const path=`/searches/${created.body.search.id}/results?revision=1`;const initial=await c.request(path);assert.equal(initial.status,200);
    await c.request('/viewed',{method:'POST',body:{jobId:'hidden-accepted'}});assert((await c.request('/workspace')).body.viewed.some(j=>j.jobId==='hidden-accepted'));
    const queueIdentity=createVisitorIdentity({db,now:s.time,config:s.config,accessForAccount:createAccessReader({db,now:s.time})});let release,selected;
    const queue=createMatchingService({db,feed:s.app.feed,tasks:s.app.tasks,now:s.time,ownerAuthority:queueIdentity.principal,taskAdmission:queueIdentity.admitMatching,provider:{available:()=>true,classify:args=>{selected=args.jobs.map(j=>j.id);return new Promise(resolve=>release=()=>resolve({decisions:args.jobs.map(j=>({id:j.id,decision:'accepted'}))}));}}});
    const task=s.app.tasks.claim({workerId:'independent-queue',kinds:['ai_match']}),work=queue.runTask(task);await Promise.resolve();assert(selected.includes('hidden-accepted'));
    s.advance(1001);release();const result=await work;assert.equal(result.committed,undefined);assert.equal(db.prepare("SELECT count(*) n FROM demo_match_jobs WHERE decision='accepted'").get().n,0);assert.equal((await c.request(`${path}&cursor=${initial.body.continuation.cursor}`)).status,409);
    assert.equal((await c.request('/workspace')).body.viewed.some(j=>j.jobId==='hidden-accepted'),false);
  });
});

test('verified handoff preserves confirmed visible and hidden classifier decisions without repeating inference',async t=>{
  const s=await setup(t,{residual:true}),c=s.client();await c.session();const id=await s.create(c);await s.results(c,id);await s.work('ai_match');await s.results(c,id);await s.work('ai_match');assert.deepEqual((await s.results(c,id)).body.hiddenMatches,{status:'exact',count:1});
  const calls=s.providerCalls();assert.equal((await c.login('one')).status,200);const page=await c.request(`/searches/${id}/results?revision=1`);assert.equal(page.status,200);assert.deepEqual(page.body.items.map(j=>j.id),['hidden-accepted','visible-accepted']);assert.deepEqual(page.body.hiddenMatches,{status:'exact',count:0});assert.equal(s.providerCalls(),calls);assert.equal(s.app.tasks.claim({workerId:'no-extra-inference',kinds:['ai_match']}),null);
});

test('merged Unicode drafts round-trip through the workspace-only bounded body allowance',async t=>{
  const s=await setup(t),c=s.client();await c.session();const id=await s.create(c),draft='界'.repeat(4000);const saved=await c.request('/visitor/workspace',{method:'PATCH',body:{expectedRevision:0,activeSearchId:id,drafts:{[id]:draft,new:draft}}});assert.equal(saved.status,200);assert(Buffer.byteLength(JSON.stringify(saved.body.state))>16_384);
  assert.equal((await c.login('one')).status,200);const moved=(await c.request('/workspace')).body;const again=await c.request('/workspace',{method:'PATCH',body:{expectedRevision:moved.revision,...moved.state}});assert.equal(again.status,200);assert.equal(again.body.state.drafts[id],draft);
});

test('a full recovery stash rejects the whole handoff and preserves both owners drafts',async t=>{
  const s=await setup(t),member=s.client();await member.session();await member.login('one');const state=(await member.request('/workspace')).body;await member.request('/workspace',{method:'PATCH',body:{expectedRevision:state.revision,activeSearchId:null,drafts:{new:'Member draft'}}});
  for(let i=0;i<100;i++)s.app.store.db.prepare('INSERT INTO justup_recovered_drafts VALUES(?,?,?,?)').run(`recovered-${i}`,'one',`Retained ${i}`,START);
  const c=s.client();await c.session();await s.create(c);await c.request('/visitor/workspace',{method:'PATCH',body:{expectedRevision:0,activeSearchId:null,drafts:{new:'Visitor draft'}}});const reply=await c.login('one');assert.equal(reply.status,429);assert.equal(reply.body.error.code,'task_limit');assert.equal(s.sessions.size,1);
  assert.equal((await c.request('/visitor/workspace')).body.state.drafts.new,'Visitor draft');const still=(await member.request('/workspace')).body;assert.equal(still.state.drafts.new,'Member draft');assert.equal(still.recoveredDrafts.length,100);
});

test('discarding more than the durable visitor cap worth of session cookies allocates nothing and a protected first search still works',async t=>{
  const s=await setup(t,{runtime:{rateLimits:{read:1000}}});
  for(let i=0;i<205;i++){const read=await s.client().session();assert.equal(read.status,200);assert.equal(read.body.visitor,null);assert.equal(read.res.headers.getSetCookie().some(c=>c.startsWith('__Host-justup_visitor=')),false);}
  assert.equal(s.app.store.db.prepare('SELECT count(*) n FROM justup_visitors').get().n,0);
  const c=s.client();await c.session();
  for(const [headers,body] of [[{Origin:'https://elsewhere.example'},{query:'Engineer',requestKey:'invalid'}],[{'X-CSRF-Token':'x'.repeat(43)},{query:'Engineer',requestKey:'invalid'}],[{},{query:'',requestKey:'invalid'}]]){assert.notEqual((await c.request('/visitor/searches',{method:'POST',body,headers})).status,202);assert.equal(s.app.store.db.prepare('SELECT count(*) n FROM justup_visitors').get().n,0);}
  const created=await c.request('/visitor/searches',{method:'POST',body:{query:'Engineer',requestKey:'first'}});assert.equal(created.status,202);assert.equal(s.app.store.db.prepare('SELECT count(*) n FROM justup_visitors').get().n,1);
  const cookie=created.res.headers.getSetCookie().find(c=>c.startsWith('__Host-justup_visitor='));for(const flag of ['HttpOnly','Secure','SameSite=Lax','Path=/'])assert(cookie.includes(flag));
});

test('current policy closure revokes existing visitor reads, query writes and queued interpretation/classification while cleanup stays available',async t=>{
  const s=await setup(t,{residual:true}),c=s.client();await c.session();const id=await s.create(c);await s.results(c,id);
  const pending=await c.request(`/visitor/searches/${id}`,{method:'PATCH',body:{query:'Persisted pending edit',requestKey:'pending-edit',expectedRevision:1}});assert.equal(pending.status,202);
  const before=s.app.store.db.prepare('SELECT count(*) n FROM demo_tasks').get().n,modelCalls=s.modelCalls(),providerCalls=s.providerCalls();
  s.config.policiesReviewed=false;s.identity.refreshAvailability();
  assert.equal((await s.results(c,id)).status,503);
  assert.notEqual((await c.request(`/visitor/searches/${id}`,{method:'PATCH',body:{query:'Must not persist',requestKey:'denied',expectedRevision:1}})).status,202);
  assert.equal(s.app.store.db.prepare('SELECT count(*) n FROM demo_tasks').get().n,before);assert.equal(JSON.parse(s.app.store.db.prepare('SELECT draft_json FROM demo_searches WHERE id=?').get(id).draft_json).query,'Persisted pending edit');
  await s.work('search_intent');await s.work('ai_match');assert.equal(s.modelCalls(),modelCalls);assert.equal(s.providerCalls(),providerCalls);
  assert.equal((await c.request('/visitor/session',{method:'DELETE',body:{}})).status,200);assert.equal(s.app.store.db.prepare('SELECT count(*) n FROM justup_visitors').get().n,0);
});

test('restart with unreviewed policy revokes persisted visitor processing before the new API exposes routes',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'justup-visitor-policy-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const backupDir=join(dir,'backups'),generationPath=join(dir,'private-generation');mkdirSync(backupDir);writeFileSync(generationPath,'00000000-0000-4000-8000-000000000000\n');
  const runtime={dbPath:join(dir,'state.sqlite'),privateGenerationPath:generationPath,backupDir},old=await setup(t,{runtime}),c=old.client();await c.session();const submitted=await c.request('/visitor/searches',{method:'POST',body:{query:'Engineer',requestKey:'queued'}}),token=c.jar.get('__Host-justup_visitor');assert.equal(submitted.status,202);
  // A second API instance is the restart proof writer; its database is real and
  // already contains the queued visitor request and the prior enabled proof.
  const next=await setup(t,{runtime,policiesReviewed:false});assert.equal(next.identity.fromToken(token),null);
  const queueIdentity=createVisitorIdentity({db:next.app.store.db,config:next.config,now:next.time});assert.equal(queueIdentity.principal(old.app.store.db.prepare('SELECT owner_id FROM demo_searches').get().owner_id),null);
  await next.work('search_intent');assert.equal(next.modelCalls(),0);
});

test('a live private pending marker stops visitor writes and independent queued work, and proof expiry or wrong build fails closed',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'justup-visitor-barrier-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const backupDir=join(dir,'backups'),generationPath=join(dir,'private-generation');mkdirSync(backupDir);writeFileSync(generationPath,'00000000-0000-4000-8000-000000000000\n');
  const s=await setup(t,{runtime:{dbPath:join(dir,'state.sqlite'),privateGenerationPath:generationPath,backupDir},residual:true}),c=s.client();await c.session();const id=await s.create(c);await s.results(c,id);
  const owner=s.app.store.db.prepare('SELECT owner_id FROM demo_searches WHERE id=?').get(id).owner_id,queue=createVisitorIdentity({db:s.app.store.db,config:s.config,now:s.time});assert(queue.principal(owner));
  assert.equal(createVisitorIdentity({db:s.app.store.db,config:{...s.config,buildIdentity:'other-build'},now:s.time}).principal(owner),null);
  const previous=s.app.store.db.prepare('SELECT checked_at FROM justup_visitor_admission').get().checked_at;
  await c.session();await c.session();assert.equal(s.app.store.db.prepare('SELECT checked_at FROM justup_visitor_admission').get().checked_at,previous);
  writeFileSync(generationPath+'.pending','retained');assert.equal(visitorPrivateGeneration(s.config),null);assert.equal(queue.principal(owner),null);
  const before=s.app.store.db.prepare('SELECT draft_json FROM demo_searches WHERE id=?').get(id).draft_json,count=s.app.store.db.prepare('SELECT count(*) n FROM demo_tasks').get().n;
  for(const method of ['POST','PATCH']){const path=method==='POST'?'/visitor/searches':`/visitor/searches/${id}`,body={query:'Private text must not persist',requestKey:method,...(method==='PATCH'?{expectedRevision:1}:{})};assert.equal((await c.request(path,{method,body})).status,503);}
  assert.equal((await s.results(c,id)).status,503);assert.equal(s.app.store.db.prepare('SELECT draft_json FROM demo_searches WHERE id=?').get(id).draft_json,before);assert.equal(s.app.store.db.prepare('SELECT count(*) n FROM demo_tasks').get().n,count);await s.work('ai_match');assert.equal(s.providerCalls(),0);
  unlinkSync(generationPath+'.pending');s.advance(90_001);assert.equal(queue.principal(owner),null);s.identity.refreshAvailability();assert(queue.principal(owner));
  s.config.policiesReviewed=false;s.identity.refreshAvailability();assert.equal((await c.request('/visitor/session',{method:'DELETE',body:{}})).status,200);
});
