// Fixed host-local foreground queue signal. This is not an HTTP route or a
// Grafana exporter; a reviewed preview collector must run it as the API UID.
import { lstatSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { readForegroundTaskAge } from './alert-signals.mjs';

export const PREVIEW_DB = '/srv/justup_preview/state/preview.sqlite';

export function readHostForegroundAge({
  inspect = lstatSync, canonical = realpathSync, uid = () => process.getuid(),
  open = (path, options) => new DatabaseSync(path, options), now = Date.now,
} = {}) {
  const file = inspect(PREVIEW_DB);
  const caller = uid();
  if (canonical(PREVIEW_DB) !== PREVIEW_DB || !file.isFile() || file.isSymbolicLink()
      || file.nlink !== 1 || file.mode & 0o007 || !Number.isSafeInteger(caller)
      || caller === 0 || file.uid !== caller) {
    throw new Error('The preview database or caller identity is invalid.');
  }
  const db = open(PREVIEW_DB, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    return readForegroundTaskAge({ db, now });
  } finally {
    db.close();
  }
}

export function runAlertSignalsCli(args, { collect = readHostForegroundAge,
  stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    if (args.length !== 0) throw new Error('Arguments are not supported.');
    const result = collect();
    const empty = result?.activeCount === 0;
    if (!Number.isSafeInteger(result?.activeCount) || result.activeCount < 0
        || !(result.oldestAgeSeconds === null || Number.isSafeInteger(result.oldestAgeSeconds)
          && result.oldestAgeSeconds >= 0)
        || empty !== (result.oldestAgeSeconds === null)) {
      throw new Error('The alert signal is invalid.');
    }
    stdout.write(JSON.stringify({ activeCount: result.activeCount,
      oldestAgeSeconds: result.oldestAgeSeconds }) + '\n');
    return 0;
  } catch {
    stderr.write('Justup alert signal unavailable.\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runAlertSignalsCli(process.argv.slice(2));
}
