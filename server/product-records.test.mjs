// Real SQLite contracts for bounded metadata, deletion, execution and operator
// reports. Fixed clocks and synthetic observations; no model/provider execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProductRecords,RECORD_RETENTION_MS } from './product-records.mjs';
import { compareEvaluation,checkedCase,CASE_RETENTION_MS } from './evaluation-records.mjs';
import { migrateSchemaV1 } from './schema.mjs';
import { createTasks } from './tasks.mjs';
import { runProductRecordsCli } from './product-records-cli.mjs';

const AT=Date.parse('2026-11-01T16:00:00Z');
const cases=JSON.parse(readFileSync(new URL('./evals/reviewed-cases.json',import.meta.url))).cases;
function fixture(t,options={}) {
  const db=new DatabaseSync(options.path??':memory:');let time=AT,barriers=0,blocked=false;
  const owners=new Map([['owner',{account:{id:'owner'},access:{kind:'free',fullAccess:true},interfaceLocale:'de'}],['visitor:one',{visitor:{id:'visitor:one'},access:{kind:'guest'},interfaceLocale:'en'}]]);
  const now=()=>time,tasks=createTasks({db,now});
  const records=createProductRecords({db,tasks,now,ownerAuthority:id=>owners.get(id),beforePrivateDelete:()=>{if(blocked)throw Error('private barrier detail');barriers++;},...options});
  t.after(()=>db.close());return {db,records,tasks,owners,advance:ms=>time+=ms,block:()=>blocked=true,barriers:()=>barriers};
}
test('fixed metadata allowlist, duplicate suppression and report expose no private identifiers or content',t=>{
  const f=fixture(t),event={ownerId:'owner',event:'search_submitted',key:'task-1',referenceId:'search-1',outcome:'accepted'};
  assert.equal(f.records.observe(event),true);assert.equal(f.records.observe(event),false);
  for(const extra of [{query:'private raw query'},{url:'https://private.example'},{ip:'127.0.0.1'},{error:'private failure'}])assert.equal(f.records.observe({...event,key:'bad',...extra}),false);
  assert.equal(f.records.observe({...event,ownerId:'deleted'}),false);
  const row=f.db.prepare('SELECT * FROM justup_journey_events').get();assert.equal(row.locale,'de');assert.equal(row.segment,'free');assert.notEqual(row.event_key,'task-1');
  const report=f.records.report(),json=JSON.stringify(report);assert.equal(report.cohorts[0].observedOwners,1);for(const raw of ['search-1','task-1','private raw query','owner_id'])assert(!json.includes(raw));
  assert(report.warnings.some(w=>w.includes('incomplete')));assert(report.warnings.some(w=>w.includes('not unique people')));
});
test('retention and row caps are transactional; a failed deletion barrier rolls back optional collection',t=>{
  const f=fixture(t,{maxEvents:2});
  for(let i=0;i<3;i++)f.records.observe({ownerId:'owner',event:'search_submitted',key:`task-${i}`,outcome:'accepted'});
  assert.equal(f.db.prepare('SELECT count(*) n FROM justup_journey_events').get().n,2);assert.equal(f.barriers(),1);
  f.advance(RECORD_RETENTION_MS);f.records.cleanup();assert.equal(f.db.prepare('SELECT count(*) n FROM justup_journey_events').get().n,0);
  for(let i=0;i<2;i++)f.records.observe({ownerId:'owner',event:'search_submitted',key:`new-${i}`,outcome:'accepted'});
  f.block();assert.equal(f.records.observe({ownerId:'owner',event:'search_submitted',key:'cannot-evict',outcome:'accepted'}),false);
  assert.equal(f.db.prepare('SELECT count(*) n FROM justup_journey_events').get().n,2);
  f.advance(RECORD_RETENTION_MS);assert.equal(f.records.cleanup(),false);assert.equal(f.db.prepare('SELECT count(*) n FROM justup_journey_events').get().n,2);
});
test('execution joins real queue attempts, repair counts and numeric metrics; retries and late deletion never inflate runs',async t=>{
  const f=fixture(t),queued=f.tasks.enqueue({ownerId:'owner',kind:'search_intent',requestKey:'one',payload:{query:'private query must stay out',searchId:'search-1'}}),task=f.tasks.claim({workerId:'fixture'});
  const handler=async()=>{f.records.onModelMetric({kind:'search_intent',model:'gpt-6-luna',usage:{inputTokens:12,outputTokens:4},rawTrace:'private trace'});f.records.compilation(false);f.records.compilation(true);return {status:'succeeded',output:{searchId:'search-1'}};};
  await f.records.runTask(task,handler);await f.records.runTask(task,handler);
  const rows=f.db.prepare('SELECT * FROM justup_model_executions').all();assert.equal(rows.length,1);assert.equal(rows[0].input_tokens,12);assert.equal(rows[0].compilation_failures,1);assert.equal(rows[0].repairs,1);assert.equal(rows[0].cost_nanodollars,null);assert.match(rows[0].prompt_version,/^[a-f0-9]{64}$/);
  assert(!JSON.stringify(rows).includes('private'));assert.equal(f.records.report().executions[0].unknownCostRuns,1);
  let release;const pending=f.records.runTask(task,async()=>{await new Promise(resolve=>release=resolve);return {status:'failed',errorCode:'private exception'};});
  f.db.exec('BEGIN IMMEDIATE');f.records.deleteAccountData('owner');f.tasks.deleteOwner('owner');f.owners.delete('owner');f.db.exec('COMMIT');release();await pending;
  assert.equal(f.db.prepare('SELECT count(*) n FROM justup_model_executions').get().n,0);assert.equal(f.tasks.get('owner',queued.id),null);
});
test('reviewed versions are immutable, bounded, split from tuning and never auto-copy referenced user content',t=>{
  const f=fixture(t),collection=f.records.evaluations;
  for(const row of cases)assert.equal(collection.importCase(row),true);
  assert.equal(collection.importCase(cases[0]),false);assert.throws(()=>collection.importCase({...cases[0],expected:{outcome:'invalid'}}));
  assert.throws(()=>collection.importCase({...cases[0],version:2,split:'tuning'}));
  assert.throws(()=>checkedCase({...cases[0],sessionToken:'must-not-import'}));assert.throws(()=>checkedCase({...cases[0],source:'user_activity'}));
  assert.equal(collection.stage({ownerId:'owner',referenceId:'search-1',revision:1,task:'search_intent',reason:'edit_requires_review'}),true);
  assert.deepEqual(Object.keys(f.db.prepare('SELECT * FROM justup_evaluation_candidates').get()).sort(),['at','owner_id','reason','reference_id','revision','task']);
  assert.equal(collection.exportCases().cases.length,cases.length);f.advance(CASE_RETENTION_MS);f.records.cleanup();assert.equal(collection.exportCases().cases.length,0);assert.equal(f.db.prepare('SELECT count(*) n FROM justup_evaluation_candidates').get().n,0);
});
test('held-out comparison includes failed/missing observations and unknown costs in insufficient evidence',()=>{
  const heldout=cases.filter(row=>row.split==='heldout'),baseline=heldout.map(row=>({id:row.id,version:row.version,failed:false,output:row.expected,durationMs:10,inputTokens:10,outputTokens:2,costNanodollars:null}));
  const candidate=structuredClone(baseline);candidate[0].failed=true;candidate[0].output=null;candidate.pop();
  const report=compareEvaluation(cases,baseline,candidate);assert.equal(report.status,'insufficient_evidence');assert.equal(report.baseline.counts.pass,heldout.length);assert.equal(report.candidate.counts.failed,1);assert.equal(report.candidate.counts.missing,1);assert.equal(report.candidate.heldoutCases,heldout.length);assert.equal(report.candidate.knownCostNanodollars,null);
  assert.throws(()=>compareEvaluation(cases,[...baseline,baseline[0]],candidate));
});
test('operator CLI defaults to aggregate and explicitly imports/exports only reviewed bounded cases',t=>{
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'justup-records-')));t.after(()=>rmSync(directory,{recursive:true,force:true}));const path=join(directory,'records.sqlite'),f=fixture(t,{path});
  f.records.observe({ownerId:'owner',event:'search_submitted',key:'private-task',referenceId:'private-search',outcome:'accepted'});
  const bundle=join(directory,'reviewed.json');writeFileSync(bundle,JSON.stringify({version:1,cases}));
  assert.equal(JSON.parse(runProductRecordsCli(['--db',path,'cases-import',bundle])).imported,cases.length);
  assert.equal(JSON.parse(runProductRecordsCli(['--db',path,'cases-export'])).cases.length,cases.length);
  const report=runProductRecordsCli(['--db',path]);assert(!report.includes('private-search'));assert(!report.includes('Backend at Acme'));
  const large=join(directory,'large.json');writeFileSync(large,'x'.repeat(4*1024*1024+1));assert.throws(()=>runProductRecordsCli(['--db',path,'cases-import',large]));
});


