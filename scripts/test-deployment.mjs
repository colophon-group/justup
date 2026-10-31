// Run deployment contracts; read when adding frontend/backend hosting or preview operator scripts.
import { readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { discoverNodeTests } from './test-server.mjs';

export function deploymentTests(root) {
  const tests = discoverNodeTests(root, 'deploy');
  if (!tests) throw new Error('Deployment contract directory is missing');
  const scripts = readdirSync(join(root, 'scripts'));
  const previewTests = scripts.filter(name => /^preview-.*\.test\.mjs$/.test(name)).map(name => resolve(root, 'scripts', name));
  let backendFiles = [];
  try { backendFiles = readdirSync(join(root, 'deploy/justup-preview'), { recursive: true }).filter(name => !name.endsWith('.md')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const hasPreviewImplementation = backendFiles.length || scripts.some(name => name.startsWith('preview-') && !name.endsWith('.test.mjs'));
  const hasPreviewContracts = previewTests.length || tests.some(path => path.startsWith(resolve(root, 'deploy/justup-preview') + '/')) || scripts.some(name => /^test_.*preview.*\.py$/.test(name));
  if (hasPreviewImplementation && !hasPreviewContracts) throw new Error('Backend preview implementation exists without registered Node/Python behavioral contracts');
  return [...tests, ...previewTests].sort();
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const files = deploymentTests(process.cwd());
  console.log(`Deployment contract files:\n${files.join('\n')}`);
  const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
