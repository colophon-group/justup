// Fixed host-local alert inputs. The protected launcher supplies the active
// artifact identity and runs this read-only child as the preview API UID.
import { lstatSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { readForegroundTaskAge } from './alert-signals.mjs';
import { importedCoverage } from './feed.mjs';
import { readRunnerObservation } from './composition.mjs';
import { assertCurrentSchema } from './schema.mjs';

export const PREVIEW_DB = '/srv/justup_preview/state/preview.sqlite';

function optional(read) {
  try { return read(); } catch { return null; }
}

export function readHostAlertSignals({ env = process.env, inspect = lstatSync, canonical = realpathSync,
  uid = () => process.getuid(), open = (path, options) => new DatabaseSync(path, options),
  runner = readRunnerObservation, now = Date.now } = {}) {
  const sourceCommit = env.JUSTUP_SOURCE_COMMIT, buildIdentity = env.JUSTUP_BUILD_ID;
  const runnerUid = env.JUSTUP_OBSERVE_RUNNER_UID;
  const expectedOwner = Number(runnerUid), caller = uid(), at = now();
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit ?? '') || !/^[a-f0-9]{64}$/u.test(buildIdentity ?? '')
      || !/^[1-9][0-9]*$/u.test(runnerUid ?? '') || !Number.isSafeInteger(expectedOwner)
      || !Number.isSafeInteger(caller) || caller <= 0 || expectedOwner === caller
      || !Number.isSafeInteger(at) || at < 0) throw new Error('Invalid alert collector identity.');
  const report = { schemaVersion: 1, sourceCommit, buildIdentity, databaseReadable: false,
    jobFeed: null, foregroundQueue: null, runner: null };
  const status = runner({ config: { dbPath: PREVIEW_DB, sourceCommit, buildIdentity }, now: () => at, expectedOwner });
  if (status) report.runner = { ready: status.ready, heartbeatAgeSeconds: Math.floor(status.ageMs / 1000),
    search: status.capabilities.search, companyRequests: status.capabilities.companyRequests,
    aiMatching: status.capabilities.aiMatching };
  const db = optional(() => {
    const file = inspect(PREVIEW_DB);
    if (canonical(PREVIEW_DB) !== PREVIEW_DB || !file.isFile() || file.isSymbolicLink()
        || file.nlink !== 1 || file.mode & 0o007 || file.uid !== caller) throw new Error('Unsafe preview database.');
    return open(PREVIEW_DB, { readOnly: true });
  });
  if (!db) return report;
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    assertCurrentSchema(db);
    report.databaseReadable = true;
    report.jobFeed = optional(() => {
      const latest = db.prepare('SELECT generation,verified_at,selection_json FROM justup_imports ORDER BY rowid DESC LIMIT 1').get();
      if (latest && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(latest.generation)) {
        throw new Error('Invalid import identity.');
      }
      const coverage = importedCoverage(latest, at);
      const verified = Date.parse(coverage.verifiedAt);
      return { stale: coverage.stale, importGeneration: latest?.generation ?? null,
        verificationAgeSeconds: Number.isFinite(verified) && verified <= at ? Math.floor((at - verified) / 1000) : null };
    });
    report.foregroundQueue = optional(() => readForegroundTaskAge({ db, now: () => at }));
    return report;
  } catch { return report; }
  finally { db.close(); }
}

export function runAlertSignalsCli(args, { collect = readHostAlertSignals,
  stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    if (args.length !== 0) throw new Error('Arguments are not supported.');
    stdout.write(JSON.stringify(collect()) + '\n');
    return 0;
  } catch {
    stderr.write('Justup alert inputs unavailable.\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runAlertSignalsCli(process.argv.slice(2));
}
