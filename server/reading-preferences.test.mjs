// SQLite integration contracts for account follows, language preferences and
// pre-inference search options. No native model, provider or external requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { openStore,DAY_MS } from './store.mjs';
import { createFeed } from './feed.mjs';
import { createTasks } from './tasks.mjs';
import { createIntentService,intentModelInput,primaryMatches } from './intent.mjs';
import { createMatchingService } from './matching.mjs';
import { createCompanyService } from './companies.mjs';
import { createApplication,prepareRestoredDatabase } from './main.mjs';
import { createReadingPreferencesService,resolveInterfaceLocale,applySearchOptions } from './reading-preferences.mjs';
import { createVisitorIdentity,createVisitorService } from './visitor.mjs';

const AT=Date.parse('2026-11-01T12:00:00Z'),iso=n=>new Date(n).toISOString();
const FIELDS=['companyInclude','companyExclude','titleAny','bodyAll','bodyNone','locations','workplaces','employmentTypes','postingLanguages','seniority'];
function modelOutput({filters={},ai=false}={}) {
  const bindings=Object.entries(filters).map(([field,values])=>({field,values}));
  return {title:'Chosen work',configuration:{schemaVersion:1,filters:{...Object.fromEntries(FIELDS.map(k=>[k,null])),...filters},residualAi:ai?{condition:'A documented four day week.',requirementIds:['ai']}:null},requirements:[...(bindings.length?[{id:'primary',text:Object.values(filters).flat().join(' '),handling:'primary',reason:'Applied.',bindings,companyReference:null}]:[]),...(ai?[{id:'ai',text:'Four day week',handling:'ai',reason:'Needs evidence.',bindings:[],companyReference:null}]:[]),...(!bindings.length&&!ai?[{id:'any',text:'Any work',handling:'preference',reason:'No required restriction.',bindings:[],companyReference:null}]:[])]};
}
function snapshot(rows) {
  return {schemaVersion:1,snapshotAt:iso(AT),verifiedAt:iso(AT),observations:[],unknownIds:[],jobs:rows.map(([id,companyId,locales],i)=>{
    const bodyText=`Role ${id}. `+'We offer a documented four day working week with regular office hours and a predictable schedule. '.repeat(4),sha=createHash('sha256').update(bodyText).digest('hex');
    return {id,companyId,companyName:companyId==='alpha'?'Alpha':'Beta',companySlug:companyId,title:'Engineer',sourceUrl:`https://example.org/jobs/${id}`,active:true,reserved:false,hasContent:true,firstObserved:iso(AT-3*DAY_MS-i*60_000),lastObserved:null,locales,locations:[],employmentTypes:[],seniority:null,salary:null,bodyText,evidence:{source:'jobseek_public',metadataFetchedAt:iso(AT),bodyFetchedAt:iso(AT),bodyUrl:`https://example.org/jobs/${id}`,bodySha256:sha,textSha256:sha,bodyBytes:Buffer.byteLength(bodyText),normalizationVersion:1,truncated:false}};
  })};
}
function fixture(t,{rows=[['a-en','alpha',['en']],['a-fr','alpha',['fr']],['a-unknown','alpha',[]],['b-en','beta',['en']]],model,provider,path=':memory:'}={}) {
  const store=openStore(path);t.after(()=>store.close());store.importSnapshot(snapshot(rows));
  const db=store.db,feed=createFeed({db,now:()=>AT}),tasks=createTasks({db,now:()=>AT}),owners=new Set(['alice','bob']);
  const ownerAuthority=id=>owners.has(id)?{account:{id},access:{fullAccess:true,kind:'account'}}:null;
  const reading=createReadingPreferencesService({db,feed,ownerAuthority,now:()=>AT});
  const matching=createMatchingService({db,feed,tasks,ownerAuthority,readingPreferences:reading,now:()=>AT,provider:provider??{available:()=>true,classify:async({jobs})=>({decisions:jobs.map(j=>({id:j.id,decision:'accepted'}))})}});
  let interpretations=0;
  const intent=createIntentService({db,feed,tasks,ownerAuthority,readingPreferences:reading,matching,now:()=>AT,model:{interpretIntent:input=>{interpretations++;return model?model(input):modelOutput();}},beforePrivateDelete:()=>{}});
  const companies=createCompanyService({db,feed,tasks,readingPreferences:reading,now:()=>AT,model:{resolveCompany:async()=>({data:{status:'candidate',candidate:{name:'New Company',domain:'newcompany.com',websiteUrl:'https://newcompany.com/',evidenceUrls:['https://newcompany.com/about']},clarification:null},evidenceVerified:true})}});
  const ctx=(method,path,body,owner='alice')=>({method,path:path.split('?')[0],url:new URL(`https://preview.example/api/v1${path}`),body,accountId:owner,viewer:ownerAuthority(owner)});
  const route=(method,path,body,owner)=>intent.route(ctx(method,path,body,owner));
  const follow=(companyId,followed,expectedRevision,owner)=>reading.route(ctx('PATCH',`/follows/${companyId}`,{followed,expectedRevision},owner)).body;
  async function run(kind='search_intent') {const task=tasks.claim({workerId:'test-runner',kinds:[kind]});assert(task);const result=await (kind==='search_intent'?intent:kind==='ai_match'?matching:companies).runTask(task);if(!result.committed)tasks.complete(task.id,task.leaseToken,result);return {task,result};}
  async function create(options) {const response=await route('POST','/searches',{query:'Engineer work',requestKey:`create-${interpretations}-${db.prepare('SELECT count(*) n FROM demo_searches').get().n}`,...(options?{options}:{})});await run();return (await route('GET','/searches')).body.items.find(s=>s.id===response.body.search.id);}
  return {store,db,feed,tasks,reading,matching,intent,companies,ctx,route,follow,run,create,owners,interpretations:()=>interpretations};
}

