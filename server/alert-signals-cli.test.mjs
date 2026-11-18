// Fixed-identity observer with disposable SQLite and synthetic runner evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { openStore, DAY_MS } from './store.mjs';
import { createTasks } from './tasks.mjs';
import { PREVIEW_DB, readHostAlertSignals, runAlertSignalsCli } from './alert-signals-cli.mjs';

const at = Date.parse('2026-11-01T12:00:00Z');
const generation = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const env = { JUSTUP_SOURCE_COMMIT: 'a'.repeat(40), JUSTUP_BUILD_ID: 'b'.repeat(64), JUSTUP_OBSERVE_RUNNER_UID: '1235' };
const inspect = () => ({ isFile: () => true, isSymbolicLink: () => false, nlink: 1, mode: 0o100660, uid: 1234 });
const defaults = { env, inspect, canonical: path => path, uid: () => 1234, now: () => at };

test('fixed host input joins read-only SQLite age and same-build runner signals without private contents', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'justup-alert-cli-'));
  const path = join(folder, 'fixture.sqlite');
  const source = openStore(path);
  t.after(() => { source.close(); rmSync(folder, { recursive: true, force: true }); });
  const tasks = createTasks({ db: source.db, now: () => at - 5000 });
  tasks.enqueue({ ownerId: 'private-account', kind: 'search_intent', requestKey: 'private-key',
    payload: { query: 'never-print-this' } });
  const old = at - DAY_MS;
  source.db.prepare('INSERT INTO justup_imports VALUES (?, ?, ?, ?, 0, 0)').run(generation, at - 1, at - 1,
    JSON.stringify({ source: 'jobseek_feed_v1', feed: { complete: true, fullSnapshotAt: new Date(old).toISOString() },
      secret: 'never-print-this' }));
  let seen;
  const result = readHostAlertSignals({ ...defaults,
    open: (fixed, options) => { seen = { path: fixed, options }; return new DatabaseSync(path, options); },
    runner: ({ expectedOwner, config }) => {
      assert.equal(expectedOwner, 1235);
      assert.deepEqual(config, { dbPath: PREVIEW_DB, sourceCommit: env.JUSTUP_SOURCE_COMMIT, buildIdentity: env.JUSTUP_BUILD_ID });
      return { ready: false, ageMs: 125_000, identity: 'private-runner',
        capabilities: { search: false, companyRequests: false, aiMatching: false } };
    },
  });
  assert.deepEqual(seen, { path: PREVIEW_DB, options: { readOnly: true } });
  assert.deepEqual(result, { schemaVersion: 1, sourceCommit: env.JUSTUP_SOURCE_COMMIT, buildIdentity: env.JUSTUP_BUILD_ID,
    databaseReadable: true, jobFeed: { stale: true, importGeneration: generation, verificationAgeSeconds: 86_400 },
    foregroundQueue: { activeCount: 1, oldestAgeSeconds: 5 },
    runner: { ready: false, heartbeatAgeSeconds: 125, search: false, companyRequests: false, aiMatching: false } });
  assert.doesNotMatch(JSON.stringify(result), /private-|never-print-this/u);
});

test('missing and unsafe evidence remain independent of a live runner signal', () => {
  const collector = { ...defaults, runner: () => ({ ready: true, ageMs: 0,
    capabilities: { search: true, companyRequests: true, aiMatching: false } }) };
  let opened = 0;
  const open = () => { opened++; throw new Error('private path or payload'); };
  assert.throws(() => readHostAlertSignals({ ...collector, uid: () => 0, open }), /invalid alert collector identity/iu);
  const missing = readHostAlertSignals({ ...collector, inspect: () => { throw new Error('missing'); }, open });
  const unsafe = readHostAlertSignals({ ...collector, inspect: () => ({ ...inspect(), uid: 42 }), open });
  assert.equal(opened, 0);
  assert.deepEqual(unsafe, missing);
  assert.deepEqual(missing, { schemaVersion: 1, sourceCommit: env.JUSTUP_SOURCE_COMMIT, buildIdentity: env.JUSTUP_BUILD_ID,
    databaseReadable: false, jobFeed: null, foregroundQueue: null,
    runner: { ready: true, heartbeatAgeSeconds: 0, search: true, companyRequests: true, aiMatching: false } });
  // Use a separate file connection in the success test. Here a disposable
  // empty database proves an unsupported schema cannot become healthy zero.
  const invalidSchema = readHostAlertSignals({ ...collector, open: () => new DatabaseSync(':memory:') });
  assert.deepEqual(invalidSchema, missing);
  const withoutTasks = readHostAlertSignals({ ...collector, open: () => openStore().db });
  assert.equal(withoutTasks.databaseReadable, true);
  assert.deepEqual(withoutTasks.jobFeed, { stale: true, importGeneration: null, verificationAgeSeconds: null });
  assert.equal(withoutTasks.foregroundQueue, null);
});

test('the observer refuses caller paths and does not expose diagnostic exceptions', () => {
  const out = [], err = [];
  const io = { collect: () => { throw new Error('private path or payload'); },
    stdout: { write: value => out.push(value) }, stderr: { write: value => err.push(value) } };
  assert.equal(runAlertSignalsCli([], io), 1);
  assert.equal(runAlertSignalsCli(['--db', '/tmp/private.sqlite'], io), 1);
  assert.deepEqual(out, []);
  assert.deepEqual(err, ['Justup alert inputs unavailable.\n', 'Justup alert inputs unavailable.\n']);
  const processResult = spawnSync(process.execPath,
    ['--no-warnings', fileURLToPath(new URL('./alert-signals-cli.mjs', import.meta.url)), '--db', '/tmp/private.sqlite'],
    { encoding: 'utf8' });
  assert.equal(processResult.status, 1);
  assert.equal(processResult.stdout, '');
  assert.equal(processResult.stderr, 'Justup alert inputs unavailable.\n');
});
