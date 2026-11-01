// Fixed queue bootstrap. Only this role reads scoped JEV configuration and can
// reach the dedicated model broker; API composition receives availability only.
import { lstatSync,readFileSync,writeFileSync,renameSync,unlinkSync,chmodSync,realpathSync } from 'node:fs';
import { dirname,isAbsolute,join,resolve } from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { createIntentService } from './intent.mjs';
import { createCompanyService } from './companies.mjs';
import { createCodexModel } from './model-runner.mjs';
import { createBrokerExecutor } from './model-broker.mjs';
import { runtimeEnv } from './config.mjs';
import { createVisitorIdentity } from './visitor.mjs';
import { createReadingPreferencesService } from './reading-preferences.mjs';
import { runnerStatusPath } from './composition.mjs';
import { createHiringWireRunner } from './hiring-wire-integration.mjs';
import { validWireConfiguration } from './hiring-wire-codex-broker.mjs';
import { createProductRecords } from './product-records.mjs';
import { SOURCE_COVERAGE_VERSIONS } from './source-coverage.mjs';
import { createEmailVerificationRunner,validateEmailVerificationConfig } from './email-verification.mjs';

function validSourceCoverage(value) {
  return value===undefined||value!==null&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype
    &&Object.keys(value).sort().join(',')==='directory,sourceVersion'&&SOURCE_COVERAGE_VERSIONS.includes(value.sourceVersion)
    &&typeof value.directory==='string'&&isAbsolute(value.directory)&&resolve(value.directory)===value.directory;
}