test('follows use canonical IDs, isolate owners and preserve explicit unfollow under retries and stale CAS',t=>{
  const f=fixture(t);
  assert.throws(()=>f.follow('missing',true,0),{status:404});
  assert.throws(()=>f.reading.route({...f.ctx('GET','/follows'),accountId:'bob'}),{status:401});
  assert.equal(f.follow('alpha',true,0).revision,1);
  assert.equal(f.follow('alpha',true,0).revision,1); // exact retry has one effect.
  assert.deepEqual(f.reading.follows('bob').items,[]);
  assert.equal(f.follow('alpha',false,1).revision,2);
  assert.throws(()=>f.follow('alpha',true,1),{status:409});
  assert.deepEqual(f.reading.followAcceptedCompany('alice','alpha').items,[]);
  f.owners.delete('alice');assert.throws(()=>f.follow('beta',true,2),{status:401});
  assert.deepEqual(f.reading.follows('alice').items,[]);
});

test('ordered browser matching and explicit interface overrides are independent of posting languages',t=>{
  const f=fixture(t);
  assert.equal(resolveInterfaceLocale(['xx','de-CH','fr-CH']),'de');
  assert.equal(resolveInterfaceLocale(['ja-JP','zh-Hans']),'en');
  const initial=f.reading.route(f.ctx('GET','/preferences?languages=ja-JP,fr-CH,de')).body;
  assert.equal(initial.interfaceLocale,null);assert.equal(initial.resolvedInterfaceLocale,'fr');
  assert.deepEqual(initial.supportedInterfaceLocales,['en','de','fr','it','es']);
  const updated=f.reading.route(f.ctx('PATCH','/preferences',{expectedRevision:0,interfaceLocale:'it'})).body;
  assert.equal(updated.revision,1);assert.equal(updated.resolvedInterfaceLocale,'it');
  assert.equal(f.reading.route(f.ctx('PATCH','/preferences',{expectedRevision:0,interfaceLocale:'it'})).body.revision,1);
  assert.throws(()=>f.reading.route(f.ctx('PATCH','/preferences',{expectedRevision:0,interfaceLocale:'de'})),{status:409});
  assert.throws(()=>f.reading.route(f.ctx('PATCH','/preferences',{expectedRevision:1,interfaceLocale:'ja'})),{status:400});
  assert.equal(f.reading.preferences('bob').interfaceLocale,null);
  assert.equal(f.reading.route(f.ctx('PATCH','/preferences',{expectedRevision:1,interfaceLocale:null})).body.resolvedInterfaceLocale,'en');
});

