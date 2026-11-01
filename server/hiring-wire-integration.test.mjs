// Weekly integration contracts: real SQLite and editorial dispatcher, fixed
// synthetic source/fake transport only. Server CI lane; no native/provider calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTasks } from './tasks.mjs';
import { createRunner } from './runner.mjs';
import { createHiringWireApi,createHiringWireRunner,hiringWirePeriodEnd } from './hiring-wire-integration.mjs';
import { SOURCE_COVERAGE_VERSION } from './source-coverage.mjs';
import { AT,END,wireFixture } from './hiring-wire-fixtures.mjs';

const model={enabled:true,attestationPath:'/unavailable/wire-proof.json',providerCatalogueSha256:'a'.repeat(64),modelUid:995,socketPath:'/unavailable/model.sock'};
const identity={buildIdentity:'b'.repeat(64),hostPlanSha256:'c'.repeat(64)};
const sourceCoverage={directory:'/protected/history',sourceVersion:SOURCE_COVERAGE_VERSION};
const published=api=>api.publicRoute({method:'GET',path:'/hiring-wire'}).body;
function state(t,{path=':memory:',at=AT}={}) {
  const db=new DatabaseSync(path);t.after(()=>{try{db.close();}catch{}});
  let instant=at;const now=()=>instant,tasks=createTasks({db,now});
  return {db,tasks,now,setNow:value=>instant=value};
}
function fakes({snapshot=()=>{const value=wireFixture();value.sourceVersion=SOURCE_COVERAGE_VERSION;return value;},step,cancel}={}) {
  let reads=0,calls=0,cancels=0,turn=0;
  return {reads:()=>reads,calls:()=>calls,cancels:()=>cancels,factories:{
    source:()=>({authoritative:true,version:SOURCE_COVERAGE_VERSION,readSnapshot:async()=>{reads++;return snapshot();}}),
    transport:({config})=>{
      assert.equal(config.buildIdentity,identity.buildIdentity);assert.equal(config.hostPlanSha256,identity.hostPlanSha256);
      return {qualified:()=>true,executionId:()=>`integration-execution-${++turn}`,
        async step(request,options){calls++;return step?step(request,options):{type:'final',data:{snapshotId:request.context.snapshot.id,items:[{factId:request.context.facts[0].id,angle:'increase'}]}};},
        async cancel(){cancels++;await cancel?.();}};
    }
  }};
}
async function composition(s,fake,extra={}) {
  const wire=await createHiringWireRunner({...s,...identity,hiringWire:model,sourceCoverage,factories:fake.factories,...extra});
  const runner=createRunner({tasks:s.tasks,handlers:{hiring_wire:wire.runTask},beforeClaim:wire.beforeClaim,workerId:'weekly-test',pollMs:10});
  return {wire,runner,api:createHiringWireApi({db:s.db,now:s.now})};
}

