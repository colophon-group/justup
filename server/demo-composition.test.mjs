// Availability is a bounded same-build file contract; these tests have no provider
// configuration and never connect to the broker or send a network request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,writeFileSync,chmodSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiServices,createApiReadiness,readRunnerStatus } from './demo-composition.mjs';
import { writeRunnerStatus,readRunnerConfig } from './demo-runner-adapter.mjs';
const AT=Date.parse('2026-10-31T16:00:00Z'),sourceCommit='a'.repeat(40),buildIdentity='sha256:immutable';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'justup-composition-')),path=join(dir,'runner-status.json');t.after(()=>rmSync(dir,{recursive:true,force:true}));return {dir,path,config:{sourceCommit,buildIdentity,runnerStatusPath:path},write(extra={}){const value={schemaVersion:1,identity:'queue-build',sourceCommit,buildIdentity,ready:true,updatedAt:new Date(AT).toISOString(),capabilities:{search:true,companyRequests:true,aiMatching:false},...extra};writeFileSync(path,JSON.stringify(value),{mode:0o640});return value;}};}
test('missing/stale/wrong-build or malformed heartbeat fails closed without model access',t=>{
  const f=fixture(t),read=()=>createApiReadiness({config:f.config,now:()=>AT})();assert.equal(read().runner.ready,false);
  for(const patch of [{updatedAt:new Date(AT-30001).toISOString()},{updatedAt:new Date(AT+1001).toISOString()},{sourceCommit:'b'.repeat(40)},{buildIdentity:'other'},{capabilities:{search:true}},{identity:'invalid identity'},{schemaVersion:2}]){f.write(patch);assert.equal(read().ready,false);assert.equal(read().capabilities.search,false);}
  f.write();chmodSync(f.path,0o644);assert.equal(read().ready,false);
});
test('fresh exact-build heartbeat exposes actual runner metadata and bounded boolean capabilities',t=>{
  const f=fixture(t);f.write();const r=createApiReadiness({config:f.config,now:()=>AT})();assert.equal(r.ready,true);assert.equal(r.runner.identity,'queue-build');assert.equal(r.runner.sourceCommit,sourceCommit);assert.equal(r.runner.buildIdentity,buildIdentity);assert.equal(r.runner.lastHeartbeat,new Date(AT).toISOString());assert.deepEqual(r.capabilities,{search:true,companyRequests:true,aiMatching:false});
});
test('API advertises queue availability and enqueues work without constructing inference providers',async t=>{
  const f=fixture(t);f.write();const db=new DatabaseSync(':memory:');t.after(()=>db.close());let serial=0;const queued=new Map();
  const tasks={enqueue(input){const task={...input,id:`task-${++serial}`,status:'pending',createdAt:new Date(AT).toISOString(),updatedAt:new Date(AT).toISOString()};queued.set(task.id,task);return task;},get:(owner,id)=>queued.get(id)?.ownerId===owner?queued.get(id):null,delete:(owner,id)=>queued.delete(id),complete:()=>false,publicView:task=>({id:task.id,status:task.status,result:null,error:null})};
  const feed={eligibleJobs:()=>[],publicJob:j=>j,companies:()=>({items:[]}),generation:()=>null,coverage:()=>({stale:true})};
  const config={...f.config,get model(){throw Error('API read model config');},get jev(){throw Error('API read provider key');}};
  const services=createApiServices({db,feed,tasks,config,now:()=>AT,beforePrivateDelete:()=>{}}),intent=services[0],company=services[1];
  assert.equal(intent.capabilities().search,true);assert.equal(company.capabilities().companyRequests,true);
  const ctx={method:'POST',path:'/searches',url:new URL('https://preview.example/searches'),body:{query:'backend',requestKey:'one'},viewer:{account:{id:'owner'}},accountId:'owner'};
  const response=await intent.route(ctx);assert.equal(response.status,202);assert.equal(JSON.stringify(response).includes('provider'),false);
  const task=queued.get(response.body.task.id);Object.assign(task,{status:'running',leaseToken:'lease',leaseUntil:AT+30000});assert.equal((await intent.runTask(task)).errorCode,'dependency_unavailable');
  f.write({ready:false});assert.equal(intent.capabilities().search,false);await assert.rejects(()=>intent.route({...ctx,body:{query:'different',requestKey:'two'}}),{code:'dependency_unavailable'});
});
test('queue status writes atomic non-secret metadata and shutdown removes availability',t=>{
  const f=fixture(t);writeRunnerStatus({path:f.path,identity:'queue-build',config:f.config,capabilities:{search:false,companyRequests:false,aiMatching:false},now:()=>AT});assert.equal(readRunnerStatus({config:f.config,now:()=>AT}).ready,true);
  writeRunnerStatus({path:f.path,identity:'queue-build',config:f.config,ready:false,capabilities:{search:false,companyRequests:false,aiMatching:false},now:()=>AT});assert.equal(readRunnerStatus({config:f.config,now:()=>AT}).ready,false);
});
test('queue configuration refuses an ordinary contributor-owned config',t=>{const f=fixture(t);f.write();assert.throws(()=>readRunnerConfig(f.path),/unavailable/);});