test('language OR sets and followed-only intersect text filters before residual AI, excluding unknown evidence',async t=>{
  let input,classified=[];
  const f=fixture(t,{model:data=>{input=data;return modelOutput({ai:true});},provider:{available:()=>true,classify:async({jobs})=>{classified.push(...jobs.map(j=>j.id));return {decisions:jobs.map(j=>({id:j.id,decision:'accepted'}))};}}});
  f.follow('alpha',true,0);
  const search=await f.create({followedOnly:true,postingLanguages:['fr','en']});
  assert.equal(input.explicitSearchOptions.followedOnly,true);assert.deepEqual(input.explicitSearchOptions.postingLanguages,['en','fr']);
  const first=(await f.route('GET',`/searches/${search.id}/results?revision=1`)).body;
  await f.run('ai_match');
  const page=(await f.route('GET',`/searches/${search.id}/results?revision=1&cursor=${first.continuation.cursor}`)).body;
  assert.deepEqual(classified,['a-en','a-fr']);assert.deepEqual(page.items.map(j=>j.id),['a-en','a-fr']);
  const calls=f.interpretations();
  const options=await f.route('PATCH',`/searches/${search.id}/options`,{expectedRevision:1,followedOnly:false,postingLanguages:[]});
  assert.equal(options.body.search.revision,2);assert.equal(f.interpretations(),calls);assert.equal(f.db.prepare('SELECT count(*) n FROM demo_match_scans').get().n,0);
  await assert.rejects(()=>f.route('GET',`/searches/${search.id}/results?revision=1&cursor=${first.continuation.cursor}`),{status:409});
});

test('conflicting selected and query languages produce honest zero without dropping requirements or inferring',async t=>{
  const f=fixture(t,{model:()=>modelOutput({filters:{postingLanguages:['en']},ai:true})});
  const search=await f.create({followedOnly:false,postingLanguages:['fr']});
  assert.deepEqual(search.configuration.filters.postingLanguages,['en']);assert.deepEqual(search.options.postingLanguages,['fr']);
  const page=(await f.route('GET',`/searches/${search.id}/results?revision=1`)).body;
  assert.deepEqual(page.items,[]);assert.equal(page.continuation.state,'exhausted');assert.equal(f.tasks.claim({workerId:'test',kinds:['ai_match']}),null);
  assert.equal(f.interpretations(),1);
});

test('many validated languages persist, empty selection includes unknown, and options preserve drafts with revision fences',async t=>{
  const languages=['af','am','ar','az','be','bg','bn','bs','ca','cs','cy','da','de','el','en','es','et','eu','fa','fi','fr','ga','gl','gu','he','hi','hr','hu','hy','id','is','it','ja','ka','kk','km','kn','ko','lt','lv','mk','ml','mn','mr','ms','mt','nb','ne','nl','nn','pa','pl','pt','ro','ru','si','sk','sl','sq','sr','sv','sw','ta','te','th','tr','uk','ur','uz','vi','zh','zu'];
  const f=fixture(t,{rows:languages.map((l,i)=>[`job-${i}`,'alpha',[l]]).concat([['unknown','alpha',[]]])});
  const search=await f.create({followedOnly:false,postingLanguages:languages});assert.equal(search.options.postingLanguages.length,languages.length);
  assert.equal((await f.route('GET',`/searches/${search.id}/results?revision=1&limit=50`)).body.items.length,50);
  const edit=await f.route('PATCH',`/searches/${search.id}`,{query:'Unsent replacement remains available',expectedRevision:1,requestKey:'edit'});
  const updated=(await f.route('PATCH',`/searches/${search.id}/options`,{expectedRevision:1,followedOnly:false,postingLanguages:[]})).body.search;
  assert.equal(updated.query,'Engineer work');assert.equal(updated.draft.query,'Unsent replacement remains available');assert.equal(updated.draft.status,'interrupted');assert.equal(f.tasks.get('alice',edit.body.task.id).status,'cancelled');
  await assert.rejects(()=>f.route('PATCH',`/searches/${search.id}/options`,{expectedRevision:1,followedOnly:false,postingLanguages:['en']}),{status:409});
  await assert.rejects(()=>f.route('PATCH',`/searches/${search.id}/options`,{expectedRevision:2,followedOnly:false,postingLanguages:['xx-invalid']}),{status:400});
  const page=(await f.route('GET',`/searches/${search.id}/results?revision=2&limit=50`)).body;
  const last=(await f.route('GET',`/searches/${search.id}/results?revision=2&limit=50&cursor=${page.continuation.cursor}`)).body;
  assert(last.items.some(j=>j.id==='unknown'));
});

