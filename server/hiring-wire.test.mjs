// Hiring Wire service owner: immutable snapshots, internal queue/publication and
// privacy integration. Server CI lane, isolated SQLite, under two seconds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createTasks } from './tasks.mjs';
import { createRunner } from './runner.mjs';
import { createHiringWireService,WIRE_OWNER } from './hiring-wire.mjs';
import { createHiringWireEditorial,DEFAULT_SCRIPT,WIRE_PROFILE_DESCRIPTOR } from './hiring-wire-editorial.mjs';
import { AT,END,wireFixture } from './hiring-wire-fixtures.mjs';

function setup(t,{transport,source,config}={}) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());let at=AT,reads=0,calls=0,snapshot=wireFixture();
  const tasks=createTasks({db,now:()=>at});
  const defaultTransport={qualified:descriptor=>assert.deepEqual(descriptor,WIRE_PROFILE_DESCRIPTOR)===undefined,executionId:()=>`execution-${++calls}`,
    step:async({context})=>({type:'final',data:{snapshotId:context.snapshot.id,items:[{factId:context.facts[0].id,angle:context.facts[0].previous===0?'new_activity':context.facts[0].change>0?'increase':context.facts[0].change<0?'decrease':'steady'}]}})};
  const editorial=createHiringWireEditorial({transport:transport??defaultTransport});
  const service=createHiringWireService({db,tasks,now:()=>at,source:source??{authoritative:true,version:'wire-history-v1',readSnapshot:async()=>{reads++;return snapshot;}},editorial,config});
  const runner=createRunner({tasks,handlers:{hiring_wire:service.runTask},workerId:'wire-test'});
  return {db,tasks,service,runner,setNow:value=>at=value,replaceSnapshot:value=>snapshot=value,reads:()=>reads,calls:()=>calls};
}
const read=service=>service.publicRoute({method:'GET',path:'/hiring-wire'}).body;

