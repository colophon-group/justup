// Runs only in the fixed preview qualification unit with the ordinary
// runner's database and its existing protected JEV configuration.
import { readRunnerConfig } from '../runner-adapter.mjs';
import { openStore } from '../store.mjs';
import { qualifyJevHeldout } from './jev-qualification.mjs';

async function main() {
  if (process.argv.length !== 2 || process.env.JUSTUP_RUN_JEV_QUALIFICATION !== 'true') {
    throw new Error('The protected JEV qualification launcher is required.');
  }
  const config = readRunnerConfig();
  if (config.jev?.qualificationOnly !== true || config.jev.enabled !== true
      || config.sharedState !== true || config.dbPath !== '/srv/justup_preview/state/preview.sqlite'
      || (process.umask() & 0o070) !== 0) throw new Error('The preview runner database is required.');
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  const store = openStore(config.dbPath, { sharedState: true });
  try {
    const startedAt = new Date().toISOString();
    const result = await qualifyJevHeldout({ db: store.db, config: config.jev, signal: controller.signal });
    console.log(JSON.stringify({ sourceCommit: config.sourceCommit, buildIdentity: config.buildIdentity,
      hostPlanSha256: config.hostPlanSha256, startedAt, finishedAt: new Date().toISOString(), ...result }));
    process.exitCode = result.status === 'pass' ? 0 : 1;
  } finally {
    store.close();
    process.removeListener('SIGTERM', abort);
    process.removeListener('SIGINT', abort);
  }
}

main().catch(() => {
  console.error('JEV qualification stopped before a complete report. Review protected state.');
  process.exitCode = 1;
});