test('follow and option changes fence late interpretation, matching pages and classifier replies',async t=>{
  let finishInterpret,finishClassify,holdInterpret=false;
  const f=fixture(t,{model:()=>holdInterpret?new Promise(r=>{finishInterpret=r;}):modelOutput({ai:true}),provider:{available:()=>true,classify:()=>new Promise(r=>{finishClassify=r;})}});
  f.follow('alpha',true,0);const search=await f.create({followedOnly:true,postingLanguages:['en']});
  await f.route('GET',`/searches/${search.id}/results?revision=1`);
  const running=f.run('ai_match');await Promise.resolve();assert(finishClassify);
  const changed=f.follow('alpha',false,1);assert.deepEqual(changed.invalidatedSearchIds,[search.id]);
  finishClassify({decisions:[{id:'a-en',decision:'accepted'}]});await running;
  assert.equal(f.db.prepare('SELECT count(*) n FROM demo_match_cache').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM demo_match_scans').get().n,0);
  holdInterpret=true;const edit=await f.route('PATCH',`/searches/${search.id}`,{query:'New text',expectedRevision:2,requestKey:'new-text'}),interpreting=f.run();await Promise.resolve();
  await f.route('PATCH',`/searches/${search.id}/options`,{expectedRevision:2,followedOnly:false,postingLanguages:['fr']});
  finishInterpret(modelOutput());await interpreting;
  assert.equal(f.tasks.get('alice',edit.body.task.id).status,'cancelled');
  const current=(await f.route('GET','/searches')).body.items[0];assert.equal(current.revision,3);assert.equal(current.query,'Engineer work');assert.equal(current.draft.query,'New text');
  let releasePage;f.matching.page=()=>new Promise(r=>{releasePage=r;});
  const paging=f.route('GET',`/searches/${search.id}/results?revision=3`);await Promise.resolve();
  await f.route('PATCH',`/searches/${search.id}/options`,{expectedRevision:3,followedOnly:false,postingLanguages:['en']});releasePage({items:[{id:'late'}],continuation:{cursor:null,state:'exhausted'}});
  await assert.rejects(()=>paging,{status:409});
});

test('exact-preview acceptance publishes canonical company and follows once while explicit unfollow survives retries and other requests',async t=>{
  const f=fixture(t);
  const created=await f.companies.route(f.ctx('POST','/company-requests',{input:'New Company',requestKey:'new-company'}));await f.run('company_resolution');
  const request=(await f.companies.route(f.ctx('GET','/company-requests'))).body.items[0],path=`/company-requests/${request.id}/accept`,body={candidateId:request.candidate.id,previewRevision:request.previewRevision};
  await assert.rejects(()=>f.companies.route({...f.ctx('POST',path,body,'bob'),idempotencyKey:'accept'}),{status:404});
  const accepted=(await f.companies.route({...f.ctx('POST',path,body),idempotencyKey:'accept'})).body.request,id=accepted.companyId;
  assert(id);assert.equal(accepted.candidate.companyId,id);assert.equal(f.feed.company(id).coverage.state,'requested');assert.equal(f.reading.follows('alice').items[0].companyId,id);
  assert.equal(JSON.stringify(f.feed.company(id)).includes('alice'),false);assert(f.feed.companies({q:'New Company'}).items.some(c=>c.id===id));
  assert(f.intent.compilerCapabilities().values.companies.some(c=>c.id===id));
  f.follow(id,false,1);
  await f.companies.route({...f.ctx('POST',path,body),idempotencyKey:'accept'});assert.deepEqual(f.reading.follows('alice').items,[]);
  const second=await f.companies.route(f.ctx('POST','/company-requests',{input:'New Company',scope:'Another region',requestKey:'new-scope'}));
  const next=second.body.request;assert.equal(next.candidate.companyId,id);
  await f.companies.route({...f.ctx('POST',`/company-requests/${next.id}/accept`,{candidateId:next.candidate.id,previewRevision:next.previewRevision}),idempotencyKey:'accept-scope'});
  assert.deepEqual(f.reading.follows('alice').items,[]);assert.equal(f.db.prepare('SELECT count(*) n FROM justup_requested_companies').get().n,1);
  const imported=await f.companies.route(f.ctx('POST','/company-requests',{input:'Alpha',requestKey:'imported'}));
  await f.companies.route({...f.ctx('POST',`/company-requests/${imported.body.request.id}/accept`,{candidateId:imported.body.request.candidate.id,previewRevision:1}),idempotencyKey:'accept-alpha'});
  assert(f.reading.follows('alice').items.some(c=>c.companyId==='alpha'));
});

test('real account deletion, rollback, reopen and restored-session invalidation include reading state without affecting another owner',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'justup-reading-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'state.sqlite');let reading,intent;
  const backupDir=join(dir,'backups'),generationPath=join(dir,'private-generation');mkdirSync(backupDir,{mode:0o700});writeFileSync(generationPath,'00000000-0000-4000-8000-000000000000\n',{mode:0o600});
  const config={dbPath:path,allowedOrigin:'https://preview.example',requiresInvitation:false,backupDir,privateGenerationPath:generationPath};
  const factory=deps=>{const ownerAuthority=id=>{const access=deps.accessForAccount(id);return access?{account:{id},access}:null;};reading=createReadingPreferencesService({...deps,ownerAuthority});intent=createIntentService({...deps,ownerAuthority,readingPreferences:reading,model:{interpretIntent:async()=>modelOutput()}});return [intent,reading];};
  let app=await createApplication({config,now:()=>AT,serviceFactories:[factory]});
  const alice=await app.auth.register({username:'alice',password:'A test password with enough length'}),bob=await app.auth.register({username:'bob',password:'Another test password with enough length'});
  const aliceId=app.auth.session(alice.token).account.id,bobId=app.auth.session(bob.token).account.id;app.store.importSnapshot(snapshot([['a','alpha',['en','fr']]]));
  const ctx=(id,method,path,body)=>({method,path,url:new URL(`https://preview.example${path}`),accountId:id,viewer:{account:{id}},body});
  reading.route(ctx(aliceId,'PATCH','/follows/alpha',{followed:true,expectedRevision:0}));reading.route(ctx(bobId,'PATCH','/follows/alpha',{followed:true,expectedRevision:0}));
  reading.route(ctx(aliceId,'PATCH','/preferences',{interfaceLocale:'es',expectedRevision:0}));reading.route(ctx(bobId,'PATCH','/preferences',{interfaceLocale:'fr',expectedRevision:0}));
  const search=await intent.route(ctx(aliceId,'POST','/searches',{query:'Engineer',requestKey:'search',options:{followedOnly:true,postingLanguages:['fr']}}));
  await app.close();app=await createApplication({config,now:()=>AT,serviceFactories:[factory]});
  assert.equal(reading.preferences(aliceId).interfaceLocale,'es');assert.equal(reading.follows(aliceId).items.length,1);assert.deepEqual(reading.options(aliceId,search.body.search.id),{followedOnly:true,postingLanguages:['fr']});
  assert.throws(()=>app.withPrivateTransaction(()=>{reading.deleteAccountData(aliceId);throw Error('rollback');}),/rollback/);assert.equal(reading.follows(aliceId).items.length,1);
  await app.auth.deleteAccount(alice.token,'A test password with enough length');
  for(const table of ['justup_company_follows','justup_follow_revisions','justup_preferences','justup_search_options'])assert.equal(app.store.db.prepare(`SELECT count(*) n FROM ${table} WHERE owner_id=?`).get(aliceId).n,0);
  assert.equal(reading.preferences(bobId).interfaceLocale,'fr');assert.equal(reading.follows(bobId).items.length,1);
  assert.throws(()=>reading.route(ctx(aliceId,'GET','/preferences')),{status:401});await app.close();
  await prepareRestoredDatabase({dbPath:path});app=await createApplication({config,now:()=>AT,serviceFactories:[factory]});t.after(()=>app.close());
  assert.equal(app.auth.session(bob.token),null);assert.equal(reading.preferences(bobId).interfaceLocale,'fr');assert.equal(app.store.db.prepare('SELECT count(*) n FROM justup_company_follows WHERE owner_id=?').get(aliceId).n,0);
});

