// Run pure TypeScript contracts using Node's type stripping; browser components have Playwright journeys.
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function webTests(root) {
  const directory = resolve(root, 'web/src');
  const files = readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.ts'))
    .map(entry => resolve(entry.parentPath, entry.name)).sort();
  if (!files.length) throw new Error('The web application has no registered TypeScript contracts');
  return files;
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const files = webTests(process.cwd());
  console.log(`Web contract files:\n${files.join('\n')}`);
  const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
