// Read-only deployed checks. Read when attaching exact-byte frontend evidence to a preview report.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { digest } from './frontend-prepare.mjs';
import { httpsOrigin } from '../deploy/frontend/worker.mjs';

export async function smoke(origin, artifact, fetchRemote = globalThis.fetch) {
  origin = httpsOrigin(origin);
  const release = JSON.parse(await readFile(join(artifact, 'release.json'), 'utf8'));
  const config = JSON.parse(await readFile(join(artifact, 'wrangler.json'), 'utf8'));
  assert.equal(config.vars.PUBLIC_ORIGIN, origin, 'Configured origin differs from smoke target');
  const deadline = Date.now() + 60_000;
  const get = async path => {
    assert.ok(Date.now() < deadline, 'Smoke deadline exceeded');
    const result = await fetchRemote(`${origin}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(Math.min(10_000, deadline - Date.now())), cache: 'no-store' });
    assert.equal(result.status, 200, `Expected 200: ${path}`);
    assert.match(result.headers.get('X-Robots-Tag') || '', /noindex/, `Missing noindex: ${path}`);
    return result;
  };
  const version = await (await get('/__preview/version')).json();
  for (const key of ['sourceSha', 'treeSha', 'assetsSha256', 'workerSha256', 'artifactSha256']) assert.equal(version[key], release[key], `Wrong deployed ${key}`);
  assert.equal(version.runtimeConfigSha256, config.vars.RUNTIME_CONFIG_SHA256, 'Wrong runtime configuration');
  assert.ok(Array.isArray(release.assets) && release.assets.length <= 200, 'Asset count exceeds bounded smoke allowance');
  for (const asset of release.assets) {
    assert.ok(!asset.path.startsWith('/') && !asset.path.split('/').some(part => part === '..'), 'Unsafe asset path');
    const result = await get(`/${asset.path.split('/').map(encodeURIComponent).join('/')}`);
    assert.equal(digest(new Uint8Array(await result.arrayBuffer())), asset.sha256, `Wrong asset bytes: ${asset.path}`);
  }
  for (const policy of ['/privacy.html', '/usage.html']) await get(policy);
  assert.match(await (await get('/robots.txt')).text(), /Disallow: \//);
  for (const path of ['/api/v1/session']) {
    const result = await get(path);
    assert.match(result.headers.get('Cache-Control') || '', /no-store/, `API can be cached: ${path}`);
    assert.match(result.headers.get('Content-Type') || '', /application\/json/, `API returned HTML: ${path}`);
    const body = await result.json();
    assert.ok(body && typeof body === 'object', `Invalid API object: ${path}`);
  }
  return { sourceSha: release.sourceSha, artifactSha256: release.artifactSha256, runtimeConfigSha256: version.runtimeConfigSha256, checkedAssets: release.assets.length, result: 'passed', scope: 'read-only frontend delivery; API/runner identities and authenticated journeys require separate release checks' };
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv.length !== 4) throw new Error('Usage: node scripts/frontend-smoke.mjs <approved-https-origin> <retained-artifact-directory>');
  console.log(JSON.stringify(await smoke(process.argv[2], process.argv[3]), null, 2));
}
