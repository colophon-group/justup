// Read-only deployed checks. Read when attaching exact-byte frontend evidence to a release report.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { digest } from './frontend-prepare.mjs';
import { httpsOrigin } from '../deploy/frontend/worker.mjs';

function assetReferences(document) {
  return new Set(Array.from(document.matchAll(/\s(?:src|href)="\/(assets\/[A-Za-z0-9_./-]+\.(?:js|css))"/g), match => match[1]));
}

export async function smoke(origin, artifact, fetchRemote = globalThis.fetch) {
  origin = httpsOrigin(origin);
  const release = JSON.parse(await readFile(join(artifact, 'release.json'), 'utf8'));
  const config = JSON.parse(await readFile(join(artifact, 'wrangler.json'), 'utf8'));
  assert.equal(config.vars.PUBLIC_ORIGIN, origin, 'Configured origin differs from smoke target');
  const deploymentMode = config.vars.DEPLOYMENT_MODE;
  assert.ok(['preview', 'production'].includes(deploymentMode), 'Invalid deployment mode');
  assert.ok(config.vars.API_DISABLED === undefined || config.vars.API_DISABLED === 'true', 'Invalid API-disabled setting');
  const apiDisabled = config.vars.API_DISABLED === 'true';
  if (apiDisabled) {
    assert.equal(deploymentMode, 'preview', 'Disabled API requires preview mode');
    assert.equal(config.vars.API_ORIGIN, undefined, 'Disabled API cannot configure an upstream');
  }
  assert.equal(config.vars.RUNTIME_CONFIG_SHA256, digest(JSON.stringify({ publicOrigin: origin, apiOrigin: apiDisabled ? null : httpsOrigin(config.vars.API_ORIGIN), apiPrefix: '/api/v1', deploymentMode })), 'Runtime configuration identity differs from its settings');
  const deadline = Date.now() + 60_000;
  const get = async (path, status = 200) => {
    assert.ok(Date.now() < deadline, 'Smoke deadline exceeded');
    const result = await fetchRemote(`${origin}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(Math.min(10_000, deadline - Date.now())), cache: 'no-store' });
    assert.equal(result.status, status, `Expected ${status}: ${path}`);
    if (deploymentMode === 'preview' || path.startsWith('/api/') || path.startsWith('/__release/')) assert.match(result.headers.get('X-Robots-Tag') || '', /noindex/, `Missing noindex: ${path}`);
    return result;
  };
  const version = await (await get('/__release/version')).json();
  for (const key of ['sourceSha', 'treeSha', 'assetsSha256', 'workerSha256', 'artifactSha256']) assert.equal(version[key], release[key], `Wrong deployed ${key}`);
  assert.equal(version.runtimeConfigSha256, config.vars.RUNTIME_CONFIG_SHA256, 'Wrong runtime configuration');
  assert.equal(version.deploymentMode, deploymentMode, 'Wrong deployed environment');
  assert.ok(Array.isArray(release.assets) && release.assets.length <= 200, 'Asset count exceeds bounded smoke allowance');
  const index = release.assets.find(asset => asset.path === 'index.html');
  assert.ok(index, 'Missing root index identity');
  const retainedIndex = await readFile(join(artifact, 'assets', 'index.html'));
  assert.equal(digest(retainedIndex), index.sha256, 'Wrong asset bytes: index.html');
  const entryAssets = assetReferences(retainedIndex.toString('utf8'));
  assert.ok([...entryAssets].some(path => path.endsWith('.js')), 'Missing retained entry script');
  const document = await (await get('/')).text();
  assert.match(document, /<meta name="justup-public-document" content="v1">/, 'Missing shared public rendering proof');
  assert.ok(document.includes(`<meta name="justup-source" content="${release.sourceSha}">`), 'Rendered document has wrong source identity');
  assert.ok(document.includes(`<meta name="justup-runtime-config" content="${config.vars.RUNTIME_CONFIG_SHA256}">`), 'Rendered document has wrong runtime identity');
  assert.ok(document.includes(`<link rel="canonical" href="${origin}/">`), 'Wrong public canonical');
  assert.match(document, /<div id="root">[\s\S]*Beat the/, 'Landing document has no readable public content');
  assert.match(document, /<template id="public-bootstrap" data-public=/, 'Missing inert public hydration data');
  assert.doesNotMatch(document, /(?:csrfToken|proposalId|passwordHash|sessionToken|modelEvidence)/, 'Private state in public document');
  const servedReferences = assetReferences(document);
  const retainedPaths = new Set(release.assets.map(asset => asset.path));
  // Lazy modules need to be available and byte-verified when requested.
  for (const path of entryAssets) assert.ok(servedReferences.has(path), `Public document does not use retained entry asset: ${path}`);
  for (const path of servedReferences) assert.ok(retainedPaths.has(path), `Public document references an unretained asset: ${path}`);
  for (const asset of release.assets) {
    assert.ok(!asset.path.startsWith('/') && !asset.path.split('/').some(part => part === '..'), 'Unsafe asset path');
    const result = await get(`/${asset.path.split('/').map(encodeURIComponent).join('/')}`);
    assert.equal(digest(new Uint8Array(await result.arrayBuffer())), asset.sha256, `Wrong asset bytes: ${asset.path}`);
  }
  for (const policy of ['/privacy.html', '/usage.html']) await get(policy);
  assert.equal(await (await get('/robots.txt')).text(), deploymentMode === 'preview' ? 'User-agent: *\nDisallow: /\n' : 'User-agent: *\nDisallow: /api/\nDisallow: /__release/\n', 'Wrong robots policy');
  if (apiDisabled) {
    for (const path of ['/api/v1/health', '/api/v1/session', '/api/v1/version']) {
      const result = await get(path, 503);
      assert.match(result.headers.get('Cache-Control') || '', /no-store/, `Disabled API can be cached: ${path}`);
      assert.match(result.headers.get('Content-Type') || '', /application\/json/, `Disabled API returned HTML: ${path}`);
      assert.equal((await result.json()).error?.code, 'dependency_unavailable', `Unexpected disabled API response: ${path}`);
    }
    return { deploymentMode, apiState: 'disabled', sourceSha: release.sourceSha, artifactSha256: release.artifactSha256, runtimeConfigSha256: version.runtimeConfigSha256, checkedAssets: release.assets.length, result: 'passed', completeReleaseGate: false, scope: 'frontend-only test deployment; API intentionally unavailable; no service health, account, provider or complete release qualification' };
  }
  const health = await get('/api/v1/health');
  assert.match(health.headers.get('Cache-Control') || '', /no-store/, 'Health can be cached');
  for (const path of ['/api/v1/session', '/api/v1/version']) {
    const result = await get(path);
    assert.match(result.headers.get('Cache-Control') || '', /no-store/, `API can be cached: ${path}`);
    assert.match(result.headers.get('Content-Type') || '', /application\/json/, `API returned HTML: ${path}`);
    const body = await result.json();
    assert.ok(body && typeof body === 'object', `Invalid API object: ${path}`);
    if (path === '/api/v1/session') {
      assert.equal(body.user, null, 'Uncredentialed smoke must be a visitor');
      assert.ok(body.access && typeof body.access === 'object', 'Missing server-owned access');
    }
  }
  return { deploymentMode, sourceSha: release.sourceSha, artifactSha256: release.artifactSha256, runtimeConfigSha256: version.runtimeConfigSha256, checkedAssets: release.assets.length, publicDocumentProof: 'semantic public HTML, runtime identity and retained asset references; rendered source facts are not immutable artifact bytes', result: 'passed', scope: 'read-only frontend delivery; API/runner identities and authenticated journeys require separate release checks' };
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv.length !== 4) throw new Error('Usage: node scripts/frontend-smoke.mjs <approved-https-origin> <retained-artifact-directory>');
  console.log(JSON.stringify(await smoke(process.argv[2], process.argv[3]), null, 2));
}
