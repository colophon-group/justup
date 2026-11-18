// Private operator read/CAS entry point for shared setup progress. Read the
// adjacent checklist before use. This command never runs configuration or providers.
import {lstatSync,readSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {assertCurrentSchema} from '../../server/schema.mjs';
import {canonicalCompanyId} from '../../server/company-identities.mjs';
import {createAccessReader} from '../../server/entitlements.mjs';
import {privateGeneration} from '../../server/processing-admission.mjs';
import {createCompanyProgress} from '../../server/company-progress.mjs';
import {MONITORING_INPUT_LIMIT,readMonitoringApproval,validMonitoringCompanyId} from '../../server/company-monitoring.mjs';

const unavailable=()=>{throw Object.assign(new Error('Company setup is unavailable.'),{code:'dependency_unavailable'});};
function protectedFile(path,modes,{optional=false,shared=false}={}) {
  let metadata;try{metadata=lstatSync(path);}catch(error){if(optional&&error.code==='ENOENT')return null;throw error;}
  if(!isAbsolute(path)||realpathSync(path)!==path||!metadata.isFile()||metadata.nlink!==1||!modes.includes(metadata.mode&0o7777)
      ||metadata.uid!==process.getuid()&&!(shared&&process.getgroups().includes(metadata.gid)))unavailable();
  return metadata;
}
function command(args) {
  if(args[0]==='pending'&&(args.length===1||args.length===3&&args[1]==='--limit'&&/^[1-9]\d?$/.test(args[2])))return {kind:'pending',limit:args.length===1?20:Number(args[2])};
  if (args[0]==='apply-monitoring' && args.length===1) return {kind:'apply-monitoring'};
  if (args[0]==='monitoring-requests' && args[1]==='--company' && validMonitoringCompanyId(args[2])
      && (args.length===3 || args.length===5 && args[3]==='--after-request'
        && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(args[4]))) {
    return {kind:'monitoring-requests',companyId:args[2],after:args[4]};
  }
  if(args.length!==9||args[0]!=='update'||args[1]!=='--company'||args[3]!=='--revision'||args[5]!=='--state'||args[7]!=='--reason'||!/^[1-9]\d{0,8}$/.test(args[4]))unavailable();
  return {kind:'update',companyId:args[2],expectedRevision:Number(args[4]),state:args[6],reason:args[8]};
}
function monitoringInput() {
  const buffer = Buffer.alloc(MONITORING_INPUT_LIMIT + 1);
  let count = 0;
  while (count < buffer.length) {
    const copied = readSync(0, buffer, count, buffer.length - count);
    if (copied === 0) break;
    count += copied;
  }
  return buffer.subarray(0,count);
}
export function companySetupCommand({env=process.env,args=process.argv.slice(2),now=Date.now,stdin=monitoringInput}={}) {
  const input=command(args),path=env.JUSTUP_DB_PATH;
  const readOnly = ['pending','monitoring-requests'].includes(input.kind);
  const approval = input.kind === 'apply-monitoring' ? readMonitoringApproval(stdin(), now()) : null;
  if(typeof path!=='string'||!isAbsolute(path)||![undefined,'true','false'].includes(env.JUSTUP_SHARED_STATE))unavailable();
  const shared=env.JUSTUP_SHARED_STATE==='true',directory=dirname(path),parent=lstatSync(directory),fileMode=shared?0o660:0o600;
  if(realpathSync(directory)!==directory||!parent.isDirectory()||(parent.mode&0o7777)!==(shared?0o2770:0o700)
      ||parent.uid!==process.getuid()&&!(shared&&parent.uid===0&&process.getgroups().includes(parent.gid)))unavailable();
  const original=protectedFile(path,[fileMode],{shared});
  for(const suffix of ['-wal','-shm'])protectedFile(path+suffix,[fileMode],{shared,optional:true});
  const generationPath=env.JUSTUP_PRIVATE_GENERATION_PATH??join(directory,'private-generation');
  const generationFile=protectedFile(generationPath,shared?[0o600,0o640]:[0o600]);
  if((generationFile.mode&0o7777)===0o640&&(dirname(generationPath)!==directory||generationFile.gid!==parent.gid))unavailable();
  const generationConfig={dbPath:path,privateGenerationPath:generationPath},generation=privateGeneration(generationConfig);
  if(!generation)unavailable();
  const priorUmask=process.umask(shared?0o007:0o077);let db;
  try {
    db=new DatabaseSync(path,{readOnly});
    const opened=protectedFile(path,[fileMode],{shared});if(opened.dev!==original.dev||opened.ino!==original.ino)unavailable();
    assertCurrentSchema(db);db.exec('PRAGMA busy_timeout=5000');
    db.exec(readOnly?'BEGIN':'BEGIN IMMEDIATE');
    try {
      if(privateGeneration(generationConfig)!==generation)unavailable();
      const progress=createCompanyProgress({db,now,canonicalCompanyId:id=>canonicalCompanyId(db,id),accessForAccount:createAccessReader({db,now})});
      let result;
      switch (input.kind) {
        case 'pending': result=progress.pending({limit:input.limit});break;
        case 'monitoring-requests': result=progress.monitoringRequests(input.companyId,input.after);break;
        case 'apply-monitoring': result=progress.applyMonitoring(approval);break;
        default: result=progress.update(input);
      }
      if(privateGeneration(generationConfig)!==generation)unavailable();
      db.exec('COMMIT');return result;
    } catch(error) {if(db.isTransaction)db.exec('ROLLBACK');throw error;}
  } finally {db?.close();process.umask(priorUmask);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try{process.stdout.write(`${JSON.stringify(companySetupCommand())}\n`);}
  catch{process.stderr.write('Company setup could not be read or updated.\n');process.exitCode=1;}
}
