// Runs only in the fixed preview qualification unit with the ordinary
// runner's database and its existing protected JEV configuration.
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { pathToFileURL } from 'node:url';
import { readRunnerConfig } from '../runner-adapter.mjs';
import { openStore } from '../store.mjs';
import { qualifyJevHeldout } from './jev-qualification.mjs';

export function assertQualificationService() {
  if (process.platform !== 'linux' || process.getuid() === 0 || process.getuid() !== process.geteuid()
      || userInfo().username !== 'justup-preview-runner') throw new Error('The dedicated runner is required.');
  const cgroup = readFileSync('/proc/self/cgroup', 'utf8').split('\n').find(line => line.startsWith('0::'));
  const status = readFileSync('/proc/self/status', 'utf8');
  if (!cgroup?.endsWith('/justup-preview.slice/justup-preview-jev-qualification.service')
      || !/^NoNewPrivs:\s+1$/mu.test(status) || !/^CapEff:\s+0+$/mu.test(status)) {
    throw new Error('The protected JEV qualification unit is required.');
  }
}

async function main() {
  if (process.argv.length !== 2 || process.env.JUSTUP_RUN_JEV_QUALIFICATION !== 'true') {
    throw new Error('The protected JEV qualification launcher is required.');
  }
  assertQualificationService();
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('JEV qualification stopped before a complete report. Review protected state.');
    process.exitCode = 1;
  });
}