test('model context bounds examples without capping or mutating the applied language selection',()=>{
  const selected=Array.from({length:800},(_,i)=>`en-x-${String(i).padStart(5,'0')}`),options={followedOnly:false,postingLanguages:selected};
  const capabilities={values:{companies:[],locations:[],workplaces:[],employmentTypes:[],postingLanguages:[],seniority:[]},aiAvailable:false};
  const input=intentModelInput({query:'Source query unchanged',capabilities,explicitSearchOptions:options,presentationLocale:'fr'});
  assert.equal(selected.length,800);assert.equal(input.explicitSearchOptions.selectedLanguageCount,800);assert.equal(input.explicitSearchOptions.contextPartial,true);assert.equal(input.presentationLocale,'fr');assert.equal(input.query,'Source query unchanged');assert(Buffer.byteLength(JSON.stringify(input))<22000);
});

test('versioned multilingual qualification cases preserve source queries and intersect every explicit constraint',()=>{
  const corpus=JSON.parse(readFileSync(new URL('./evals/reading-preferences-v1.json',import.meta.url)));
  const capabilities={values:{companies:[],locations:[],workplaces:[],employmentTypes:[],postingLanguages:['de','en','fr','it'],seniority:[]},aiAvailable:false};
  const jobs=['de','en','fr','it'].map(id=>({id,companyId:'alpha',locales:[id]})).concat([{id:'unknown',companyId:'alpha',locales:[]}]);
  for(const c of corpus.cases) {
    const input=intentModelInput({query:c.query,capabilities,explicitSearchOptions:c.options,presentationLocale:c.presentationLocale});
    assert.equal(input.query,c.query,c.id);assert.equal(input.presentationLocale,c.presentationLocale,c.id);
    const effective=applySearchOptions({filters:{postingLanguages:c.queryPostingLanguages}},c.options,[]);
    assert.deepEqual(jobs.filter(j=>primaryMatches(j,effective)).map(j=>j.id),c.expectedPostingIds,c.id);
  }
});