test('stable product evidence survives the offline epoch-one rename without a collection-owned version bump',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(readFileSync(new URL('./fixtures/schema-v1.sql',import.meta.url),'utf8'));
  const records=createProductRecords({db,now:()=>AT,ownerAuthority:id=>id==='owner'?{account:{id},access:{kind:'free'}}:null});
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,1);
  records.observe({ownerId:'owner',event:'search_submitted',key:'task-1',referenceId:'search-1',outcome:'accepted'});records.evaluations.importCase(cases[0]);records.evaluations.stage({ownerId:'owner',referenceId:'search-1',revision:1,task:'search_intent',reason:'edit_requires_review'});
  const tables=['justup_journey_events','justup_model_executions','justup_evaluation_candidates','justup_evaluation_cases'],rows=()=>tables.map(name=>db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()),before=rows();
  migrateSchemaV1(db);assert.deepEqual(rows(),before);assert.equal(db.prepare('PRAGMA user_version').get().user_version,2);
});

test('matching execution preserves confirmed numeric cost and keeps an ambiguous attempt cost unknown',async t=>{
  const f=fixture(t);
  for(const ambiguous of [0,1]){
    f.tasks.enqueue({ownerId:'owner',kind:'ai_match',requestKey:`matching-${ambiguous}`,payload:{scanId:'scan-1'}});const task=f.tasks.claim({workerId:'fixture',kinds:['ai_match']});
    const result=await f.records.runTask(task,async()=>({status:'succeeded',output:{inputTokens:20,outputTokens:2,costNanodollars:840,attempts:1,ambiguousAttempts:ambiguous,evaluated:2,cacheHits:1,insufficient:1}}));f.tasks.complete(task.id,task.leaseToken,result);
  }
  const rows=f.db.prepare('SELECT cost_nanodollars,evaluated FROM justup_model_executions ORDER BY rowid').all();assert.deepEqual(rows.map(row=>row.cost_nanodollars),[840,null]);assert(rows.every(row=>row.evaluated===2));
});

