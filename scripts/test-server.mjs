// Run every available server contract; read when adding the first backend or changing suite discovery.
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function serverTests(root) {
  const directory = resolve(root, 'server');
  let entries;
  try { entries = readdirSync(directory, { recursive: true, withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const tests = entries.filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs')).map(entry => resolve(entry.parentPath, entry.name)).sort();
  if (!tests.length) throw new Error('Server directory exists without registered .test.mjs contracts; do not skip backend verification');
  return tests;
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const tests = serverTests(process.cwd());
  if (tests === null) console.log('Server suite unavailable: this candidate has no server directory.');
  else {
    const result = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' });
    process.exit(result.status ?? 1);
  }
}
