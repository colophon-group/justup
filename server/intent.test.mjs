// Provider-free compiler and SQLite state-transition contracts; no model auth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createIntentService,compileIntent,intentCapabilities,primaryMatches,intentModelInput } from './intent.mjs';

const at=Date.parse('2026-10-31T16:00:00Z');
const FIELDS=['companyInclude','companyExclude','titleAny','bodyAll','bodyNone','locations','workplaces','employmentTypes','postingLanguages','seniority'];
function output(filters={},requirements,residualAi=null) {
  const bindings=Object.entries(filters).filter(([,v])=>v).map(([field,values])=>({field,values}));
  requirements??=[{id:'r1',text:Object.values(filters).flat().join(' ')||'Any job',handling:'primary',reason:'Applied evidence.'}];
  const accounted=requirements.map(r=>({companyReference:null,...r,bindings:r.bindings??(r.handling==='primary'?bindings:[])}));
  if(bindings.length&&!accounted.some(r=>r.handling==='primary'))accounted.unshift({id:'applied',text:Object.values(filters).flat().join(' '),handling:'primary',reason:'Applied evidence.',bindings,companyReference:null});
  return {title:'Backend',configuration:{schemaVersion:1,filters:{...Object.fromEntries(FIELDS.map(k=>[k,null])),...filters},residualAi},requirements:accounted};
}
function job(id,extra={}) { return {id,companyId:'acme',companyName:'Acme Labs',companySlug:'acme-labs',title:'Backend Engineer',bodyText:'Python services and databases.',firstObserved:`2026-10-2${id==='a'?'9':'8'}T10:00:00Z`,locations:[{name:'Zurich, Switzerland',workplace:'onsite'}],locales:['en'],employmentTypes:['full_time'],seniority:{id:'senior',name:'Senior'},...extra}; }
function fixture(model={interpretIntent:async()=>output({titleAny:['backend']})},config={}) {
  const db=new DatabaseSync(':memory:'),records=new Map();let seq=0,generation='g1',clock=at,currentAccess={kind:'free'};
  const tasks={
    enqueue(args){const prior=[...records.values()].find(r=>r.ownerId===args.ownerId&&r.kind===args.kind&&r.requestKey===args.requestKey);if(prior)return prior;const t={...args,id:`task-${++seq}`,status:'pending',output:null,createdAt:new Date(clock).toISOString(),updatedAt:new Date(clock).toISOString()};records.set(t.id,t);return t;},
    get(owner,id){const r=records.get(id);return r?.ownerId===owner?r:null;},
    complete(id,token,result){const r=records.get(id);if(!r||r.status!=='running'||r.leaseToken!==token||r.leaseUntil<=clock)return false;Object.assign(r,result);return true;},
    cancel(owner,id){const r=this.get(owner,id);if(r)r.status='cancelled';},delete(owner,id){if(this.get(owner,id))records.delete(id);},
    publicView(t,result=null){return {id:t.id,kind:t.kind,status:t.status,createdAt:t.createdAt,updatedAt:t.updatedAt,result:['succeeded','warning'].includes(t.status)?result:null,error:null};},
  };
  const jobs=[job('a'),job('b',{title:'Designer',companyId:'other',companyName:'Other',companySlug:'other'})];
  const feed={eligibleJobs:({viewer})=>viewer?.account?.id?jobs:jobs.filter(j=>j.id==='b'),generation:()=>generation,coverage:()=>({verifiedAt:new Date(at).toISOString(),stale:false}),publicJob:j=>({id:j.id,title:j.title,firstObserved:j.firstObserved})};
  let deletions=0;
  const service=createIntentService({db,feed,tasks,now:()=>clock,beforePrivateDelete:()=>{deletions++;},model,ownerAuthority:id=>({account:{id},access:currentAccess}),...config});
  const ctx=(method,path,body,owner='owner')=>({method,path:path.split('?')[0],url:new URL(`https://preview.example/api/v1${path}`),body,accountId:owner,viewer:owner?{account:{id:owner},access:{kind:'free'}}:null});
  const route=(method,path,body,owner)=>service.route(ctx(method,path,body,owner));
  async function run(id) { const t=records.get(id);Object.assign(t,{status:'running',leaseToken:`lease-${id}`,leaseUntil:clock+60000});const result=await service.runTask({...t});if(!result.committed)tasks.complete(id,t.leaseToken,result);return {result,task:t,projection:service.taskResult(t,{accountId:t.ownerId})}; }
  return {db,tasks,records,jobs,feed,service,ctx,route,run,get deletions(){return deletions;},setGeneration:v=>generation=v,setClock:v=>clock=v,setAccess:v=>currentAccess=v};
}

