// Isolated test billing on the existing API/queue. Provider identifiers and
// hosted URLs stay private; only the queue can contact fixed Stripe endpoints.
import {createHash,randomUUID} from 'node:crypto';
import {createProcessingAdmission} from './processing-admission.mjs';
import {createStripeTestClient,verifyStripeWebhook,STRIPE_API_VERSION} from './account-provider-clients.mjs';
import {stripeEventReference,stripeOffer,stripeCheckoutFields,stripePortalFields,stripeHostedUrl,
  stripeSettledPeriod,stripeEntitlementSnapshot,stripeTerminationReady} from './stripe-billing-protocol.mjs';
import {createEntitlements} from './entitlements.mjs';
import {problem,transaction} from './store.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const id=(value,prefix)=>typeof value==='string'&&new RegExp(`^${prefix}_[A-Za-z0-9]{1,128}$`).test(value);
const requestKey=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const ref=value=>typeof value==='string'?value:value?.id;
const fail=(code='billing_unavailable',status=503)=>{throw problem(code,status);};
const iso=value=>value==null?null:new Date(value).toISOString();
const KINDS=['billing_checkout','billing_portal','billing_reconcile','billing_terminate'];
const BILLING_FAILURES=new Set(['billing_unavailable','billing_termination_pending','billing_operator_reconciliation_required','billing_evidence_invalid','billing_configuration_mismatch','processing_unavailable']);
const RECEIPT_FAILURES=new Set([...BILLING_FAILURES,'task_failed','task_timeout','task_interrupted','revision_conflict','provider_unavailable','provider_down','timeout','rate_limit','provider_rate_limit']);

export function validateStripeBillingConfig(value,{role='queue'}={}) {
  if(value===undefined||exact(value,['enabled'])&&value.enabled===false)return value;
  if(!exact(value,['enabled','accountId','offers','portalConfigurationId','origin',role==='api'?'webhookSecret':'apiKey'])
      ||value.enabled!==true||!id(value.accountId,'acct')||!id(value.portalConfigurationId,'bpc')
      ||!exact(value.offers,['weekly','monthly']))fail();
  let origin;try{origin=new URL(value.origin);}catch{fail();}
  if(origin.protocol!=='https:'||origin.origin!==value.origin||origin.username||origin.password||origin.port
      ||!/^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value.origin))fail();
  for(const plan of ['weekly','monthly']){
    const offer=value.offers[plan];
    if(!exact(offer,['priceId','currency','amount'])||!id(offer.priceId,'price')||!/^[a-z]{3}$/.test(offer.currency??'')
        ||!Number.isSafeInteger(offer.amount)||offer.amount<1||offer.amount>1_000_000_000)fail();
  }
  if(value.offers.weekly.priceId===value.offers.monthly.priceId)fail();
  if(role==='api'?!/^whsec_[A-Za-z0-9_]{16,256}$/.test(value.webhookSecret??''):!/^rk_test_[A-Za-z0-9_]{1,256}$/.test(value.apiKey??''))fail();
  return value;
}
export function stripeBillingFromEnv(env) {
  const enabled=env.JUSTUP_STRIPE_TEST_BILLING_ENABLED;
  if(enabled===undefined||enabled==='false')return enabled===undefined?undefined:{enabled:false};
  if(enabled!=='true')fail();
  let offers;try{offers=JSON.parse(env.JUSTUP_STRIPE_TEST_OFFERS);}catch{fail();}
  return validateStripeBillingConfig({enabled:true,accountId:env.JUSTUP_STRIPE_TEST_ACCOUNT_ID,offers,
    portalConfigurationId:env.JUSTUP_STRIPE_TEST_PORTAL_CONFIGURATION_ID,origin:env.JUSTUP_ORIGIN,
    webhookSecret:env.JUSTUP_STRIPE_TEST_WEBHOOK_SECRET},{role:'api'});
}
function configurationHash(value){return hash(JSON.stringify({accountId:value.accountId,offers:Object.fromEntries(['weekly','monthly'].map(plan=>[plan,
  {priceId:value.offers[plan].priceId,currency:value.offers[plan].currency,amount:value.offers[plan].amount}])),portalConfigurationId:value.portalConfigurationId,origin:value.origin}));}
