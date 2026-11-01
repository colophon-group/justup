import test from 'node:test';
import assert from 'node:assert/strict';
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
  const { tasks, advance } = setup(t, { maxAttempts: 1, maxTasks: 1 }); const one = tasks.enqueue(input());
  tasks.claim({ workerId: 'worker', leaseMs: 1000 }); advance(1001); tasks.recover();
  assert.equal(tasks.get('a', one.id).status, 'failed'); assert.equal(tasks.claim({ workerId: 'worker' }), null);
  assert.throws(() => tasks.enqueue(input({ requestKey: 'two' })), { status: 429 });
  assert.throws(() => tasks.enqueue(input({ payload: { text: 'x'.repeat(16384) } })), { code: 'invalid_input' });
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
  const {tasks,db,advance}=setup(t),other=createTasks({db,now:()=>100_001});
  const wire=tasks.enqueue(input({ownerId:'__hiring_wire__',kind:'hiring_wire'}));advance(1);
  const foreground=tasks.enqueue(input({kind:'future_foreground'}));
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
test('unknown cleanup halt requires the exact live system lease and keeps one durable safe reason',t=>{
  const {tasks,db}=setup(t);
  const wire=tasks.enqueue(input({ownerId:'__hiring_wire__',kind:'hiring_wire'})),lease=tasks.claim({workerId:'worker'});
  assert.equal(tasks.haltWire(wire.id,'wrong-token'),false);assert.equal(tasks.halted(),false);
  assert.equal(tasks.haltWire(wire.id,lease.leaseToken),true);assert.equal(tasks.haltWire(wire.id,lease.leaseToken),true);
  assert.equal(db.prepare('SELECT count(*) n FROM hiring_wire_cleanup_halt').get().n,1);
  assert.deepEqual({...db.prepare('SELECT reason FROM hiring_wire_cleanup_halt').get()},{reason:'cleanup_unproven'});
  assert.equal(tasks.heartbeat(wire.id,lease.leaseToken),true);
  assert.equal(tasks.complete(wire.id,lease.leaseToken,{status:'failed'}),false);
});
