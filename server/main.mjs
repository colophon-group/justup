// Compose the isolated demo API. Direct execution requires explicit demo storage
// and build configuration; import createDemo to add reviewed feature services.
import { createServer } from 'node:http';
import { mkdirSync, chmodSync, readFileSync, statSync, lstatSync, readdirSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, unlinkSync, accessSync, constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve, isAbsolute, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStore } from './store.mjs';
import { createFeed } from './feed.mjs';
import { createTasks } from './tasks.mjs';
import { createHandler } from './http.mjs';

// Invalidate old private snapshots before a SQL deletion can commit. A later SQL
// rollback may invalidate extra backups, which is safer than restoring deleted data.
export function createDeletionBarrier({ generationPath, backupDir, dbPath } = {}) {
  if (!generationPath && !backupDir && (dbPath == null || dbPath === ':memory:')) return { ready: () => true, beforePrivateDelete: () => {} };
  const configured = typeof generationPath === 'string' && typeof backupDir === 'string'
    && isAbsolute(generationPath) && isAbsolute(backupDir);
  const inside = (root, path) => { const rel = relative(resolve(root), resolve(path)); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
  function validate() {
    if (!configured || inside(backupDir, generationPath) || (dbPath && dbPath !== ':memory:' && inside(backupDir, dbPath))) throw new Error('Private deletion storage is unavailable.');
    for (const directory of [dirname(generationPath), backupDir]) {
      if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('Private deletion storage is unavailable.');
      accessSync(directory, constants.W_OK);
    }
    if (lstatSync(generationPath).size > 64 || !lstatSync(generationPath).isFile() || lstatSync(generationPath).isSymbolicLink()
        || !/^[a-f0-9-]{36}\n?$/.test(readFileSync(generationPath, 'utf8'))) throw new Error('Private deletion generation is unavailable.');
    const files = readdirSync(backupDir).map((name) => resolve(backupDir, name));
    if (files.some((file) => !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())) throw new Error('Private backup storage is unavailable.');
    return files;
  }
  function syncDirectory(path) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
  function beforePrivateDelete() {
    const files = validate(), temporary = `${generationPath}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = openSync(temporary, 'wx', 0o600);
      writeFileSync(fd, `${randomUUID()}\n`); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, generationPath); syncDirectory(dirname(generationPath));
      for (const file of files) unlinkSync(file);
      syncDirectory(backupDir);
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return { ready: () => { try { validate(); return true; } catch { return false; } }, beforePrivateDelete };
}
export async function createDemo({ config = {}, now = Date.now, serviceFactories = [], authFactory, logger } = {}) {
  const path = config.dbPath ?? ':memory:';
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const store = openStore(path);
  if (path !== ':memory:') chmodSync(path, 0o600);
  try {
    const feed = createFeed({ db: store.db, now, cursorSecret: config.cursorSecret, verificationTtlMs: config.verificationTtlMs });
    const tasks = createTasks({ db: store.db, now });
    const deletion = createDeletionBarrier({ generationPath: config.privateGenerationPath, backupDir: config.backupDir, dbPath: path });
    const services = serviceFactories.flatMap((factory) => factory({ db: store.db, feed, tasks, config, now, beforePrivateDelete: deletion.beforePrivateDelete }));
    if (services.some((s) => !s || typeof s.then === 'function')) throw new TypeError('Service factories must synchronously return services.');
    const deleteAccountData = (ownerId) => {
      deletion.beforePrivateDelete();
      for (const service of services) {
        const result = service.deleteAccountData?.(ownerId);
        if (result && typeof result.then === 'function') throw new TypeError('Deletion hooks must be synchronous.');
      }
      tasks.deleteOwner(ownerId);
    };
    const createAuth = authFactory ?? (await import('./auth.mjs')).createAuth;
    const auth = createAuth({ db: store.db, config, now, deleteAccountData });
    let maintenanceReady = false;
    function maintainAuth() {
      try {
        if (typeof auth.cleanup !== 'function') return;
        const result = auth.cleanup();
        if (result && typeof result.then === 'function') throw new TypeError('Authentication cleanup must be synchronous.');
        maintenanceReady = true;
      } catch { maintenanceReady = false; }
    }
    maintainAuth();
    const maintenanceTimer = setInterval(maintainAuth, 60_000); maintenanceTimer.unref();
    const handler = createHandler({ auth, feed, tasks, db: store.db, services,
      config: { ...config, deletionReady: deletion.ready, authMaintenanceReady: () => maintenanceReady }, now, logger });
    const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 16_384 }, handler);
    server.keepAliveTimeout = 5000;
    server.maxRequestsPerSocket = 100;
    return { server, store, feed, tasks, auth, services, close: async () => {
      clearInterval(maintenanceTimer);
      if (server.listening) await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
      store.close();
    } };
  } catch (error) { store.close(); throw error; }
}
export function readImportFile(path) {
  if (statSync(path).size > 64 * 1024 * 1024) throw new Error('Demo import exceeds the 64 MiB limit.');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path))); }
  catch { throw new Error('Invalid demo import file.'); }
}
export function configFromEnv(env = process.env) {
  return {
    dbPath: env.JUSTUP_DEMO_DB_PATH, allowedOrigin: env.JUSTUP_DEMO_ORIGIN,
    allowInsecureLocalhost: env.JUSTUP_DEMO_ALLOW_LOCAL_HTTP === 'true',
    inviteCode: env.JUSTUP_DEMO_INVITE_CODE, privacyUrl: env.JUSTUP_DEMO_PRIVACY_URL,
    usageUrl: env.JUSTUP_DEMO_USAGE_URL, policyVersion: env.JUSTUP_DEMO_POLICY_VERSION,
    policiesReviewed: env.JUSTUP_DEMO_POLICIES_REVIEWED === 'true',
    sourceCommit: env.JUSTUP_DEMO_SOURCE_COMMIT, buildIdentity: env.JUSTUP_DEMO_BUILD_ID,
    csrfSecret: env.JUSTUP_DEMO_CSRF_SECRET, cursorSecret: env.JUSTUP_DEMO_CURSOR_SECRET,
    privateGenerationPath: env.JUSTUP_DEMO_PRIVATE_GENERATION_PATH, backupDir: env.JUSTUP_DEMO_BACKUP_DIR,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  const config = configFromEnv();
  const args = process.argv.slice(2);
  if (!config.dbPath || (!config.allowedOrigin && args[0] !== '--prepare-restored-db')) throw new Error('Set explicit JUSTUP_DEMO_DB_PATH and JUSTUP_DEMO_ORIGIN.');
  if (args[0] === '--prepare-restored-db' && args.length === 2) {
    const restored = resolve(args[1]);
    if (restored === resolve(config.dbPath) || !lstatSync(restored).isFile() || lstatSync(restored).isSymbolicLink()) throw new Error('Use a separate restored demo database file.');
    config.dbPath = restored;
  }
  const demo = await createDemo({ config, logger: (event) => console.log(JSON.stringify(event)) });
  if (args[0] === '--import' && args.length === 2) {
    const result = demo.store.importSnapshot(readImportFile(args[1]));
    console.log(JSON.stringify(result)); // Counts and random generation only; no source content.
    await demo.close();
  } else if (args[0] === '--prepare-restored-db' && args.length === 2) {
    if (typeof demo.auth.invalidateAllSessions !== 'function') { await demo.close(); throw new Error('Restored session invalidation is unavailable.'); }
    const result = demo.auth.invalidateAllSessions();
    if (result && typeof result.then === 'function') { await demo.close(); throw new Error('Restored session invalidation must be synchronous.'); }
    console.log(JSON.stringify({ schemaVersion: 1, sessionsInvalidated: true, remainingSessions: 0, sessionsDeleted: result.sessionsDeleted }));
    await demo.close();
  } else if (args.length) {
    await demo.close(); throw new Error('Usage: node server/main.mjs [--import /private/snapshot.json | --prepare-restored-db /private/restored.sqlite]');
  } else {
    const port = Number(process.env.JUSTUP_DEMO_PORT ?? 8787);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid demo port.');
    demo.server.listen(port, '127.0.0.1');
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { demo.close().then(() => process.exit(0)); });
  }
}