test('policy closure or changed task binding suppresses new private evidence while retained cleanup remains available',async t=>{
  let paused=false,key='reviewed-fr';
  const viewer={account:{id:'owner'},access:{kind:'paid',fullAccess:true},interfaceLocale:'fr'};
  const f=fixture(t,{ownerAuthority:(owner,{allowUnavailable=false,locale='fr'}={})=>owner==='owner'&&(allowUnavailable||!paused&&locale==='fr')?{...viewer,processingPolicy:{key}}:null});
  assert.equal(f.records.observe({ownerId:'owner',event:'report_served',key:'before-pause',locale:'fr',outcome:'accepted'}),true);
  const staged={ownerId:'owner',referenceId:'search-1',revision:1,task:'search_intent',reason:'edit_requires_review',locale:'fr'};
  assert.equal(f.records.evaluations.stage(staged),true);
  f.tasks.enqueue({ownerId:'owner',kind:'search_intent',requestKey:'queued',payload:{searchId:'search-1',presentationLocale:'fr',policyKey:key}});
  const task=f.tasks.claim({workerId:'fixture'});let release;
  const pending=f.records.runTask(task,()=>new Promise(resolve=>release=()=>resolve({status:'failed',errorCode:'processing_unavailable'})));
  key='changed-fr';release();await pending;
  assert.equal(f.db.prepare('SELECT count(*) n FROM justup_model_executions').get().n,0);
  paused=true;
  assert.equal(f.records.observe({ownerId:'owner',event:'report_served',key:'during-pause',locale:'fr',outcome:'accepted'}),false);
  assert.equal(f.records.evaluations.stage({...staged,revision:2}),false);
  f.records.taskFinished(task);assert.equal(f.db.prepare('SELECT count(*) n FROM justup_journey_events').get().n,1);
  f.advance(RECORD_RETENTION_MS);assert.equal(f.records.cleanup(),true);
  for(const table of ['justup_journey_events','justup_model_executions','justup_evaluation_candidates'])assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
});
