import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = new URL('../prototype/', import.meta.url);
const files = readdirSync(directory).filter((name) => name.endsWith('.js'));

for (const file of files) {
  const path = fileURLToPath(new URL(file, directory));
  const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`Checked ${files.length} JavaScript files.`);
