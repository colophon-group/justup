import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.mjs';
import { createTasks } from './tasks.mjs';
function setup(t, config = {}) {
  const s = openStore(); t.after(() => s.close()); let at = 100_000;
  return { db: s.db, tasks: createTasks({ db: s.db, now: () => at, ...config }), advance: (v) => { at += v; } };
}
const input = (extra = {}) => ({ ownerId: 'a', kind: 'search_intent', requestKey: 'one', payload: { query: 'Engineer' }, ...extra });
test('task idempotence is scoped to owner and kind and rejects reused-key payloads', (t) => {
  const { tasks } = setup(t); const one = tasks.enqueue(input());
  assert.equal(tasks.enqueue(input()).id, one.id);
  assert.notEqual(tasks.enqueue(input({ ownerId: 'b' })).id, one.id);
  assert.notEqual(tasks.enqueue(input({ kind: 'company_resolution' })).id, one.id);
  assert.throws(() => tasks.enqueue(input({ payload: { query: 'Other' } })), { status: 409 });
  assert.equal(tasks.get('b', one.id), null);
});
test('single global lease, heartbeat and recovery reject stale completion', (t) => {
  const { tasks, advance } = setup(t); const one = tasks.enqueue(input());
  const claimed = tasks.claim({ workerId: 'worker', leaseMs: 1000 });
  assert.equal(claimed.id, one.id); assert.equal(tasks.claim({ workerId: 'other' }), null);
  advance(500); assert.equal(tasks.heartbeat(one.id, claimed.leaseToken, 1000), true);
  advance(1001); assert.equal(tasks.complete(one.id, claimed.leaseToken, { status: 'succeeded' }), false);
  tasks.recover(); const next = tasks.claim({ workerId: 'other' });
  assert.equal(next.attempts, 2); assert.notEqual(next.leaseToken, claimed.leaseToken);
  assert.equal(tasks.complete(one.id, claimed.leaseToken, { status: 'succeeded' }), false);
  assert.equal(tasks.complete(one.id, next.leaseToken, { status: 'warning', output: { reason: 'unknown' } }), true);
});
test('bounded attempts terminal failure and task ceilings are durable', (t) => {
  const { tasks, advance } = setup(t, { maxAttempts: 1, maxActiveTasks: 1, maxStoredTasks: 1 }); const one = tasks.enqueue(input());
  tasks.claim({ workerId: 'worker', leaseMs: 1000 }); advance(1001); tasks.recover();
  assert.equal(tasks.get('a', one.id).status, 'failed'); assert.equal(tasks.claim({ workerId: 'worker' }), null);
  assert.throws(() => tasks.enqueue(input({ requestKey: 'two' })), { status: 429 });
  assert.throws(() => tasks.enqueue(input({ payload: { text: 'x'.repeat(16384) } })), { code: 'invalid_input' });
});
test('completed work leaves active capacity while exact retries survive a SQLite restart', (t) => {
  const directory=mkdtempSync(join(tmpdir(),'task-history-')),path=join(directory,'queue.sqlite');
  let store=openStore(path),at=100_000;
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  let tasks=createTasks({db:store.db,now:()=>at}),first;
  for(let i=0;i<96;i++){
    const task=tasks.enqueue(input({requestKey:`work:${i}`}));
    if(i===0)first=task;
    const lease=tasks.claim({workerId:'worker'});
    assert.equal(lease.id,task.id);
    assert.equal(tasks.complete(task.id,lease.leaseToken,{status:'succeeded',output:{done:i}}),true);
  }
  assert.equal(store.db.prepare("SELECT count(*) n FROM justup_tasks WHERE status IN ('pending','running')").get().n,0);
  const next=tasks.enqueue(input({requestKey:'work:96'}));
  assert.equal(next.status,'pending');
  const wire=tasks.enqueue(input({ownerId:'__hiring_wire__',kind:'hiring_wire',requestKey:'edition:next'}));
  assert.equal(wire.status,'pending');
  assert.equal(tasks.enqueue(input({requestKey:'work:0'})).id,first.id);
  store.close();store=openStore(path);tasks=createTasks({db:store.db,now:()=>at});
  assert.equal(tasks.enqueue(input({requestKey:'work:0'})).id,first.id);
  assert.equal(tasks.get('a',next.id).status,'pending');
  assert.equal(tasks.get('__hiring_wire__',wire.id).status,'pending');
  const foreground=tasks.claim({workerId:'worker'});
  assert.equal(foreground.id,next.id);
  assert.equal(tasks.complete(next.id,foreground.leaseToken,{status:'succeeded'}),true);
  assert.equal(tasks.claim({workerId:'worker'}).id,wire.id);
});
test('active and stored ceilings keep recent receipts and recover after retention', (t) => {
  const {tasks,db,advance}=setup(t,{maxActiveTasks:1,maxStoredTasks:3,retentionMs:1000});
  const finish=key=>{
    const task=tasks.enqueue(input({requestKey:key})),lease=tasks.claim({workerId:'worker'});
    assert.equal(tasks.complete(task.id,lease.leaseToken,{status:'succeeded'}),true);
    return task;
  };
  const pending=tasks.enqueue(input({requestKey:'first'}));
  assert.throws(()=>tasks.enqueue(input({requestKey:'second'})),{code:'task_limit'});
  const lease=tasks.claim({workerId:'worker'});
  assert.equal(tasks.complete(pending.id,lease.leaseToken,{status:'succeeded'}),true);
  const second=finish('second'),third=finish('third');
  assert.equal(db.prepare('SELECT count(*) n FROM justup_tasks').get().n,3);
  assert.throws(()=>tasks.enqueue(input({requestKey:'fourth'})),{code:'task_limit'});
  assert.equal(tasks.enqueue(input({requestKey:'first'})).id,pending.id);
  assert.throws(()=>tasks.enqueue(input({requestKey:'first',payload:{query:'Other'}})),{code:'idempotency_conflict'});
  assert.equal(tasks.get('a',second.id).status,'succeeded');
  assert.equal(tasks.get('a',third.id).status,'succeeded');
  advance(1001);
  const fourth=tasks.enqueue(input({requestKey:'fourth'}));
  assert.equal(fourth.status,'pending');
  assert.equal(tasks.get('a',pending.id),null);
  assert.equal(db.prepare('SELECT count(*) n FROM justup_tasks').get().n,1);
});
test('deletion and cancellation invalidate running work and public view omits private material', (t) => {
  const { tasks, db } = setup(t); const one = tasks.enqueue(input()); const lease = tasks.claim({ workerId: 'worker' });
  const view = tasks.publicView(lease); assert.equal(view.result, null); assert.equal(view.error, null);
  assert.throws(() => tasks.publicView(lease, { jobs: ['hidden'] }), /typed result/);
  const failedView = tasks.publicView({ ...lease, status: 'failed', errorCode: 'provider_raw_secret' });
  assert.deepEqual(failedView.error, { code: 'task_failed', message: 'This task could not finish.', retryable: false });
  for (const secret of ['payload', 'leaseToken', 'ownerId', 'requestKey']) assert.ok(!(secret in view));
  db.exec('BEGIN'); tasks.deleteOwner('a'); db.exec('COMMIT');
  assert.equal(tasks.complete(one.id, lease.leaseToken, { status: 'succeeded' }), false); assert.equal(tasks.get('a', one.id), null);
  const next = tasks.enqueue(input()); assert.equal(tasks.cancel('b', next.id), false); assert.equal(tasks.cancel('a', next.id), true);
  assert.equal(tasks.get('a', next.id).payload, null);
});