test('live snapshots share canonical filtering without cursors, scroll advancement or speculative refill and retain older accepted rows behind new pending work',async t=>{
  const f=fixture(t,{model:()=>modelOutput({ai:true})}),search=await f.create();
  const first=await f.intent.snapshot({ownerId:'alice',activeSearchId:search.id,activeRevision:f.db.prepare('SELECT revision FROM demo_searches WHERE id=?').get(search.id).revision,viewer:f.ctx('GET','/searches').viewer});
  assert.equal(first.searches[0].continuation.cursor,null);assert.equal(first.searches[0].reconciliation.complete,true);
  const taskCount=()=>f.db.prepare('SELECT count(*) n FROM demo_tasks').get().n;
  const pendingCount=taskCount();await f.intent.snapshot({ownerId:'alice',activeSearchId:search.id,activeRevision:f.db.prepare('SELECT revision FROM demo_searches WHERE id=?').get(search.id).revision,viewer:f.ctx('GET','/searches').viewer});assert.equal(taskCount(),pendingCount);
  await f.run('ai_match');const accepted=await f.intent.snapshot({ownerId:'alice',activeSearchId:search.id,activeRevision:f.db.prepare('SELECT revision FROM demo_searches WHERE id=?').get(search.id).revision,viewer:f.ctx('GET','/searches').viewer});
  assert.equal(accepted.searches[0].items.length,4);assert.equal(accepted.searches[0].reconciliation.complete,true);assert.equal(f.db.prepare('SELECT delivered FROM demo_match_scans').get().delivered,0);
  for(const table of ['demo_search_cursors','demo_search_delegate_cursors','demo_match_cursors'])assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
  const next=snapshot([['a-en','alpha',['en']],['a-fr','alpha',['fr']],['a-unknown','alpha',[]],['b-en','beta',['en']]]),newJob=snapshot([['new','alpha',['en']]]).jobs[0];newJob.firstObserved=iso(AT-DAY_MS);next.jobs.push(newJob);f.store.importSnapshot(next);
  const updated=await f.intent.snapshot({ownerId:'alice',activeSearchId:search.id,activeRevision:f.db.prepare('SELECT revision FROM demo_searches WHERE id=?').get(search.id).revision,viewer:f.ctx('GET','/searches').viewer}),state=updated.searches[0];
  assert.notEqual(updated.generation,accepted.generation);assert.equal(updated.revisionKey,JSON.stringify([[search.id,1]]));assert.deepEqual(state.items,[]);assert.equal(state.reconciliation.complete,true);assert.deepEqual(state.reconciliation.retainedItemIds,accepted.searches[0].items.map(j=>j.id));
  const existingTasks=taskCount();await f.intent.snapshot({ownerId:'alice',activeSearchId:search.id,activeRevision:f.db.prepare('SELECT revision FROM demo_searches WHERE id=?').get(search.id).revision,viewer:f.ctx('GET','/searches').viewer});assert.equal(taskCount(),existingTasks);assert.equal(f.db.prepare('SELECT delivered FROM demo_match_scans').get().delivered,0);
  f.db.prepare("UPDATE demo_jobs SET active=0 WHERE id='a-fr'").run();const closed=await f.intent.snapshot({ownerId:'alice',activeSearchId:search.id,activeRevision:f.db.prepare('SELECT revision FROM demo_searches WHERE id=?').get(search.id).revision,viewer:f.ctx('GET','/searches').viewer});assert.equal(closed.searches[0].reconciliation.retainedItemIds.includes('a-fr'),false);
});

