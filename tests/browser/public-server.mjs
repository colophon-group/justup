// Local-only built-Worker fixture. No service calls and no fixture data enters a product asset.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createPublicHandler } from '../../web/worker-dist/worker.mjs';
import { localeSeam } from './locale-seam-server.mjs';
import { company, session } from './api-fixture.mjs';
const port = Number(process.env.JUSTUP_PUBLIC_TEST_PORT || 4207);
const origin = `http://127.0.0.1:${port}`;
const files = resolve('web/dist');
const api = async target => {
  const url = new URL(target); const path = url.pathname;
  const items = Array.from({ length: 30 }, (_, index) => ({ ...company, id: index ? `company-${index}` : company.id, name: index ? `Public company ${index}` : company.name }));
  const body = path === '/api/v1/companies' ? { items: items.slice(url.searchParams.has('cursor') ? 20 : 0, url.searchParams.has('cursor') ? 30 : 20), nextCursor: url.searchParams.has('cursor') ? null : 'public-next' } : path === '/api/v1/companies/library' ? { ...company, lastSuccessfulCheckAt: '2026-10-31T23:30:00Z' } : path === '/api/v1/session' ? session({ user: null }) : path === '/api/v1/searches' ? { items: [] } : { error: { code: 'not_found', message: 'Not found.' } };
  return new Response(JSON.stringify(body), { status: body.error ? 404 : 200, headers: { 'Content-Type': 'application/json' } });
};
const handle = createPublicHandler(api);
const handleLocaleSeam = await localeSeam();
const assets = { fetch: async request => {
  const path = resolve(files, '.' + new URL(request.url).pathname);
  if (!path.startsWith(files + sep)) return new Response('Not found', { status: 404 });
  try { return new Response(await readFile(path), { headers: { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(path)] || 'application/octet-stream' } }); }
  catch { return new Response('Not found', { status: 404 }); }
} };
// Edge validates an HTTPS public origin; this local HTTP adapter preserves the origin contract internally.
createServer(async (req, res) => {
  try {
    if (await handleLocaleSeam(req, res)) return;
    const result = await handle(new Request(`https://public.justup.test${req.url}`, { method: req.method, headers: req.headers }), { PUBLIC_ORIGIN: 'https://public.justup.test', API_ORIGIN: 'https://fixed-api.test', DEPLOYMENT_MODE: 'preview', RELEASE_JSON: JSON.stringify({ sourceSha: 'a'.repeat(40) }), RUNTIME_CONFIG_SHA256: 'f'.repeat(64), ASSETS: assets });
    const headers = Object.fromEntries(result.headers);
    if (headers.location) headers.location = headers.location.replace('https://public.justup.test', origin);
    res.writeHead(result.status, headers); res.end(Buffer.from(await result.arrayBuffer()));
  } catch { res.writeHead(500); res.end('Fixture failed'); }
}).listen(port, '127.0.0.1');
