// Lease/deadline tests for the provider-free bounded worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunner } from './runner.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createTasks } from './tasks.mjs';

function queue(kind='search_intent') {
  const record={id:'task',ownerId:'owner',kind,status:'pending',leaseToken:'lease',output:null};let claims=0,completions=0,beats=0;
  const tasks={claim({kinds}){claims++;if(record.status!=='pending'||!kinds.includes(kind))return null;record.status='running';return {...record};},heartbeat(){beats++;return record.status==='running';},complete(id,token,result){completions++;if(record.status!=='running'||token!==record.leaseToken)return false;Object.assign(record,result);return true;},get:()=>record,recover(){}};
  return {tasks,record,get claims(){return claims;},get completions(){return completions;},get beats(){return beats;}};
}
test('runner dispatches injected handler exactly once and does not claim concurrently',async()=>{
  const q=queue();let release,calls=0;const runner=createRunner({tasks:q.tasks,handlers:{search_intent:async(task,{signal})=>{calls++;assert.equal(signal.aborted,false);return new Promise(resolve=>release=resolve);}}});
  const pending=runner.runOnce();await Promise.resolve();assert.equal(await runner.runOnce(),false);release({status:'succeeded',output:{searchId:'s',revision:1}});assert.equal(await pending,true);assert.equal(await runner.runOnce(),false);assert.equal(calls,1);assert.equal(q.completions,1);
});
test('task deadline aborts handler and clears lease with a safe failure',async()=>{
  const q=queue();let signal;const runner=createRunner({tasks:q.tasks,taskTimeoutMs:20,handlers:{search_intent:async(_,opts)=>{signal=opts.signal;return new Promise(()=>{});}}});
  assert.equal(await runner.runOnce(),true);assert.equal(signal.aborted,true);assert.equal(q.record.status,'failed');assert.equal(q.record.errorCode,'task_timeout');
});
test('handler exceptions and invalid terminal output become safe task failures',async()=>{
  for(const handler of [()=>{throw Error('private prompt');},()=>({status:'made_up'})]) {const q=queue();await createRunner({tasks:q.tasks,handlers:{search_intent:handler}}).runOnce();assert.equal(q.record.status,'failed');assert.ok(['task_failed','invalid_output'].includes(q.record.errorCode));assert.equal(JSON.stringify(q.record).includes('private'),false);}
});
test('atomic service completion is verified and never completed twice',async()=>{
  const q=queue();const output={searchId:'s',revision:1};const runner=createRunner({tasks:q.tasks,handlers:{search_intent:task=>{q.tasks.complete(task.id,task.leaseToken,{status:'succeeded',output});return {status:'succeeded',output,committed:true};}}});
  await runner.runOnce();assert.equal(q.record.status,'succeeded');assert.equal(q.completions,1);
});
test('deleting a running task prevents a late successful handler from recreating it',async()=>{
  const q=queue();let release;const runner=createRunner({tasks:q.tasks,handlers:{search_intent:()=>new Promise(resolve=>release=resolve)}}),pending=runner.runOnce();await Promise.resolve();q.record.status='deleted';release({status:'succeeded',output:{searchId:'s'}});await pending;assert.equal(q.record.status,'deleted');
});
test('shutdown aborts active work and the polling loop exits',async()=>{
  const q=queue();let started;const ready=new Promise(resolve=>started=resolve),shutdown=new AbortController();const runner=createRunner({tasks:q.tasks,handlers:{search_intent:()=>{started();return new Promise(()=>{});}}});
  const running=runner.run({signal:shutdown.signal});await ready;shutdown.abort();await running;assert.equal(q.record.status,'failed');assert.equal(q.record.errorCode,'task_timeout');
});
test('fixed maintenance hook enqueues before a claim and shares foreground priority',async t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());const tasks=createTasks({db}),order=[];
  const runner=createRunner({tasks,beforeClaim:()=>{
    tasks.enqueue({ownerId:'__hiring_wire__',kind:'hiring_wire',requestKey:'week',payload:{}});
    tasks.enqueue({ownerId:'owner',kind:'search_intent',requestKey:'search',payload:{}});
  },handlers:{hiring_wire:()=>{order.push('wire');return {status:'succeeded'};},search_intent:()=>{order.push('search');return {status:'succeeded'};}}});
  await runner.runOnce();await runner.runOnce();assert.deepEqual(order,['search','wire']);
});
test('foreground arrival aborts Wire and waits cleanup before releasing its lease',async t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());const tasks=createTasks({db});
  const wire=tasks.enqueue({ownerId:'__hiring_wire__',kind:'hiring_wire',requestKey:'week',payload:{}});
  let started,cleaning,releaseCleanup,cleaned=false,attempt=0;
  const active=new Promise(resolve=>started=resolve),cancelling=new Promise(resolve=>cleaning=resolve);
  const runner=createRunner({tasks,pollMs:10,handlers:{
    hiring_wire:async(_,{signal})=>{
      if(++attempt>1)return {status:'succeeded'};
      started();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
      assert.equal(signal.reason.code,'task_preempted');cleaning();
      await new Promise(resolve=>releaseCleanup=resolve);cleaned=true;
      return {status:'paused',errorCode:'task_preempted'};
    },search_intent:()=>{assert.equal(cleaned,true);return {status:'succeeded'};}
  }});
  const running=runner.runOnce();await active;
  const foreground=tasks.enqueue({ownerId:'owner',kind:'search_intent',requestKey:'search',payload:{}});
  await cancelling;
  assert.equal(tasks.get(wire.ownerId,wire.id).status,'running');
  assert.equal(tasks.claim({workerId:'other'}),null);assert.equal(await runner.runOnce(),false);
  releaseCleanup();await running;
  assert.equal(tasks.get(wire.ownerId,wire.id).status,'pending');
  await runner.runOnce();assert.equal(tasks.get('owner',foreground.id).status,'succeeded');
  await runner.runOnce();assert.equal(tasks.get(wire.ownerId,wire.id).status,'succeeded');
});
test('preemption cannot resurrect Wire when cancellation invalidated its lease',async t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());const tasks=createTasks({db});
  const wire=tasks.enqueue({ownerId:'__hiring_wire__',kind:'hiring_wire',requestKey:'week',payload:{}});
  const runner=createRunner({tasks,pollMs:10,handlers:{hiring_wire:async(_,{signal})=>{
    tasks.enqueue({ownerId:'owner',kind:'search_intent',requestKey:'search',payload:{}});
    await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
    tasks.cancel(wire.ownerId,wire.id);return {status:'paused'};
  }}});
  await runner.runOnce();assert.equal(tasks.get(wire.ownerId,wire.id).status,'cancelled');
});