test('compiler normalizes dataset aliases and rejects unavailable values with exact paths',()=>{
  const caps=intentCapabilities([job('a')]);
  const good=compileIntent(output({companyInclude:['ACME-LABS'],locations:['zurich, switzerland'],seniority:['Senior']}),caps);
  assert.equal(good.ok,true);assert.deepEqual(good.value.configuration.filters,{companyInclude:['acme'],locations:['Zurich, Switzerland'],seniority:['senior']});
  const bad=compileIntent(output({workplaces:['cross-border']}),caps);
  assert.ok(bad.diagnostics.some(d=>d.path==='$.configuration.filters.workplaces[0]'&&d.code==='unknown_value'&&Array.isArray(d.alternatives)));
});
test('compiler rejects conflicts, unknown keys, blank terms and AI without availability',()=>{
  const caps=intentCapabilities([job('a')]);
  for(const raw of [output({companyInclude:['acme'],companyExclude:['acme']}),output({salary:['100000']}),output({titleAny:['  ']}),output({},[{id:'r1',text:'Visa',handling:'ai',reason:'No primary field.'}],{condition:'Visa sponsorship',requirementIds:['r1']})]) assert.equal(compileIntent(raw,caps).ok,false);
});
test('unrelated existing filter cannot masquerade as implementation of a hard requirement',()=>{
  const bad=output({titleAny:['backend']},[{id:'r1',text:'Visa sponsorship required',handling:'primary',reason:'Claimed supported.',bindings:[{field:'titleAny',values:['backend']}]}]);
  const result=compileIntent(bad,intentCapabilities([job('a')]));assert.equal(result.ok,false);assert.ok(result.diagnostics.some(d=>d.code==='unimplemented_primary_requirement'));
  const missing=output({titleAny:['backend']});missing.requirements[0].bindings=[];assert.equal(compileIntent(missing,intentCapabilities([job('a')])).ok,false);
});
test('large catalogue projection and bounded repair fit stdin while compiler sees all canonical values',()=>{
  const jobs=Array.from({length:1000},(_,i)=>job(String(i),{companyId:`company-${i}`,companyName:`Company ${i}`,companySlug:`company-${i}`,locations:[{name:`City ${i}, Country ${i%2}`,workplace:'onsite'}]})),caps=intentCapabilities(jobs);
  const query='Backend at Company 947 in Country 1',input=intentModelInput({query,capabilities:caps});assert.ok(Buffer.byteLength(JSON.stringify(input))<22000);assert.equal(input.query,query);assert.ok(input.capabilities.values.companies.some(c=>c.id==='company-947'));assert.equal(input.capabilities.catalogue.totals.companies,1000);
  const wrong=compileIntent(output({companyInclude:['Company 947'],locations:['City 9999']}),caps);assert.equal(wrong.ok,false);assert.ok(wrong.diagnostics.some(d=>d.path==='$.configuration.filters.locations[0]'&&d.alternatives.length<=6));
  const repair=intentModelInput({query,capabilities:caps,prior:{query,configuration:{schemaVersion:1,filters:{locations:jobs.map(j=>j.locations[0].name)},residualAi:null}},repair:{diagnostics:wrong.diagnostics,previous:output({companyInclude:['Company 947'],locations:['City 9999']})}});assert.ok(Buffer.byteLength(JSON.stringify(repair))+1600<24576);assert.equal(repair.prior.configurationContextPartial,true);
  const compiled=compileIntent(output({locations:['Country 1']}),caps);assert.equal(compiled.ok,true);assert.deepEqual(compiled.value.configuration.filters.locations,['Country 1']);assert.equal(jobs.filter(j=>primaryMatches(j,compiled.value.configuration)).length,500);
  const ambiguous=compileIntent(output({locations:['Paris']}),intentCapabilities([job('a',{locations:[{name:'Paris, France',workplace:'onsite'}]}),job('b',{locations:[{name:'Paris, United States',workplace:'onsite'}]})]));assert.equal(ambiguous.ok,false);
});
test('company prefill is bounded positive unknown metadata, never a known, ambiguous, excluded or unrelated mention',()=>{
  const caps=intentCapabilities([job('a'),job('b',{companyId:'shared-1',companyName:'Shared',companySlug:'shared-one'}),job('c',{companyId:'shared-2',companyName:'Shared',companySlug:'shared-two'})]);
  const raw=(name,handling='unsatisfied')=>output({},[{id:'company',text:`Company ${name}`,handling,reason:'This company is unavailable.',bindings:[],companyReference:{input:name,scope:'Zurich'}}]);
  const accepted=compileIntent(raw('Newco'),caps,{query:'Jobs at Newco in Zurich'});assert.equal(accepted.ok,true);assert.deepEqual(accepted.value.warnings[0].companyRequestPrefill,{input:'Newco',scope:'Zurich'});assert.equal(accepted.value.warnings[0].code,'company_not_found');assert.deepEqual(Object.keys(accepted.value.requirements[0]).sort(),['handling','id','reason','text']);
  assert.equal(compileIntent(raw('Newco'),caps,{query:'Newco jobs'}).value.warnings[0].companyRequestPrefill.scope,null);
  for(const [name,query,handling] of [['Acme Labs','Jobs at Acme Labs','unsatisfied'],['acme-labs','Jobs at acme-labs','unsatisfied'],['Shared','Jobs at Shared','unsatisfied'],['Newco','Exclude Newco','unsatisfied'],['Newco','Ideally Newco','preference'],['Newco','Example mention Newco; backend jobs at Acme Labs','unsatisfied'],['Unrelated','Jobs at Newco','unsatisfied']])assert.equal(compileIntent(raw(name,handling),caps,{query}).value.warnings.some(w=>w.companyRequestPrefill),false,query);
  for(const name of ['https://example.com','javascript:alert(1)','example.com?tracking=1','会社.example','<script>','Bad\nName'])assert.equal(compileIntent(raw(name),caps,{query:`Jobs at ${name}`}).value.warnings.some(w=>w.companyRequestPrefill),false,name);
});
test('warned company prefill survives explicit confirmation without creating a company request',async t=>{
  const f=fixture({interpretIntent:async()=>output({},[{id:'company',text:'Company Newco',handling:'unsatisfied',reason:'Company is not imported.',bindings:[],companyReference:{input:'Newco',scope:null}}])});t.after(()=>f.db.close());
  const created=await f.route('POST','/searches',{query:'Jobs at Newco',requestKey:'newco'}),done=await f.run(created.body.task.id),proposal=done.projection.proposal;
  assert.equal(done.task.status,'warning');assert.deepEqual(proposal.warnings[0].companyRequestPrefill,{input:'Newco',scope:null});assert.equal(f.records.size,1);
  const confirmed=await f.route('POST',`/searches/${created.body.search.id}/confirm`,{proposalId:proposal.proposalId,expectedRevision:0});assert.deepEqual(confirmed.body.search.warnings[0],proposal.warnings[0]);assert.equal(f.records.size,1);
});
test('known imported company without eligible jobs compiles to a fresh zero result and never a missing-company hint',async t=>{
  let sent;const f=fixture({interpretIntent:async input=>{sent=input;return output({companyInclude:['known-old']});}});t.after(()=>f.db.close());
  f.db.exec('CREATE TABLE justup_jobs(company_id TEXT,first_seen_at INTEGER,data_json TEXT)');
  const metadata={companyId:'known-old',companyName:'Known Old',companySlug:'known-old',locations:[{name:'Zurich, Switzerland',workplace:'onsite'}],employmentTypes:['full_time'],locales:['en'],seniority:null,id:'must-not-enter-capabilities',title:'must-not-enter-capabilities',bodyText:'must-not-enter-capabilities'};
  f.db.prepare('INSERT INTO justup_jobs VALUES(?,?,?)').run('known-old',at-20*86400000,JSON.stringify(metadata));f.feed.eligibleJobs=()=>[];
  const caps=f.service.compilerCapabilities();assert.equal(caps.values.companies[0].id,'known-old');assert.equal(JSON.stringify(caps).includes('must-not-enter-capabilities'),false);
  const reference=output({},[{id:'company',text:'Company known-old',handling:'unsatisfied',reason:'No current jobs.',bindings:[],companyReference:{input:'known-old',scope:null}}]);assert.equal(compileIntent(reference,caps,{query:'Jobs at known-old'}).value.warnings.some(w=>w.companyRequestPrefill),false);
  const created=await f.route('POST','/searches',{query:'Jobs at known-old',requestKey:'known'}),done=await f.run(created.body.task.id);assert.equal(done.task.status,'succeeded');assert.equal(JSON.stringify(sent).includes('must-not-enter-capabilities'),false);
  const page=(await f.route('GET',`/searches/${created.body.search.id}/results?revision=1`)).body;assert.deepEqual(page.items,[]);assert.equal(page.continuation.state,'exhausted');assert.equal(page.coverage.stale,false);
});
test('missing body/location/seniority evidence cannot satisfy required or excluded terms',()=>{
  for(const filters of [{bodyAll:['python']},{bodyNone:['agency']},{locations:['Zurich, Switzerland']},{workplaces:['remote']},{seniority:['senior']}]) assert.equal(primaryMatches(job('a',{bodyText:null,locations:[],seniority:null}),{filters}),false);
  assert.equal(primaryMatches(job('a'),{filters:{bodyAll:['PYTHON'],titleAny:['backend'],bodyNone:['agency']}}),true);
});
test('create is owner-only and request-key retries preserve one revision-zero draft',async t=>{
  const f=fixture();t.after(()=>f.db.close());
  await assert.rejects(()=>f.route('POST','/searches',{query:'backend',requestKey:'one'},null),{status:401});
  const a=await f.route('POST','/searches',{query:'backend',requestKey:'one'}),b=await f.route('POST','/searches',{query:'backend',requestKey:'one'});
  assert.equal(a.status,202);assert.equal(a.body.search.revision,0);assert.equal(a.body.search.draft.query,'backend');assert.deepEqual(b,a);assert.equal(f.records.size,1);
  await assert.rejects(()=>f.route('POST','/searches',{query:'designer',requestKey:'one'}),{status:409});
  assert.deepEqual((await f.route('GET','/searches',undefined,'another')).body,{items:[]});
});
test('accepted valid zero-result search is success and retains exact user query',async t=>{
  const f=fixture({interpretIntent:async()=>output({titleAny:['astronaut']})});t.after(()=>f.db.close());
  const a=await f.route('POST','/searches',{query:'Astronaut jobs',requestKey:'one'}),done=await f.run(a.body.task.id);
  assert.equal(done.result.committed,true);assert.equal(done.task.status,'succeeded');assert.equal(done.projection.search.query,'Astronaut jobs');
  const page=await f.route('GET',`/searches/${a.body.search.id}/results?revision=1`);
  assert.deepEqual(page.body.items,[]);assert.equal(page.body.continuation.state,'exhausted');assert.equal(page.body.ai.status,'not_required');
});
test('repair receives field diagnostics once without account IDs or job bodies',async t=>{
  const inputs=[];const f=fixture({interpretIntent:async input=>{inputs.push(input);return inputs.length===1?output({workplaces:['from anywhere']}):output({titleAny:['backend']});}});t.after(()=>f.db.close());
  const a=await f.route('POST','/searches',{query:'backend',requestKey:'one'});await f.run(a.body.task.id);
  assert.equal(inputs.length,2);assert.equal(inputs[1].repair.diagnostics[0].path,'$.configuration.filters.workplaces[0]');
  assert.equal(JSON.stringify(inputs).includes('owner'),false);assert.equal(JSON.stringify(inputs).includes('Python services'),false);
});
test('failed repair and provider failure retain accepted state plus pending draft',async t=>{
  let mode='good',calls=0;const f=fixture({interpretIntent:async()=>{calls++;if(mode==='down')throw Error('private provider text');return mode==='bad'?output({workplaces:['unknown']}):output({titleAny:['backend']});}});t.after(()=>f.db.close());
  const first=await f.route('POST','/searches',{query:'backend',requestKey:'one'});await f.run(first.body.task.id);
  for(const [requestKey,query,next] of [['two','invalid workplace','bad'],['three','edited backend','down']]) {
    mode=next;const a=await f.route('PATCH',`/searches/${first.body.search.id}`,{query,expectedRevision:1,requestKey});const before=calls,done=await f.run(a.body.task.id);
    assert.equal(done.task.status,'failed');assert.equal(calls-before,next==='bad'?2:1);
    const current=(await f.route('GET','/searches')).body.items[0];assert.equal(current.query,'backend');assert.equal(current.revision,1);assert.equal(current.draft.query,query);
  }
});
test('unsupported requirement produces explicit proposal; stale preview cannot confirm',async t=>{
  let warning=false;const f=fixture({interpretIntent:async()=>warning?output({titleAny:['backend']},[{id:'r1',text:'Visa sponsorship',handling:'unsatisfied',reason:'Visa evidence is unavailable.'}]):output({titleAny:['backend']})});t.after(()=>f.db.close());
  const a=await f.route('POST','/searches',{query:'backend',requestKey:'one'});await f.run(a.body.task.id);warning=true;
  const b=await f.route('PATCH',`/searches/${a.body.search.id}`,{query:'backend with visa',expectedRevision:1,requestKey:'two'}),done=await f.run(b.body.task.id);
  assert.equal(done.task.status,'warning');const p=done.projection.proposal;assert.equal(p.expectedRevision,1);
  assert.equal((await f.route('GET','/searches')).body.items[0].query,'backend');
  const accepted=await f.route('POST',`/searches/${a.body.search.id}/confirm`,{proposalId:p.proposalId,expectedRevision:1});
  assert.equal(accepted.body.search.revision,2);assert.equal(accepted.body.search.warnings[0].code,'unsupported_requirement');
  await assert.rejects(()=>f.route('POST',`/searches/${a.body.search.id}/confirm`,{proposalId:p.proposalId,expectedRevision:1}),{status:409});
});
test('edits replace criteria and receive the prior accepted query/configuration',async t=>{
  const seen=[];const f=fixture({interpretIntent:async input=>{seen.push(input);return seen.length===1?output({titleAny:['backend'],workplaces:['onsite']}):output({titleAny:['designer']});}});t.after(()=>f.db.close());
  const a=await f.route('POST','/searches',{query:'onsite backend',requestKey:'one'});await f.run(a.body.task.id);
  const b=await f.route('PATCH',`/searches/${a.body.search.id}`,{query:'designer',expectedRevision:1,requestKey:'two'});const done=await f.run(b.body.task.id);
  assert.equal(seen[1].prior.query,'onsite backend');assert.deepEqual(done.projection.search.configuration.filters,{titleAny:['designer']});
  await assert.rejects(()=>f.route('PATCH',`/searches/${a.body.search.id}`,{query:'old',expectedRevision:1,requestKey:'three'}),{status:409});
});
test('newer drafts and deletion make late model completions inert',async t=>{
  let release;const f=fixture({interpretIntent:()=>new Promise(resolve=>{release=resolve;})});t.after(()=>f.db.close());
  const a=await f.route('POST','/searches',{query:'backend',requestKey:'one'}),running=f.run(a.body.task.id);await Promise.resolve();
  const b=await f.route('PATCH',`/searches/${a.body.search.id}`,{query:'designer',expectedRevision:0,requestKey:'two'});release(output({titleAny:['backend']}));await running;
  assert.equal((await f.route('GET','/searches')).body.items[0].draft.query,'designer');
  const next=f.run(b.body.task.id);await Promise.resolve();await f.route('DELETE',`/searches/${a.body.search.id}`);release(output({titleAny:['designer']}));await next;
  assert.deepEqual((await f.route('GET','/searches')).body.items,[]);assert.equal(f.records.size,0);assert.equal(f.deletions,1);
});
test('cursor binds revision, access and generation and never exposes internal body',async t=>{
  const f=fixture({interpretIntent:async()=>output({},[{id:'r1',text:'All jobs',handling:'preference',reason:'No binding filter.'}])});t.after(()=>f.db.close());
  const a=await f.route('POST','/searches',{query:'All jobs',requestKey:'one'});await f.run(a.body.task.id);
  const path=`/searches/${a.body.search.id}/results?revision=1&limit=1`,page=(await f.route('GET',path)).body;
  assert.equal(page.items[0].id,'a');assert.equal(page.continuation.state,'open');assert.equal(JSON.stringify(page).includes('bodyText'),false);
  const next=(await f.route('GET',`${path}&cursor=${page.continuation.cursor}`)).body;assert.equal(next.items[0].id,'b');assert.equal(next.continuation.state,'exhausted');
  const ctx=f.ctx('GET',`${path}&cursor=${page.continuation.cursor}`);ctx.viewer.access={kind:'expired'};f.setAccess({kind:'expired'});await assert.rejects(()=>f.service.route(ctx),{code:'stale_cursor'});
  f.setGeneration('g2');await assert.rejects(()=>f.route('GET',`${path}&cursor=${page.continuation.cursor}`),{status:409});
});
test('stale or unverified source pauses before eligibility work and resumes without claiming exhaustion',async t=>{
  const f=fixture();t.after(()=>f.db.close());const created=await f.route('POST','/searches',{query:'backend',requestKey:'one'});await f.run(created.body.task.id);
  const original=f.feed.eligibleJobs;let calls=0;f.feed.eligibleJobs=(args)=>{calls++;return original(args);};const path=`/searches/${created.body.search.id}/results?revision=1`;
  for(const coverage of [{stale:true,verifiedAt:new Date(at).toISOString()},{stale:false,verifiedAt:null}]){f.feed.coverage=()=>coverage;const page=(await f.route('GET',path)).body;assert.equal(page.continuation.state,'paused');assert.equal(page.continuation.retryAfterMs,5000);assert.equal(page.coverage.state,'import_unavailable');assert.equal(page.coverage.description,'Imported listings need verification.');assert.equal(page.ai.status,'not_required');assert.deepEqual(page.items,[]);assert.equal(calls,0);
    f.feed.coverage=()=>({stale:false,verifiedAt:new Date(at).toISOString()});const resumed=(await f.route('GET',`${path}&cursor=${page.continuation.cursor}`)).body;assert.equal(resumed.items[0].id,'a');calls=0;
    f.setGeneration('new-generation');await assert.rejects(()=>f.route('GET',`${path}&cursor=${page.continuation.cursor}`),{code:'stale_cursor'});f.setGeneration('g1');}
});
test('residual condition without matching stays active with a resumable paused empty batch',async t=>{
  const f=fixture({interpretIntent:async()=>output({titleAny:['backend']},[{id:'r1',text:'Infrastructure',handling:'ai',reason:'Requires body interpretation.'}],{condition:'Infrastructure work',requirementIds:['r1']})},{config:{aiMatchingAvailable:true}});t.after(()=>f.db.close());
  const a=await f.route('POST','/searches',{query:'infrastructure backend',requestKey:'one'});await f.run(a.body.task.id);
  const path=`/searches/${a.body.search.id}/results?revision=1`,page=(await f.route('GET',path)).body;
  assert.equal(page.continuation.state,'paused');assert.equal(page.ai.status,'dependency_unavailable');assert.deepEqual(page.items,[]);
  assert.equal((await f.route('GET',`${path}&cursor=${page.continuation.cursor}`)).body.continuation.cursor,page.continuation.cursor);
});
test('injected matching owns its opaque continuation and receives only eligible primary matches',async t=>{
  let supplied;const matching={available:()=>true,page:async args=>{supplied=args;return {items:[],continuation:{state:'pending',cursor:'matching-cursor',retryAfterMs:1000},ai:{status:'pending'}};}};
  const f=fixture({interpretIntent:async()=>output({titleAny:['backend']},[{id:'r1',text:'Infrastructure',handling:'ai',reason:'Needs body.'}],{condition:'Infrastructure',requirementIds:['r1']})},{matching});t.after(()=>f.db.close());
  const a=await f.route('POST','/searches',{query:'Infrastructure backend',requestKey:'one'});await f.run(a.body.task.id);
  const path=`/searches/${a.body.search.id}/results?revision=1`,first=(await f.route('GET',path)).body;assert.notEqual(first.continuation.cursor,'matching-cursor');
  let eligibleCalls=0,matchingCalls=0;const getJobs=f.feed.eligibleJobs,page=matching.page;f.feed.eligibleJobs=(args)=>{eligibleCalls++;return getJobs(args);};matching.page=(args)=>{matchingCalls++;return page(args);};f.feed.coverage=()=>({stale:true,verifiedAt:null});
  const paused=(await f.route('GET',`${path}&cursor=${first.continuation.cursor}`)).body;assert.equal(paused.continuation.state,'paused');assert.equal(paused.continuation.cursor,first.continuation.cursor);assert.equal(paused.ai.status,'dependency_unavailable');assert.equal(eligibleCalls,0);assert.equal(matchingCalls,0);
  f.feed.coverage=()=>({stale:false,verifiedAt:new Date(at).toISOString()});await f.route('GET',`${path}&cursor=${paused.continuation.cursor}`);
  assert.deepEqual(supplied.jobs.map(j=>j.id),['a']);assert.equal(supplied.cursor,'matching-cursor');
});
test('account deletion composes synchronously and backup-barrier failure preserves private data',async t=>{
  const f=fixture();t.after(()=>f.db.close());const a=await f.route('POST','/searches',{query:'backend',requestKey:'one'});
  const noDelete=createIntentService({db:f.db,feed:f.feed,tasks:f.tasks,ownerAuthority:id=>({account:{id},access:{kind:'free'}}),model:{interpretIntent:async()=>output({titleAny:['backend']})}});
  await assert.rejects(()=>noDelete.route(f.ctx('DELETE',`/searches/${a.body.search.id}`)),{status:503});assert.equal(f.records.size,1);
  f.db.exec('BEGIN');f.service.deleteAccountData('owner');f.db.exec('COMMIT');assert.equal(f.records.size,0);assert.deepEqual((await f.route('GET','/searches')).body.items,[]);
});
test('direct deletion holds the core private transaction through the barrier and SQL commit',async t=>{
  const f=fixture();t.after(()=>f.db.close());const created=await f.route('POST','/searches',{query:'backend',requestKey:'one'});let barriers=0,released=0;
  const service=createIntentService({db:f.db,feed:f.feed,tasks:f.tasks,ownerAuthority:id=>({account:{id},access:{kind:'free'}}),beforePrivateDelete:()=>{assert.equal(f.db.isTransaction,true);barriers++;},withPrivateTransaction:fn=>{f.db.exec('BEGIN');try{const result=fn();f.db.exec('COMMIT');return result;}catch(error){f.db.exec('ROLLBACK');throw error;}finally{assert.equal(f.db.isTransaction,false);released++;}}});
  assert.equal((await service.route(f.ctx('DELETE',`/searches/${created.body.search.id}`))).status,200);assert.equal(barriers,1);assert.equal(released,1);
});
test('held-out compiler fixtures enforce acceptance, warning and unsafe-output rejection',()=>{
  const fixtures=JSON.parse(readFileSync(new URL('./evals/intent-heldout.json',import.meta.url)));
  for(const item of fixtures.cases) {
    const result=compileIntent(output(item.filters,item.requirements,item.residualAi??null),intentCapabilities([job('a')],item.aiAvailable??false));
    assert.equal(result.ok,item.expected!=='invalid',item.id);
    if(result.ok)assert.equal(result.value.warnings.length>0,item.expected==='warning',item.id);
  }
});