test('weekly queue publishes one immutable edition and exposes only approved aggregates',async t=>{
  const {service,runner,tasks,db,calls}=setup(t),task=service.enqueuePeriod(END);
  assert.equal(read(service).state,'unavailable');assert.equal(service.capabilities().hiringWire,false);
  assert.equal(service.enqueuePeriod(END).id,task.id);assert.equal(task.ownerId,WIRE_OWNER);
  assert.equal(await runner.runOnce(),true);assert.equal(tasks.get(WIRE_OWNER,task.id).status,'succeeded');
  const edition=read(service).edition;
  assert.equal(edition.expiresAt,'2026-11-09T00:00:00.000Z');
  assert.equal(edition.items[0].activity.current,3);assert.equal(service.capabilities().hiringWire,true);
  for(const restricted of ['restricted-old','restricted-new','internal-board','coverage','script','executionId','account','query','body'])assert.equal(JSON.stringify(edition).includes(restricted),false);
  assert.equal(service.publicRoute({method:'GET',path:'/hiring-wire/editions/2026-11-02'}).body.state,'published');
  assert.equal(service.enqueuePeriod(END).id,task.id);assert.equal(await runner.runOnce(),false);assert.equal(calls(),1);
  assert.throws(()=>db.prepare("UPDATE hiring_wire_editions SET public_json='{}'").run(),/immutable/);
  assert.throws(()=>db.prepare("UPDATE hiring_wire_editions SET snapshot_json='{}'").run(),/immutable/);
  assert.equal(service.taskResult(task),undefined);
});
test('a failed editorial attempt retries frozen facts despite a changed source',async t=>{
  let attempts=0;const {service,runner,tasks,reads,db,replaceSnapshot}=setup(t,{transport:{qualified:()=>true,executionId:()=>`attempt-${++attempts}`,step:async({context})=>{
    if(attempts===1)throw new Error('private provider message');
    return {type:'final',data:{snapshotId:context.snapshot.id,items:[{factId:context.facts[0].id,angle:'increase'}]}};
  }}});
  const first=service.enqueuePeriod(END);await runner.runOnce();
  assert.equal(tasks.get(WIRE_OWNER,first.id).status,'failed');assert.equal(read(service).edition,null);assert.equal(reads(),1);
  const frozen=db.prepare('SELECT snapshot_sha256 FROM hiring_wire_editions').get().snapshot_sha256;
  const changed=wireFixture();changed.snapshotId='changed-source';changed.postings=[];replaceSnapshot(changed);
  assert.throws(()=>db.prepare("UPDATE hiring_wire_editions SET period_id='2026-10-26'").run(),/immutable/);
  const retry=service.enqueuePeriod(END);assert.notEqual(retry.id,first.id);assert.equal(service.enqueuePeriod(END).id,retry.id);
  await runner.runOnce();assert.equal(tasks.get(WIRE_OWNER,retry.id).status,'succeeded');assert.equal(reads(),1);
  assert.equal(read(service).edition.items[0].activity.current,3);
  assert.equal(db.prepare('SELECT snapshot_sha256 FROM hiring_wire_editions').get().snapshot_sha256,frozen);
  assert.deepEqual(db.prepare('SELECT outcome FROM hiring_wire_executions ORDER BY started_at,id').all().map(x=>x.outcome).sort(),['failed','published']);
});
test('a publication failure rolls back queue success and can retry the same edition',async t=>{
  const {service,runner,tasks,db}=setup(t);const original=tasks.complete;let fail=true;
  tasks.complete=(...args)=>fail?false:original(...args);
  const first=service.enqueuePeriod(END);await runner.runOnce();
  assert.equal(read(service).state,'unavailable');assert.equal(db.prepare('SELECT status FROM hiring_wire_editions').get().status,'pending');
  // Simulate the runner's expired-lease recovery after the failed final commit.
  fail=false;tasks.complete(first.id,tasks.get(WIRE_OWNER,first.id).leaseToken,{status:'failed',errorCode:'task_interrupted'});
  service.enqueuePeriod(END);await runner.runOnce();assert.equal(read(service).state,'published');
});
test('lease cancellation before completion cannot publish late model output',async t=>{
  let taskId;const {service,runner,tasks}=setup(t,{transport:{qualified:()=>true,executionId:()=>'cancelled-execution',step:async({context})=>{
    tasks.cancel(WIRE_OWNER,taskId);return {type:'final',data:{snapshotId:context.snapshot.id,items:[{factId:context.facts[0].id,angle:'increase'}]}};
  }}});
  taskId=service.enqueuePeriod(END).id;await runner.runOnce();assert.equal(read(service).edition,null);assert.equal(tasks.get(WIRE_OWNER,taskId).status,'cancelled');
});
test('missing history, unavailable Sol and unapproved outputs keep publication closed',async t=>{
  for(const mode of ['no-history','sparse','unapproved','fabricated']) {
    await t.test(mode,async t=>{
      const snapshot=wireFixture();if(mode==='sparse')snapshot.scopes[0].coverage=[];
      const {service,runner,tasks}=setup(t,{source:{authoritative:mode!=='no-history',version:'wire-history-v1',readSnapshot:async()=>snapshot},transport:{qualified:()=>mode!=='unapproved',executionId:()=>'bad-execution',step:async({context})=>({type:'final',data:{snapshotId:context.snapshot.id,items:[{factId:context.facts[0].id,angle:'increase',headline:'This company hired 900 people'}]}})}});
      const task=service.enqueuePeriod(END);await runner.runOnce();assert.equal(read(service).state,'unavailable');assert.equal(tasks.get(WIRE_OWNER,task.id).status,'failed');
    });
  }
});
test('published reads need no owner while mutation and account task generation have no route',async t=>{
  const {service,tasks}=setup(t);
  for(const method of ['POST','PUT','DELETE'])assert.equal(service.publicRoute({method,path:'/hiring-wire'}),null);
  assert.equal(service.publicRoute({method:'GET',path:'/hiring-wire/generate'}),null);
  assert.equal(service.publicRoute({method:'GET',path:'/hiring-wire/editions/2026-10-26'}).body.edition,null);
  assert.equal((await service.runTask({ownerId:'private-user',kind:'hiring_wire',payload:{periodEnd:END}})).status,'failed');
  const task=service.enqueuePeriod(END);assert.equal(tasks.get('private-user',task.id),null);
});
test('versioned script updates have an effect and reject unsafe scripts and stale replacements',async t=>{
  const {service,runner,db}=setup(t);const initial=service.workspace.read();
  const changed=service.workspace.replace(initial.revision,{...DEFAULT_SCRIPT,sort:'most_activity',minCurrent:2,maxItems:1});
  assert.notEqual(changed.revision,initial.revision);assert.throws(()=>service.workspace.replace(initial.revision,DEFAULT_SCRIPT));
  assert.throws(()=>service.workspace.replace(changed.revision,{...DEFAULT_SCRIPT,command:'cat /private/auth'}));
  service.enqueuePeriod(END);await runner.runOnce();
  assert.deepEqual(JSON.parse(db.prepare('SELECT workspace_json FROM hiring_wire_editions').get().workspace_json),changed);
});
test('private deletion does not attach account state to editions and retention remains bounded',async t=>{
  const {service,runner,db,setNow}=setup(t);service.enqueuePeriod(END);await runner.runOnce();
  service.deleteAccountData('deleted-user');assert.equal(read(service).state,'published');
  for(let i=0;i<40;i++){const script=service.workspace.read();service.workspace.replace(script.revision,{...script.script,minCurrent:i+1});}
  assert.equal(db.prepare('SELECT count(*) n FROM hiring_wire_tool_versions').get().n,32);
  setNow(AT+31*86_400_000);service.cleanup();assert.equal(db.prepare('SELECT count(*) n FROM hiring_wire_executions').get().n,0);
  assert.equal(read(service).state,'unavailable');
  assert.equal(service.publicRoute({method:'GET',path:'/hiring-wire/editions/2026-11-02'}).body.state,'published');
});
test('current edition expires at the fixed next-week boundary while archive stays historical',async t=>{
  const {service,runner,setNow}=setup(t);service.enqueuePeriod(END);await runner.runOnce();
  setNow(Date.parse('2026-11-08T23:59:59.999Z'));assert.equal(read(service).state,'published');
  setNow(Date.parse('2026-11-09T00:00:00.000Z'));assert.equal(read(service).state,'unavailable');assert.equal(service.capabilities().hiringWire,false);
  assert.equal(service.publicRoute({method:'GET',path:'/hiring-wire/editions/2026-11-02'}).body.edition.expiresAt,'2026-11-09T00:00:00.000Z');
});
test('weekly continuity reads prior editions and retains the configured complete history budget',async t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());let at=AT,priorCounts=[];
  const tasks=createTasks({db,now:()=>at});
  const source={authoritative:true,version:'wire-history-v1',readSnapshot:async({periodEnd})=>{
    const snapshot=wireFixture(),offset=Date.parse(periodEnd)-Date.parse(END),shift=value=>new Date(Date.parse(value)+offset).toISOString();
    snapshot.snapshotId=`snapshot-${periodEnd.slice(0,10)}`;snapshot.asOf=periodEnd;snapshot.generatedAt=new Date(at).toISOString();
    snapshot.scopes[0].lastVerifiedAt=periodEnd;snapshot.scopes[0].coverage[0].start=shift(snapshot.scopes[0].coverage[0].start);snapshot.scopes[0].coverage[0].end=periodEnd;
    snapshot.postings=snapshot.postings.map(posting=>({...posting,id:`${posting.id}-${periodEnd.slice(0,10)}`,firstObserved:shift(posting.firstObserved)}));return snapshot;
  }};
  const editorial=createHiringWireEditorial({transport:{qualified:()=>true,executionId:()=>`edition-${at}`,step:async({context})=>{
    priorCounts.push(context.previousEditions.length);return {type:'final',data:{snapshotId:context.snapshot.id,items:[{factId:context.facts[0].id,angle:'counts'}]}};
  }}});
  const service=createHiringWireService({db,tasks,source,editorial,now:()=>at,config:{retainedEditions:8}}),runner=createRunner({tasks,handlers:{hiring_wire:service.runTask},workerId:'history'});
  for(let i=0;i<9;i++){at=AT+i*7*86_400_000;service.enqueuePeriod(new Date(Date.parse(END)+i*7*86_400_000).toISOString());await runner.runOnce();}
  assert.deepEqual(priorCounts,[0,1,2,3,4,5,6,7,8]);assert.equal(db.prepare("SELECT count(*) n FROM hiring_wire_editions WHERE status='published'").get().n,8);
  assert.equal(service.publicRoute({method:'GET',path:'/hiring-wire/editions/2026-11-02'}).body.state,'unavailable');
  assert.equal(read(service).edition.id,'2026-12-28');
});
