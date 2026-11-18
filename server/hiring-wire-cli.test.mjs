// Hiring Wire operator CLI contracts. Server CI lane; temporary local state only,
// under one second. No scheduler, model or external service is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.mjs';
import { enqueueWeekly,latestWirePeriodEnd } from '../scripts/hiring-wire/enqueue.mjs';
import { checkSnapshot } from '../scripts/hiring-wire/check-snapshot.mjs';
import { AT,END,wireFixture } from './hiring-wire-fixtures.mjs';
function directory(t){const path=realpathSync(mkdtempSync(join(tmpdir(),'wire-cli-')));t.after(()=>rmSync(path,{recursive:true,force:true}));return path;}
test('weekly entry computes Monday UTC and repeated scheduling reuses the system task',t=>{
  assert.equal(latestWirePeriodEnd(AT),END);assert.equal(latestWirePeriodEnd(Date.parse('2026-11-08T23:59:59.999Z')),END);
  const path=join(directory(t),'application.sqlite');openStore(path).close();
  const input={env:{JUSTUP_DB_PATH:path},args:['--period',END],now:()=>AT};
  const first=enqueueWeekly(input),second=enqueueWeekly(input);assert.equal(first.taskId,second.taskId);assert.equal(first.status,'pending');
  assert.throws(()=>enqueueWeekly({...input,env:{}}));assert.throws(()=>enqueueWeekly({...input,args:['--enable-provider']}));
});
test('snapshot preflight validates history without returning restricted identifiers',t=>{
  const dir=directory(t),path=join(dir,'snapshot.json');writeFileSync(path,JSON.stringify(wireFixture()),{mode:0o600});
  const result=checkSnapshot({args:[path,'--period',END],now:()=>AT});assert.equal(result.comparableCompanies,1);
  assert.equal(JSON.stringify(result).includes('restricted'),false);assert.equal(JSON.stringify(result).includes('internal-board'),false);
  const link=join(dir,'link.json');symlinkSync(path,link);assert.throws(()=>checkSnapshot({args:[link,'--period',END],now:()=>AT}));
  writeFileSync(path,JSON.stringify({credential:'not-a-source-projection'}));assert.throws(()=>checkSnapshot({args:[path,'--period',END],now:()=>AT}));
});

test('snapshot preflight validates the exact Jobseek wrapper and compiled period from stdin', t => {
  const path = join(directory(t), 'artifact.json');
  const args = ['--artifact', '--source-version', 'jobseek-coverage-v2', '--period', END];
  const fixture = wireFixture();
  fixture.schemaVersion = 2;
  fixture.sourceVersion = args[2];
  for (const scope of fixture.scopes) scope.publicLink = null;
  const raw = Buffer.from(JSON.stringify(fixture));
  const envelope = {
    artifactVersion: 1,
    snapshotBytesBase64: raw.toString('base64'),
    sha256: createHash('sha256').update(raw).digest('hex')
  };
  function check(supplied, options = {}) {
    writeFileSync(path, JSON.stringify(supplied));
    const fd = openSync(path, 'r');
    try {
      return checkSnapshot({ args, now: () => AT, inputFd: fd, ...options });
    } finally {
      closeSync(fd);
    }
  }
  const receipt = check(envelope);
  assert.equal(receipt.comparableCompanies, 1);
  assert.equal(receipt.periodEnd, END);
  assert.match(receipt.snapshotSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(Object.keys(receipt).sort(), ['comparableCompanies', 'periodEnd', 'snapshotSha256', 'suppressedScopes']);
  assert.throws(() => check({ ...envelope, sha256: '0'.repeat(64) }));
  assert.throws(() => check(envelope, { args: args.map(part => part === 'jobseek-coverage-v2' ? 'jobseek-coverage-v1' : part) }));
  assert.throws(() => check(envelope, { now: () => AT + 2 * 86_400_000 }), { code: 'dependency_unavailable' });

  const entry = fileURLToPath(new URL('../scripts/hiring-wire/check-snapshot.mjs', import.meta.url));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const command = spawnSync(process.execPath, [
    '--permission', '--allow-fs-read=' + root, '--import', `data:text/javascript,Date.now=()=>${AT}`,
    entry, ...args
  ], { input: JSON.stringify(envelope), encoding: 'utf8', timeout: 5000 });
  assert.equal(command.status, 0, command.stderr);
  assert.deepEqual(JSON.parse(command.stdout), receipt);
});
