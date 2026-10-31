// Provider-free compiler and SQLite state-transition contracts; no model auth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createIntentService,compileIntent,intentCapabilities,primaryMatches } from './intent.mjs';

const at=Date.parse('2026-10-31T16:00:00Z');
const FIELDS=['companyInclude','companyExclude','titleAny','bodyAll','bodyNone','locations','workplaces','employmentTypes','postingLanguages','seniority'];
function output(filters={},requirements=[{id:'r1',text:'Backend roles',handling:'primary',reason:'Title evidence.'}],residualAi=null) {
  return {title:'Backend',configuration:{schemaVersion:1,filters:{...Object.fromEntries(FIELDS.map(k=>[k,null])),...filters},residualAi},requirements};
}
function job(id,extra={}) { return {id,companyId:'acme',companyName:'Acme Labs',companySlug:'acme-labs',title:'Backend Engineer',bodyText:'Python services and databases.',firstObserved:`2026-10-2${id==='a'?'9':'8'}T10:00:00Z`,locations:[{name:'Zurich, Switzerland',workplace:'onsite'}],locales:['en'],employmentTypes:['full_time'],seniority:{id:'senior',name:'Senior'},...extra}; }
function fixture(model={interpretIntent:async()=>output({titleAny:['backend']})},config={}) {
  const db=new DatabaseSync(':memory:'),records=new Map();let seq=0,generation='g1',clock=at;
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
  const service=createIntentService({db,feed,tasks,now:()=>clock,beforePrivateDelete:()=>{deletions++;},model,...config});
  const ctx=(method,path,body,owner='owner')=>({method,path:path.split('?')[0],url:new URL(`https://preview.example/api/v1${path}`),body,accountId:owner,viewer:owner?{account:{id:owner},access:{kind:'demo'}}:null});
  const route=(method,path,body,owner)=>service.route(ctx(method,path,body,owner));
  async function run(id) { const t=records.get(id);Object.assign(t,{status:'running',leaseToken:`lease-${id}`,leaseUntil:clock+60000});const result=await service.runTask({...t});if(!result.committed)tasks.complete(id,t.leaseToken,result);return {result,task:t,projection:service.taskResult(t,{accountId:t.ownerId})}; }
  return {db,tasks,records,jobs,feed,service,ctx,route,run,get deletions(){return deletions;},setGeneration:v=>generation=v,setClock:v=>clock=v};
}

test('compiler normalizes dataset aliases and rejects unavailable values with exact paths',()=>{
  const caps=intentCapabilities([job('a')]);
  const good=compileIntent(output({companyInclude:['ACME-LABS'],locations:['zurich, switzerland'],seniority:['Senior']}),caps);
  assert.equal(good.ok,true);assert.deepEqual(good.value.configuration.filters,{companyInclude:['acme'],locations:['Zurich, Switzerland'],seniority:['senior']});
  const bad=compileIntent(output({workplaces:['cross-border']}),caps);
  assert.deepEqual(bad.diagnostics,[{path:'$.configuration.filters.workplaces[0]',code:'unknown_value'}]);
});
test('compiler rejects conflicts, unknown keys, blank terms and AI without availability',()=>{
  const caps=intentCapabilities([job('a')]);
  for(const raw of [output({companyInclude:['acme'],companyExclude:['acme']}),output({salary:['100000']}),output({titleAny:['  ']}),output({},[{id:'r1',text:'Visa',handling:'ai',reason:'No primary field.'}],{condition:'Visa sponsorship',requirementIds:['r1']})]) assert.equal(compileIntent(raw,caps).ok,false);
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
  const ctx=f.ctx('GET',`${path}&cursor=${page.continuation.cursor}`);ctx.viewer.access={kind:'expired'};await assert.rejects(()=>f.service.route(ctx),{code:'stale_cursor'});
  f.setGeneration('g2');await assert.rejects(()=>f.route('GET',`${path}&cursor=${page.continuation.cursor}`),{status:409});
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
  await f.route('GET',`/searches/${a.body.search.id}/results?revision=1&cursor=matching-cursor`);
  assert.deepEqual(supplied.jobs.map(j=>j.id),['a']);assert.equal(supplied.cursor,'matching-cursor');
});
test('account deletion composes synchronously and backup-barrier failure preserves private data',async t=>{
  const f=fixture();t.after(()=>f.db.close());const a=await f.route('POST','/searches',{query:'backend',requestKey:'one'});
  const noDelete=createIntentService({db:f.db,feed:f.feed,tasks:f.tasks,model:{interpretIntent:async()=>output({titleAny:['backend']})}});
  await assert.rejects(()=>noDelete.route(f.ctx('DELETE',`/searches/${a.body.search.id}`)),{status:503});assert.equal(f.records.size,1);
  f.db.exec('BEGIN');f.service.deleteAccountData('owner');f.db.exec('COMMIT');assert.equal(f.records.size,0);assert.deepEqual((await f.route('GET','/searches')).body.items,[]);
});
test('held-out compiler fixtures enforce acceptance, warning and unsafe-output rejection',()=>{
  const fixtures=JSON.parse(readFileSync(new URL('./evals/intent-heldout.json',import.meta.url)));
  for(const item of fixtures.cases) {
    const result=compileIntent(output(item.filters,item.requirements,item.residualAi??null),intentCapabilities([job('a')],item.aiAvailable??false));
    assert.equal(result.ok,item.expected!=='invalid',item.id);
    if(result.ok)assert.equal(result.value.warnings.length>0,item.expected==='warning',item.id);
  }
});