test('an awaited live snapshot rejects revision, source membership and authority changes before returning public rows',async t=>{
  const f=fixture(t,{model:()=>modelOutput({ai:true})}),search=await f.create();
  let release;f.matching.snapshot=()=>new Promise(resolve=>{release=()=>resolve({items:[],continuation:{cursor:null,state:'pending'},reconciliation:{complete:false,retainedItemIds:[]}});});
  const viewer=f.ctx('GET','/searches').viewer;
  let pending=f.intent.snapshot({ownerId:'alice',activeSearchId:search.id,activeRevision:f.db.prepare('SELECT revision FROM demo_searches WHERE id=?').get(search.id).revision,viewer});await Promise.resolve();
  await f.route('PATCH',`/searches/${search.id}/options`,{expectedRevision:1,followedOnly:false,postingLanguages:['en']});release();await assert.rejects(()=>pending,{status:409});
  pending=f.intent.snapshot({ownerId:'alice',activeSearchId:search.id,activeRevision:f.db.prepare('SELECT revision FROM demo_searches WHERE id=?').get(search.id).revision,viewer});await Promise.resolve();f.db.prepare("UPDATE demo_jobs SET active=0 WHERE id='a-en'").run();release();await assert.rejects(()=>pending,{status:409});
  pending=f.intent.snapshot({ownerId:'alice',activeSearchId:search.id,activeRevision:f.db.prepare('SELECT revision FROM demo_searches WHERE id=?').get(search.id).revision,viewer});await Promise.resolve();f.owners.delete('alice');release();await assert.rejects(()=>pending,{status:409});
});