function initialize(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS justup_billing_accounts(
    account_id TEXT PRIMARY KEY REFERENCES auth_accounts(id) ON DELETE RESTRICT,billing_reference TEXT NOT NULL UNIQUE,
    customer_id TEXT UNIQUE,subscription_id TEXT UNIQUE,settled_invoice_id TEXT,settled_charge_id TEXT,
    locale TEXT NOT NULL,policy_key TEXT NOT NULL,closing_revision INTEGER NOT NULL DEFAULT 0,
    termination_revision INTEGER,termination_verified_at INTEGER,current_checkout_operation_id TEXT) STRICT;
    CREATE TABLE IF NOT EXISTS justup_billing_operations(
    id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL,request_key TEXT NOT NULL,input_hash TEXT NOT NULL,plan TEXT,
    locale TEXT NOT NULL,policy_key TEXT NOT NULL,session_hash TEXT,
    configuration_hash TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,expires_at INTEGER,
    status TEXT NOT NULL,resource_kind TEXT,resource_id TEXT,event_id TEXT,url TEXT,error_code TEXT,
    task_id TEXT,attempt INTEGER NOT NULL DEFAULT 0,UNIQUE(account_id,kind,request_key)) STRICT;`);
  const anchored=()=>db.prepare('PRAGMA table_info(justup_billing_accounts)').all().some(column=>column.name==='current_checkout_operation_id');
  // Older rows have no durable generation pointer. One checkout can be
  // provider-confirmed; competing or missing history requires reconciliation.
  if(!anchored())transaction(db,()=>{if(!anchored()){
    db.exec(`ALTER TABLE justup_billing_accounts ADD COLUMN current_checkout_operation_id TEXT;
      UPDATE justup_billing_accounts SET current_checkout_operation_id=(
        SELECT min(id) FROM justup_billing_operations WHERE account_id=justup_billing_accounts.account_id AND kind='checkout');
      UPDATE justup_billing_accounts SET current_checkout_operation_id='legacy-unresolved' WHERE current_checkout_operation_id IS NULL;
      UPDATE justup_billing_operations SET status='ambiguous',error_code='billing_operator_reconciliation_required'
        WHERE kind='checkout' AND (account_id IN (SELECT account_id FROM justup_billing_operations WHERE kind='checkout' GROUP BY account_id HAVING count(*)>1) OR resource_kind='customer');
      UPDATE justup_billing_accounts SET termination_revision=NULL,termination_verified_at=NULL;
      UPDATE justup_billing_operations SET status='failed',error_code='billing_termination_pending' WHERE kind='terminate';`);
  }});
}
const accountRow=(db,owner)=>db.prepare('SELECT * FROM justup_billing_accounts WHERE account_id=?').get(owner);
function liveOwner(db,owner,now){return db.prepare('SELECT id,account_expires_at FROM auth_accounts WHERE id=? AND (account_expires_at IS NULL OR account_expires_at>?)').get(owner,now());}
function liveSession(db,owner,sessionHash,now){return typeof sessionHash==='string'&&/^[a-f0-9]{64}$/.test(sessionHash)&&Boolean(db.prepare('SELECT 1 FROM auth_sessions WHERE account_id=? AND token_hash=? AND expires_at>?').get(owner,Buffer.from(sessionHash,'hex'),now()));}
const operationRow=(db,owner,identifier)=>db.prepare('SELECT * FROM justup_billing_operations WHERE id=? AND account_id=?').get(identifier,owner);
function unresolvedCheckout(db,binding){
  if(!binding?.current_checkout_operation_id)return false;
  const anchor=operationRow(db,binding.account_id,binding.current_checkout_operation_id);
  return !anchor||anchor.error_code==='billing_operator_reconciliation_required'||anchor.resource_kind==='checkout'&&Boolean(anchor.resource_id);
}
function taskActive(tasks,task,now){const current=tasks.get(task.ownerId,task.id);return current?.status==='running'&&current.leaseToken===task.leaseToken&&current.leaseUntil>now();}
function terminationReceipt(db,receipt){
  if(!receipt||receipt.kind!=='billing_terminate'||!['succeeded','failed'].includes(receipt.status)||receipt.output!==null
      ||!exact(receipt.payload,['operationId','locale','policyKey'])||typeof receipt.payload.operationId!=='string'
      ||receipt.errorCode!==null&&!RECEIPT_FAILURES.has(receipt.errorCode))return null;
  const operation=operationRow(db,receipt.ownerId,receipt.payload.operationId),binding=accountRow(db,receipt.ownerId);
  if(!operation||!binding||operation.kind!=='terminate'||operation.task_id!==receipt.id||binding.closing_revision<1
      ||receipt.payload.locale!==operation.locale||receipt.payload.policyKey!==operation.policy_key
      ||operation.request_key!==`termination:${binding.closing_revision}`||operation.input_hash!==hash(operation.request_key))return null;
  return {operation,binding};
}
function receiptFailure(receipt,operation){return BILLING_FAILURES.has(operation.error_code)?operation.error_code:BILLING_FAILURES.has(receipt.errorCode)?receipt.errorCode:'billing_unavailable';}
function terminationOutcome(receipt,{operation,binding}){
  if(receipt.status==='failed')return {status:'failed',error:receiptFailure(receipt,operation)};
  if(receipt.errorCode===null&&operation.status==='ready'&&binding.termination_revision===binding.closing_revision
      &&Number.isSafeInteger(binding.termination_verified_at))return {status:'ready',error:null};
  return null;
}
function absorbedTermination(db,receipt){
  const state=terminationReceipt(db,receipt);if(!state)return false;
  const outcome=terminationOutcome(receipt,state),{operation}=state;
  return outcome!==null&&operation.resource_kind==='termination_receipt'&&operation.resource_id===receipt.id
    &&operation.status===outcome.status&&operation.error_code===outcome.error;
}
function enqueue(db,tasks,operation,now) {
  if(operation.task_id&&['pending','running'].includes(tasks.get(operation.account_id,operation.task_id)?.status))return;
  // A terminal cleanup receipt must be observed and released through the API's
  // protected transaction before a retry can replace its canonical pointer.
  if(operation.kind==='terminate'&&operation.task_id&&db.prepare('SELECT 1 FROM justup_tasks WHERE id=?').get(operation.task_id))return;
  if(operation.task_id)tasks.delete(operation.account_id,operation.task_id);
  const attempt=operation.attempt+1,task=tasks.enqueue({ownerId:operation.account_id,kind:`billing_${operation.kind}`,
    requestKey:`${operation.id}:${attempt}`,payload:{operationId:operation.id,locale:operation.locale,policyKey:operation.policy_key}});
  db.prepare("UPDATE justup_billing_operations SET task_id=?,attempt=?,status='pending',updated_at=?,error_code=NULL WHERE id=?").run(task.id,attempt,now(),operation.id);
}
function insertOperation(db,tasks,{owner,kind,key,inputHash,plan=null,locale,policyKey,sessionHash=null,configHash,expiresAt=null,resourceKind=null,resourceId=null,eventId=null},now) {
  // One reusable termination reservation per binding is outside ordinary history
  // capacity. It remains owner-bound and still obeys the shared task queue limits.
  if(kind==='terminate'){if(db.prepare("SELECT 1 FROM justup_billing_operations WHERE account_id=? AND kind='terminate'").get(owner))fail('billing_conflict',409);}
  else if(db.prepare("SELECT count(*) n FROM justup_billing_operations WHERE kind<>'terminate'").get().n>=128
      ||db.prepare("SELECT count(*) n FROM justup_billing_operations WHERE account_id=? AND kind<>'terminate'").get(owner).n>=32)fail('rate_limit',429);
  const identifier=randomUUID();
  db.prepare(`INSERT INTO justup_billing_operations(id,account_id,kind,request_key,input_hash,plan,locale,policy_key,session_hash,
    configuration_hash,created_at,updated_at,expires_at,status,resource_kind,resource_id,event_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)`)
    .run(identifier,owner,kind,key,inputHash,plan,locale,policyKey,sessionHash,configHash,now(),now(),expiresAt,resourceKind,resourceId,eventId);
  const operation=operationRow(db,owner,identifier);
  try{enqueue(db,tasks,operation,now);}catch(error){if(kind!=='terminate'||error.code!=='task_limit')throw error;}
  return operationRow(db,owner,identifier);
}

export function createStripeBillingApi({db,tasks,config={},now=Date.now,getAuth,availability=()=>false,processingAvailability,
  beforePrivateDelete=()=>{},withPrivateTransaction=work=>transaction(db,work)}={}) {
  initialize(db);const settings=validateStripeBillingConfig(config.stripeBilling,{role:'api'}),configured=settings?.enabled===true;
  if(configured&&settings.origin!==config.allowedOrigin)fail();
  const admission=createProcessingAdmission({db,config,now,availability:processingAvailability});
  const enabled=()=>{try{return configured&&availability()===true;}catch{return false;}};
  function current(ctx,{cleanup=false}={}) {
    const owner=liveOwner(db,ctx.accountId,now);
    if(!owner||!liveSession(db,ctx.accountId,ctx.sessionHash,now))fail('unauthenticated',401);
    if(!cleanup&&!admission.processingPolicy(ctx.interfaceLocale))fail('policy_unavailable',503);
    return owner;
  }
  function view(operation) {
    const closing=accountRow(db,operation.account_id)?.closing_revision>0;
    const allowed=operation.kind==='terminate'||enabled()&&admission.processingPolicy(operation.locale)?.key===operation.policy_key&&operation.configuration_hash===configurationHash(settings);
    const ready=operation.status==='ready'&&allowed&&(!closing||operation.kind==='terminate')&&(operation.expires_at==null||operation.expires_at>now());
    return {id:operation.id,kind:operation.kind,status:ready?'ready':['pending','running','ambiguous'].includes(operation.status)?'pending':'failed',
      url:ready&&operation.url?operation.url:null,expiresAt:iso(operation.expires_at),retryAfterMs:ready||operation.error_code==='billing_operator_reconciliation_required'?null:5000,
      error:operation.error_code||!allowed?{code:operation.error_code??'processing_unavailable',retryable:operation.error_code!=='billing_operator_reconciliation_required'}:null};
  }
  function cleanup() {
    const expired=db.prepare('SELECT id FROM justup_billing_operations WHERE url IS NOT NULL AND expires_at<=?').all(now());
    const old=db.prepare("SELECT id FROM justup_billing_operations WHERE kind<>'terminate' AND status IN ('ready','failed') AND updated_at<? AND id NOT IN (SELECT current_checkout_operation_id FROM justup_billing_accounts WHERE current_checkout_operation_id IS NOT NULL)").all(now()-86_400_000);
    const receipts=db.prepare("SELECT id,account_id FROM justup_billing_operations WHERE kind='terminate' AND resource_kind='termination_receipt' AND task_id IS NOT NULL LIMIT 96").all();
    if(!expired.length&&!old.length&&!receipts.length)return;
    withPrivateTransaction(()=>{
      for(const row of receipts){
        const operation=operationRow(db,row.account_id,row.id);let receipt;
        try{receipt=tasks.get(row.account_id,operation?.task_id);}catch{continue;}
        if(!absorbedTermination(db,receipt))continue;
        beforePrivateDelete();
        if(tasks.releaseCleanupReceipt(row.account_id,receipt.id,current=>absorbedTermination(db,current)))
          db.prepare('UPDATE justup_billing_operations SET task_id=NULL WHERE id=? AND task_id=?').run(operation.id,receipt.id);
      }
      if(expired.length||old.length)beforePrivateDelete();for(const row of expired)db.prepare('UPDATE justup_billing_operations SET url=NULL WHERE id=?').run(row.id);
      for(const row of old){const operation=db.prepare('SELECT * FROM justup_billing_operations WHERE id=?').get(row.id);if(operation.task_id)tasks.delete(operation.account_id,operation.task_id);db.prepare('DELETE FROM justup_billing_operations WHERE id=?').run(row.id);}});
  }
  function start(ctx,kind) {
    const owner=current(ctx);if(!enabled())fail();
    if(owner.account_expires_at!==null)fail('billing_account_lifetime',403);
    if(!db.prepare('SELECT 1 FROM access_identities WHERE account_id=?').get(ctx.accountId))fail('identity_unverified',403);
    const required=kind==='checkout'?['plan','requestKey']:['requestKey'];if(!exact(ctx.body,required)||!requestKey(ctx.body.requestKey)||kind==='checkout'&&!['weekly','monthly'].includes(ctx.body.plan))fail('invalid_input',400);
    const fingerprint=hash(JSON.stringify({kind,plan:ctx.body.plan??null})),policy=admission.processingPolicy(ctx.interfaceLocale);
    return withPrivateTransaction(()=>{
      current(ctx);const prior=db.prepare('SELECT * FROM justup_billing_operations WHERE account_id=? AND kind=? AND request_key=?').get(ctx.accountId,kind,ctx.body.requestKey);
      if(prior){if(prior.input_hash!==fingerprint)fail('idempotency_conflict',409);return prior;}
      let binding=accountRow(db,ctx.accountId);
      if(binding?.closing_revision>0)fail('billing_termination_pending',409);
      if(kind==='checkout'&&unresolvedCheckout(db,binding))fail('billing_pending',409);
      const access=getAuth?.()?.accessForAccount?.(ctx.accountId);
      if(kind==='checkout'&&binding?.subscription_id&&(access?.fullAccess!==false||access?.kind==='pending'))fail('billing_conflict',409);
      if(['portal','reconcile'].includes(kind)&&!binding?.customer_id)fail('billing_unavailable',503);
      if(kind!=='reconcile'&&db.prepare("SELECT 1 FROM justup_billing_operations WHERE account_id=? AND kind IN ('checkout','portal') AND (status IN ('pending','running','ambiguous') OR ?='checkout' AND kind='checkout' AND status='ready' AND expires_at>?)").get(ctx.accountId,kind,now()))fail('billing_pending',409);
      if(!binding){db.prepare('INSERT INTO justup_billing_accounts(account_id,billing_reference,locale,policy_key) VALUES(?,?,?,?)').run(ctx.accountId,randomUUID(),ctx.interfaceLocale,policy.key);binding=accountRow(db,ctx.accountId);}
      db.prepare('UPDATE justup_billing_accounts SET locale=?,policy_key=? WHERE account_id=?').run(ctx.interfaceLocale,policy.key,ctx.accountId);
      const operation=insertOperation(db,tasks,{owner:ctx.accountId,kind,key:ctx.body.requestKey,inputHash:fingerprint,plan:ctx.body.plan??null,
        locale:ctx.interfaceLocale,policyKey:policy.key,sessionHash:ctx.sessionHash,configHash:configurationHash(settings),
        resourceKind:kind==='reconcile'?(binding.subscription_id?'subscription':'customer'):null,resourceId:kind==='reconcile'?(binding.subscription_id??binding.customer_id):null,
        expiresAt:kind==='reconcile'?null:now()+(kind==='checkout'?31*60_000:5*60_000)},now);
      if(kind==='checkout'){
        db.prepare('UPDATE justup_billing_accounts SET current_checkout_operation_id=? WHERE account_id=?').run(operation.id,ctx.accountId);
        db.prepare("UPDATE access_subscriptions SET state_version=state_version+1,reconcile_pending=1 WHERE account_id=? AND (status<>'ended' OR reconcile_pending=1)").run(ctx.accountId);
      }
      return operation;
    });
  }
  function prepareDeletion({accountId,token}) {
    const ctx={accountId,sessionHash:hash(token),interfaceLocale:'en'};current(ctx,{cleanup:true});
    cleanup();
    let binding=accountRow(db,accountId);if(!binding)return true;
    if(binding.closing_revision>0&&binding.termination_revision===binding.closing_revision&&binding.termination_verified_at<=now()&&binding.termination_verified_at>=now()-30_000)return true;
    if(!enabled())fail('billing_termination_unavailable',503);
    withPrivateTransaction(()=>{
      current(ctx,{cleanup:true});binding=accountRow(db,accountId);
      if(binding.closing_revision===0){beforePrivateDelete();db.prepare('UPDATE justup_billing_accounts SET closing_revision=1,termination_revision=NULL,termination_verified_at=NULL WHERE account_id=?').run(accountId);
        db.prepare('UPDATE justup_billing_operations SET url=NULL WHERE account_id=?').run(accountId);}
      binding=accountRow(db,accountId);
      let operation=db.prepare("SELECT * FROM justup_billing_operations WHERE account_id=? AND kind='terminate' ORDER BY created_at DESC LIMIT 1").get(accountId);
      if(operation){if(operation.error_code==='billing_operator_reconciliation_required')fail('billing_termination_unavailable',503);
        const task=operation.task_id?tasks.get(accountId,operation.task_id):null;
        const active=task&&['pending','running'].includes(task.status);
        if(!active&&Math.max(operation.updated_at,task?Date.parse(task.updatedAt):0)+5000<=now()){
          beforePrivateDelete();try{enqueue(db,tasks,operation,now);}catch(error){if(error.code!=='task_limit')throw error;}
        }return;}
      insertOperation(db,tasks,{owner:accountId,kind:'terminate',key:`termination:${binding.closing_revision}`,inputHash:hash(`termination:${binding.closing_revision}`),
        locale:binding.locale,policyKey:binding.policy_key,configHash:configurationHash(settings)},now);
    });
    fail('billing_termination_pending',409);
  }
  function assertDeletionReady(owner) {
    const binding=accountRow(db,owner);if(!binding)return;
    if(binding.closing_revision<1||binding.termination_revision!==binding.closing_revision||binding.termination_verified_at>now()||binding.termination_verified_at<now()-30_000)fail('billing_termination_pending',409);
  }
  function deleteAccountData(owner){assertDeletionReady(owner);if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='auth_accounts' AND type='table'").get())return;
    db.prepare('DELETE FROM justup_billing_operations WHERE account_id=?').run(owner);db.prepare('DELETE FROM justup_billing_accounts WHERE account_id=?').run(owner);}
  function handleWebhook({body,signature}) {
    if(!configured)fail();
    const event=verifyStripeWebhook({body,signature,secret:settings.webhookSecret,now});
    if(event.api_version!==STRIPE_API_VERSION)fail('invalid_provider_signature',400);
    const reference=stripeEventReference(event,{accountId:settings.accountId});if(!reference)return {status:200,body:{received:true}};
    const binding=reference.customerId?db.prepare('SELECT * FROM justup_billing_accounts WHERE customer_id=?').get(reference.customerId)
      :db.prepare('SELECT * FROM justup_billing_accounts WHERE settled_charge_id=?').get(reference.resourceId);
    if(!binding||!liveOwner(db,binding.account_id,now))return {status:200,body:{received:true}};
    if(!enabled())fail();
    withPrivateTransaction(()=>{
      if(!liveOwner(db,binding.account_id,now))return;
      const previous=db.prepare("SELECT * FROM justup_billing_operations WHERE account_id=? AND kind='reconcile' AND request_key=?").get(binding.account_id,event.id);
      const fingerprint=hash(JSON.stringify(reference));if(previous){
        if(previous.input_hash!==fingerprint)fail('billing_conflict',409);
        const task=previous.task_id?tasks.get(binding.account_id,previous.task_id):null;
        if(previous.status!=='ready'&&(!task||!['pending','running'].includes(task.status))&&previous.updated_at+5000<=now()){beforePrivateDelete();enqueue(db,tasks,previous,now);}
        return;
      }
      // Applied event receipts outlive short-lived operation history. A delivery
      // retry must not pause a projection that the ledger has already settled.
      if(db.prepare('SELECT 1 FROM access_billing_events WHERE event_hash=? AND account_id=?').get(hash(`billing-event:${event.id}`),binding.account_id))return;
      db.prepare("UPDATE access_subscriptions SET state_version=state_version+1,reconcile_pending=1 WHERE account_id=? AND (status<>'ended' OR reconcile_pending=1)").run(binding.account_id);
      insertOperation(db,tasks,{owner:binding.account_id,kind:'reconcile',key:event.id,inputHash:fingerprint,locale:binding.locale,policyKey:binding.policy_key,
        configHash:configurationHash(settings),resourceKind:reference.kind,resourceId:reference.resourceId,eventId:event.id},now);
    });
    return {status:200,body:{received:true}};
  }
  function handleBilling(ctx) {
    if(!ctx.path.startsWith('/account/billing'))return null;
    if([...ctx.url.searchParams].length)fail('invalid_query',400);cleanup();current(ctx,{cleanup:ctx.method==='GET'});
    if(ctx.method==='GET'&&ctx.path==='/account/billing'){
      const binding=accountRow(db,ctx.accountId),owner=liveOwner(db,ctx.accountId,now),available=enabled()&&Boolean(admission.processingPolicy(ctx.interfaceLocale)),closing=Boolean(binding?.closing_revision>0);
      const operation=db.prepare("SELECT * FROM justup_billing_operations WHERE account_id=? AND kind='terminate' ORDER BY created_at DESC LIMIT 1").get(ctx.accountId);
      const active=db.prepare("SELECT * FROM justup_billing_operations WHERE account_id=? AND kind IN ('checkout','portal') ORDER BY created_at DESC,id DESC LIMIT 1").get(ctx.accountId);
      const access=getAuth?.()?.accessForAccount?.(ctx.accountId),activeCheckout=active?.kind==='checkout'&&active.expires_at>now()&&['pending','running','ready','ambiguous'].includes(active.status);
      return {status:200,body:{billing:{available,mode:configured?'test':null,offers:configured?['weekly','monthly'].map(plan=>({plan,currency:settings.offers[plan].currency,amount:settings.offers[plan].amount,interval:plan==='weekly'?'week':'month'})):[],
        closing,canCheckout:available&&!closing&&!activeCheckout&&!unresolvedCheckout(db,binding)&&owner.account_expires_at===null&&(!binding?.subscription_id||access?.fullAccess===false&&access?.kind!=='pending')&&Boolean(db.prepare('SELECT 1 FROM access_identities WHERE account_id=?').get(ctx.accountId)),
        canManage:available&&!closing&&Boolean(binding?.customer_id),operation:active?view(active):null,termination:operation?view(operation):null}}};
    }
    const match=/^\/account\/billing\/operations\/([a-f0-9-]{36})$/.exec(ctx.path);
    if(ctx.method==='GET'&&match){const operation=operationRow(db,ctx.accountId,match[1]);if(!operation)return fail('not_found',404);return {status:200,body:{operation:view(operation)}};}
    if(ctx.method==='POST'&&ctx.path==='/account/billing/checkout')return {status:202,body:{operation:view(start(ctx,'checkout'))}};
    if(ctx.method==='POST'&&ctx.path==='/account/billing/manage')return {status:202,body:{operation:view(start(ctx,'portal'))}};
    if(ctx.method==='POST'&&ctx.path==='/account/billing/reconcile')return {status:202,body:{operation:view(start(ctx,'reconcile'))}};
    fail('not_found',404);
  }
  return {stripeBilling:true,handleBilling,handleWebhook,prepareDeletion,assertDeletionReady,deleteAccountData,cleanup,
    capabilities:()=>({billing:enabled()}),refreshAvailability:admission.refreshAvailability};
}

export function createStripeBillingRunner({db,tasks,config={},now=Date.now,client}={}) {
  initialize(db);const settings=validateStripeBillingConfig(config.stripeBilling),enabled=settings?.enabled===true;
  if(enabled)client??=createStripeTestClient({apiKey:settings.apiKey,accountId:settings.accountId});
  const admission=createProcessingAdmission({db,config,now});
  const ledger=enabled?createEntitlements({db,now,billingEventVerifier:event=>event}):null;
  const signals=new WeakMap();
  function observeReceipt(receipt){
    const state=terminationReceipt(db,receipt);if(!state)return false;
    const outcome=terminationOutcome(receipt,state);if(!outcome)return false;
    if(absorbedTermination(db,receipt))return true;
    // Only bounded status and the receipt identity are absorbed here. Original
    // provider keys, mutation times and uncertain checkout evidence stay owned.
    db.prepare("UPDATE justup_billing_operations SET status=?,error_code=?,resource_kind='termination_receipt',resource_id=?,updated_at=max(updated_at,?) WHERE id=? AND task_id=?")
      .run(outcome.status,outcome.error,receipt.id,Date.parse(receipt.updatedAt),state.operation.id,receipt.id);
    return true;
  }
  function taskFinished(task){
    if(task.kind!=='billing_terminate')return false;
    return transaction(db,()=>{try{return observeReceipt(tasks.get(task.ownerId,task.id));}catch{return false;}});
  }
  function reconcileCompletedTasks(){
    return transaction(db,()=>{
      const rows=db.prepare("SELECT id,owner_id FROM justup_tasks WHERE kind='billing_terminate' AND status IN ('succeeded','failed') ORDER BY updated_at,id LIMIT 96").all();let absorbed=0;
      for(const row of rows)try{if(observeReceipt(tasks.get(row.owner_id,row.id)))absorbed++;}catch{ /* Unknown evidence remains in its receipt. */ }
      return absorbed;
    });
  }
  function current(task,{cleanup=false}={}) {
    if(signals.get(task)?.aborted)fail('task_interrupted');
    const operation=operationRow(db,task.ownerId,task.payload?.operationId),binding=accountRow(db,task.ownerId);
    if(!enabled||!operation||!binding||!liveOwner(db,task.ownerId,now)||operation.task_id!==task.id||task.kind!==`billing_${operation.kind}`
        ||task.payload.locale!==operation.locale||task.payload.policyKey!==operation.policy_key||!taskActive(tasks,task,now)
        ||operation.configuration_hash!==configurationHash(settings))fail('processing_unavailable');
    if(!cleanup){if(operation.error_code==='billing_operator_reconciliation_required')fail('billing_operator_reconciliation_required');
      const policy=admission.processingPolicy(operation.locale);
      if(!policy||policy.key!==operation.policy_key||task.payload.policyKey!==policy.key)fail('processing_unavailable');
      if(operation.session_hash&&!liveSession(db,task.ownerId,operation.session_hash,now))fail('unauthenticated',401);}
    return {operation,binding};
  }
  function save(task,work){return transaction(db,()=>{const state=current(task,{cleanup:task.kind==='billing_terminate'});return work(state);});}
  const providerOptions=(operation,signal,suffix='')=>({signal,idempotencyKey:`justup/${operation.id}/${suffix||operation.kind}`});
  async function checkout(task,signal) {
    let {operation,binding}=current(task);if(binding.closing_revision>0||liveOwner(db,task.ownerId,now).account_expires_at!==null)fail('billing_termination_pending',409);
    if(!binding.customer_id&&operation.resource_kind==='customer'&&['running','ambiguous'].includes(operation.status)&&operation.created_at+23*3_600_000<=now())fail('billing_operator_reconciliation_required');
    if(operation.expires_at<=now())fail('billing_unavailable');
    const prices=Object.fromEntries(Object.entries(settings.offers).map(([plan,value])=>[plan,value.priceId]));
    const price=await client.retrievePrice(prices[operation.plan],{signal}),offer=stripeOffer(price,{plan:operation.plan,prices});
    if(offer.currency!==settings.offers[operation.plan].currency||offer.amount!==settings.offers[operation.plan].amount)fail('billing_configuration_mismatch');
    ({operation,binding}=current(task));if(binding.closing_revision>0)fail('billing_termination_pending',409);
    if(binding.customer_id){const customer=await client.retrieveCustomer(binding.customer_id,{signal});if(customer.metadata?.justup_reference!==binding.billing_reference)fail('billing_evidence_invalid');}
    if(binding.subscription_id){
      const previous=await client.retrieveSubscription(binding.subscription_id,{signal});
      if(previous.status!=='canceled'||ref(previous.customer)!==binding.customer_id||previous.metadata?.justup_reference!==binding.billing_reference)fail('billing_conflict',409);
      // Retain the canceled binding until the current checkout proves its
      // replacement. Late events cannot become a new ownership generation.
    }
    if(!binding.customer_id){
      save(task,()=>db.prepare("UPDATE justup_billing_operations SET status='running',resource_kind='customer',updated_at=? WHERE id=?").run(now(),operation.id));
      const customer=await client.createCustomer(binding.billing_reference,providerOptions(operation,signal,'customer'));
      save(task,()=>db.prepare('UPDATE justup_billing_accounts SET customer_id=? WHERE account_id=? AND customer_id IS NULL').run(customer.id,task.ownerId));
      binding=accountRow(db,task.ownerId);
    }
    ({operation,binding}=current(task));if(binding.closing_revision>0)fail('billing_termination_pending',409);
    const fields=stripeCheckoutFields({plan:operation.plan,prices,customerId:binding.customer_id,billingReference:binding.billing_reference,
      returnTo:`${settings.origin}/`,expiresAt:Math.floor(operation.expires_at/1000),now:now()});
    save(task,()=>db.prepare("UPDATE justup_billing_operations SET status='running',resource_kind='checkout',updated_at=? WHERE id=?").run(now(),operation.id));
    const session=await client.createCheckout(fields,providerOptions(operation,signal));
    if(ref(session.customer)!==binding.customer_id||session.client_reference_id!==binding.billing_reference
        ||session.metadata?.justup_reference!==binding.billing_reference||session.mode!=='subscription'||session.status!=='open'
        ||session.managed_payments?.enabled===true
        ||session.expires_at*1000>operation.expires_at)fail('billing_evidence_invalid');
    const url=stripeHostedUrl('checkout',session.url);
    return save(task,({binding:latest})=>{
      db.prepare('UPDATE justup_billing_operations SET resource_kind=\'checkout\',resource_id=?,url=?,status=?,updated_at=? WHERE id=?')
        .run(session.id,latest.closing_revision>0?null:url,latest.closing_revision>0?'ambiguous':'ready',now(),operation.id);
      return latest.closing_revision>0?{status:'failed',errorCode:'billing_termination_pending'}:{status:'succeeded',output:null};
    });
  }
  async function portal(task,signal) {
    const {operation,binding}=current(task);if(binding.closing_revision>0||!binding.customer_id)fail('billing_termination_pending',409);
    const portalConfig=await client.retrievePortalConfiguration(settings.portalConfigurationId,{signal});
    if(portalConfig.active!==true||portalConfig.features?.subscription_update?.enabled!==false
        ||portalConfig.features?.subscription_cancel?.enabled!==true||portalConfig.features.subscription_cancel.mode!=='at_period_end')fail('billing_configuration_mismatch');
    current(task);const session=await client.createPortal(stripePortalFields({customerId:binding.customer_id,configurationId:settings.portalConfigurationId,returnTo:`${settings.origin}/`}),providerOptions(operation,signal));
    if(session.customer!==binding.customer_id||session.configuration!==settings.portalConfigurationId)fail('billing_evidence_invalid');
    const url=stripeHostedUrl('portal',session.url);
    return save(task,({binding:latest})=>{if(latest.closing_revision>0)fail('billing_termination_pending',409);
      db.prepare("UPDATE justup_billing_operations SET status='ready',url=?,updated_at=? WHERE id=?").run(url,now(),operation.id);return {status:'succeeded',output:null};});
  }
  async function reconcile(task,signal) {
    const {operation,binding}=current(task);if(binding.closing_revision>0)fail('billing_termination_pending',409);
    let subscriptionId=binding.subscription_id,anchorKind='settled_checkout';
    const anchor=binding.current_checkout_operation_id?operationRow(db,task.ownerId,binding.current_checkout_operation_id):null;
    if(binding.current_checkout_operation_id){
      if(!anchor)fail('billing_operator_reconciliation_required');
      if(anchor.kind!=='checkout')fail('billing_evidence_invalid');
      if(anchor.error_code==='billing_operator_reconciliation_required')fail('billing_operator_reconciliation_required');
      if(!anchor.resource_id){
        const anchorTask=anchor.task_id?tasks.get(anchor.account_id,anchor.task_id):null;
        const inactive=!anchorTask||!['pending','running'].includes(anchorTask.status);
        if(inactive&&(anchor.resource_kind===null||anchor.resource_kind==='unstarted_checkout'||anchor.resource_kind==='customer'&&binding.customer_id)){
          anchorKind='unstarted_checkout';
          if(!subscriptionId)return save(task,({binding:latest})=>{
            if(latest.current_checkout_operation_id!==anchor.id)fail('billing_reconcile_required',409);
            db.prepare("UPDATE justup_billing_operations SET resource_kind='unstarted_checkout',status='failed',updated_at=? WHERE id=?").run(now(),anchor.id);
            db.prepare("UPDATE justup_billing_operations SET status='ready',updated_at=? WHERE id=?").run(now(),operation.id);return {status:'succeeded',output:null};
          });
        }else{
          if(inactive&&(anchor.resource_kind==='customer'?anchor.created_at+23*3_600_000<=now():anchor.expires_at<=now())){
            save(task,()=>db.prepare("UPDATE justup_billing_operations SET status='ambiguous',error_code='billing_operator_reconciliation_required',updated_at=? WHERE id=?").run(now(),anchor.id));
            fail('billing_operator_reconciliation_required');
          }
          fail('billing_reconcile_required',409);
        }
      }else{
        const session=await client.retrieveCheckout(anchor.resource_id,{signal});
        if(session.id!==anchor.resource_id||ref(session.customer)!==binding.customer_id||session.client_reference_id!==binding.billing_reference
            ||session.metadata?.justup_reference!==binding.billing_reference||session.mode!=='subscription'||!['open','complete','expired'].includes(session.status))fail('billing_evidence_invalid');
        subscriptionId=ref(session.subscription);
        if(!subscriptionId){
          if(session.status==='expired'&&binding.subscription_id){subscriptionId=binding.subscription_id;anchorKind='expired_checkout';}
          else return save(task,({binding:latest})=>{
            if(latest.current_checkout_operation_id!==anchor.id)fail('billing_reconcile_required',409);
            if(session.status==='expired')db.prepare("UPDATE justup_billing_operations SET resource_kind='expired_checkout',updated_at=? WHERE id=?").run(now(),anchor.id);
            db.prepare("UPDATE justup_billing_operations SET status='ready',updated_at=? WHERE id=?").run(now(),operation.id);return {status:'succeeded',output:null};
          });
        }else if(session.status!=='complete')fail('billing_evidence_invalid');
      }
    }
    else if(operation.resource_kind==='subscription')subscriptionId=operation.resource_id;
    else if(operation.resource_kind==='invoice'){const invoice=await client.retrieveInvoice(operation.resource_id,{signal});if(ref(invoice.customer)!==binding.customer_id)fail('billing_evidence_invalid');subscriptionId=ref(invoice.parent?.subscription_details?.subscription);}
    else if(operation.resource_kind==='checkout'){const session=await client.retrieveCheckout(operation.resource_id,{signal});if(ref(session.customer)!==binding.customer_id||session.client_reference_id!==binding.billing_reference)fail('billing_evidence_invalid');subscriptionId=ref(session.subscription);if(!subscriptionId)return {status:'succeeded',output:null};}
    else if(operation.resource_kind==='charge'){const charge=await client.retrieveCharge(operation.resource_id,{signal});if(ref(charge.customer)!==binding.customer_id)fail('billing_evidence_invalid');}
    else if(operation.resource_kind==='customer'){
      const values=await client.listSubscriptions(binding.customer_id,{signal});if(values.has_more||values.data.length>1)fail('billing_evidence_invalid');
      if(!values.data.length)return save(task,()=>{
        db.prepare("UPDATE justup_billing_operations SET status='ready',updated_at=? WHERE id=?").run(now(),operation.id);return {status:'succeeded',output:null};});
      subscriptionId=values.data[0].id;
    }
    if(!id(subscriptionId,'sub')||!anchor&&binding.subscription_id&&binding.subscription_id!==subscriptionId)fail('billing_evidence_invalid');
    const localBinding={accountId:task.ownerId,customerId:binding.customer_id,subscriptionId,billingReference:binding.billing_reference,settledInvoiceId:binding.subscription_id===subscriptionId?binding.settled_invoice_id:null};
    let newest=null;
    await ledger.applyBillingEvent({eventId:operation.event_id??`operation:${operation.id}`,accountId:task.ownerId,subscriptionId,
      commit(){const latest=current(task);if(latest.binding.closing_revision>0)fail('billing_termination_pending',409);
        if(latest.binding.current_checkout_operation_id!==binding.current_checkout_operation_id)fail('billing_reconcile_required',409);
        if(anchor)db.prepare("UPDATE justup_billing_operations SET resource_kind=?,status=CASE WHEN ?='unstarted_checkout' THEN 'failed' ELSE status END,updated_at=? WHERE id=?").run(anchorKind,anchorKind,now(),anchor.id);
        // Current checkout ownership supersedes older generations atomically.
        // Their reservations must not revive access or leave a permanent pause.
        db.prepare("UPDATE access_subscriptions SET state_version=state_version+1,status='ended',plan=NULL,paid_through_at=NULL,reconcile_pending=0 WHERE account_id=? AND subscription_hash<>?").run(task.ownerId,hash(`subscription:${subscriptionId}`));
        db.prepare('UPDATE justup_billing_accounts SET subscription_id=?,settled_invoice_id=?,settled_charge_id=? WHERE account_id=?')
          .run(subscriptionId,newest?.period.invoiceId??localBinding.settledInvoiceId,newest?.chargeId??(binding.subscription_id===subscriptionId?binding.settled_charge_id:null),task.ownerId);return true;},reconcile:async()=>{
      current(task);const subscription=await client.retrieveSubscription(subscriptionId,{signal}),settled=[];
      const approved=Object.values(settings.offers).find(offer=>offer.priceId===subscription.items?.data?.[0]?.price?.id);
      if(!approved||subscription.items.data[0].price.unit_amount!==approved.amount||subscription.items.data[0].price.currency!==approved.currency)fail('billing_configuration_mismatch');
      for(const invoiceId of [...new Set([ref(subscription.latest_invoice),localBinding.settledInvoiceId].filter(Boolean))]){
        const invoice=await client.retrieveInvoice(invoiceId,{signal});if(invoice.status!=='paid')continue;
        const paymentId=invoice.payments?.data?.[0]?.payment?.payment_intent;if(!id(paymentId,'pi'))fail('billing_evidence_invalid');
        const intent=await client.retrievePaymentIntent(paymentId,{signal}),charge=await client.retrieveCharge(ref(intent.latest_charge),{signal});
        const period=stripeSettledPeriod({subscription,invoice,paymentIntent:intent,charge,binding:localBinding,
          prices:Object.fromEntries(Object.entries(settings.offers).map(([plan,offer])=>[plan,offer.priceId])),now:now()});
        settled.push(period);if(!newest||period.paidThroughAt>newest.period.paidThroughAt)newest={period,chargeId:charge.id};
      }
      if(current(task).binding.closing_revision>0)fail('billing_termination_pending',409);
      return stripeEntitlementSnapshot({subscription,settledPeriods:settled,binding:localBinding,
        prices:Object.fromEntries(Object.entries(settings.offers).map(([plan,offer])=>[plan,offer.priceId])),observedAt:now()});
    }});
    return save(task,()=>{db.prepare("UPDATE justup_billing_operations SET status='ready',updated_at=? WHERE id=?").run(now(),operation.id);return {status:'succeeded',output:null};});
  }
  async function terminate(task,signal) {
    let {operation,binding}=current(task,{cleanup:true});if(binding.closing_revision<1)fail('billing_termination_pending');
    if(binding.current_checkout_operation_id&&!operationRow(db,task.ownerId,binding.current_checkout_operation_id)&&!binding.customer_id)fail('billing_operator_reconciliation_required');
    const unfinished=db.prepare("SELECT * FROM justup_billing_operations WHERE account_id=? AND kind='checkout' AND status IN ('pending','running','ambiguous')").all(task.ownerId);
    if(unfinished.some(value=>value.resource_kind==='customer'&&value.error_code==='billing_operator_reconciliation_required'))fail('billing_operator_reconciliation_required');
    if(!binding.customer_id){
      const unknown=unfinished.find(value=>value.resource_kind==='customer'&&['running','ambiguous'].includes(value.status));
      if(unknown){
        if(unknown.created_at+23*3_600_000<=now())fail('billing_operator_reconciliation_required');
        const customer=await client.createCustomer(binding.billing_reference,providerOptions(unknown,signal,'customer'));
        save(task,()=>{db.prepare('UPDATE justup_billing_accounts SET customer_id=? WHERE account_id=? AND customer_id IS NULL').run(customer.id,task.ownerId);
          db.prepare("UPDATE justup_billing_operations SET resource_id=?,status='failed',error_code='billing_termination_pending',updated_at=? WHERE id=?").run(customer.id,now(),unknown.id);});
        binding=accountRow(db,task.ownerId);
      }
    }
    if(unfinished.some(value=>value.resource_kind==='checkout'&&!value.resource_id&&(value.status==='running'||value.status==='ambiguous')&&value.expires_at>now()))fail('billing_termination_pending',409);
    if(!binding.customer_id){
      if(unfinished.some(value=>value.status==='running'||value.status==='ambiguous'))fail('billing_termination_pending',409);
      return save(task,()=>{db.prepare('UPDATE justup_billing_accounts SET termination_revision=closing_revision,termination_verified_at=? WHERE account_id=?').run(now(),task.ownerId);
        db.prepare("UPDATE justup_billing_operations SET status='ready',updated_at=? WHERE id=?").run(now(),operation.id);return {status:'succeeded',output:null};});
    }
    const customer=await client.retrieveCustomer(binding.customer_id,{signal});
    if(customer.metadata?.justup_reference!==binding.billing_reference)fail('billing_evidence_invalid');
    let checkouts=await client.listCheckouts(binding.customer_id,{signal}),subscriptions=await client.listSubscriptions(binding.customer_id,{signal});
    if(checkouts.has_more||subscriptions.has_more)fail('billing_termination_unavailable');
    for(const session of checkouts.data){if(ref(session.customer)!==binding.customer_id)fail('billing_evidence_invalid');if(session.status==='open')await client.expireCheckout(session.id,providerOptions(operation,signal,`expire:${session.id}`));}
    for(const subscription of subscriptions.data){if(ref(subscription.customer)!==binding.customer_id)fail('billing_evidence_invalid');if(subscription.status!=='canceled')await client.cancelSubscription(subscription.id,providerOptions(operation,signal,`cancel:${subscription.id}`));}
    checkouts=await client.listCheckouts(binding.customer_id,{signal});subscriptions=await client.listSubscriptions(binding.customer_id,{signal});
    const proof={closureRevision:binding.closing_revision,unresolvedOperations:0,verifiedAt:now(),customer,checkouts,subscriptions};
    if(!stripeTerminationReady({closingRevision:binding.closing_revision,proof,binding:{customerId:binding.customer_id,billingReference:binding.billing_reference},now:now()}))fail('billing_termination_pending',409);
    return save(task,({binding:latest})=>{if(latest.closing_revision!==binding.closing_revision)fail('billing_termination_pending',409);
      db.prepare('UPDATE justup_billing_accounts SET termination_revision=closing_revision,termination_verified_at=? WHERE account_id=?').run(now(),task.ownerId);
      db.prepare("UPDATE justup_billing_operations SET status='ready',updated_at=? WHERE id=?").run(now(),operation.id);return {status:'succeeded',output:null};});
  }
  async function runTask(task,{signal}={}) {
    signals.set(task,signal);
    try{
      if(signal?.aborted)fail('task_interrupted');
      const handler={billing_checkout:checkout,billing_portal:portal,billing_reconcile:reconcile,billing_terminate:terminate}[task.kind];
      if(!handler)fail('invalid_input',400);
      const result=await handler(task,signal);if(signal?.aborted)fail('task_interrupted');return result;
    }catch(error){
      const operation=operationRow(db,task.ownerId,task.payload?.operationId);
      if(operation&&taskActive(tasks,task,now))db.prepare("UPDATE justup_billing_operations SET status=?,error_code=?,updated_at=? WHERE id=?")
        .run(operation.kind==='checkout'&&['running','ambiguous'].includes(operation.status)?'ambiguous':'failed',['billing_termination_pending','billing_operator_reconciliation_required','billing_evidence_invalid','billing_configuration_mismatch','processing_unavailable'].includes(error.code)?error.code:'billing_unavailable',now(),operation.id);
      return {status:'failed',errorCode:['billing_termination_pending','billing_operator_reconciliation_required','billing_evidence_invalid','billing_configuration_mismatch','processing_unavailable','task_interrupted'].includes(error.code)?error.code:'billing_unavailable'};
    }finally{signals.delete(task);}
  }
  reconcileCompletedTasks();
  return {available:()=>enabled,runTask,kinds:KINDS,taskFinished,reconcileCompletedTasks};
}
