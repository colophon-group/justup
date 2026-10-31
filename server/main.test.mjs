import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, truncateSync, statSync, mkdirSync, readFileSync, readdirSync, existsSync, chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from './store.mjs';
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
  assert.throws(() => demo.withPrivateTransaction(() => { cleanup('a'); throw new Error('later SQL failure'); }), /later SQL failure/);
  assert.notEqual(readFileSync(generationPath, 'utf8'), old); assert.deepEqual(readdirSync(backupDir), []);
  assert.ok(demo.tasks.get('a', task.id)); // rollback keeps data but cannot restore its older backup.
  const before = readFileSync(generationPath, 'utf8'); mkdirSync(join(backupDir, 'unsafe-directory'));
  const barrier = createDeletionBarrier({ generationPath, backupDir }); assert.equal(barrier.ready(), false);
  assert.throws(() => demo.withPrivateTransaction(() => cleanup('a')), /backup storage/);
  assert.equal(readFileSync(generationPath, 'utf8'), before); assert.ok(demo.tasks.get('a', task.id));
});

// A separate process performs SQLite's real online backup while the writer holds
// an uncommitted deletion. Generation-only consumers used to accept this copy.
const COPY_DURING_TRANSACTION = `
import json, os, sqlite3, sys
source, target, generation = sys.argv[1:]
def stable():
    one = open(generation).read()
    if os.path.lexists(generation + '.pending'):
        return None
    two = open(generation).read()
    return one if one == two else None
before = stable()
observed_generation = open(generation).read()
reader = sqlite3.connect(source, timeout=2)
writer = sqlite3.connect(target, timeout=2)
reader.backup(writer)
count = writer.execute('SELECT count(*) FROM private_records').fetchone()[0]
writer.close(); reader.close()
after = stable()
print(json.dumps({'count':count,'generation':observed_generation,'before':before,'after':after}))
`;
test('real concurrent SQLite backup is rejected throughout pending deletion and old backups fail after commit', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'justup-backup-race-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const backupDir = join(dir, 'backups'), generationPath = join(dir, 'private-generation'), dbPath = join(dir, 'live.sqlite');
  mkdirSync(backupDir); const old = '00000000-0000-4000-8000-000000000000\n'; writeFileSync(generationPath, old);
  const demo = await createDemo({ config: { dbPath, privateGenerationPath: generationPath, backupDir, allowedOrigin: 'https://preview.example' }, authFactory: () => ({}) });
  t.after(() => demo.close()); demo.store.db.exec("CREATE TABLE private_records(id TEXT); INSERT INTO private_records VALUES('account-a');");
  const snapshot = join(dir, 'raced.sqlite'); let raced;
  demo.withPrivateTransaction(() => {
    demo.beforePrivateDelete(); demo.store.db.exec('DELETE FROM private_records');
    assert.equal(demo.store.db.isTransaction, true); assert.ok(existsSync(generationPath + '.pending'));
    assert.throws(() => demo.afterPrivateTransaction(), /has not ended/);
    const copied = spawnSync('python3', ['-c', COPY_DURING_TRANSACTION, dbPath, snapshot, generationPath], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(copied.status, 0, copied.stderr); raced = JSON.parse(copied.stdout);
    assert.equal(raced.count, 1); // SQLite copied the old committed private row.
    assert.equal(raced.generation, readFileSync(generationPath, 'utf8')); // generation alone would accept it.
    assert.equal(raced.before, null); assert.equal(raced.after, null); // stable consumers reject pending on both sides.
    assert.ok(existsSync(generationPath + '.pending'));
  });
  assert.equal(demo.store.db.isTransaction, false); assert.equal(existsSync(generationPath + '.pending'), false);
  assert.equal(demo.store.db.prepare('SELECT count(*) AS n FROM private_records').get().n, 0);
  assert.notEqual(readFileSync(generationPath, 'utf8'), old); // A pre-deletion backup cannot restore under the live generation.
  const copy = new DatabaseSync(snapshot, { readOnly: true });
  assert.equal(copy.prepare('SELECT count(*) AS n FROM private_records').get().n, 1); copy.close();
});
test('crash-retained and replaced pending markers are never cleared by a different owner', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'justup-pending-owner-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const backupDir = join(dir, 'backups'), generationPath = join(dir, 'private-generation'), dbPath = join(dir, 'live.sqlite');
  mkdirSync(backupDir); writeFileSync(generationPath, '00000000-0000-4000-8000-000000000000\n');
  const store = openStore(dbPath), first = createDeletionBarrier({ db: store.db, dbPath, generationPath, backupDir });
  store.db.exec('BEGIN IMMEDIATE'); first.beforePrivateDelete(); store.db.exec('ROLLBACK');
  const pendingPath = generationPath + '.pending', foreign = JSON.stringify({ version: 1, token: 'foreign-owner' }) + '\n';
  unlinkSync(pendingPath); writeFileSync(pendingPath, foreign);
  assert.throws(() => first.afterPrivateTransaction(), /ownership changed/); assert.equal(readFileSync(pendingPath, 'utf8'), foreign);
  store.close(); const reopened = openStore(dbPath); t.after(() => reopened.close());
  const next = createDeletionBarrier({ db: reopened.db, dbPath, generationPath, backupDir });
  assert.equal(next.ready(), false); next.afterPrivateTransaction(); assert.ok(existsSync(pendingPath));
  reopened.db.exec('BEGIN IMMEDIATE'); assert.throws(() => next.beforePrivateDelete(), /pending/); reopened.db.exec('ROLLBACK');
  next.afterPrivateTransaction(); assert.equal(readFileSync(pendingPath, 'utf8'), foreign);
  const demo = await createDemo({ config: { dbPath, privateGenerationPath: generationPath, backupDir, allowedOrigin: 'https://preview.example',
    policiesReviewed: true, privacyUrl: 'https://preview.example/privacy', usageUrl: 'https://preview.example/usage', policyVersion: 'synthetic', inviteCode: 'synthetic' },
    authFactory: () => ({ cleanup: () => ({}), session: () => null }) });
  await new Promise((r) => demo.server.listen(0, '127.0.0.1', r));
  try {
    const session = await (await fetch(`http://127.0.0.1:${demo.server.address().port}/api/v1/session`)).json();
    assert.equal(session.authentication.loginEnabled, false); assert.equal(session.authentication.reason, 'deletion_unavailable');
    assert.equal(readFileSync(pendingPath, 'utf8'), foreign);
  } finally { demo.server.closeAllConnections(); await demo.close(); }
});
test('shared API/queue storage keeps DB, WAL and SHM group-private and rejects unsafe setup', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'justup-shared-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'demo.sqlite'), oldMask = process.umask(0o007);
  try {
    chmodSync(dir, 0o2770);
    const demo = await createDemo({ config: { dbPath: path, sharedState: true, allowedOrigin: 'https://preview.example' }, authFactory: () => ({}) });
    try {
      demo.store.db.exec('CREATE TABLE shared_probe(id INTEGER); INSERT INTO shared_probe VALUES(1);');
      for (const file of [path, path + '-wal', path + '-shm']) assert.equal(statSync(file).mode & 0o777, 0o660);
      assert.equal(statSync(dir).mode & 0o7777, 0o2770);
    } finally { await demo.close(); }
    process.umask(0o077); assert.throws(() => openStore(path, { sharedState: true }), /umask/);
    process.umask(0o007); chmodSync(dir, 0o0770); assert.throws(() => openStore(path, { sharedState: true }), /02770/);
  } finally { process.umask(oldMask); }
});
