import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createTasks } from './tasks.mjs';
import { PREVIEW_DB, readHostForegroundAge, runAlertSignalsCli } from './alert-signals-cli.mjs';

test('fixed host collector opens only the preview path read-only and emits aggregate age', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'justup-alert-cli-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const source = new DatabaseSync(join(folder, 'fixture.sqlite'));
  t.after(() => source.close());
  const tasks = createTasks({ db: source, now: () => 100_000 });
  tasks.enqueue({ ownerId: 'private-account', kind: 'search_intent', requestKey: 'private-key',
    payload: { query: 'never-print-this' } });
  let seen;
  const result = readHostForegroundAge({
    inspect: path => { assert.equal(path, PREVIEW_DB); return { isFile: () => true,
      isSymbolicLink: () => false, nlink: 1, mode: 0o100660, uid: 1234 }; },
    canonical: path => path, uid: () => 1234,
    open: (path, options) => { seen = { path, options }; return new DatabaseSync(join(folder, 'fixture.sqlite'), options); },
    now: () => 105_000,
  });
  assert.deepEqual(seen, { path: PREVIEW_DB, options: { readOnly: true } });
  assert.deepEqual(result, { activeCount: 1, oldestAgeSeconds: 5 });
  const out = [], err = [];
  assert.equal(runAlertSignalsCli([], { collect: () => ({ ...result, secret: 'never-print-this' }),
    stdout: { write: value => out.push(value) }, stderr: { write: value => err.push(value) } }), 0);
  assert.equal(out.join(''), '{"activeCount":1,"oldestAgeSeconds":5}\n');
  assert.deepEqual(err, []);
});

test('collector refuses wrong identity and CLI hides database errors and caller arguments', () => {
  let opened = 0;
  const common = { inspect: () => ({ isFile: () => true, isSymbolicLink: () => false,
    nlink: 1, mode: 0o100660, uid: 1234 }), canonical: path => path,
    open: () => { opened++; throw new Error('private path or payload'); } };
  assert.throws(() => readHostForegroundAge({ ...common, uid: () => 0 }), /caller identity/);
  assert.throws(() => readHostForegroundAge({ ...common, uid: () => 5678 }), /caller identity/);
  assert.equal(opened, 0);
  const out = [], err = [];
  const io = { collect: () => { throw new Error('private path or payload'); },
    stdout: { write: value => out.push(value) }, stderr: { write: value => err.push(value) } };
  assert.equal(runAlertSignalsCli([], io), 1);
  assert.equal(runAlertSignalsCli(['--db', '/tmp/private.sqlite'], io), 1);
  assert.deepEqual(out, []);
  assert.deepEqual(err, ['Justup alert signal unavailable.\n', 'Justup alert signal unavailable.\n']);
  const processResult = spawnSync(process.execPath,
    ['--no-warnings', fileURLToPath(new URL('./alert-signals-cli.mjs', import.meta.url)), '--db', '/tmp/private.sqlite'],
    { encoding: 'utf8' });
  assert.equal(processResult.status, 1);
  assert.equal(processResult.stdout, '');
  assert.equal(processResult.stderr, 'Justup alert signal unavailable.\n');
});
