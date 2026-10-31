// Run every available server contract; read when adding the first backend or changing suite discovery.
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function discoverNodeTests(root, scope) {
  const directory = resolve(root, scope);
  let entries;
  try { entries = readdirSync(directory, { recursive: true, withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const tests = entries.filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs')).map(entry => resolve(entry.parentPath, entry.name)).sort();
  if (!tests.length) throw new Error(`${scope} directory exists without registered .test.mjs contracts; do not skip verification`);
  return tests;
}
export const serverTests = root => discoverNodeTests(root, 'server');
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const tests = serverTests(process.cwd());
  if (tests === null) console.log('Server suite unavailable: this candidate has no server directory.');
  else {
    console.log(`Server contract files:\n${tests.join('\n')}`);
    const result = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' });
    process.exit(result.status ?? 1);
  }
}
