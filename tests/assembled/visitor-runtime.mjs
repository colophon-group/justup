// Local assembled proof: current or explicitly archived API source, real HTTP/SQLite/auth/composition,
// built Worker/assets, and a deterministic injected queue interpreter. No provider calls.
import { createServer } from 'node:https';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createPublicHandler } from '../../web/worker-dist/worker.mjs';
export async function startVisitorRuntime({ now = Date.now } = {}) {
  const ingressSecret = 'A'.repeat(43);
  const dir = mkdtempSync(join(tmpdir(), 'justup-assembled-visitor-')), ref = process.env.JUSTUP_ASSEMBLED_API_REF;
  let app, server, heartbeatTimer, queue;
  const liveConnections = new Set();
  try {
  const API_COMMIT = execFileSync('git', ['rev-parse', '--verify', `${ref || 'HEAD'}^{commit}`], { encoding: 'utf8' }).trim();
  let source = process.cwd();
  if (ref) {
    source = join(dir, 'api'); mkdirSync(source);
    execFileSync('tar', ['-x', '-C', source], { input: execFileSync('git', ['archive', API_COMMIT], { maxBuffer: 64 * 1024 * 1024 }), env: { ...process.env, LC_ALL: 'C' } });
  }
  const load = name => import(pathToFileURL(join(source, 'server', name)).href);
  const { createConfiguredApplication } = await load('main.mjs'), { createIntentService } = await load('intent.mjs');
  const origin = `https://127.0.0.1:${process.env.JUSTUP_ASSEMBLED_TEST_PORT || 4204}`;
  const generation = join(dir, 'private-generation'), backups = join(dir, 'backups'), status = join(dir, 'runner-status.json');
  mkdirSync(backups); writeFileSync(generation, '00000000-0000-4000-8000-000000000000\n');
  let available = true, modelCalls = 0, busy = false, loss = null, hold = null;
  const calls = [], modelInputs = [];
  const locales = ['en', 'de', 'fr', 'it', 'es'], version = 'synthetic-reviewed';
  const policyLocales = Object.fromEntries(locales.map(locale => { const suffix = locale === 'en' ? '' : `.${locale}`; return [locale, { reviewed: true, version, privacyUrl: `${origin}/privacy${suffix}.html`, usageUrl: `${origin}/usage${suffix}.html` }]; }));
  // Local synthetic admission only: these hashes bind the exact built drafts;
  // they do not approve any notice or activate a deployment.
  const policyAssetProof = { origin, sourceCommit: API_COMMIT, assetsSha256: 'f'.repeat(64), locales: Object.fromEntries(locales.map(locale => {
    const suffix = locale === 'en' ? '' : `.${locale}`, hash = kind => createHash('sha256').update(readFileSync(`web/dist/${kind}${suffix}.html`)).digest('hex');
    return [locale, { version, privacySha256: hash('privacy'), usageSha256: hash('usage') }];
  })) };
  const heartbeat = () => writeFileSync(status, JSON.stringify({ schemaVersion: 1, identity: 'assembled-local-queue', sourceCommit: API_COMMIT, buildIdentity: 'assembled-local', ready: true, updatedAt: new Date(now()).toISOString(), capabilities: { search: available, companyRequests: false, aiMatching: false } }), { mode: 0o640 });
  heartbeat(); heartbeatTimer = setInterval(heartbeat, 5000);
  app = await createConfiguredApplication({ now, config: { dbPath: join(dir, 'state.sqlite'), privateGenerationPath: generation, backupDir: backups,
    servicesEnabled: true, sourceCommit: API_COMMIT, buildIdentity: 'assembled-local', runnerStatusPath: status,
    allowedOrigin: origin, trustedIngressSecret: ingressSecret, requiresInvitation: false, policiesReviewed: true, policyVersion: 'synthetic-reviewed', privacyUrl: origin + '/privacy.html', usageUrl: origin + '/usage.html',
    policyLocales, policyAssetProof,
  } });
  const db = app.store.db, records = app.services.find(service => typeof service.onModelMetric === 'function'), identity = app.services.find(service => service.identity)?.identity;
  const reading = app.services.find(service => typeof service.preferences === 'function');
  if (!records?.runTask || !identity?.principal || !reading?.preferences)
    throw new Error('API source must include the reviewed visitor, reading-preferences and product-record composition before current-source assembly can pass.');
  const filters = ['companyInclude', 'companyExclude', 'titleAny', 'bodyAll', 'bodyNone', 'locations', 'workplaces', 'employmentTypes', 'postingLanguages', 'seniority'];
  const worker = createIntentService({ db, feed: app.feed, tasks: app.tasks, ownerAuthority: identity.principal, visitorIdentity: identity, readingPreferences: reading, records,
    model: { interpretIntent: async input => { modelCalls++; modelInputs.push(input); records.onModelMetric({ kind: 'search_intent', model: 'gpt-6-luna', usage: { inputTokens: 10, outputTokens: 3 } });
      return { title: 'Engineering', configuration: { schemaVersion: 1, filters: { ...Object.fromEntries(filters.map(key => [key, null])), titleAny: ['engineer'] }, residualAi: null }, requirements: [{ id: 'role', text: 'Engineer', handling: 'primary', reason: 'Synthetic title evidence.', bindings: [{ field: 'titleAny', values: ['engineer'] }], companyReference: null }] };
    } },
  });
  queue = setInterval(async () => { if (busy || !available) return; busy = true; try { const task = app.tasks.claim({ workerId: 'assembled-local', kinds: ['search_intent'] }); if (task) { const result = await records.runTask(task, worker.runTask); if (!result.committed) app.tasks.complete(task.id, task.leaseToken, result); records.taskFinished(task); } } finally { busy = false; } }, 20);
  const at = now();
  app.store.importSnapshot({ schemaVersion: 1, snapshotAt: new Date(at).toISOString(), verifiedAt: new Date(at).toISOString(), observations: [], unknownIds: [], jobs: [{
    id: 'assembled-engineer', companyId: 'assembled', companyName: 'Assembled Company', companySlug: 'assembled', title: 'Engineer', sourceUrl: 'https://example.org/careers/engineer', active: true, reserved: false, hasContent: true,
    firstObserved: new Date(at - 3 * 86400000).toISOString(), lastObserved: null, locales: ['en'], locations: [], employmentTypes: [], seniority: null, salary: null, bodyText: null,
    evidence: { source: 'jobseek_public', metadataFetchedAt: new Date(at).toISOString(), bodyFetchedAt: null, bodyUrl: null, bodySha256: null, textSha256: null, bodyBytes: 0, normalizationVersion: 1, truncated: false },
  }] });
  await app.auth.register({ username: 'assembled-reader', password: 'Synthetic-local-account-password' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const api = `http://127.0.0.1:${app.server.address().port}`, assetsRoot = resolve('web/dist');
  const upstream = async (target, options) => {
    const url = new URL(target), path = url.pathname, method = options?.method || 'GET';
    const body = options?.body ? await new Response(options.body).text() : undefined;
    const headers = new Headers(options?.headers);
    const call = { path, method, body: body ? JSON.parse(body) : null, locale: headers.get('X-Justup-Locale'),
      ...(/\/workspace\/events$/.test(path) ? { lastEventId: headers.get('Last-Event-ID') } : {}) }; calls.push(call);
    const result = await fetch(api + path + url.search, { ...options, body, duplex: 'half' });
    call.status = result.status;
    if (path === '/api/v1/session') call.session = await result.clone().json();
    return result;
  };
  const handle = createPublicHandler(upstream);
  const key = join(dir, 'tls.key'), cert = join(dir, 'tls.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
  server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, async (req, res) => {
    const abort = new AbortController();
    const disconnected = () => abort.abort();
    res.once('close', disconnected);
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const incomingHeaders = new Headers(req.headers); incomingHeaders.set('CF-Connecting-IP', '203.0.113.25');
      const request = new Request(origin + req.url, { method: req.method, headers: incomingHeaders, signal: abort.signal, ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Buffer.concat(chunks) }) });
      const result = await handle(request, { API_INGRESS_SECRET: ingressSecret, PUBLIC_ORIGIN: origin, API_ORIGIN: 'https://api.fixture.example', DEPLOYMENT_MODE: 'preview', RELEASE_JSON: JSON.stringify({ sourceSha: 'a'.repeat(40) }), RUNTIME_CONFIG_SHA256: 'f'.repeat(64), ASSETS: { fetch: async request => {
        const path = resolve(assetsRoot, '.' + new URL(request.url).pathname); if (!path.startsWith(assetsRoot + sep)) return new Response(null, { status: 404 });
        try { return new Response(readFileSync(path), { headers: { 'Content-Type': ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' })[extname(path)] || 'application/octet-stream' } }); } catch { return new Response(null, { status: 404 }); }
      } } });
      const headers = Object.fromEntries(result.headers); const cookies = result.headers.getSetCookie(); if (cookies.length) headers['set-cookie'] = cookies;
      if (/^text\/event-stream(?:;|$)/i.test(result.headers.get('Content-Type') || '')) {
        // Stream actual Worker/API frames immediately; JSON response fault injection
        // below remains buffered so its existing committed-response semantics stay intact.
        const reader = result.body?.getReader();
        const cancel = () => { abort.abort(); void reader?.cancel().catch(() => {}); };
        liveConnections.add(res); res.once('close', cancel);
        res.writeHead(result.status, headers); res.flushHeaders();
        try {
          while (reader && !res.destroyed) {
            const part = await reader.read(); if (part.done) break;
            if (!res.write(Buffer.from(part.value))) await new Promise(resolve => {
              const drained = () => { res.off('drain', drained); res.off('close', drained); resolve(); };
              res.once('drain', drained); res.once('close', drained);
              if (res.destroyed) drained();
            });
          }
          if (!res.destroyed) res.end();
        } finally {
          liveConnections.delete(res); res.off('close', cancel);
          await reader?.cancel().catch(() => {});
        }
        return;
      }
      const bytes = Buffer.from(await result.arrayBuffer());
      const matched = fault => fault && req.method === fault.method && new URL(origin + req.url).pathname === '/api/v1' + fault.path && fault.when(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null);
      if (matched(hold)) { const waiting = hold; hold = null; waiting.reached(); await waiting.wait; }
      if (matched(loss)) { loss = null; res.writeHead(result.status, { ...headers, 'Content-Length': bytes.length }); res.flushHeaders(); res.destroy(); return; }
      res.writeHead(result.status, headers); res.end(bytes);
    } catch { if (!res.destroyed) { if (res.headersSent) res.destroy(); else { res.writeHead(500); res.end('Local assembled fixture failed'); } } }
    finally { res.off('close', disconnected); }
  });
  await new Promise(resolve => server.listen(Number(new URL(origin).port), '127.0.0.1', resolve));
  return { origin, calls, modelInputs, app, db, sourceCommit: API_COMMIT, modelCalls: () => modelCalls,
    refreshHeartbeat: heartbeat,
    liveConnections: () => liveConnections.size,
    dropLiveConnections() { for (const connection of liveConnections) connection.destroy(); },
    setAvailable(value) { available = value; heartbeat(); },
    loseNext(method, path, when = () => true) { loss = { method, path, when }; },
    holdNext(method, path, when = () => true) { let reached, release; const arrived = new Promise(resolve => { reached = resolve; }); const wait = new Promise(resolve => { release = resolve; }); hold = { method, path, when, reached, wait }; return { arrived, release }; },
    count: table => db.prepare(`SELECT count(*) n FROM ${table}`).get().n,
    workspaces: () => db.prepare('SELECT state_json,revision FROM justup_workspaces').all().map(row => ({ revision: row.revision, ...JSON.parse(row.state_json) })),
    async close() { clearInterval(queue); clearInterval(heartbeatTimer); server.closeAllConnections(); app.server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await app.close(); rmSync(dir, { recursive: true, force: true }); },
  };
  } catch (cause) {
    clearInterval(queue); clearInterval(heartbeatTimer);
    server?.closeAllConnections(); app?.server.closeAllConnections();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await app?.close(); rmSync(dir, { recursive: true, force: true });
    throw new Error(`Assembled API source ${ref || 'checked-out/current'} is not compatible with this candidate.`, { cause });
  }
}
