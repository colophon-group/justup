// Fixed queue bootstrap. Only this role reads scoped JEV configuration and can
// reach the dedicated model broker; API composition receives availability only.
import { lstatSync,readFileSync,writeFileSync,renameSync,unlinkSync,chmodSync,realpathSync } from 'node:fs';
import { dirname,isAbsolute,join } from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { createIntentService } from './intent.mjs';
import { createCompanyService } from './companies.mjs';
import { createCodexModel } from './model-runner.mjs';
import { createBrokerExecutor } from './model-broker.mjs';
import { runnerStatusPath } from './demo-composition.mjs';

export function readRunnerConfig(path=process.env.JUSTUP_DEMO_RUNNER_CONFIG){
  if(!isAbsolute(path)||realpathSync(path)!==path)throw new Error('Runner configuration is unavailable.');
  const meta=lstatSync(path);if(!meta.isFile()||meta.uid!==0||(meta.mode&0o027)!==0||meta.size>32_768)throw new Error('Runner configuration is unavailable.');
  const config=JSON.parse(readFileSync(path,'utf8'));
  if(!config||typeof config!=='object'||Array.isArray(config)||Object.keys(config).some(k=>!['dbPath','sharedState','sourceCommit','buildIdentity','runnerStatusPath','model','jev','matching','verificationTtlMs'].includes(k))||!isAbsolute(config.dbPath)||!/^[a-f0-9]{40}$/.test(config.sourceCommit??'')||typeof config.buildIdentity!=='string'||!config.buildIdentity||config.buildIdentity.length>200||!isAbsolute(runnerStatusPath(config)))throw new Error('Runner configuration is unavailable.');
  return config;
}
export function writeRunnerStatus({path,identity,config,capabilities,ready=true,now=Date.now}){
  const parent=dirname(path),meta=lstatSync(parent);if(!isAbsolute(path)||!meta.isDirectory()||meta.isSymbolicLink()||(meta.mode&0o002)!==0)throw new Error('Runner status storage is unavailable.');
  const value={schemaVersion:1,identity,sourceCommit:config.sourceCommit,buildIdentity:config.buildIdentity,updatedAt:new Date(now()).toISOString(),ready,capabilities};
  const temp=join(parent,`.runner-status-${randomUUID()}.tmp`);
  try{writeFileSync(temp,JSON.stringify(value),{flag:'wx',mode:0o640});chmodSync(temp,0o640);renameSync(temp,path);}finally{try{unlinkSync(temp);}catch(error){if(error.code!=='ENOENT')throw error;}}
}
export async function createRunnerDependencies(){
  const config=readRunnerConfig();
  // Shared-state startup checks the service's operator-owned umask; never change
  // a caller's process mask silently or point this at another application's DB.
  if(config.sharedState===true&&(process.umask()&0o070)!==0)throw new Error('Shared runner state requires group access.');
  const [{openStore},{createFeed},{createTasks},{createMatchingService}]=await Promise.all([import('./store.mjs'),import('./feed.mjs'),import('./tasks.mjs'),import('./matching.mjs')]);
  const store=openStore(config.dbPath,{sharedState:config.sharedState===true});let heartbeatTimer,cleanupTimer;
  try{
    const feed=createFeed({db:store.db,verificationTtlMs:config.verificationTtlMs}),tasks=createTasks({db:store.db});
    const modelConfig=config.model??{},executor=isAbsolute(modelConfig.socketPath??'')?createBrokerExecutor({socketPath:modelConfig.socketPath}):undefined;
    const model=createCodexModel({config:modelConfig,...(executor?{execute:executor}:{})});
    const matching=createMatchingService({db:store.db,feed,tasks,config:{jev:config.jev??{},matching:config.matching}});
    const intent=createIntentService({db:store.db,feed,tasks,model,matching}),companies=createCompanyService({db:store.db,feed,tasks,model});
    const workerId=`runner-${config.sourceCommit.slice(0,12)}-${createHash('sha256').update(config.buildIdentity).digest('hex').slice(0,12)}`;
    const statusPath=runnerStatusPath(config),capabilities=()=>({search:model.available('search_intent'),companyRequests:model.available('company_resolution'),aiMatching:matching.available()});
    const heartbeat=()=>writeRunnerStatus({path:statusPath,identity:workerId,config,capabilities:capabilities()});
    matching.cleanup();heartbeat();
    heartbeatTimer=setInterval(()=>{try{heartbeat();}catch{ /* stale status fails closed in the API */ }},10_000);
    cleanupTimer=setInterval(()=>{try{matching.cleanup();}catch{ /* task/page paths retry bounded cleanup */ }},60_000);
    return {tasks,handlers:{search_intent:intent.runTask,company_resolution:companies.runTask,ai_match:matching.runTask},workerId,
      close(){clearInterval(heartbeatTimer);clearInterval(cleanupTimer);try{writeRunnerStatus({path:statusPath,identity:workerId,config,capabilities:{search:false,companyRequests:false,aiMatching:false},ready:false});}finally{store.close();}}};
  }catch(error){clearInterval(heartbeatTimer);clearInterval(cleanupTimer);store.close();throw error;}
}
