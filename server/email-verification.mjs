// Account/session-bound email ownership proof and queue-only delivery. Read when
// changing challenge retention, one-time proof consumption or provider admission.
import { createHash,createHmac,randomUUID,timingSafeEqual } from 'node:crypto';
import { createProcessingAdmission } from './processing-admission.mjs';
import { normalizedEmail,createResendClient } from './account-provider-clients.mjs';
import { problem,transaction } from './store.mjs';

const TTL=600_000,COOLDOWN=60_000,MAX_ATTEMPTS=5;
const hash=value=>createHash('sha256').update(value).digest('hex');
export const emailSessionHash=token=>hash(token);
const validId=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const validSecret=value=>typeof value==='string'&&value.length>=32&&value.length<=512&&!/[^\x20-\x7e]/.test(value);
export function validateEmailVerificationConfig(value) {
  if(value===undefined||exact(value,['enabled'])&&value.enabled===false)return value;
  if(!exact(value,['enabled','apiKey','verificationKey','maxDaily','maxMonthly'])||value.enabled!==true
      ||typeof value.apiKey!=='string'||value.apiKey.length<8||value.apiKey.length>512||/[^\x21-\x7e]/.test(value.apiKey)
      ||!validSecret(value.verificationKey)||!Number.isInteger(value.maxDaily)||value.maxDaily<1||value.maxDaily>10
      ||!Number.isInteger(value.maxMonthly)||value.maxMonthly<1||value.maxMonthly>100)throw problem('verification_unavailable',503);
  return value;
}
function initialize(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS justup_email_challenges(
    id TEXT PRIMARY KEY,account_id TEXT NOT NULL UNIQUE REFERENCES auth_accounts(id) ON DELETE CASCADE,
    session_hash TEXT NOT NULL,email TEXT,subject_key TEXT,code_hash TEXT,
    status TEXT NOT NULL CHECK(status IN ('queued','sent','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,send_reserved INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,locale TEXT NOT NULL,policy_key TEXT NOT NULL,
    task_id TEXT NOT NULL,request_key TEXT NOT NULL,input_hash TEXT NOT NULL) STRICT;
    CREATE INDEX IF NOT EXISTS justup_email_challenges_expiry ON justup_email_challenges(expires_at);
    CREATE TABLE IF NOT EXISTS justup_email_usage(period TEXT PRIMARY KEY,attempts INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS justup_email_verifier_identity(id INTEGER PRIMARY KEY CHECK(id=1),key_sha256 TEXT NOT NULL) STRICT;`);
}
function liveSession(db,owner,sessionHash,now) {
  if(typeof sessionHash!=='string'||!/^[a-f0-9]{64}$/.test(sessionHash))return false;
  return Boolean(db.prepare(`SELECT 1 FROM auth_sessions s JOIN auth_accounts a ON a.id=s.account_id
    WHERE s.token_hash=? AND s.account_id=? AND s.expires_at>? AND (a.account_expires_at IS NULL OR a.account_expires_at>?)`).get(Buffer.from(sessionHash,'hex'),owner,now(),now()));
}
function usableRow(db,row,now) {
  return row&&row.expires_at>now()&&liveSession(db,row.account_id,row.session_hash,now);
}
function leaseActive(tasks,task,now) {
  const current=tasks.get(task.ownerId,task.id);
  return current?.status==='running'&&current.leaseToken===task.leaseToken&&current.leaseUntil>now();
}
export function createEmailVerificationApi({db,tasks,config={},now=Date.now,getAuth,availability=()=>false,
  processingAvailability,beforePrivateDelete=()=>{},afterPrivateTransaction=()=>{},withPrivateTransaction=work=>transaction(db,work)}={}) {
  initialize(db);
  if(config.emailVerificationEnabled!==undefined&&typeof config.emailVerificationEnabled!=='boolean')throw problem('verification_unavailable',503);
  if(config.emailVerificationEnabled===true&&!validSecret(config.csrfSecret))throw problem('verification_unavailable',503);
  const admission=createProcessingAdmission({db,config,now,availability:processingAvailability});
  const rowFor=owner=>db.prepare('SELECT * FROM justup_email_challenges WHERE account_id=?').get(owner);
  const configured=()=>config.emailVerificationEnabled===true;
  const enabled=()=>{try{return configured()&&availability()===true;}catch{return false;}};
  const policy=locale=>admission.processingPolicy(locale);
  function requireCurrent(ctx) {
    if(!liveSession(db,ctx.accountId,ctx.sessionHash,now))throw problem('unauthenticated',401);
    const current=policy(ctx.interfaceLocale);if(!current)throw problem('policy_unavailable',503);
    return current;
  }
  function state(owner,sessionHash) {
    if(db.prepare('SELECT 1 FROM access_identities WHERE account_id=?').get(owner))return {state:'verified',challengeId:null,expiresAt:null,retryAfterMs:null};
    const row=rowFor(owner);
    if(usableRow(db,row,now)&&row.session_hash===sessionHash)return {state:row.status==='queued'?'pending':row.status,challengeId:row.id,expiresAt:new Date(row.expires_at).toISOString(),retryAfterMs:Math.max(0,row.created_at+COOLDOWN-now())};
    return {state:enabled()?'unverified':'unavailable',challengeId:null,expiresAt:null,retryAfterMs:null};
  }
  function cleanup() {
    const rows=db.prepare('SELECT * FROM justup_email_challenges').all();
    const remove=rows.filter(row=>config.emailVerificationEnabled!==true||!usableRow(db,row,now)),scrub=rows.filter(row=>config.emailVerificationEnabled===true&&usableRow(db,row,now)&&row.status!=='queued'&&row.email!==null);
    if(!remove.length&&!scrub.length)return;
    withPrivateTransaction(()=>{
      beforePrivateDelete();
      for(const row of remove){tasks.cancel(row.account_id,row.task_id);db.prepare('DELETE FROM justup_email_challenges WHERE id=?').run(row.id);}
      for(const row of scrub)db.prepare('UPDATE justup_email_challenges SET email=NULL WHERE id=?').run(row.id);
    });
  }
  function verifyIdentityProof(proof) {
    if(!exact(proof,['accountId','sessionHash','challengeId','code','interfaceLocale','policyKey'])||!validId(proof.challengeId)||typeof proof.code!=='string'||!/^\d{8}$/.test(proof.code))throw problem('verification_invalid',400);
    const ctx={accountId:proof.accountId,sessionHash:proof.sessionHash,interfaceLocale:proof.interfaceLocale};
    const current=requireCurrent(ctx),row=rowFor(proof.accountId);
    if(!configured())throw problem('verification_unavailable',503);
    if(!row||row.id!==proof.challengeId||row.session_hash!==proof.sessionHash)throw problem('verification_invalid',400);
    if(!usableRow(db,row,now))throw problem('verification_expired',410);
    if(current.key!==proof.policyKey||row.policy_key!==proof.policyKey||row.locale!==proof.interfaceLocale)throw problem('policy_unavailable',503);
    if(row.attempts>=MAX_ATTEMPTS)throw problem('verification_locked',429);
    if(row.status!=='sent'||!row.subject_key||!row.code_hash)throw problem('verification_pending',409);
    const expected=hash(`${row.id}:${proof.code}`);
    db.prepare('UPDATE justup_email_challenges SET attempts=attempts+1 WHERE id=? AND attempts<?').run(row.id,MAX_ATTEMPTS);
    if(!timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(row.code_hash,'hex')))throw problem('verification_invalid',400);
    return {accountId:row.account_id,subjectKey:row.subject_key,legacyKey:null,verifiedAt:now(),commit(){
      const latest=rowFor(row.account_id),latestPolicy=requireCurrent(ctx);
      if(!configured()||!usableRow(db,latest,now)||latest.id!==row.id||latest.session_hash!==row.session_hash||latest.code_hash!==row.code_hash
          ||latest.status!=='sent'||latestPolicy.key!==row.policy_key)throw problem('verification_invalid',400);
      beforePrivateDelete();
      if(db.prepare('DELETE FROM justup_email_challenges WHERE id=?').run(row.id).changes!==1)throw problem('verification_invalid',400);
      return true;
    }};
  }
  async function handleVerification(ctx) {
    if(!['/account/verification','/account/verification/confirm'].includes(ctx.path))return null;
    if([...ctx.url.searchParams].length)throw problem('invalid_query');
    cleanup();
    if(ctx.method==='GET'&&ctx.path==='/account/verification')return {status:200,body:{verification:state(ctx.accountId,ctx.sessionHash)}};
    const current=requireCurrent(ctx);if(!configured())throw problem('verification_unavailable',503);
    if(ctx.method==='POST'&&ctx.path==='/account/verification') {
      if(!enabled())throw problem('verification_unavailable',503);
      if(!exact(ctx.body,['email','requestKey'])||typeof ctx.body.requestKey!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(ctx.body.requestKey))throw problem('invalid_input');
      const email=normalizedEmail(ctx.body.email),inputHash=createHmac('sha256',config.csrfSecret).update(`email-request-v1:${email}`).digest('hex'),previous=rowFor(ctx.accountId);
      if(previous?.request_key===ctx.body.requestKey){if(previous.session_hash!==ctx.sessionHash||previous.input_hash!==inputHash)throw problem('idempotency_conflict',409);return {status:202,body:{verification:state(ctx.accountId,ctx.sessionHash)}};}
      if(db.prepare('SELECT 1 FROM access_identities WHERE account_id=?').get(ctx.accountId))throw problem('verification_conflict',409);
      if(previous&&previous.created_at+COOLDOWN>now())throw problem('rate_limit',429);
      withPrivateTransaction(()=>{
        requireCurrent(ctx);
        if(previous){beforePrivateDelete();tasks.cancel(ctx.accountId,previous.task_id);db.prepare('DELETE FROM justup_email_challenges WHERE account_id=?').run(ctx.accountId);}
        if(db.prepare('SELECT count(*) n FROM justup_email_challenges').get().n>=100)throw problem('rate_limit',429);
        const id=randomUUID(),task=tasks.enqueue({ownerId:ctx.accountId,kind:'email_verification',requestKey:ctx.body.requestKey,payload:{challengeId:id,locale:ctx.interfaceLocale,policyKey:current.key}});
        db.prepare('INSERT INTO justup_email_challenges(id,account_id,session_hash,email,status,created_at,expires_at,locale,policy_key,task_id,request_key,input_hash) VALUES(?,?,?,?,\'queued\',?,?,?,?,?,?,?)')
          .run(id,ctx.accountId,ctx.sessionHash,email,now(),now()+TTL,ctx.interfaceLocale,current.key,task.id,ctx.body.requestKey,inputHash);
      });
      return {status:202,body:{verification:state(ctx.accountId,ctx.sessionHash)}};
    }
    if(ctx.method==='POST'&&ctx.path==='/account/verification/confirm') {
      if(!exact(ctx.body,['challengeId','code']))throw problem('invalid_input');
      try{await getAuth().recordIdentityProof({...ctx.body,accountId:ctx.accountId,sessionHash:ctx.sessionHash,interfaceLocale:ctx.interfaceLocale,policyKey:current.key});}
      finally{afterPrivateTransaction();}
      return {status:200,body:{verification:state(ctx.accountId,ctx.sessionHash)}};
    }
    throw problem('not_found',404);
  }
  return {emailVerification:true,handleVerification,verifyIdentityProof,cleanup,refreshAvailability:admission.refreshAvailability,
    capabilities:()=>({emailVerification:enabled()}),deleteAccountData:owner=>{
      // Isolated auth-factory tests may intentionally omit auth storage; no
      // challenge can have been inserted without its referenced account table.
      if(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='auth_accounts'").get())db.prepare('DELETE FROM justup_email_challenges WHERE account_id=?').run(owner);
    }};
}

export function createEmailVerificationRunner({db,tasks,config={},now=Date.now,client}={}) {
  initialize(db);const provider=validateEmailVerificationConfig(config.emailVerification),enabled=provider?.enabled===true;
  if(enabled){
    const fingerprint=hash(provider.verificationKey),prior=db.prepare('SELECT key_sha256 FROM justup_email_verifier_identity WHERE id=1').get();
    if(prior&&prior.key_sha256!==fingerprint)throw problem('verification_key_changed',503);
    db.prepare('INSERT OR IGNORE INTO justup_email_verifier_identity VALUES(1,?)').run(fingerprint);
    client??=createResendClient({apiKey:provider.apiKey});
  }
  const admission=createProcessingAdmission({db,config,now});
  function current(task) {
    const row=db.prepare('SELECT * FROM justup_email_challenges WHERE id=? AND account_id=?').get(task.payload?.challengeId,task.ownerId),policy=admission.processingPolicy(task.payload?.locale);
    if(!enabled||!usableRow(db,row,now)||row.status!=='queued'||row.task_id!==task.id||row.policy_key!==task.payload.policyKey||row.locale!==task.payload.locale
        ||!policy||policy.key!==row.policy_key||!leaseActive(tasks,task,now))throw problem('processing_unavailable',503);
    return row;
  }
  async function runTask(task,{signal}={}) {
    try {
      const row=current(task),code=(createHmac('sha256',provider.verificationKey).update(`email-code-v1:${row.id}`).digest().readUInt32BE(0)%100_000_000).toString().padStart(8,'0');
      const subject=createHmac('sha256',provider.verificationKey).update(`email-subject-v1:${row.email}`).digest('base64url');
      transaction(db,()=>{
        current(task);
        if(!row.send_reserved){
          const day=new Date(now()).toISOString().slice(0,10),month=day.slice(0,7);
          for(const [period,ceiling] of [[day,provider.maxDaily],[month,provider.maxMonthly]])if((db.prepare('SELECT attempts FROM justup_email_usage WHERE period=?').get(period)?.attempts??0)>=ceiling)throw problem('rate_limit',429);
          for(const period of [day,month])db.prepare('INSERT INTO justup_email_usage VALUES(?,1) ON CONFLICT(period) DO UPDATE SET attempts=attempts+1').run(period);
          db.prepare('UPDATE justup_email_challenges SET send_reserved=1 WHERE id=?').run(row.id);
          db.prepare('DELETE FROM justup_email_usage WHERE period<?').run(new Date(now()-32*86_400_000).toISOString().slice(0,7));
        }
      });
      if(signal?.aborted)throw problem('task_interrupted',503);
      await client.sendVerification({email:row.email,code,challengeId:row.id,locale:row.locale,signal});
      if(signal?.aborted)throw problem('task_interrupted',503);
      return transaction(db,()=>{
        current(task);
        db.prepare("UPDATE justup_email_challenges SET status='sent',subject_key=?,code_hash=? WHERE id=?").run(subject,hash(`${row.id}:${code}`),row.id);
        if(!tasks.complete(task.id,task.leaseToken,{status:'succeeded',output:null}))throw problem('revision_conflict',409);
        return {status:'succeeded',output:null,committed:true};
      });
    }catch(error){
      if(leaseActive(tasks,task,now))db.prepare("UPDATE justup_email_challenges SET status='failed' WHERE task_id=? AND status='queued'").run(task.id);
      return {status:'failed',errorCode:['processing_unavailable','rate_limit','task_interrupted'].includes(error.code)?error.code:'provider_unavailable'};
    }
  }
  return {available:()=>enabled,runTask};
}
