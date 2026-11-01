// One API-published proof for account and visitor processing. Queue readers bind
// source/build, exact locale policy identity, age and the live deletion generation.
import { lstatSync,readFileSync } from 'node:fs';
import { dirname,isAbsolute,join } from 'node:path';
import { createHash } from 'node:crypto';
import { policyScopes } from './policies.mjs';
export function privateGeneration(config={}) {
  if(config.dbPath===':memory:')return 'isolated-memory';
  const path=config.privateGenerationPath??(isAbsolute(config.dbPath??'')?join(dirname(config.dbPath),'private-generation'):null);
  if(!path||!isAbsolute(path))return null;
  const read=()=>{const meta=lstatSync(path);if(!meta.isFile()||meta.isSymbolicLink()||meta.nlink!==1||meta.size>64)throw Error('Unavailable');const value=readFileSync(path,'utf8');if(!/^[a-f0-9-]{36}\n?$/.test(value))throw Error('Unavailable');return value;};
  try{const first=read();try{lstatSync(path+'.pending');return null;}catch(error){if(error.code!=='ENOENT')return null;}return first===read()?first:null;}catch{return null;}
}
export function createProcessingAdmission({db,now=Date.now,config={},availability}={}) {
  if(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='justup_visitor_admission'").get()&&!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='justup_processing_admission'").get())db.exec('ALTER TABLE justup_visitor_admission RENAME TO justup_processing_admission');
  db.exec('CREATE TABLE IF NOT EXISTS justup_processing_admission(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),source_commit TEXT,build_identity TEXT,policy_version TEXT,private_generation TEXT,checked_at INTEGER NOT NULL) STRICT');
  if(!db.prepare('PRAGMA table_info(justup_processing_admission)').all().some(c=>c.name==='policy_scope'))db.exec('ALTER TABLE justup_processing_admission ADD COLUMN policy_scope TEXT');
  const bindingValid=()=>/^[a-f0-9]{40}$/.test(config.sourceCommit??'')&&typeof config.buildIdentity==='string'&&config.buildIdentity.length>0&&config.buildIdentity.length<=200;
  const write=(enabled,generation,scope)=>db.prepare('INSERT INTO justup_processing_admission VALUES(1,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,source_commit=excluded.source_commit,build_identity=excluded.build_identity,policy_version=excluded.policy_version,private_generation=excluded.private_generation,checked_at=excluded.checked_at,policy_scope=excluded.policy_scope').run(Number(enabled),config.sourceCommit??null,config.buildIdentity??null,config.policyVersion??null,generation,now(),scope);
  function refreshAvailability(){
    if(!availability)return;
    const scope=JSON.stringify(policyScopes(config)),generation=privateGeneration(config);let enabled=false;
    try{enabled=availability()===true&&bindingValid()&&generation!==null;}catch{}
    const prior=db.prepare('SELECT * FROM justup_processing_admission WHERE id=1').get();
    if(!prior||prior.enabled!==Number(enabled)||prior.source_commit!==config.sourceCommit||prior.build_identity!==config.buildIdentity||prior.private_generation!==generation||prior.policy_scope!==scope||now()-prior.checked_at>=30_000)write(enabled,generation,scope);
  }
  function processingPolicy(locale='en'){
    refreshAvailability();const proof=db.prepare('SELECT * FROM justup_processing_admission WHERE id=1').get();
    if(!bindingValid()||proof?.enabled!==1||proof.source_commit!==config.sourceCommit||proof.build_identity!==config.buildIdentity||proof.checked_at>now()||now()-proof.checked_at>=90_000||proof.private_generation==null||proof.private_generation!==privateGeneration(config))return false;
    try{const policy=JSON.parse(proof.policy_scope)?.[locale];if(policy?.locale!==locale||policy.reviewed!==true||typeof policy.version!=='string'||config.policyVersion!=null&&proof.policy_version!==config.policyVersion)return null;return {locale,key:createHash('sha256').update(JSON.stringify(policy)).digest('hex')};}catch{return null;}
  }
  if(availability)write(false,privateGeneration(config),null);
  return {processingPolicy,processingAvailable:locale=>Boolean(processingPolicy(locale)),refreshAvailability};
}
