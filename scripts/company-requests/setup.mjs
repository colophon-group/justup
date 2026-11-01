// Private operator read/CAS entry point for shared setup progress. Read the
// adjacent checklist before use. This command never runs configuration or providers.
import {lstatSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {assertCurrentSchema} from '../../server/schema.mjs';
import {canonicalCompanyId} from '../../server/company-identities.mjs';
import {createAccessReader} from '../../server/entitlements.mjs';
import {privateGeneration} from '../../server/processing-admission.mjs';
import {createCompanyProgress} from '../../server/company-progress.mjs';

const unavailable=()=>{throw Object.assign(new Error('Company setup is unavailable.'),{code:'dependency_unavailable'});};
function protectedFile(path,mode,{optional=false,shared=false}={}) {
  let metadata;try{metadata=lstatSync(path);}catch(error){if(optional&&error.code==='ENOENT')return null;throw error;}
  if(!isAbsolute(path)||realpathSync(path)!==path||!metadata.isFile()||metadata.nlink!==1||(metadata.mode&0o777)!==mode
      ||metadata.uid!==process.getuid()&&!(shared&&process.getgroups().includes(metadata.gid)))unavailable();
  return metadata;
}
function command(args) {
  if(args[0]==='pending'&&(args.length===1||args.length===3&&args[1]==='--limit'&&/^[1-9]\d?$/.test(args[2])))return {kind:'pending',limit:args.length===1?20:Number(args[2])};
  if(args.length!==9||args[0]!=='update'||args[1]!=='--company'||args[3]!=='--revision'||args[5]!=='--state'||args[7]!=='--reason'||!/^[1-9]\d{0,8}$/.test(args[4]))unavailable();
  return {kind:'update',companyId:args[2],expectedRevision:Number(args[4]),state:args[6],reason:args[8]};
}
export function companySetupCommand({env=process.env,args=process.argv.slice(2),now=Date.now}={}) {
  const input=command(args),path=env.JUSTUP_DB_PATH;
  if(typeof path!=='string'||!isAbsolute(path)||![undefined,'true','false'].includes(env.JUSTUP_SHARED_STATE))unavailable();
  const shared=env.JUSTUP_SHARED_STATE==='true',directory=dirname(path),parent=lstatSync(directory),fileMode=shared?0o660:0o600;
  if(realpathSync(directory)!==directory||!parent.isDirectory()||(parent.mode&0o7777)!==(shared?0o2770:0o700)
      ||parent.uid!==process.getuid()&&!(shared&&parent.uid===0&&process.getgroups().includes(parent.gid)))unavailable();
  const original=protectedFile(path,fileMode,{shared});
  for(const suffix of ['-wal','-shm'])protectedFile(path+suffix,fileMode,{shared,optional:true});
  const generationPath=env.JUSTUP_PRIVATE_GENERATION_PATH??join(directory,'private-generation');
  protectedFile(generationPath,0o600);
  const generationConfig={dbPath:path,privateGenerationPath:generationPath},generation=privateGeneration(generationConfig);
  if(!generation)unavailable();
  const priorUmask=process.umask(shared?0o007:0o077);let db;
  try {
    db=new DatabaseSync(path,{readOnly:input.kind==='pending'});
    const opened=protectedFile(path,fileMode,{shared});if(opened.dev!==original.dev||opened.ino!==original.ino)unavailable();
    assertCurrentSchema(db);db.exec('PRAGMA busy_timeout=5000');
    db.exec(input.kind==='pending'?'BEGIN':'BEGIN IMMEDIATE');
    try {
      if(privateGeneration(generationConfig)!==generation)unavailable();
      const progress=createCompanyProgress({db,now,canonicalCompanyId:id=>canonicalCompanyId(db,id),accessForAccount:createAccessReader({db,now})});
      const result=input.kind==='pending'?progress.pending({limit:input.limit}):progress.update(input);
      if(privateGeneration(generationConfig)!==generation)unavailable();
      db.exec('COMMIT');return result;
    } catch(error) {if(db.isTransaction)db.exec('ROLLBACK');throw error;}
  } finally {db?.close();process.umask(priorUmask);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try{process.stdout.write(`${JSON.stringify(companySetupCommand())}\n`);}
  catch{process.stderr.write('Company setup could not be read or updated.\n');process.exitCode=1;}
}