export function runnerIdentity(env=process.env){
  const sourceCommit=runtimeEnv(env,'SOURCE_COMMIT'),buildIdentity=runtimeEnv(env,'BUILD_ID'),hostPlanSha256=runtimeEnv(env,'HOST_PLAN_SHA256');
  if(!/^[a-f0-9]{40}$/.test(sourceCommit??'')||!/^[a-f0-9]{64}$/.test(buildIdentity??'')||!/^[a-f0-9]{64}$/.test(hostPlanSha256??''))throw new Error('Runner build identity is unavailable.');
  return {sourceCommit,buildIdentity,hostPlanSha256};
}
export function bindRunnerConfig(config,env=process.env){
  const identity=runnerIdentity(env);
  if(!config||typeof config!=='object'||Array.isArray(config)||Object.keys(config).some(k=>!['dbPath','sharedState','runnerStatusPath','model','jev','matching','verificationTtlMs','hiringWire','sourceCoverage','emailVerification'].includes(k))||typeof config.dbPath!=='string'||!isAbsolute(config.dbPath)||!isAbsolute(runnerStatusPath(config))||config.model!=null&&(typeof config.model!=='object'||Array.isArray(config.model)||Object.hasOwn(config.model,'sourceCommit')||Object.hasOwn(config.model,'buildIdentity')||Object.hasOwn(config.model,'hostPlanSha256'))||!validWireConfiguration(config.hiringWire)||!validSourceCoverage(config.sourceCoverage))throw new Error('Runner configuration is unavailable.');
  validateEmailVerificationConfig(config.emailVerification);
  // Only the trusted launcher derives these from the verified artifact and
  // installed host plan. Operator JSON cannot substitute a different proof.
  return {...config,...identity,model:{...(config.model??{}),buildIdentity:identity.buildIdentity,hostPlanSha256:identity.hostPlanSha256}};
}
export function readRunnerConfig(path,env=process.env){
  path ??= runtimeEnv(env,'RUNNER_CONFIG');
  if(typeof path!=='string'||!isAbsolute(path)||realpathSync(path)!==path)throw new Error('Runner configuration is unavailable.');
  const meta=lstatSync(path);if(!meta.isFile()||meta.uid!==0||(meta.mode&0o027)!==0||meta.size>32_768)throw new Error('Runner configuration is unavailable.');
  return bindRunnerConfig(JSON.parse(readFileSync(path,'utf8')),env);
}
export function writeRunnerStatus({path,identity,config,capabilities,ready=true,now=Date.now}){
  const parent=dirname(path),meta=lstatSync(parent);if(!isAbsolute(path)||!meta.isDirectory()||meta.isSymbolicLink()||(meta.mode&0o002)!==0)throw new Error('Runner status storage is unavailable.');
  const value={schemaVersion:1,identity,sourceCommit:config.sourceCommit,buildIdentity:config.buildIdentity,updatedAt:new Date(now()).toISOString(),ready,capabilities};
  const temp=join(parent,`.runner-status-${randomUUID()}.tmp`);
  try{writeFileSync(temp,JSON.stringify(value),{flag:'wx',mode:0o640});chmodSync(temp,0o640);renameSync(temp,path);}finally{try{unlinkSync(temp);}catch(error){if(error.code!=='ENOENT')throw error;}}
}
// The process-local halt survives a failed queue-guard write. Every later status
// publication stays unavailable without consulting providers or reopening work.
export function createRunnerStatusPublisher({path,identity,config,tasks,capabilities,now=Date.now}){
  let forcedUnavailable=false;
  function heartbeat(){
    const ready=!forcedUnavailable&&!tasks.halted();
    const available=Object.fromEntries(Object.entries(capabilities).map(([kind,read])=>[kind,ready?read():false]));
    writeRunnerStatus({path,identity,config,capabilities:available,ready,now});
  }
  return {heartbeat,onHalt(){forcedUnavailable=true;heartbeat();}};
}
export async function createRunnerDependencies(){
  const config=readRunnerConfig();
  // Shared-state startup checks the service's operator-owned umask; never change
  // a caller's process mask silently or point this at another application's DB.
  if(config.sharedState===true&&(process.umask()&0o070)!==0)throw new Error('Shared runner state requires group access.');
  const [{openStore},{createFeed},{createTasks},{createMatchingService},{createAccessReader}]=await Promise.all([import('./store.mjs'),import('./feed.mjs'),import('./tasks.mjs'),import('./matching.mjs'),import('./entitlements.mjs')]);
  const store=openStore(config.dbPath,{sharedState:config.sharedState===true});let heartbeatTimer,cleanupTimer;
  try{
    const feed=createFeed({db:store.db,verificationTtlMs:config.verificationTtlMs}),tasks=createTasks({db:store.db});
    const identity=createVisitorIdentity({db:store.db,config:{dbPath:config.dbPath,sourceCommit:config.sourceCommit,buildIdentity:config.buildIdentity},accessForAccount:createAccessReader({db:store.db})});
    const ownership={ownerAuthority:identity.principal,visitorIdentity:identity,taskAdmission:identity.admitMatching};
    const records=createProductRecords({db:store.db,tasks,ownerAuthority:identity.principal});
    const readingPreferences=createReadingPreferencesService({db:store.db,feed,ownerAuthority:identity.principal});
    const modelConfig=config.model??{},executor=isAbsolute(modelConfig.socketPath??'')?createBrokerExecutor({socketPath:modelConfig.socketPath}):undefined;
    const model=createCodexModel({config:modelConfig,onMetric:records.onModelMetric,...(executor?{execute:executor}:{})});
    const matching=createMatchingService({db:store.db,feed,tasks,...ownership,readingPreferences,config:{jev:config.jev??{},matching:config.matching}});
    const intent=createIntentService({db:store.db,feed,tasks,...ownership,readingPreferences,model,matching,records}),companies=createCompanyService({db:store.db,feed,tasks,model,readingPreferences,...ownership,records});
    const wire=await createHiringWireRunner({db:store.db,tasks,now:Date.now,hiringWire:config.hiringWire,sourceCoverage:config.sourceCoverage,buildIdentity:config.buildIdentity,hostPlanSha256:config.hostPlanSha256});
    const email=createEmailVerificationRunner({db:store.db,tasks,config,now:Date.now});
    const workerId=`runner-${config.sourceCommit.slice(0,12)}-${createHash('sha256').update(config.buildIdentity).digest('hex').slice(0,12)}`;
    const statusPath=runnerStatusPath(config),{heartbeat,onHalt}=createRunnerStatusPublisher({path:statusPath,identity:workerId,config,tasks,
      capabilities:{search:()=>model.available('search_intent'),companyRequests:()=>model.available('company_resolution'),aiMatching:()=>matching.available(),...(config.emailVerification!==undefined?{emailVerification:()=>email.available()}: {})}});
    matching.cleanup();heartbeat();
    heartbeatTimer=setInterval(()=>{try{heartbeat();}catch{ /* stale status fails closed in the API */ }},10_000);
    cleanupTimer=setInterval(()=>{try{matching.cleanup();}catch{ /* task/page paths retry bounded cleanup */ }},60_000);
    return {tasks,handlers:{search_intent:(task,options)=>records.runTask(task,intent.runTask,options),company_resolution:(task,options)=>records.runTask(task,companies.runTask,options),ai_match:(task,options)=>records.runTask(task,matching.runTask,options),hiring_wire:wire.runTask,email_verification:email.runTask},onTaskFinished:records.taskFinished,beforeClaim:wire.beforeClaim,onHalt,workerId,
      close(){clearInterval(heartbeatTimer);clearInterval(cleanupTimer);try{writeRunnerStatus({path:statusPath,identity:workerId,config,capabilities:{search:false,companyRequests:false,aiMatching:false},ready:false});}finally{store.close();}}};
  }catch(error){clearInterval(heartbeatTimer);clearInterval(cleanupTimer);store.close();throw error;}
}