test('safe transient task failures report retryable while validation and unknown failures do not', (t) => {
  const { tasks } = setup(t), task = tasks.enqueue(input());
  for (const code of ['provider_unavailable', 'provider_down', 'task_timeout', 'timeout', 'rate_limit', 'provider_rate_limit']) {
    assert.equal(tasks.publicView({ ...task, status: 'failed', errorCode: code }).error.retryable, true);
  }
  for (const code of ['invalid_output', 'unsupported_requirements', 'provider_secret_value']) {
    assert.equal(tasks.publicView({ ...task, status: 'failed', errorCode: code }).error.retryable, false);
  }
});

test('private Wire work reserves its system owner and cannot produce a public task envelope', t => {
  const {tasks}=setup(t);
  assert.throws(()=>tasks.enqueue(input({kind:'hiring_wire'})),{code:'invalid_input'});
  assert.throws(()=>tasks.enqueue(input({ownerId:'__hiring_wire__'})),{code:'invalid_input'});
  const wire=tasks.enqueue(input({ownerId:'__hiring_wire__',kind:'hiring_wire'}));
  assert.equal(tasks.get('a',wire.id),null);
  assert.throws(()=>tasks.publicView(wire),{status:404});
});
test('all foreground kinds claim before older Wire work with one global lease', t => {
  const directory=mkdtempSync(join(tmpdir(),'task-priority-')),path=join(directory,'queue.sqlite');
  const store=openStore(path),rival=openStore(path);t.after(()=>{rival.close();store.close();rmSync(directory,{recursive:true,force:true});});
  const tasks=createTasks({db:store.db,now:()=>100_000}),other=createTasks({db:rival.db,now:()=>100_001});
  const wire=tasks.enqueue(input({ownerId:'__hiring_wire__',kind:'hiring_wire'}));
  const foreground=other.enqueue(input({kind:'future_foreground'}));
  assert.equal(tasks.hasForeground(),true);
  const claimed=tasks.claim({workerId:'worker'});
  assert.equal(claimed.id,foreground.id);assert.equal(other.claim({workerId:'racing-worker'}),null);
  tasks.complete(claimed.id,claimed.leaseToken,{status:'succeeded'});
  assert.equal(tasks.hasForeground(),false);assert.equal(other.claim({workerId:'racing-worker'}).id,wire.id);
});
test('Wire pause compares the live lease, never resurrects a task and bounds interruptions', t => {
  const {tasks,advance}=setup(t,{maxAttempts:2});
  const wire=tasks.enqueue(input({ownerId:'__hiring_wire__',kind:'hiring_wire'}));
  const first=tasks.claim({workerId:'worker'});
  assert.equal(tasks.pauseWire(wire.id,'wrong-lease'),false);
  assert.equal(tasks.pauseWire(wire.id,first.leaseToken),true);
  assert.equal(tasks.get(wire.ownerId,wire.id).status,'pending');
  assert.equal(tasks.pauseWire(wire.id,first.leaseToken),false);
  const second=tasks.claim({workerId:'worker'});
  assert.notEqual(second.leaseToken,first.leaseToken);
  assert.equal(tasks.pauseWire(wire.id,second.leaseToken),true);
  assert.equal(tasks.get(wire.ownerId,wire.id).status,'failed');
  assert.equal(tasks.get(wire.ownerId,wire.id).errorCode,'task_preempted');
  assert.equal(tasks.pauseWire(wire.id,second.leaseToken),false);
  const cancelled=tasks.enqueue(input({ownerId:'__hiring_wire__',kind:'hiring_wire',requestKey:'cancelled'}));
  const lease=tasks.claim({workerId:'worker',leaseMs:1000});advance(1001);
  assert.equal(tasks.pauseWire(cancelled.id,lease.leaseToken),false);
});
test('unknown cleanup halt accepts only a previously claimed private Wire identity and keeps one safe reason',t=>{
  const {tasks,db}=setup(t);
  const foreground=tasks.enqueue(input()),foregroundLease=tasks.claim({workerId:'worker'});
  assert.equal(tasks.haltWire(foreground.id,foregroundLease.leaseToken),false);
  assert.equal(tasks.complete(foreground.id,foregroundLease.leaseToken,{status:'succeeded'}),true);
  const wire=tasks.enqueue(input({ownerId:'__hiring_wire__',kind:'hiring_wire'}));
  assert.equal(tasks.haltWire(wire.id,foregroundLease.leaseToken),false);
  const lease=tasks.claim({workerId:'worker'});
  assert.equal(tasks.haltWire(wire.id,'wrong-token'),false);assert.equal(tasks.halted(),false);
  assert.equal(tasks.haltWire(wire.id,lease.leaseToken),true);assert.equal(tasks.haltWire(wire.id,lease.leaseToken),true);
  assert.equal(db.prepare('SELECT count(*) n FROM hiring_wire_cleanup_halt').get().n,1);
  assert.deepEqual({...db.prepare('SELECT reason FROM hiring_wire_cleanup_halt').get()},{reason:'cleanup_unproven'});
  assert.equal(tasks.heartbeat(wire.id,lease.leaseToken),true);
  assert.equal(tasks.complete(wire.id,lease.leaseToken,{status:'failed'}),false);
});
test('expired Wire ownership seals a halt before recovery, claim or availability can release the shared slot',async t=>{
  for(const entry of ['recover','claim','halted'])await t.test(entry,t=>{
    const {tasks,advance}=setup(t,{maxAttempts:1});
    const wire=tasks.enqueue(input({ownerId:'__hiring_wire__',kind:'hiring_wire'})),lease=tasks.claim({workerId:'worker',leaseMs:1000});
    const foreground=tasks.enqueue(input());advance(1000);
    assert.equal(tasks[entry]({workerId:'restart'}),entry==='halted'?true:entry==='claim'?null:undefined);
    assert.equal(tasks.halted(),true);assert.equal(tasks.claim({workerId:'restart'}),null);
    const held=tasks.get(wire.ownerId,wire.id);
    assert.equal(held.status,'running');assert.equal(held.leaseToken,lease.leaseToken);assert.equal(held.attempts,1);
    assert.equal(tasks.get(foreground.ownerId,foreground.id).status,'pending');
    advance(-1001);tasks.recover();assert.equal(tasks.halted(),true);assert.equal(tasks.claim({workerId:'clock-rollback'}),null);
  });
});
test('a trusted stale cleanup report halts Wire after legacy recovery or a superseding claim',async t=>{
  for(const superseded of [false,true])await t.test(String(superseded),t=>{
    const {tasks,db,advance}=setup(t);
    const wire=tasks.enqueue(input({ownerId:'__hiring_wire__',kind:'hiring_wire'})),lease=tasks.claim({workerId:'old-worker',leaseMs:1000});
    advance(1001);
    // Represent a queue recovered by an older runtime that discarded ownership
    // without native cleanup proof. Current recovery must never create this state.
    db.prepare("UPDATE justup_tasks SET status='pending',lease_until=NULL,lease_token=NULL,worker_id=NULL WHERE id=?").run(wire.id);
    if(superseded)assert.notEqual(tasks.claim({workerId:'new-worker'}).leaseToken,lease.leaseToken);
    const status=tasks.get(wire.ownerId,wire.id).status;
    assert.equal(tasks.haltWire(wire.id,lease.leaseToken),true);
    tasks.enqueue(input());tasks.recover();assert.equal(tasks.claim({workerId:'restart'}),null);
    assert.equal(tasks.halted(),true);assert.equal(tasks.get(wire.ownerId,wire.id).status,status);
  });
});
