// One-use Luna qualification through the fixed capped operator sandbox.
import { constants,closeSync,fsyncSync,fstatSync,lstatSync,openSync,readFileSync,realpathSync,writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBrokerExecutor } from '../model-broker.mjs';
import { CODEX_VERSION,MODEL_CATALOGUE_SHA256,MODEL_PROFILES,createCodexModel } from '../model-runner.mjs';
import { createQualificationObserver,evaluateQualification,fixedQualificationManifest } from './luna-qualification.mjs';
import { qualificationReportSha, qualificationReviewKey, sealQualificationAnswers } from './luna-qualification-review.mjs';

const BASE='/srv/justup_preview',ROOT=BASE+'/queue/qualification',GRANT=ROOT+'/grant.json',WORK=ROOT+'/results';
const UNIT='justup-preview-luna-qualification.service';
const SHA=/^[a-f0-9]{64}$/,OID=/^[a-f0-9]{40}$/,RUN=/^[a-f0-9]{32}$/;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const unavailable=()=>new Error('Luna qualification is unavailable.');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const safeDate=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)&&Number.isFinite(Date.parse(value));

export function validateQualificationGrant(value,{sourceCommit,buildIdentity,hostPlanSha256,manifestSha256,now=Date.now()}){
  if(!plain(value)||Object.keys(value).sort().join(',')!=='buildIdentity,expiresAt,hostPlanSha256,kind,manifestSha256,notBefore,reviewPublicKey,runId,schemaVersion,sourceCommit'
    ||value.schemaVersion!==2||value.kind!=='luna_qualification_once'||!RUN.test(value.runId??'')
    ||!OID.test(value.sourceCommit??'')||!SHA.test(value.buildIdentity??'')||!SHA.test(value.hostPlanSha256??'')||!SHA.test(value.manifestSha256??'')
    ||value.sourceCommit!==sourceCommit||value.buildIdentity!==buildIdentity||value.hostPlanSha256!==hostPlanSha256||value.manifestSha256!==manifestSha256
    ||typeof value.reviewPublicKey!=='string'||!safeDate(value.notBefore)||!safeDate(value.expiresAt))throw unavailable();
  const start=Date.parse(value.notBefore),end=Date.parse(value.expiresAt);
  if(end<=start||end-start>300_000||now<start||now>=end)throw unavailable();
  return value;
}

export function inQualificationSandbox(cgroup,status){
  const parts=cgroup.split('\n').find(line=>line.startsWith('0::'))?.slice(3).split('/');
  return parts?.at(-1)===UNIT&&parts.at(-2)==='justup-preview.slice'
    &&/^NoNewPrivs:\s+1$/mu.test(status)&&/^CapEff:\s+0+$/mu.test(status);
}
function assertQualificationSandbox(){
  if(process.platform!=='linux'||typeof process.getuid!=='function'||typeof process.geteuid!=='function'||process.getuid()!==process.geteuid()||process.getuid()===0)throw unavailable();
  const lines=readFileSync('/etc/passwd','utf8').split('\n');
  const matches=lines.filter(line=>line.startsWith('justup-preview-runner:'));
  if(matches.length!==1||Number(matches[0].split(':')[2])!==process.getuid())throw unavailable();
  if(!inQualificationSandbox(readFileSync('/proc/self/cgroup','utf8'),readFileSync('/proc/self/status','utf8')))throw unavailable();
}
function readProtectedGrant(expected){
  if(!SHA.test(expected??''))throw unavailable();
  if(realpathSync(GRANT)!==GRANT)throw unavailable();
  const parent=lstatSync(ROOT);
  if(!parent.isDirectory()||parent.uid!==0||parent.gid!==process.getgid()||(parent.mode&0o777)!==0o750)throw unavailable();
  const fd=openSync(GRANT,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const before=fstatSync(fd);
    if(!before.isFile()||before.uid!==0||before.gid!==process.getgid()||(before.mode&0o777)!==0o640||before.nlink!==1||before.size<1||before.size>8192)throw unavailable();
    const bytes=readFileSync(fd),after=fstatSync(fd);
    if(['dev','ino','size','mtimeMs','ctimeMs'].some(key=>before[key]!==after[key])||sha(bytes)!==expected)throw unavailable();
    return JSON.parse(bytes);
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
function qualificationModelConfig(identity){
  return {cliVersion:CODEX_VERSION,socketPath:BASE+'/broker/model.sock',attestationPath:BASE+'/broker/isolation-reviewed.json',
    enabled:true,isolationVerified:true,companyResearchVerified:true,...identity,
    taskProfiles:Object.fromEntries(Object.entries(MODEL_PROFILES).map(([kind,profile])=>[kind,{enabled:true,toolPolicySha256:profile.toolPolicySha256,modelCatalogueSha256:MODEL_CATALOGUE_SHA256}]))};
}
export async function runQualificationCli(){
  assertQualificationSandbox();
  const identity={sourceCommit:process.env.JUSTUP_SOURCE_COMMIT,buildIdentity:process.env.JUSTUP_BUILD_ID,
    hostPlanSha256:process.env.JUSTUP_HOST_PLAN_SHA256};
  const {manifest,sha256:manifestSha256}=fixedQualificationManifest();
  const grantSha256=process.env.JUSTUP_LUNA_GRANT_SHA256;
  const grant=validateQualificationGrant(readProtectedGrant(grantSha256),{...identity,manifestSha256});
  const recipient=qualificationReviewKey(grant.reviewPublicKey);
  const path=outputPath(grant.runId);
  // Exclusive creation is the non-retry marker. A crash leaves a partial
  // redacted record and the same grant cannot be exercised a second time.
  const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{
    const header={version:2,kind:'luna_qualification_start',runId:grant.runId,...identity,manifestSha256,grantSha256,
      reviewKeySha256:recipient.sha256};
    appendLine(fd,header);
    const observer=createQualificationObserver();
    const config=qualificationModelConfig(identity);
    const executor=createBrokerExecutor({socketPath:config.socketPath,onReply:observer.onReply});
    const model=createCodexModel({config,execute:executor,onMetric:observer.onMetric});
    const answers=[];
    const report=await evaluateQualification({manifest,model,observer,
      onCase(record){appendLine(fd,{kind:'case',record});},
      onClarification(item){answers.push(item);}});
    const sealed=sealQualificationAnswers({manifest,header,report,answers,recipient});
    if(sealed)appendLine(fd,sealed);
    appendLine(fd,{kind:'summary',passed:report.passed,intent:report.intent,company:report.company,totals:report.totals,
      reportSha256:qualificationReportSha(report)});
    // The caller may retain an unsuccessful measurement. Only the separate
    // finalized report carries the qualification verdict.
    return 0;
  }finally{closeSync(fd);}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{if(process.argv.length!==2)throw unavailable();process.exitCode=await runQualificationCli();}
  catch{console.error('Luna qualification did not complete.');process.exitCode=1;}
}