test('UTC schedule uses the most recent fixed Monday without local-time drift',()=>{
  assert.equal(hiringWirePeriodEnd(Date.parse('2026-11-01T23:59:59.999Z')),'2026-10-26T00:00:00.000Z');
  assert.equal(hiringWirePeriodEnd(Date.parse(END)),END);
  assert.equal(hiringWirePeriodEnd(Date.parse('2026-11-08T23:59:59.999Z')),END);
});
test('default disabled runner schedules nothing and public reader ignores private configuration',async t=>{
  const s=state(t),deps={db:s.db,now:s.now};
  for(const key of ['hiringWire','sourceCoverage','buildIdentity','hostPlanSha256'])Object.defineProperty(deps,key,{get(){throw Error('private configuration read');}});
  const api=createHiringWireApi(deps),wire=await createHiringWireRunner(s);
  assert.deepEqual(wire.beforeClaim(),{state:'disabled'});assert.equal(published(api).state,'unavailable');
  assert.deepEqual(Object.keys(api).sort(),['capabilities','publicRoute']);
  assert.equal(s.db.prepare('SELECT count(*) n FROM demo_tasks').get().n,0);
});
test('enabled weekly path publishes synthetic facts once across SQLite restart and expiry',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'wire-integration-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const path=join(directory,'weekly.sqlite'),s=state(t,{path}),fake=fakes();
  const {runner,wire,api}=await composition(s,fake);
  assert.equal(await runner.runOnce(),true);assert.equal(published(api).edition.items[0].activity.current,3);
  assert.equal(fake.reads(),1);assert.equal(fake.calls(),1);assert.equal(fake.cancels(),1);
  for(let i=0;i<20;i++)assert.equal(wire.beforeClaim().state,'published');
  assert.equal(s.db.prepare('SELECT count(*) n FROM demo_tasks').get().n,1);
  s.db.close();
  const restarted=state(t,{path}),next=await composition(restarted,fake);
  assert.equal(await next.runner.runOnce(),false);assert.equal(fake.calls(),1);
  assert.equal(published(next.api).state,'published');
  restarted.setNow(Date.parse(END)+7*86_400_000);
  assert.equal(published(next.api).state,'unavailable');
  assert.equal(next.api.publicRoute({method:'GET',path:'/hiring-wire/editions/2026-11-02'}).body.state,'published');
  for(const method of ['POST','PUT','DELETE'])assert.equal(next.api.publicRoute({method,path:'/hiring-wire'}),null);
});
test('missing source makes zero editorial calls and dependency retries stop after bounded backoff',async t=>{
  const s=state(t),fake=fakes(),{runner,wire,api}=await composition(s,fake,{sourceCoverage:undefined});
  await runner.runOnce();assert.equal(published(api).state,'unavailable');
  assert.equal(wire.beforeClaim().state,'dependency_unavailable');
  for(let i=0;i<100;i++)wire.beforeClaim();
  assert.equal(s.db.prepare('SELECT count(*) n FROM demo_tasks').get().n,1);
  s.setNow(AT+15*60_000);await runner.runOnce();wire.beforeClaim();
  s.setNow(AT+15*60_000+2*60*60_000);await runner.runOnce();wire.beforeClaim();
  s.setNow(AT+86_400_000);for(let i=0;i<100;i++)wire.beforeClaim();
  assert.equal(s.db.prepare('SELECT count(*) n FROM demo_tasks').get().n,3);
  assert.equal(fake.calls(),0);assert.equal(fake.reads(),0);
});
test('actual transport with missing independent proof makes zero broker or editorial calls',async t=>{
  const s=state(t),fake=fakes();delete fake.factories.transport;
  const {runner,wire,api}=await composition(s,fake);
  await runner.runOnce();assert.equal(wire.beforeClaim().state,'dependency_unavailable');
  assert.equal(published(api).state,'unavailable');assert.equal(fake.reads(),1);assert.equal(fake.calls(),0);
});
test('invalid facts and unsupported editorial output never get an automatic lucky retry',async t=>{
  for(const mode of ['facts','quality'])await t.test(mode,async t=>{
    const s=state(t),fake=fakes(mode==='facts'?{snapshot:()=>({...wireFixture(),sourceVersion:SOURCE_COVERAGE_VERSION,privateQuery:'forbidden'})}:{step:()=>({type:'final',data:{snapshotId:'invented',items:[]}})});
    const {runner,wire,api}=await composition(s,fake);await runner.runOnce();
    assert.equal(wire.beforeClaim().state,'invalid_output');
    s.setNow(AT+86_400_000);for(let i=0;i<100;i++)wire.beforeClaim();
    assert.equal(s.db.prepare('SELECT count(*) n FROM demo_tasks').get().n,1);assert.equal(published(api).state,'unavailable');
  });
});
test('scheduler restart rediscovers an enqueued task if its durable reference write was interrupted',async t=>{
  const s=state(t),fake=fakes(),first=await composition(s,fake);
  first.wire.beforeClaim();const task=s.db.prepare('SELECT id FROM demo_tasks').get().id;
  s.db.prepare("UPDATE hiring_wire_schedule SET task_id=NULL,attempts=0,outcome='pending'").run();
  const restarted=await composition(s,fake);restarted.wire.beforeClaim();
  assert.equal(s.db.prepare('SELECT count(*) n FROM demo_tasks').get().n,1);
  assert.equal(s.db.prepare('SELECT task_id FROM hiring_wire_schedule').get().task_id,task);
  await restarted.runner.runOnce();assert.equal(fake.calls(),1);
});
test('configuration pins source version and rejects JSON identity or caller-selected modules',async t=>{
  const s=state(t);
  for(const extra of [{hiringWire:{...model,buildIdentity:'d'.repeat(64)}},{sourceCoverage:{...sourceCoverage,sourceVersion:'caller-version'}},
    {sourceCoverage:{...sourceCoverage,directory:'/protected/../other'}},{sourceCoverage:{...sourceCoverage,module:'/tmp/caller.mjs'}}]) {
    await assert.rejects(createHiringWireRunner({...s,...identity,hiringWire:model,sourceCoverage,...extra}),TypeError);
  }
});
test('preempted weekly editorial awaits cleanup, publishes nothing, then resumes the same task after foreground work',async t=>{
  const s=state(t);let started,cleaning,releaseCleanup,turn=0,cancellations=0,cleaned=false;
  const active=new Promise(resolve=>started=resolve),cleanup=new Promise(resolve=>cleaning=resolve);
  const fake=fakes({step:async(request,{signal})=>{
    if(++turn===1) {
      started();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{code:'task_timeout'})),{once:true}));
    }
    return {type:'final',data:{snapshotId:request.context.snapshot.id,items:[{factId:request.context.facts[0].id,angle:'increase'}]}};
  },cancel:async()=>{if(++cancellations===1){cleaning();await new Promise(resolve=>releaseCleanup=resolve);cleaned=true;}}});
  const {wire,api}=await composition(s,fake),runner=createRunner({tasks:s.tasks,beforeClaim:wire.beforeClaim,pollMs:10,handlers:{
    hiring_wire:wire.runTask,search_intent:()=>{assert.equal(cleaned,true);return {status:'succeeded'};}
  }});
  const pending=runner.runOnce();await active;
  const wireId=s.db.prepare("SELECT id FROM demo_tasks WHERE kind='hiring_wire'").get().id;
  const foreground=s.tasks.enqueue({ownerId:'account',kind:'search_intent',requestKey:'interactive',payload:{}});
  await cleanup;
  assert.equal(published(api).state,'unavailable');assert.equal(s.tasks.get('__hiring_wire__',wireId).status,'running');
  assert.equal(s.tasks.claim({workerId:'racing-runner'}),null);
  releaseCleanup();await pending;
  assert.equal(s.tasks.get('__hiring_wire__',wireId).status,'pending');assert.equal(published(api).state,'unavailable');
  assert.equal(s.db.prepare('SELECT error_code FROM hiring_wire_executions').get().error_code,'task_preempted');
  await runner.runOnce();assert.equal(s.tasks.get('account',foreground.id).status,'succeeded');
  await runner.runOnce();assert.equal(published(api).state,'published');assert.equal(fake.cancels(),2);
  assert.equal(s.db.prepare("SELECT count(*) n FROM demo_tasks WHERE kind='hiring_wire'").get().n,1);
});
test('unproven native cleanup durably halts claim/recovery/scheduling across reopen and elapsed lease',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'wire-halt-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const path=join(directory,'halt.sqlite'),s=state(t,{path});let unready=0;
  const fake=fakes({cancel:()=>{throw Object.assign(Error('fixed cleanup failure'),{code:'cleanup_unproven'});}});
  const {wire,api}=await composition(s,fake);
  const runner=createRunner({tasks:s.tasks,beforeClaim:wire.beforeClaim,onHalt:()=>unready++,handlers:{hiring_wire:wire.runTask}});
  t.after(()=>runner.stop());await runner.runOnce();
  const held=s.db.prepare("SELECT id,lease_token FROM demo_tasks WHERE kind='hiring_wire'").get();
  assert.equal(unready,1);assert.equal(runner.ready(),false);assert.equal(s.tasks.halted(),true);
  assert.equal(published(api).state,'unavailable');assert.equal(s.tasks.get('__hiring_wire__',held.id).status,'running');
  assert.equal(s.tasks.complete(held.id,held.lease_token,{status:'succeeded'}),false);
  assert.equal(s.tasks.pauseWire(held.id,held.lease_token),false);
  s.tasks.enqueue({ownerId:'account',kind:'search_intent',requestKey:'foreground',payload:{}});
  assert.equal(await runner.runOnce(),false);assert.deepEqual(wire.beforeClaim(),{state:'cleanup_unproven'});
  assert.equal(s.db.prepare('SELECT count(*) n FROM hiring_wire_cleanup_halt').get().n,1);
  runner.stop();s.db.close();
  const restarted=state(t,{path,at:AT+86_400_000}),next=await composition(restarted,fake);
  restarted.tasks.recover();assert.equal(restarted.tasks.claim({workerId:'restart'}),null);
  assert.equal(restarted.tasks.get('__hiring_wire__',held.id).status,'running');
  assert.deepEqual(next.wire.beforeClaim(),{state:'cleanup_unproven'});
  assert.equal(await next.runner.runOnce(),false);assert.equal(fake.calls(),1);
  assert.equal(restarted.db.prepare('SELECT count(*) n FROM demo_tasks').get().n,2);
  assert.equal(restarted.db.prepare('SELECT count(*) n FROM hiring_wire_schedule').get().n,1);
});
