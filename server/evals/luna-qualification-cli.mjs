// Prepared one-use Luna qualification path. Live entry is blocked until a
// reviewed fixed systemd unit installs the queue sandbox for this command.
import { constants,closeSync,fsyncSync,fstatSync,lstatSync,openSync,readFileSync,realpathSync,writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBrokerExecutor } from '../model-broker.mjs';
import { CODEX_VERSION,MODEL_CATALOGUE_SHA256,MODEL_PROFILES,createCodexModel } from '../model-runner.mjs';
import { readRunnerConfig } from '../runner-adapter.mjs';
import { createQualificationObserver,evaluateQualification,fixedQualificationManifest } from './luna-qualification.mjs';

const BASE='/srv/justup_preview',GRANT=BASE+'/queue/config/luna-qualification.json',WORK=BASE+'/queue/work';
const QUALIFICATION_SOURCE_ONLY=true;
const SHA=/^[a-f0-9]{64}$/,OID=/^[a-f0-9]{40}$/,RUN=/^[a-f0-9]{32}$/;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const unavailable=()=>new Error('Luna qualification is unavailable.');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const safeDate=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)&&Number.isFinite(Date.parse(value));

export function validateQualificationGrant(value,{sourceCommit,buildIdentity,hostPlanSha256,manifestSha256,now=Date.now()}){
  if(!plain(value)||Object.keys(value).sort().join(',')!=='buildIdentity,expiresAt,hostPlanSha256,kind,manifestSha256,notBefore,runId,schemaVersion,sourceCommit'
    ||value.schemaVersion!==1||value.kind!=='luna_qualification_once'||!RUN.test(value.runId??'')
    ||!OID.test(value.sourceCommit??'')||!SHA.test(value.buildIdentity??'')||!SHA.test(value.hostPlanSha256??'')||!SHA.test(value.manifestSha256??'')
    ||value.sourceCommit!==sourceCommit||value.buildIdentity!==buildIdentity||value.hostPlanSha256!==hostPlanSha256||value.manifestSha256!==manifestSha256
    ||!safeDate(value.notBefore)||!safeDate(value.expiresAt))throw unavailable();
  const start=Date.parse(value.notBefore),end=Date.parse(value.expiresAt);
  if(end<=start||end-start>300_000||now<start||now>=end)throw unavailable();
  return value;
}

function queueUid(){
  if(process.platform!=='linux'||typeof process.getuid!=='function'||typeof process.geteuid!=='function'||process.getuid()!==process.geteuid()||process.getuid()===0)throw unavailable();
  const lines=readFileSync('/etc/passwd','utf8').split('\n');
  const matches=lines.filter(line=>line.startsWith('justup-preview-runner:'));
  if(matches.length!==1||Number(matches[0].split(':')[2])!==process.getuid())throw unavailable();
  return process.getuid();
}
function readProtectedGrant(){
  if(realpathSync(GRANT)!==GRANT)throw unavailable();
  const parent=lstatSync(BASE+'/queue/config');
  if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==0||(parent.mode&0o002)!==0)throw unavailable();
  const fd=openSync(GRANT,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const before=fstatSync(fd);
    if(!before.isFile()||before.uid!==0||before.gid!==process.getgid()||(before.mode&0o777)!==0o640||before.nlink!==1||before.size<1||before.size>8192)throw unavailable();
    const bytes=readFileSync(fd),after=fstatSync(fd);
    if(['dev','ino','size','mtimeMs','ctimeMs'].some(key=>before[key]!==after[key]))throw unavailable();
    return {value:JSON.parse(bytes),sha256:sha(bytes)};
  }finally{closeSync(fd);}
}
function outputPath(runId){
  if(realpathSync(WORK)!==WORK)throw unavailable();
  const meta=lstatSync(WORK);
  if(!meta.isDirectory()||meta.isSymbolicLink()||meta.uid!==process.getuid()||(meta.mode&0o777)!==0o700)throw unavailable();
  return join(WORK,`luna-qualification-${runId}.jsonl`);
}
function appendLine(fd,value){
  const bytes=Buffer.from(JSON.stringify(value)+'\n');
  if(bytes.length>8192)throw unavailable();
  for(let offset=0;offset<bytes.length;){const written=writeSync(fd,bytes,offset,bytes.length-offset);if(written<1)throw unavailable();offset+=written;}
  fsyncSync(fd);
}
function qualificationModelConfig(base,identity){
  const model=base.model;
  if(!plain(model)||model.cliVersion!==CODEX_VERSION||model.socketPath!==BASE+'/broker/model.sock'||model.attestationPath!==BASE+'/broker/isolation-reviewed.json'
    ||model.companyResearchVerified!==true)throw unavailable();
  // Product configuration may remain disabled. Only this process turns on
  // attested profiles after a separate root grant; it publishes no capability.
  return {...model,enabled:true,isolationVerified:true,companyResearchVerified:true,...identity,
    taskProfiles:Object.fromEntries(Object.entries(MODEL_PROFILES).map(([kind,profile])=>[kind,{enabled:true,toolPolicySha256:profile.toolPolicySha256,modelCatalogueSha256:MODEL_CATALOGUE_SHA256}]))};
}
export async function runQualificationCli(){
  // A queue UID alone does not prove the systemd sandbox. Remove this source
  // gate only with the fixed installed service and its host-plan review.
  if(QUALIFICATION_SOURCE_ONLY)throw unavailable();
  queueUid();
  const config=readRunnerConfig(),identity={sourceCommit:config.sourceCommit,buildIdentity:config.buildIdentity,hostPlanSha256:config.hostPlanSha256};
  const {manifest,sha256:manifestSha256}=fixedQualificationManifest();
  const protectedGrant=readProtectedGrant();
  const grant=validateQualificationGrant(protectedGrant.value,{...identity,manifestSha256});
  const path=outputPath(grant.runId);
  // Exclusive creation is the non-retry marker. A crash leaves a partial
  // redacted record and the same grant cannot be exercised a second time.
  const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{
    const header={version:1,kind:'luna_qualification_start',runId:grant.runId,...identity,manifestSha256,grantSha256:protectedGrant.sha256};
    appendLine(fd,header);
    const observer=createQualificationObserver();
    const executor=createBrokerExecutor({socketPath:config.model.socketPath,onReply:observer.onReply});
    const model=createCodexModel({config:qualificationModelConfig(config,identity),execute:executor,onMetric:observer.onMetric});
    const report=await evaluateQualification({manifest,model,observer,onCase(record){appendLine(fd,{kind:'case',...record});}});
    appendLine(fd,{kind:'summary',passed:report.passed,intent:report.intent,company:report.company,totals:report.totals});
    return report.passed?0:2;
  }finally{closeSync(fd);}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{if(process.argv.length!==2)throw unavailable();process.exitCode=await runQualificationCli();}
  catch{console.error('Luna qualification did not complete.');process.exitCode=1;}
}
