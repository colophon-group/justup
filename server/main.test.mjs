import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, truncateSync, statSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDemo, createDeletionBarrier, readImportFile, configFromEnv } from './main.mjs';

test('feature deletion and tasks compose synchronously inside the auth transaction', async (t) => {
  let cleanup;
  const demo = await createDemo({ config: { allowedOrigin: 'https://preview.example' },
    authFactory: ({ deleteAccountData }) => { cleanup = deleteAccountData; return {}; },
    serviceFactories: [({ db }) => {
      db.exec('CREATE TABLE feature_private(owner_id TEXT, data TEXT)');
      return { deleteAccountData: (id) => db.prepare('DELETE FROM feature_private WHERE owner_id=?').run(id) };
    }] }); t.after(() => demo.close());
  demo.store.db.prepare('INSERT INTO feature_private VALUES (?,?)').run('a', 'private');
  const task = demo.tasks.enqueue({ ownerId: 'a', kind: 'search_intent', requestKey: 'one', payload: {} });
  assert.throws(() => demo.store.transaction(() => { cleanup('a'); throw new Error('rollback'); }), /rollback/);
  assert.equal(demo.tasks.get('a', task.id).id, task.id);
  assert.equal(demo.store.db.prepare('SELECT count(*) AS n FROM feature_private').get().n, 1);
  demo.store.transaction(() => cleanup('a'));
  assert.equal(demo.tasks.get('a', task.id), null);
  assert.equal(demo.store.db.prepare('SELECT count(*) AS n FROM feature_private').get().n, 0);
});
test('persistent demo files are private, imports are bounded and env flags are explicit', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'justup-demo-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'private', 'demo.sqlite');
  const demo = await createDemo({ config: { dbPath: path, allowedOrigin: 'https://preview.example' }, authFactory: () => ({}) });
  assert.equal(statSync(path).mode & 0o777, 0o600); await demo.close();
  const input = join(dir, 'snapshot.json'); writeFileSync(input, '{}'); assert.deepEqual(readImportFile(input), {});
  writeFileSync(input, '{sensitive source text'); assert.throws(() => readImportFile(input), { message: 'Invalid demo import file.' });
  truncateSync(input, 64 * 1024 * 1024 + 1); assert.throws(() => readImportFile(input), /64 MiB/);
  const env = configFromEnv({ JUSTUP_DEMO_POLICIES_REVIEWED: 'yes', JUSTUP_DEMO_ALLOW_LOCAL_HTTP: 'true' });
  assert.equal(env.policiesReviewed, false); assert.equal(env.allowInsecureLocalhost, true);
});
test('health/version expose fixed identity and explicitly unavailable runner', async (t) => {
  const demo = await createDemo({ config: { allowedOrigin: 'https://preview.example', sourceCommit: 'a'.repeat(40), buildIdentity: 'build-a' }, authFactory: () => ({ session: () => null }) });
  await new Promise((r) => demo.server.listen(0, '127.0.0.1', r));
  t.after(async () => { demo.server.closeAllConnections(); await demo.close(); });
  const base = `http://127.0.0.1:${demo.server.address().port}/api/v1`;
  const health = await (await fetch(base + '/health')).json(); assert.equal(health.ready, true); assert.equal(health.runner.ready, false);
  const version = await (await fetch(base + '/version')).json(); assert.equal(version.sourceCommit, 'a'.repeat(40));
  assert.equal(version.buildIdentity, 'build-a'); assert.equal(version.schemaVersion, 1); assert.equal(version.importGeneration, null);
});

test('deletion rotates and flushes recovery generation before private SQL commit; unsafe storage fails closed', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'justup-deletion-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const backupDir = join(dir, 'backups'), generationPath = join(dir, 'private-generation');
  mkdirSync(backupDir, { mode: 0o700 }); const old = '00000000-0000-4000-8000-000000000000\n';
  writeFileSync(generationPath, old); writeFileSync(join(backupDir, 'snapshot.sqlite'), 'private'); writeFileSync(join(backupDir, 'snapshot.json'), '{}');
  let cleanup;
  const demo = await createDemo({ config: { allowedOrigin: 'https://preview.example', privateGenerationPath: generationPath, backupDir },
    authFactory: ({ deleteAccountData }) => { cleanup = deleteAccountData; return {}; } }); t.after(() => demo.close());
  const task = demo.tasks.enqueue({ ownerId: 'a', kind: 'search_intent', requestKey: 'one', payload: {} });
  assert.throws(() => demo.store.transaction(() => { cleanup('a'); throw new Error('later SQL failure'); }), /later SQL failure/);
  assert.notEqual(readFileSync(generationPath, 'utf8'), old); assert.deepEqual(readdirSync(backupDir), []);
  assert.ok(demo.tasks.get('a', task.id)); // rollback keeps data but cannot restore its older backup.
  const before = readFileSync(generationPath, 'utf8'); mkdirSync(join(backupDir, 'unsafe-directory'));
  const barrier = createDeletionBarrier({ generationPath, backupDir }); assert.equal(barrier.ready(), false);
  assert.throws(() => demo.store.transaction(() => cleanup('a')), /backup storage/);
  assert.equal(readFileSync(generationPath, 'utf8'), before); assert.ok(demo.tasks.get('a', task.id));
});
