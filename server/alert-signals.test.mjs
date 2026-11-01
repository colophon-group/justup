import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from './store.mjs';
import { createTasks } from './tasks.mjs';
import { readForegroundTaskAge } from './alert-signals.mjs';

test('foreground age includes pending and running work but excludes background and terminal work', (t) => {
  const store = openStore();
  t.after(() => store.close());
  let at = 100_000;
  const tasks = createTasks({ db: store.db, now: () => at });
  const signal = () => readForegroundTaskAge({ db: store.db, now: () => at });
  assert.deepEqual(signal(), { activeCount: 0, oldestAgeSeconds: null });

  tasks.enqueue({ ownerId: '__hiring_wire__', kind: 'hiring_wire', requestKey: 'background', payload: { secret: 'private' } });
  at += 1_000;
  const search = tasks.enqueue({ ownerId: 'account-a', kind: 'search_intent', requestKey: 'search', payload: { query: 'private' } });
  at += 1_000;
  const company = tasks.enqueue({ ownerId: 'account-b', kind: 'company_resolution', requestKey: 'company', payload: { name: 'private' } });
  at += 3_500;
  assert.deepEqual(signal(), { activeCount: 2, oldestAgeSeconds: 4 });
  assert.ok(!JSON.stringify(signal()).includes('private'));

  const running = tasks.claim({ workerId: 'runner', kinds: ['search_intent'] });
  assert.equal(running.id, search.id);
  assert.deepEqual(signal(), { activeCount: 2, oldestAgeSeconds: 4 });
  assert.equal(tasks.complete(search.id, running.leaseToken, { status: 'succeeded' }), true);
  assert.deepEqual(signal(), { activeCount: 1, oldestAgeSeconds: 3 });
  assert.equal(tasks.cancel('account-b', company.id), true);
  assert.deepEqual(signal(), { activeCount: 0, oldestAgeSeconds: null });
  tasks.enqueue({ ownerId: 'account-c', kind: 'billing_terminate', requestKey: 'cleanup', payload: {} });
  assert.deepEqual(signal(), { activeCount: 1, oldestAgeSeconds: 0 });
});

test('missing or future task evidence fails instead of reporting a healthy zero', (t) => {
  const store = openStore();
  t.after(() => store.close());
  const at = 100_000;
  assert.throws(() => readForegroundTaskAge({ db: store.db, now: () => at }), /no such table/);
  const tasks = createTasks({ db: store.db, now: () => at });
  const task = tasks.enqueue({ ownerId: 'account-a', kind: 'search_intent', requestKey: 'one', payload: {} });
  store.db.prepare('UPDATE justup_tasks SET created_at=? WHERE id=?').run(at + 1, task.id);
  assert.throws(() => readForegroundTaskAge({ db: store.db, now: () => at }), /timestamp is invalid/);
  assert.throws(() => readForegroundTaskAge({ db: store.db, now: () => Number.NaN }), /clock is invalid/);
});
