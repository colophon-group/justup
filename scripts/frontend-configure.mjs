// Generate runtime-only Cloudflare config after hostname/resource approval; never embeds values in assets.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digest, verifyArtifact } from './frontend-prepare.mjs';
import { httpsOrigin } from '../deploy/frontend/worker.mjs';

const [artifact, workerName, publicUrl, apiUrl, deploymentMode = 'preview'] = process.argv.slice(2);
if (process.argv.length > 7 || !['preview', 'production'].includes(deploymentMode) || !artifact || !/^[a-z][a-z0-9-]{2,62}$/.test(workerName || '') || !publicUrl || !apiUrl) throw new Error('Usage: node scripts/frontend-configure.mjs <artifact-directory> <worker-name> <approved-public-origin> <approved-api-origin|disabled> [preview|production]');
const publicOrigin = httpsOrigin(publicUrl);
const apiDisabled = apiUrl === 'disabled';
if (apiDisabled && deploymentMode !== 'preview') throw new Error('Disabled API is permitted only for a test preview');
const apiOrigin = apiDisabled ? null : httpsOrigin(apiUrl);
if (publicOrigin === apiOrigin) throw new Error('API origin must be a separate HTTPS upstream');
const publicHost = new URL(publicOrigin).hostname;
const workersDev = publicHost.endsWith('.workers.dev');
if (workersDev && (deploymentMode !== 'preview' || publicHost.split('.').length !== 4 || publicHost.split('.')[0] !== workerName)) throw new Error('workers.dev requires a matching preview Worker name');
const release = await verifyArtifact(artifact);
const identity = Object.fromEntries(['sourceSha', 'treeSha', 'assetsSha256', 'workerSha256', 'artifactSha256'].map(key => [key, release[key]]));
const runtime = { publicOrigin, apiOrigin, apiPrefix: '/api/v1', deploymentMode };
const config = {
  name: workerName, main: './worker.mjs', compatibility_date: '2026-10-30',
  workers_dev: workersDev, preview_urls: false, no_bundle: true, find_additional_modules: false,
  assets: { directory: './assets', binding: 'ASSETS', run_worker_first: true, html_handling: 'none', not_found_handling: 'none' },
  ...(workersDev ? {} : { routes: [{ pattern: publicHost, custom_domain: true }] }),
  vars: { DEPLOYMENT_MODE: deploymentMode, PUBLIC_ORIGIN: publicOrigin, ...(apiDisabled ? { API_DISABLED: 'true' } : { API_ORIGIN: apiOrigin }), RELEASE_JSON: JSON.stringify(identity), RUNTIME_CONFIG_SHA256: digest(JSON.stringify(runtime)) },
  observability: { enabled: false },
};
await writeFile(resolve(artifact, 'wrangler.json'), `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' });
console.log(`Prepared ${resolve(artifact, 'wrangler.json')}; no service has been provisioned or deployed.`);