test('real HTTP exposes account preferences and visitor languages with CSRF, handoff and account isolation',async t=>{
  const origin='https://preview.example';let intent,reading,modelInput;
  const app=await createApplication({now:()=>AT,config:{dbPath:':memory:',sourceCommit:'a'.repeat(40),buildIdentity:'synthetic-build',allowedOrigin:origin,requiresInvitation:false,policiesReviewed:true,privacyUrl:origin+'/privacy',usageUrl:origin+'/usage',policyVersion:'synthetic'},serviceFactories:[deps=>{
    const identity=createVisitorIdentity(deps),ownership={ownerAuthority:identity.principal,visitorIdentity:identity};
    reading=createReadingPreferencesService({...deps,...ownership});
    intent=createIntentService({...deps,...ownership,readingPreferences:reading,model:{interpretIntent:async data=>{modelInput=data;return modelOutput();}}});
    const visitor=createVisitorService({...deps,identity,intent});return [intent,visitor,reading];
  }]});
  app.store.importSnapshot(snapshot([['en','alpha',['en']],['fr','alpha',['fr']],['unknown','alpha',[]]]));
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(async()=>{app.server.closeAllConnections();await app.close();});
  const base=`http://127.0.0.1:${app.server.address().port}/api/v1`;
  function client(){const jar=new Map();let csrf;
    return {async call(path,method='GET',body,headers={}){
      const res=await fetch(base+path,{method,headers:{cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; '),...(method==='GET'?{}:{Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrf}),...headers},...(body?{body:JSON.stringify(body)}:{})});
      for(const cookie of res.headers.getSetCookie()){const pair=cookie.split(';')[0],at=pair.indexOf('=');jar.set(pair.slice(0,at),pair.slice(at+1));}
      const data=await res.json();if(data.csrfToken)csrf=data.csrfToken;return {status:res.status,body:data};
    }};
  }
  const a=client(),b=client(),session=await a.call('/session');await b.call('/session');
  assert.equal(session.body.capabilities.follows,true);assert.equal(session.body.capabilities.preferences,true);
  assert.equal((await a.call('/follows')).status,401);
  assert.deepEqual((await a.call('/visitor/search-options')).body.postingLanguages.map(l=>l.id),['en','fr']);
  const created=await a.call('/visitor/searches','POST',{query:'Original source query',requestKey:'visitor',presentationLocale:'de',options:{followedOnly:false,postingLanguages:['fr']}});assert.equal(created.status,202);
  const task=app.tasks.claim({workerId:'fixture',kinds:['search_intent']});assert.equal((await intent.runTask(task)).committed,true);assert.equal(modelInput.presentationLocale,'de');assert.equal(modelInput.query,'Original source query');
  const id=created.body.search.id;
  assert.equal((await a.call(`/visitor/searches/${id}/options`,'PATCH',{expectedRevision:1,followedOnly:true,postingLanguages:['fr']})).status,401);
  const selected=await a.call(`/visitor/searches/${id}/options`,'PATCH',{expectedRevision:1,followedOnly:false,postingLanguages:['en']});assert.equal(selected.status,200);assert.equal(selected.body.search.revision,2);
  assert.deepEqual((await a.call(`/visitor/searches/${id}/results?revision=2`)).body.items.map(j=>j.id),['en']);
  assert.equal((await b.call('/visitor/searches','POST',{query:'Another visitor search',requestKey:'other-owner'})).status,202);
  assert.equal((await b.call(`/visitor/searches/${id}/options`,'PATCH',{expectedRevision:2,followedOnly:false,postingLanguages:[]})).status,404);
  await a.call('/visitor/viewed','POST',{jobId:'en'});
  const registered=await a.call('/auth/register','POST',{username:'http-alice',password:'A synthetic HTTP account password'});assert.equal(registered.status,201);
  const searches=await a.call('/searches');assert.deepEqual(searches.body.items[0].options,{followedOnly:false,postingLanguages:['en']});assert.equal((await a.call('/workspace')).body.viewed[0].jobId,'en');
  assert.equal((await a.call('/follows/alpha','PATCH',{expectedRevision:0,followed:true},{'X-CSRF-Token':'x'.repeat(43)})).status,403);
  assert.equal((await a.call('/follows/alpha','PATCH',{expectedRevision:0,followed:true})).status,200);
  const prefs=await a.call('/preferences?languages=ja-JP,es-MX,de-CH');assert.equal(prefs.body.resolvedInterfaceLocale,'es');
  assert.equal((await a.call('/preferences','PATCH',{expectedRevision:0,interfaceLocale:'it'})).status,200);
  assert.equal((await a.call(`/searches/${id}`,'PATCH',{query:'Query unchanged by locale',expectedRevision:2,requestKey:'invalid-locale',presentationLocale:'ja'})).status,400);
  await b.call('/auth/register','POST',{username:'http-bob',password:'Another synthetic HTTP password'});assert.deepEqual((await b.call('/follows')).body.items,[]);assert.equal((await b.call('/preferences')).body.interfaceLocale,null);
  assert.equal((await b.call(`/searches/${id}/options`,'PATCH',{expectedRevision:2,followedOnly:false,postingLanguages:[]})).status,404);
  assert.equal((await a.call('/follows')).body.accountId,registered.body.user.id);
});
