// Hiring Wire operator CLI contracts. Server CI lane; temporary local state only,
// under one second. No scheduler, model or external service is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,realpathSync,rmSync,writeFileSync,symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
