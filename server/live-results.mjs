// Bounded workspace SSE transport over the canonical search snapshot. Read when
// changing reconnect recovery, authorization during streams or socket cleanup.
import { createHash, randomBytes } from 'node:crypto';
import { problem } from './store.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ownerOf = viewer => viewer?.visitor?.id ?? viewer?.account?.id ?? null;
const accessKey = viewer => hash({ owner: ownerOf(viewer), access: viewer?.access ?? null });
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const fingerprintOf = ({ databaseKey, ...snapshot }) => hash({ ...snapshot, searches: snapshot.searches.map(({ asOf, ...search }) => search) });

export function createLiveResultsService({ db, feed, intent, now = Date.now, config = {}, afterPrivateTransaction = () => {} } = {}) {
  if (!db || typeof intent?.snapshot !== 'function' || typeof feed?.generation !== 'function') throw new TypeError('Canonical search snapshots are required.');
  const options = { pollMs: 1000, heartbeatMs: 15_000, lifetimeMs: 300_000, drainMs: 5000,
    maxConnections: 16, maxConnectionsPerOwner: 2, maxEventBytes: 1_048_576, ...config.liveResults };
  const bounds = { pollMs: [10, 5000], heartbeatMs: [20, 30_000], lifetimeMs: [100, 600_000],
    drainMs: [20, 10_000], maxConnections: [1, 32], maxConnectionsPerOwner: [1, 2], maxEventBytes: [1024, 1_048_576] };
  for (const [name, [min, max]] of Object.entries(bounds)) if (!Number.isSafeInteger(options[name]) || options[name] < min || options[name] > max) throw new TypeError('Invalid live result bounds.');
  const connections = new Set(), identities = new Map(), cache = new Map();
  let timer = null, polling = false, closed = false;
  const revisionKey = connection => JSON.stringify(db.prepare('SELECT id,revision FROM demo_searches WHERE owner_id=? AND id=? AND accepted_json IS NOT NULL').all(connection.ownerId, connection.searchId).map(r => [r.id, r.revision]));
  const cacheKey = connection => JSON.stringify([connection.ownerId, connection.searchId, connection.revision]);
  const databaseKey = () => `${db.prepare('PRAGMA data_version').get().data_version}:${db.prepare('SELECT total_changes() AS n').get().n}`;
  function remember(scope) {
    for (const [key, value] of identities) if (value.until <= now()) identities.delete(key);
    while (identities.size >= 1024) identities.delete(identities.keys().next().value);
    const id = randomBytes(32).toString('base64url');
    identities.set(id, { scope, until: now() + 600_000 });
    return id;
  }
  function stop(connection, destroy = false) {
    if (!connections.delete(connection)) return;
    clearTimeout(connection.drainTimer);
    connection.res.off('drain', connection.onDrain);
    connection.res.off('close', connection.onClose);
    connection.res.off('error', connection.onClose);
    connection.req.off('aborted', connection.onClose);
    if (destroy) connection.res.destroy(); else connection.res.end();
    if (![...connections].some(other => cacheKey(other) === cacheKey(connection))) cache.delete(cacheKey(connection));
    if (!connections.size && timer) { clearInterval(timer); timer = null; }
  }
  function write(connection, frame) {
    if (!connections.has(connection) || connection.blocked || connection.res.destroyed) return false;
    if (!connection.res.write(frame)) {
      connection.blocked = true;
      connection.drainTimer = setTimeout(() => stop(connection, true), options.drainMs);
      connection.drainTimer.unref?.();
    }
    connection.lastWrite = now();
    return true;
  }
  function unavailable(connection, reason) {
    if (connection.blocked) return stop(connection, true);
    write(connection, `event: unavailable\ndata: ${JSON.stringify({ schemaVersion: 1, reason, retryAfterMs: 1000 })}\n\n`);
    stop(connection);
  }
  function authority(connection) {
    const viewer = connection.readAuthority();
    if (!viewer || ownerOf(viewer) !== connection.ownerId) throw problem('unauthenticated', 401);
    return viewer;
  }
  async function update(connection, key) {
    const viewer = authority(connection), access = accessKey(viewer), at = now();
    if (revisionKey(connection) !== connection.revisionKey) return unavailable(connection, 'search_changed');
    if (at - connection.openedAt >= options.lifetimeMs) return unavailable(connection, 'reconnect');
    // Revalidate even while a slow reader is blocked. No second frame is queued.
    if (connection.blocked) {
      if (connection.access !== access) stop(connection, true);
      return;
    }
    let saved = cache.get(cacheKey(connection));
    if (!saved || connection.fingerprint == null || saved.key !== key || saved.access !== access || saved.refreshAt <= at) {
      let snapshot;
      try { snapshot = await intent.snapshot({ ownerId: connection.ownerId, viewer,
        activeSearchId: connection.searchId, activeRevision: connection.revision }); }
      finally { afterPrivateTransaction(); }
      if (!connections.has(connection) || closed) return;
      const current = authority(connection);
      if (accessKey(current) !== access || snapshot.revisionKey !== revisionKey(connection)
          || snapshot.generation !== feed.generation() || snapshot.databaseKey !== databaseKey()) {
        cache.delete(cacheKey(connection)); return;
      }
      const fingerprint = fingerprintOf(snapshot);
      saved = { snapshot, fingerprint, access, key: snapshot.databaseKey, refreshAt: at + Math.min(5000,
        ...snapshot.searches.map(search => search.continuation?.retryAfterMs ?? 5000).filter(ms => ms > 0)) };
      cache.set(cacheKey(connection), saved);
    }
    // A preceding async snapshot can yield to logout, deletion, a revised search
    // or another import. Reject its entire projection before writing any bytes.
    const current = authority(connection);
    if (accessKey(current) !== saved.access || saved.snapshot.revisionKey !== revisionKey(connection)
        || saved.snapshot.generation !== feed.generation() || saved.key !== databaseKey()) { cache.delete(cacheKey(connection)); return; }
    const scope = hash({ owner: connection.ownerId, access: saved.access, authority: connection.authorityKey,
      revision: saved.snapshot.revisionKey, generation: saved.snapshot.generation });
    if (connection.fingerprint !== saved.fingerprint || connection.access !== saved.access) {
      const prior = connection.lastEventId == null ? null : identities.get(connection.lastEventId);
      const reason = connection.fingerprint == null
        ? connection.lastEventId == null ? 'initial' : prior?.scope === scope && prior.until > at ? 'resumed' : 'recovery' : 'changed';
      const id = remember(scope);
      const data = JSON.stringify({ schemaVersion: 1, scope: 'active_search', searchId: connection.searchId,
        revision: connection.revision, asOf: new Date(at).toISOString(), reason, searches: saved.snapshot.searches });
      const frame = `id: ${id}\nevent: snapshot\ndata: ${data}\n\n`;
      if (Buffer.byteLength(frame) > options.maxEventBytes) return unavailable(connection, 'dependency_unavailable');
      if (write(connection, frame)) {
        connection.fingerprint = saved.fingerprint; connection.access = saved.access;
      }
    } else if (at - connection.lastWrite >= options.heartbeatMs) write(connection, ': heartbeat\n\n');
  }
  async function poll() {
    if (polling || closed || !connections.size) return;
    polling = true;
    try {
      // One cheap shared SQLite fingerprint per poll. Each owner shares a bounded
      // canonical projection; time/access/provider transitions also force refresh.
      let key = databaseKey();
      for (const connection of [...connections]) {
        try { await update(connection, key); }
        catch (error) { unavailable(connection, error.code === 'unauthenticated' ? 'authority_lost'
          : error.code === 'revision_conflict' ? 'search_changed' : 'dependency_unavailable'); }
        if (!closed) key = databaseKey();
      }
    } catch {
      for (const connection of [...connections]) unavailable(connection, 'dependency_unavailable');
    } finally { polling = false; }
  }
  function openStream({ req, res, readAuthority, authorityKey, searchId, revision, lastEventId = null }) {
    if (closed) throw problem('dependency_unavailable', 503);
    if (lastEventId != null && (typeof lastEventId !== 'string' || !TOKEN.test(lastEventId))) throw problem('invalid_cursor');
    const viewer = readAuthority(), ownerId = ownerOf(viewer);
    if (!ownerId) throw problem('unauthenticated', 401);
    const accepted = db.prepare('SELECT revision FROM demo_searches WHERE owner_id=? AND id=? AND accepted_json IS NOT NULL').get(ownerId, searchId);
    if (!accepted) throw problem('not_found',404);
    if (accepted.revision !== revision) throw problem('revision_conflict',409);
    if (connections.size >= options.maxConnections || [...connections].filter(c => c.ownerId === ownerId).length >= options.maxConnectionsPerOwner) throw problem('rate_limit', 429);
    const connection = { req, res, readAuthority, authorityKey, ownerId, searchId, revision,
      revisionKey: JSON.stringify([[searchId, revision]]), lastEventId, openedAt: now(), lastWrite: now(),
      blocked: false, access: accessKey(viewer), fingerprint: null };
    connection.onClose = () => stop(connection, true);
    connection.onDrain = () => { clearTimeout(connection.drainTimer); connection.blocked = false; };
    req.once('aborted', connection.onClose); res.once('close', connection.onClose); res.once('error', connection.onClose); res.on('drain', connection.onDrain);
    connections.add(connection);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'private, no-store, no-transform',
      'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    write(connection, 'retry: 1000\n\n');
    if (!timer) { timer = setInterval(poll, options.pollMs); timer.unref?.(); }
    void poll();
  }
  return { capabilities: () => ({ sse: !closed }), openStream,
    close() { closed = true; if (timer) clearInterval(timer); timer = null;
      for (const connection of [...connections]) stop(connection, true);
      cache.clear(); identities.clear();
    } };
}
