// Compose the Justup API. Direct execution requires explicit isolated storage
// and build configuration; import createApplication to add reviewed feature services.
import { createServer } from 'node:http';
import { mkdirSync, chmodSync, readFileSync, statSync, lstatSync, readdirSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, unlinkSync, accessSync, fstatSync, realpathSync, constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve, isAbsolute, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStore } from './store.mjs';
import { createFeed } from './feed.mjs';
import { createTasks } from './tasks.mjs';
import { createHandler } from './http.mjs';
import { runtimeEnv, booleanEnv, integerEnv } from './config.mjs';

// Hold a durable pending marker across the SQL transaction. Backup/restore must
// reject any pending marker, including one retained after a process crash.
export function createDeletionBarrier({ generationPath, backupDir, dbPath, db } = {}) {
  if (!generationPath && !backupDir && (dbPath == null || dbPath === ':memory:')) return {
    ready: () => true, beforePrivateDelete: () => {}, afterPrivateTransaction: () => {},
  };
  const configured = typeof generationPath === 'string' && typeof backupDir === 'string'
    && isAbsolute(generationPath) && isAbsolute(backupDir);
  const pendingPath = configured ? `${generationPath}.pending` : null;
  let ownedMarker = null;
  const inside = (root, path) => { const rel = relative(resolve(root), resolve(path)); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
  function absentPending() {
    try { lstatSync(pendingPath); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    throw new Error('A private deletion transaction is pending.');
  }
  function markerIsOwned() {
    const info = lstatSync(pendingPath);
    if (!ownedMarker || !info.isFile() || info.isSymbolicLink() || info.size > 256
        || info.dev !== ownedMarker.dev || info.ino !== ownedMarker.ino
        || readFileSync(pendingPath, 'utf8') !== ownedMarker.value) throw new Error('Private deletion marker ownership changed.');
  }
  function validate() {
    if (!configured || inside(backupDir, generationPath) || (dbPath && dbPath !== ':memory:' && inside(backupDir, dbPath))) throw new Error('Private deletion storage is unavailable.');
    for (const directory of [dirname(generationPath), backupDir]) {
      const info = lstatSync(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Private deletion storage is unavailable.');
      accessSync(directory, constants.W_OK);
    }
    const info = lstatSync(generationPath);
    if (info.size > 64 || !info.isFile() || info.isSymbolicLink()
        || !/^[a-f0-9-]{36}\n?$/.test(readFileSync(generationPath, 'utf8'))) throw new Error('Private deletion generation is unavailable.');
    const files = readdirSync(backupDir).map((name) => resolve(backupDir, name));
    if (files.some((file) => !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())) throw new Error('Private backup storage is unavailable.');
    return files;
  }
  function syncDirectory(path) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
  function beforePrivateDelete() {
    if (db?.isTransaction !== true) throw new Error('Private deletion requires an active SQL transaction.');
    if (ownedMarker) { markerIsOwned(); return; }
    const files = validate(); absentPending();
    const marker = { version: 1, token: randomUUID() }, value = `${JSON.stringify(marker)}\n`;
    const markerFd = openSync(pendingPath, 'wx', 0o600);
    try {
      writeFileSync(markerFd, value);
      const info = fstatSync(markerFd); ownedMarker = { value, dev: info.dev, ino: info.ino };
      fsyncSync(markerFd);
    } finally { closeSync(markerFd); }
    syncDirectory(dirname(generationPath));
    const temporary = `${generationPath}.${randomUUID()}.tmp`; let fd;
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
  function afterPrivateTransaction() {
    if (!ownedMarker) return; // A foreign/crash-retained marker is never ours to clear.
    if (db?.isTransaction !== false) throw new Error('Private SQL transaction has not ended.');
    markerIsOwned(); unlinkSync(pendingPath); syncDirectory(dirname(generationPath)); ownedMarker = null;
  }
  return { ready: () => { try { validate(); absentPending(); return !ownedMarker; } catch { return false; } },
    beforePrivateDelete, afterPrivateTransaction };
}
export async function createApplication({ config = {}, now = Date.now, serviceFactories = [], authFactory, logger } = {}) {
  const path = config.dbPath ?? ':memory:';
  if (path !== ':memory:' && !config.sharedState) mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const store = openStore(path, { sharedState: config.sharedState === true });
  try {
    const feed = createFeed({ db: store.db, now, cursorSecret: config.cursorSecret, verificationTtlMs: config.verificationTtlMs });
    const tasks = createTasks({ db: store.db, now });
    const deletion = createDeletionBarrier({ generationPath: config.privateGenerationPath, backupDir: config.backupDir, dbPath: path, db: store.db });
    const withPrivateTransaction = (work) => { try { return store.transaction(work); } finally { deletion.afterPrivateTransaction(); } };
    let auth;
    const accessForAccount=id=>auth?.accessForAccount?.(id)??null;
    const services = serviceFactories.flatMap((factory) => factory({ db: store.db, feed, tasks, config, now, accessForAccount, beforePrivateDelete: deletion.beforePrivateDelete, afterPrivateTransaction: deletion.afterPrivateTransaction, withPrivateTransaction }));
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
    auth = createAuth({ db: store.db, config, now, deleteAccountData });
    let maintenanceReady = false;
    function maintainAuth() {
      try {
        if (typeof auth.cleanup !== 'function') return;
        const result = auth.cleanup();
        if (result && typeof result.then === 'function') throw new TypeError('Authentication cleanup must be synchronous.');
        for(const service of services)service.cleanup?.();
        maintenanceReady = true;
      } catch { maintenanceReady = false; }
      finally { try { deletion.afterPrivateTransaction(); } catch { maintenanceReady = false; } }
    }
    maintainAuth();
    const maintenanceTimer = setInterval(maintainAuth, 60_000); maintenanceTimer.unref();
    const handler = createHandler({ auth, feed, tasks, db: store.db, services,
      config: { ...config, deletionReady: deletion.ready, authMaintenanceReady: () => maintenanceReady },
      afterPrivateTransaction: deletion.afterPrivateTransaction, now, logger });
    const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 16_384 }, handler);
    server.keepAliveTimeout = 5000;
    server.maxRequestsPerSocket = 100;
    return { server, store, feed, tasks, auth, services, beforePrivateDelete: deletion.beforePrivateDelete,
      afterPrivateTransaction: deletion.afterPrivateTransaction, withPrivateTransaction, close: async () => {
      clearInterval(maintenanceTimer);
      if (server.listening) await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
      deletion.afterPrivateTransaction();
      store.close();
    } };
  } catch (error) { store.close(); throw error; }
}
// The executable has one reviewed adapter, never an environment-selected module.
export async function createConfiguredApplication({ config = {}, ...options } = {}) {
  if (!config.servicesEnabled) return createApplication({ ...options, config });
  const configured = { ...config, runnerStatusPath: config.runnerStatusPath ?? resolve(dirname(config.dbPath), 'runner-status.json') };
  const { createApiServices, createApiReadiness } = await import('./composition.mjs');
  return createApplication({ ...options, config: { ...configured, readiness: createApiReadiness({ config: configured, now: options.now ?? Date.now }) },
    serviceFactories: [createApiServices] });
}
export async function prepareRestoredDatabase({ dbPath, authFactory } = {}) {
  if (typeof dbPath !== 'string' || dbPath === ':memory:' || !lstatSync(dbPath).isFile() || lstatSync(dbPath).isSymbolicLink()) throw new Error('Use an existing restored application database file.');
  const store = openStore(dbPath);
  try {
    const createAuth = authFactory ?? (await import('./auth.mjs')).createAuth;
    // Restore preparation only invalidates sessions. Retention cleanup requires
    // the fully composed feature deletion hooks and belongs to normal startup.
    const auth = createAuth({ db: store.db });
    if (typeof auth.invalidateAllSessions !== 'function') throw new Error('Restored session invalidation is unavailable.');
    const result = auth.invalidateAllSessions();
    if (result && typeof result.then === 'function' || !Number.isSafeInteger(result?.sessionsDeleted) || result.sessionsDeleted < 0
        || store.db.isTransaction) throw new Error('Restored session invalidation failed.');
    return { schemaVersion: 1, sessionsInvalidated: true, remainingSessions: 0, sessionsDeleted: result.sessionsDeleted };
  } finally { store.close(); }
}
export function readImportFile(path) {
  if (statSync(path).size > 64 * 1024 * 1024) throw new Error('Job import exceeds the 64 MiB limit.');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path))); }
  catch { throw new Error('Invalid job import file.'); }
}
export function configFromEnv(env = process.env) {
  return {
    servicesEnabled: booleanEnv(env, 'SERVICES_ENABLED'), runnerStatusPath: runtimeEnv(env, 'RUNNER_STATUS_PATH'),
    dbPath: runtimeEnv(env, 'DB_PATH'), sharedState: booleanEnv(env, 'SHARED_STATE'), allowedOrigin: runtimeEnv(env, 'ORIGIN'),
    allowInsecureLocalhost: booleanEnv(env, 'ALLOW_LOCAL_HTTP'),
    requiresInvitation: booleanEnv(env, 'REQUIRES_INVITATION', true), inviteCode: runtimeEnv(env, 'INVITE_CODE'),
    maxAccounts: integerEnv(env, 'MAX_ACCOUNTS', { nullable: true }),
    sessionTtlMs: integerEnv(env, 'SESSION_TTL_MS'), accountTtlMs: integerEnv(env, 'ACCOUNT_TTL_MS', { nullable: true }),
    accountExpiresAt: integerEnv(env, 'ACCOUNT_EXPIRES_AT', { nullable: true }),
    privacyUrl: runtimeEnv(env, 'PRIVACY_URL'), usageUrl: runtimeEnv(env, 'USAGE_URL'), policyVersion: runtimeEnv(env, 'POLICY_VERSION'),
    policiesReviewed: booleanEnv(env, 'POLICIES_REVIEWED'),
    sourceCommit: runtimeEnv(env, 'SOURCE_COMMIT'), buildIdentity: runtimeEnv(env, 'BUILD_ID'),
    csrfSecret: runtimeEnv(env, 'CSRF_SECRET'), cursorSecret: runtimeEnv(env, 'CURSOR_SECRET'),
    privateGenerationPath: runtimeEnv(env, 'PRIVATE_GENERATION_PATH'), backupDir: runtimeEnv(env, 'BACKUP_DIR'),
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const config = configFromEnv();
  process.umask(config.sharedState ? 0o007 : 0o077);
  const args = process.argv.slice(2);
  if (!config.dbPath || (!config.allowedOrigin && args.length === 0)) throw new Error('Set explicit JUSTUP_DB_PATH and JUSTUP_ORIGIN.');
  if (args[0] === '--prepare-restored-db' && args.length === 2) {
    const restored = resolve(args[1]);
    if (restored === resolve(config.dbPath) || !lstatSync(restored).isFile() || lstatSync(restored).isSymbolicLink()) throw new Error('Use a separate restored application database file.');
    console.log(JSON.stringify(await prepareRestoredDatabase({ dbPath: restored })));
  } else if (args[0] === '--import' && args.length === 2) {
    const store = openStore(config.dbPath, { sharedState: config.sharedState });
    try { console.log(JSON.stringify(store.importSnapshot(readImportFile(args[1])))); }
    finally { store.close(); }
  } else if (args.length === 0) {
    const application = await createConfiguredApplication({ config, logger: (event) => console.log(JSON.stringify(event)) });
    const port = Number(runtimeEnv(process.env, 'PORT') ?? 8787);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid application port.');
    application.server.listen(port, '127.0.0.1');
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { application.close().then(() => process.exit(0)); });
  } else throw new Error('Usage: node server/main.mjs [--import /private/snapshot.json | --prepare-restored-db /private/restored.sqlite]');
}
