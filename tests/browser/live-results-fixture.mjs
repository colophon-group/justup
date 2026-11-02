// Deterministic same-origin HTTP/SSE faults; compiled application assets remain unmodified.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { once } from 'node:events';
import { session, search, job } from './api-fixture.mjs';
export async function liveFixture() {
  const assets = resolve('web/dist'), calls = [], connections = new Set(), streams = [];
  let activeSession = session({ capabilities: { ...session().capabilities, sse: true, viewed: true } }), searches = [search()], sequence = 0;
  const jobs = Array.from({ length: 24 }, (_, i) => ({ ...job(i + 1), firstObserved: new Date(Date.UTC(2026, 10, 1, 12, 0, -i)).toISOString() }));
  let preference = { accountId: 'reader', revision: 0, interfaceLocale: null, supportedInterfaceLocales: ['en', 'de', 'fr', 'it', 'es'], defaultInterfaceLocale: 'en', resolvedInterfaceLocale: 'en' };
  let streamFailure = null;
  let current = jobs, workspace = { revision: 0, state: { activeSearchId: 'search-1', drafts: {} }, viewed: [], recoveredDrafts: [] }, staleCursor = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const body = []; for await (const chunk of req) body.push(chunk);
    const call = { path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, method: req.method, body: body.length ? JSON.parse(Buffer.concat(body)) : null }; calls.push(call);
    const json = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname.endsWith('/workspace/events')) {
      if (streamFailure) { const failure = streamFailure; if (!failure.repeat) streamFailure = null; return json({ error: { code: 'live_unavailable' } }, failure.status); }
      const stream = { res, call, closed: false }; streams.push(stream); connections.add(stream);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }); res.write('retry: 1000\n\n');
      res.on('close', () => { stream.closed = true; connections.delete(stream); }); return;
    }
    if (url.pathname === '/api/v1/session') return json(activeSession);
    if (url.pathname === '/api/v1/hiring-wire') return json({ state: 'unavailable', edition: null });
    if (url.pathname === '/api/v1/preferences') {
      if (req.method === 'PATCH') preference = { ...preference, revision: preference.revision + 1, interfaceLocale: call.body.interfaceLocale, resolvedInterfaceLocale: call.body.interfaceLocale || 'en' };
      return json(preference);
    }
    if (url.pathname === '/api/v1/searches') return json({ items: searches });
    if (url.pathname === '/api/v1/workspace') {
      if (req.method === 'PATCH') workspace = { ...workspace, revision: workspace.revision + 1, state: { activeSearchId: call.body.activeSearchId, drafts: call.body.drafts } };
      return json(workspace);
    }
    if (url.pathname === '/api/v1/viewed') { workspace.viewed.push({ jobId: call.body.jobId, firstViewedAt: new Date().toISOString() }); return json({ viewed: true }); }
    if (url.pathname.endsWith('/results')) {
      if (staleCursor && url.searchParams.has('cursor')) { staleCursor = false; return json({ error: { code: 'stale_cursor', message: 'Import changed.' } }, 409); }
      const offset = Number(url.searchParams.get('cursor') || 0), items = current.slice(offset, offset + 12), more = offset + items.length < current.length;
      const searchId = url.pathname.split('/').at(-2);
      return json({ searchId, revision: searches.find(item => item.id === searchId)?.revision ?? 1, items, continuation: { state: more ? 'open' : 'exhausted', cursor: more ? String(offset + items.length) : null }, ai: { status: 'not_required' } });
    }
    if (url.pathname.startsWith('/api/')) return json({ items: [], nextCursor: null });
    let file = resolve(assets, '.' + url.pathname);
    if (!file.startsWith(assets + sep) && file !== assets) { res.writeHead(404); res.end(); return; }
    try { if (url.pathname === '/') file = resolve(assets, 'index.html'); const bytes = readFileSync(file); res.writeHead(200, { 'content-type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[extname(file)] || 'application/octet-stream' }); res.end(bytes); }
    catch { res.writeHead(404); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const snapshot = ({ items = current.slice(0, 96), retained = current.map(item => item.id), complete = true, reason = 'changed', revision = searches[0].revision, id = Buffer.from(String(++sequence).padStart(32, '0')).toString('base64url'), asOf = new Date(Date.UTC(2026, 10, 2, 12, 0, sequence)).toISOString() } = {}) => {
    const event = { schemaVersion: 1, scope: 'active_search', searchId: 'search-1', revision, asOf, reason, searches: [{ searchId: 'search-1', revision, items, continuation: { state: current.length > items.length ? 'open' : 'exhausted', cursor: null, retryAfterMs: null }, ai: { status: 'not_required' }, hiddenMatches: { status: 'exact', count: 0 }, reconciliation: { complete, retainedItemIds: retained } }] };
    for (const stream of connections) stream.res.write(`id: ${id}\nevent: snapshot\ndata: ${JSON.stringify(event)}\n\n`);
    return { id, event };
  };
  return { origin: `http://127.0.0.1:${server.address().port}`, calls, streams, jobs, snapshot,
    setJobs(value) { current = value; }, setSession(value) { activeSession = value; }, setSearch(value) { searches = Array.isArray(value) ? value : [value]; }, staleCursor() { staleCursor = true; },
    unavailable(reason) { for (const stream of connections) { stream.res.write(`event: unavailable\ndata: ${JSON.stringify({ schemaVersion: 1, reason, retryAfterMs: 1000 })}\n\n`); stream.res.end(); } },
    rejectStreams(status, repeat = false) { streamFailure = { status, repeat }; },
    disconnect() { for (const stream of connections) stream.res.destroy(); },
    async close() { for (const stream of connections) stream.res.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
