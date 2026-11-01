// Real SQLite/auth/task contracts; every Stripe response is a local synthetic
// object. No test credentials, provider request or hosted page is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,unlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from './main.mjs';
import {createAuth} from './auth.mjs';
import {createRunner} from './runner.mjs';
import {createBillingRunnerHooks} from './runner-adapter.mjs';
import {createStripeBillingRunner,validateStripeBillingConfig} from './stripe-billing.mjs';
import {STRIPE_API_VERSION} from './account-provider-clients.mjs';
import {syntheticPolicyProof} from './policy-test-fixtures.mjs';

const PASSWORD='a sufficiently long password';
const ORIGIN='https://preview.justup.work';
const offers={weekly:{priceId:'price_Weekly',currency:'usd',amount:100},monthly:{priceId:'price_Monthly',currency:'usd',amount:400}};
const list=data=>({object:'list',has_more:false,data});
const hash=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t,{storage={},hooks={}}={}) {
  let at=Date.parse('2026-11-01T15:00:00.000Z');const now=()=>at;
  const base={enabled:true,accountId:'acct_Sandbox',offers,portalConfigurationId:'bpc_Justup',origin:ORIGIN};
  const config={dbPath:':memory:',sourceCommit:'a'.repeat(40),buildIdentity:'b'.repeat(64),csrfSecret:'c'.repeat(32),
    allowedOrigin:ORIGIN,privacyUrl:`${ORIGIN}/privacy.html`,usageUrl:`${ORIGIN}/usage.html`,policiesReviewed:true,policyVersion:'test-v1',policyAssetProof:syntheticPolicyProof({origin:ORIGIN,sourceCommit:'a'.repeat(40),version:'test-v1'}),requiresInvitation:false,
    stripeBilling:{...base,webhookSecret:'whsec_synthetic_endpoint_secret_value'},readiness:()=>({capabilities:{stripeBilling:true}}),...storage};
  let app=await createApplication({config,now});t.after(()=>app.close());let api=app.services.find(service=>service.stripeBilling);
  const state={customer:null,checkouts:[],subscription:null,invoice:null,intent:null,charge:null,calls:[],customerKeys:[],terminationKeys:[],unavailable:false};
  function called(name){state.calls.push(name);if(state.unavailable)throw Object.assign(new Error('synthetic private failure'),{code:'provider_unavailable'});}
  const client={
    async retrievePrice(identifier){called('price');const [plan,offer]=Object.entries(offers).find(([,value])=>value.priceId===identifier);return {id:identifier,object:'price',livemode:false,active:true,type:'recurring',billing_scheme:'per_unit',unit_amount:offer.amount,currency:offer.currency,
      recurring:{interval:plan==='weekly'?'week':'month',interval_count:1,usage_type:'licensed',trial_period_days:null}};},
    async createCustomer(billingReference,options){called('customer-create');state.customerKeys.push(options.idempotencyKey);state.customer??={id:'cus_Owner',object:'customer',livemode:false,metadata:{justup_reference:billingReference}};await hooks.customer?.();return structuredClone(state.customer);},
    async retrieveCustomer(){called('customer-read');return structuredClone(state.customer);},
    async createCheckout(fields){called('checkout-create');await hooks.checkout?.();const value={id:'cs_test_Owner',object:'checkout.session',livemode:false,mode:'subscription',status:'open',customer:fields.customer,client_reference_id:fields.client_reference_id,
      metadata:{justup_reference:fields['metadata[justup_reference]']},expires_at:Number(fields.expires_at),url:'https://checkout.stripe.com/c/pay/cs_test_Owner#synthetic',subscription:null};state.checkouts=[value];return structuredClone(value);},
    async retrieveCheckout(identifier){called('checkout-read');return structuredClone(state.checkouts.find(value=>value.id===identifier));},
    async retrievePortalConfiguration(){called('portal-config');return {id:'bpc_Justup',object:'billing_portal.configuration',livemode:false,active:true,features:{subscription_update:{enabled:false},subscription_cancel:{enabled:true,mode:'at_period_end'}}};},
    async createPortal(fields){called('portal-create');return {id:'bps_Owner',object:'billing_portal.session',livemode:false,customer:fields.customer,configuration:fields.configuration,url:'https://billing.stripe.com/p/session/test_Synthetic'};},
    async retrieveSubscription(identifier){called('subscription-read');await hooks.subscription?.();return structuredClone(state.previousSubscription?.id===identifier?state.previousSubscription:state.subscription);},
    async retrieveInvoice(identifier){called('invoice-read');if(identifier==='in_Unpaid')return {id:identifier,object:'invoice',livemode:false,customer:'cus_Owner',status:'open'};return structuredClone(state.invoice);},
    async retrievePaymentIntent(){called('intent-read');return structuredClone(state.intent);},
    async retrieveCharge(){called('charge-read');const charge=structuredClone(state.charge);await hooks.charge?.();return charge;},
    async listCheckouts(){called('checkout-list');return list(structuredClone(state.checkouts));},
    async listSubscriptions(){called('subscription-list');return list(state.subscription?[structuredClone(state.subscription)]:[]);},
    async expireCheckout(identifier,options){called('checkout-expire');state.terminationKeys.push(options.idempotencyKey);await hooks.expire?.();const value=state.checkouts.find(value=>value.id===identifier);value.status='expired';return structuredClone(value);},
    async cancelSubscription(){called('subscription-cancel');state.subscription.status='canceled';return structuredClone(state.subscription);},
  };
  const queueConfig={...config,stripeBilling:{...base,apiKey:'rk_test_Synthetic'}};
  let queue=createStripeBillingRunner({db:app.store.db,tasks:app.tasks,config:queueConfig,now,client});
  const owner=await app.auth.register({username:'person',password:PASSWORD});
  app.store.db.prepare('INSERT INTO access_identities VALUES(?,?,NULL,?)').run(owner.account.id,hash('synthetic verified subject'),at);
  const ctx=(body,path='/account/billing/checkout',method='POST',person=owner)=>({method,path,url:new URL(`${ORIGIN}/api/v1${path}`),body,accountId:person.account.id,sessionHash:hash(person.token),interfaceLocale:'en'});
  const start=(requestKey='first')=>api.handleBilling(ctx({plan:'weekly',requestKey}));
  async function work({observe=true,...options}={}){const task=app.tasks.claim({workerId:'test-worker',kinds:queue.kinds,leaseMs:90_000});assert.ok(task);const result=await queue.runTask(task,options);const completed=app.tasks.complete(task.id,task.leaseToken,{status:result.status,errorCode:result.errorCode??null,output:result.output??null});if(completed&&observe)queue.taskFinished?.(task);return {task,result};}
  function paid(){
    const reference=state.customer.metadata.justup_reference,seconds=at/1000;
    const price={id:offers.weekly.priceId,object:'price',livemode:false,active:true,type:'recurring',billing_scheme:'per_unit',unit_amount:100,currency:'usd',recurring:{interval:'week',interval_count:1,usage_type:'licensed',trial_period_days:null}};
    state.subscription={id:'sub_Owner',object:'subscription',livemode:false,customer:'cus_Owner',metadata:{justup_reference:reference},collection_method:'charge_automatically',status:'active',cancel_at_period_end:false,latest_invoice:'in_Paid',
      items:list([{id:'si_Owner',object:'subscription_item',subscription:'sub_Owner',quantity:1,price,current_period_start:seconds-10,current_period_end:seconds+604790}])};
    state.invoice={id:'in_Paid',object:'invoice',livemode:false,customer:'cus_Owner',status:'paid',currency:'usd',collection_method:'charge_automatically',billing_reason:'subscription_create',parent:{type:'subscription_details',subscription_details:{subscription:'sub_Owner'}},
      amount_due:100,amount_paid:100,amount_remaining:0,pre_payment_credit_notes_amount:0,post_payment_credit_notes_amount:0,
      lines:list([{id:'il_Owner',object:'line_item',livemode:false,quantity:1,amount:100,currency:'usd',parent:{type:'subscription_item_details',subscription_item_details:{subscription:'sub_Owner',subscription_item:'si_Owner',proration:false}},
        pricing:{type:'price_details',price_details:{price:offers.weekly.priceId}},period:{start:seconds-10,end:seconds+604790}}]),
      payments:list([{id:'inpay_Owner',object:'invoice_payment',livemode:false,status:'paid',invoice:'in_Paid',amount_paid:100,currency:'usd',payment:{type:'payment_intent',payment_intent:'pi_Owner'}}])};
    state.intent={id:'pi_Owner',object:'payment_intent',livemode:false,customer:'cus_Owner',status:'succeeded',currency:'usd',amount:100,amount_received:100,latest_charge:'ch_Owner'};
    state.charge={id:'ch_Owner',object:'charge',livemode:false,customer:'cus_Owner',payment_intent:'pi_Owner',currency:'usd',amount:100,amount_captured:100,amount_refunded:0,paid:true,captured:true,refunded:false,disputed:false,status:'succeeded'};
    if(state.checkouts[0]){state.checkouts[0].status='complete';state.checkouts[0].subscription='sub_Owner';}
  }
  function notification(identifier='evt_First',object=state.subscription,type='customer.subscription.updated',created=at/1000){const event={id:identifier,object:'event',livemode:false,api_version:STRIPE_API_VERSION,type,created,data:{object:structuredClone(object)}};
    const body=Buffer.from(JSON.stringify(event)),timestamp=Math.floor(at/1000),signature=`t=${timestamp},v1=${createHmac('sha256',config.stripeBilling.webhookSecret).update(`${timestamp}.`).update(body).digest('hex')}`;
    return {body,signature};}
  function realRunner({observe=true,maintenance=true,onFinished=()=>{},handler}={}){return createRunner({tasks:app.tasks,handlers:{billing_terminate:handler??queue.runTask},
    ...createBillingRunnerHooks({billing:{taskFinished:task=>observe&&queue.taskFinished?.(task),reconcileCompletedTasks:()=>maintenance&&queue.reconcileCompletedTasks?.()},onTaskFinished:onFinished,beforeClaim:()=>{}})}); }
  async function reopen(){await app.close();app=await createApplication({config,now});api=app.services.find(service=>service.stripeBilling);queue=createStripeBillingRunner({db:app.store.db,tasks:app.tasks,config:queueConfig,now,client});}
  return {get app(){return app;},get api(){return api;},get queue(){return queue;},config,queueConfig,state,owner,ctx,start,work,paid,notification,now,reopen,realRunner,advance:ms=>{at+=ms;}};
}

function retainSyntheticHistory(f,count){
  const receipts=[];
  for(let index=0;index<count;index++){
    const input={ownerId:'retained-history-owner',kind:'synthetic_history',requestKey:`history-${index}`,payload:{entry:index}};
    const task=f.app.tasks.enqueue(input),lease=f.app.tasks.claim({workerId:'history-worker',kinds:['synthetic_history'],leaseMs:90_000});
    assert.equal(lease.id,task.id);assert.equal(f.app.tasks.complete(task.id,lease.leaseToken,{status:'succeeded',output:{recorded:index}}),true);
    receipts.push({input,id:task.id});
  }
  return receipts;
}

test('checkout, signed current-state reconciliation and hosted management compose without exposing queue secrets',async t=>{
  const f=await fixture(t),first=f.start();assert.deepEqual(f.start(),first);
  assert.equal(first.body.operation.status,'pending');const task=f.app.store.db.prepare('SELECT payload_json FROM justup_tasks').get();
  for(const value of ['cus_','price_','rk_test_','whsec_','url'])assert.equal(task.payload_json.includes(value),false);
  assert.equal((await f.work()).result.status,'succeeded');
  const operation=f.api.handleBilling(f.ctx(undefined,`/account/billing/operations/${first.body.operation.id}`,'GET')).body.operation;
  assert.equal(operation.status,'ready');assert.equal(operation.url,'https://checkout.stripe.com/c/pay/cs_test_Owner#synthetic');
  assert.equal(f.app.auth.session(f.owner.token).access.fullAccess,false);
  f.paid();const notice=f.notification();assert.deepEqual(f.api.handleWebhook(notice),{status:200,body:{received:true}});
  const before=f.app.store.db.prepare('SELECT count(*) n FROM justup_billing_operations').get().n;f.api.handleWebhook(notice);
  assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM justup_billing_operations').get().n,before);
  assert.equal((await f.work()).result.status,'succeeded');const access=f.app.auth.session(f.owner.token).access;
  assert.equal(access.kind,'paid');assert.equal(access.premium,true);assert.equal(access.until,new Date(f.now()+604790000).toISOString());
  const portal=f.api.handleBilling(f.ctx({requestKey:'manage'},'/account/billing/manage'));assert.equal(portal.status,202);
  assert.equal((await f.work()).result.status,'succeeded');assert.equal(f.api.handleBilling(f.ctx(undefined,`/account/billing/operations/${portal.body.operation.id}`,'GET')).body.operation.url,'https://billing.stripe.com/p/session/test_Synthetic');
});

test('unordered events use current subscription and failed or refunded payment cannot extend access',async t=>{
  const f=await fixture(t);f.start();await f.work();f.paid();f.api.handleWebhook(f.notification());await f.work();
  const until=f.app.auth.session(f.owner.token).access.until;
  f.state.subscription.status='past_due';f.state.subscription.latest_invoice='in_Unpaid';
  f.api.handleWebhook(f.notification('evt_OldTimestamp',f.state.subscription,'customer.subscription.updated',1));
  assert.equal(f.app.auth.session(f.owner.token).access.fullAccess,false);
  assert.equal((await f.work()).result.status,'succeeded');assert.equal(f.app.auth.session(f.owner.token).access.kind,'past_due');assert.equal(f.app.auth.session(f.owner.token).access.until,until);
  f.state.charge.amount_refunded=1;f.api.handleWebhook(f.notification('evt_Refund',f.state.charge,'charge.refunded'));
  assert.equal((await f.work()).result.status,'failed');assert.equal(f.app.auth.session(f.owner.token).access.fullAccess,false);
  assert.equal(f.app.auth.session(f.owner.token).access.kind,'pending');
});

test('password-confirmed deletion keeps all data until termination, then erases every owned billing and redemption row',async t=>{
  const f=await fixture(t);f.start();await f.work();f.paid();f.api.handleWebhook(f.notification());await f.work();
  await assert.rejects(f.app.auth.deleteAccount(f.owner.token,'the wrong long password'),{code:'invalid_credentials'});
  assert.equal(f.app.store.db.prepare('SELECT closing_revision FROM justup_billing_accounts').get().closing_revision,0);
  await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});
  assert.ok(f.app.auth.session(f.owner.token));assert.equal(f.app.auth.session(f.owner.token).access.fullAccess,false);
  assert.equal((await f.work()).result.status,'succeeded');assert.equal(f.state.subscription.status,'canceled');
  assert.deepEqual(await f.app.auth.deleteAccount(f.owner.token,PASSWORD),{deleted:true});f.app.afterPrivateTransaction();
  for(const table of ['auth_accounts','auth_sessions','access_identities','access_free_periods','access_subscriptions','access_billing_events','justup_billing_accounts','justup_billing_operations','justup_tasks'])assert.equal(f.app.store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0,table);
  f.api.handleWebhook(f.notification('evt_Late'));assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM justup_billing_accounts').get().n,0);
});

test('a provider outage never reports deletion and explicit retry can finish without tombstones',async t=>{
  const f=await fixture(t);f.start();await f.work();f.paid();f.api.handleWebhook(f.notification());await f.work();f.state.unavailable=true;
  await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});assert.equal((await f.work()).result.status,'failed');
  assert.ok(f.app.auth.session(f.owner.token));assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM access_identities').get().n,1);
  f.state.unavailable=false;f.advance(5001);await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});
  assert.equal((await f.work()).result.status,'succeeded');assert.deepEqual(await f.app.auth.deleteAccount(f.owner.token,PASSWORD),{deleted:true});
});

test('billing closure fences a checkout already waiting on its provider and never reveals the late URL',async t=>{
  let started,release;const waiting=new Promise(resolve=>{started=resolve;});
  const f=await fixture(t,{hooks:{checkout:async()=>{started();await new Promise(resolve=>{release=resolve;});}}});
  const first=f.start(),working=f.work();await waiting;
  await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});release();
  assert.equal((await working).result.status,'failed');
  assert.equal(f.api.handleBilling(f.ctx(undefined,`/account/billing/operations/${first.body.operation.id}`,'GET')).body.operation.url,null);
  assert.equal((await f.work()).result.status,'succeeded');assert.equal(f.state.checkouts[0].status,'expired');
  assert.deepEqual(await f.app.auth.deleteAccount(f.owner.token,PASSWORD),{deleted:true});
});

test('an unaware auth deletion is blocked by provider-table foreign keys and rolls back',async t=>{
  const f=await fixture(t);f.start();await f.work();
  const unaware=createAuth({db:f.app.store.db,config:{requiresInvitation:false},now:f.now});
  await assert.rejects(unaware.deleteAccount(f.owner.token,PASSWORD));
  assert.ok(unaware.session(f.owner.token));assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM justup_billing_accounts').get().n,1);
  assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM access_identities').get().n,1);
});

test('unknown customer creation preserves ownership and resolves only by the same provider idempotency key',async t=>{
  let first=true;
  const f=await fixture(t,{hooks:{customer:()=>{if(first){first=false;throw new Error('synthetic response lost after remote creation');}}}});
  f.start();assert.equal((await f.work()).result.status,'failed');
  const reserved=f.app.store.db.prepare('SELECT * FROM justup_billing_accounts').get();assert.equal(reserved.customer_id,null);
  assert.equal(f.app.store.db.prepare("SELECT status FROM justup_billing_operations WHERE kind='checkout'").get().status,'ambiguous');
  await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});
  assert.equal((await f.work()).result.status,'succeeded');assert.equal(f.state.customerKeys.length,2);assert.equal(f.state.customerKeys[0],f.state.customerKeys[1]);
  assert.deepEqual(await f.app.auth.deleteAccount(f.owner.token,PASSWORD),{deleted:true});
});

test('checkout expiry and a lapsed provider idempotency window never erase an unknown customer outcome',async t=>{
  const f=await fixture(t,{hooks:{customer:()=>{throw new Error('synthetic unknown external result');}}});
  f.start();await f.work();f.state.unavailable=true;f.advance(32*60_000);
  await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});assert.equal((await f.work()).result.status,'failed');
  assert.ok(f.app.auth.session(f.owner.token));assert.equal(f.app.store.db.prepare('SELECT termination_verified_at FROM justup_billing_accounts').get().termination_verified_at,null);
  f.advance(23*3_600_000);f.state.unavailable=false;
  await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});const before=f.state.customerKeys.length;
  assert.equal((await f.work()).result.status,'failed');assert.equal(f.state.customerKeys.length,before);assert.ok(f.app.auth.session(f.owner.token));
  const termination=f.api.handleBilling(f.ctx(undefined,'/account/billing','GET')).body.billing.termination;
  assert.equal(termination.error.code,'billing_operator_reconciliation_required');assert.equal(termination.error.retryable,false);
  await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_unavailable'});
});

test('an aborted checkout cannot commit a hosted URL even when a fake provider ignores cancellation',async t=>{
  const controller=new AbortController();
  const f=await fixture(t,{hooks:{checkout:()=>controller.abort()}});const operation=f.start();
  assert.equal((await f.work({signal:controller.signal})).result.errorCode,'task_interrupted');
  assert.equal(f.app.store.db.prepare('SELECT url FROM justup_billing_operations WHERE id=?').get(operation.body.operation.id).url,null);
  assert.equal(f.app.store.db.prepare('SELECT status FROM justup_billing_operations WHERE id=?').get(operation.body.operation.id).status,'ambiguous');
});

test('closure during payment retrieval cannot publish a paid entitlement or recreate provider identity',async t=>{
  let f,once=true;
  f=await fixture(t,{hooks:{subscription:async()=>{if(once){once=false;await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});}}}});
  f.start();await f.work();f.paid();f.api.handleWebhook(f.notification());assert.equal((await f.work()).result.status,'failed');
  const paid=f.app.store.db.prepare('SELECT paid_through_at,reconcile_pending FROM access_subscriptions').get();assert.equal(paid.paid_through_at,null);assert.equal(paid.reconcile_pending,1);
  assert.equal(f.app.auth.session(f.owner.token).access.fullAccess,false);
});

test('temporary accounts cannot start billing, and restore invalidation removes URL and termination authority',async t=>{
  const limited=await fixture(t,{storage:{accountTtlMs:600_000}});
  assert.throws(()=>limited.start(),{code:'billing_account_lifetime'});assert.equal(limited.state.calls.length,0);
  limited.advance(600_001);assert.equal(limited.app.auth.cleanup().accountsDeleted,1);
  const f=await fixture(t);const operation=f.start();await f.work();
  await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});await f.work();
  f.app.auth.invalidateAllSessions();
  const row=f.app.store.db.prepare('SELECT termination_verified_at FROM justup_billing_accounts').get();assert.equal(row.termination_verified_at,null);
  assert.equal(f.app.store.db.prepare('SELECT url FROM justup_billing_operations WHERE id=?').get(operation.body.operation.id).url,null);
  assert.equal(f.app.auth.session(f.owner.token),null);
});

test('policy closure blocks new billing and payment grants while provider termination remains available',async t=>{
  const f=await fixture(t);f.start();await f.work();f.paid();f.api.handleWebhook(f.notification());
  f.config.policiesReviewed=false;f.api.refreshAvailability();assert.equal((await f.work()).result.status,'failed');assert.equal(f.app.auth.session(f.owner.token).access.fullAccess,false);
  assert.throws(()=>f.api.handleBilling(f.ctx({requestKey:'manage'},'/account/billing/manage')),{code:'policy_unavailable'});
  await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});assert.equal((await f.work()).result.status,'succeeded');
  assert.deepEqual(await f.app.auth.deleteAccount(f.owner.token,PASSWORD),{deleted:true});
});

test('HTTP webhook exception is exact and signed, ordinary billing still requires owner Origin CSRF and locale',async t=>{
  const f=await fixture(t);f.start();await f.work();f.paid();await new Promise(resolve=>f.app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${f.app.server.address().port}/api/v1`,cookie=`__Host-justup_session=${f.owner.token}`;
  const session=await(await fetch(`${base}/session`,{headers:{Cookie:cookie}})).json();assert.equal(session.capabilities.billing,true);assert.equal(session.access.billingEnabled,true);
  const notice=f.notification();
  const sent=await fetch(`${base}/billing/stripe/webhook`,{method:'POST',headers:{'Content-Type':'application/json','Stripe-Signature':notice.signature},body:notice.body});assert.equal(sent.status,200);
  const bad=await fetch(`${base}/billing/stripe/webhook`,{method:'POST',headers:{'Content-Type':'application/json','Stripe-Signature':notice.signature},body:Buffer.from('{}')});assert.equal(bad.status,400);
  const browser=await fetch(`${base}/billing/stripe/webhook`,{method:'POST',headers:{'Content-Type':'application/json','Stripe-Signature':notice.signature,Origin:ORIGIN},body:notice.body});assert.equal(browser.status,400);
  const headers={Cookie:cookie,'Content-Type':'application/json',Origin:ORIGIN,'X-CSRF-Token':session.csrfToken};
  assert.equal((await fetch(`${base}/account/billing/manage`,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{"requestKey":"no-origin"}'})).status,403);
  assert.equal((await fetch(`${base}/account/billing/manage`,{method:'POST',headers,body:'{"requestKey":"proper"}'})).status,202);
});

test('API and queue roles reject live/admin keys, extra fields and mismatched offer settings',async t=>{
  const f=await fixture(t);
  for(const bad of [{...f.queueConfig.stripeBilling,apiKey:'sk_test_Admin'},{...f.queueConfig.stripeBilling,apiKey:'rk_live_Unsafe'},
    {...f.queueConfig.stripeBilling,unexpected:true},{...f.queueConfig.stripeBilling,offers:{weekly:offers.weekly,monthly:offers.weekly}}])assert.throws(()=>validateStripeBillingConfig(bad));
  assert.throws(()=>validateStripeBillingConfig({...f.config.stripeBilling,apiKey:'rk_test_NotApi'},{role:'api'}));
  f.config.stripeBilling.offers={monthly:offers.monthly,weekly:offers.weekly};f.start();assert.equal((await f.work()).result.status,'succeeded');
});


test('new refund evidence invalidates an older in-flight paid snapshot before its commit',async t=>{
  let release,read;const paused=new Promise(resolve=>{read=resolve;});let block=false;
  const f=await fixture(t,{hooks:{charge:async()=>{if(block){block=false;read();await new Promise(resolve=>{release=resolve;});}}}});
  f.start();await f.work();f.paid();f.api.handleWebhook(f.notification());await f.work();
  f.api.handleBilling(f.ctx({requestKey:'fresh-before-refund'},'/account/billing/reconcile'));
  block=true;const older=f.work();await paused;
  f.state.charge.amount_refunded=1;const refund=f.notification('evt_ConcurrentRefund',f.state.charge,'charge.refunded');
  f.api.handleWebhook(refund);assert.equal(f.app.auth.session(f.owner.token).access.fullAccess,false);
  release();assert.equal((await older).result.status,'failed');
  assert.equal(f.app.auth.session(f.owner.token).access.fullAccess,false);
  assert.equal((await f.work()).result.status,'failed');assert.equal(f.app.auth.session(f.owner.token).access.fullAccess,false);
  f.state.charge.amount_refunded=0;f.advance(5001);f.api.handleWebhook(refund);
  assert.equal((await f.work()).result.status,'succeeded');assert.equal(f.app.auth.session(f.owner.token).access.kind,'paid');
  const version=f.app.store.db.prepare('SELECT state_version FROM access_subscriptions').get().state_version;
  f.api.handleWebhook(refund);assert.equal(f.app.auth.session(f.owner.token).access.kind,'paid');
  assert.equal(f.app.store.db.prepare('SELECT state_version FROM access_subscriptions').get().state_version,version);
  f.advance(2*86_400_000);f.api.cleanup();
  assert.equal(f.app.store.db.prepare("SELECT 1 FROM justup_billing_operations WHERE request_key='evt_ConcurrentRefund'").get(),undefined);
  f.api.handleWebhook(f.notification('evt_ConcurrentRefund',{...f.state.charge,amount_refunded:1},'charge.refunded'));assert.equal(f.app.auth.session(f.owner.token).access.kind,'paid');
  assert.equal(f.app.store.db.prepare('SELECT state_version FROM access_subscriptions').get().state_version,version);
});

for(const restart of [false,'restart','upgrade'])test(`an unseen old subscription cannot take replacement ownership${restart?` after cleanup and ${restart}`:''}`,async t=>{
  const directory=mkdtempSync(join(tmpdir(),'justup-billing-generation-')),backupDir=join(directory,'backups'),privateGenerationPath=join(directory,'private-generation');
  mkdirSync(backupDir,{mode:0o700});writeFileSync(privateGenerationPath,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n',{mode:0o600});
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const f=await fixture(t,{storage:{dbPath:join(directory,'billing.sqlite'),backupDir,privateGenerationPath}});f.start();await f.work();f.paid();
  const period={start:f.now()/1000-604740,end:f.now()/1000+60};
  Object.assign(f.state.subscription.items.data[0],{current_period_start:period.start,current_period_end:period.end});f.state.invoice.lines.data[0].period=period;
  f.api.handleWebhook(f.notification());await f.work();
  f.state.subscription.status='canceled';f.api.handleWebhook(f.notification('evt_Canceled'));await f.work();
  f.advance(32*60_000);const replacement=f.start('replacement');await f.work();
  const canceled=structuredClone(f.state.subscription);f.state.previousSubscription=canceled;
  const paidReplacement=()=>{f.paid();for(const name of ['subscription','invoice','intent','charge','checkouts'])f.state[name]=JSON.parse(JSON.stringify(f.state[name]).replaceAll('sub_Owner','sub_Replacement').replaceAll('in_Paid','in_Replacement').replaceAll('pi_Owner','pi_Replacement').replaceAll('ch_Owner','ch_Replacement'));};
  if(restart){
    paidReplacement();f.advance(2*86_400_000);
    if(restart==='upgrade'){
      f.app.store.db.prepare("UPDATE justup_billing_operations SET created_at=CASE WHEN id=? THEN 1 ELSE ? END,resource_kind='checkout' WHERE kind='checkout'").run(replacement.body.operation.id,f.now()+86_400_000);
      f.app.store.db.exec('ALTER TABLE justup_billing_accounts DROP COLUMN current_checkout_operation_id');
    }else f.api.cleanup();
    await f.reopen();f.api.cleanup();
    if(restart==='upgrade'){
      const held=f.app.store.db.prepare("SELECT status,error_code FROM justup_billing_operations WHERE kind='checkout'").all();
      assert.equal(held.length,2);assert.ok(held.every(row=>row.status==='ambiguous'&&row.error_code==='billing_operator_reconciliation_required'));
      const before=f.app.store.db.prepare('SELECT subscription_id FROM justup_billing_accounts').get().subscription_id;
      for(const [event,object] of [['evt_LegacyOld',canceled],['evt_LegacyNew',f.state.subscription]]){
        f.api.handleWebhook(f.notification(event,object));assert.equal((await f.work()).result.errorCode,'billing_operator_reconciliation_required');
        assert.equal(f.app.store.db.prepare('SELECT subscription_id FROM justup_billing_accounts').get().subscription_id,before);assert.equal(f.app.auth.session(f.owner.token).access.fullAccess,false);
      }
      assert.throws(()=>f.start('legacy-ambiguous-replacement'),{code:'billing_pending'});return;
    }
    assert.equal(f.app.store.db.prepare('SELECT current_checkout_operation_id FROM justup_billing_accounts').get().current_checkout_operation_id,replacement.body.operation.id);
    const proof=f.app.store.db.prepare('SELECT resource_id,url FROM justup_billing_operations WHERE id=?').get(replacement.body.operation.id);assert.ok(proof.resource_id);assert.equal(proof.url,null);
  }
  f.api.handleWebhook(f.notification('evt_UnseenOld',canceled));assert.equal((await f.work()).result.status,'succeeded');
  if(!restart)paidReplacement();
  f.api.handleWebhook(f.notification('evt_NewSubscription'));assert.equal((await f.work()).result.status,'succeeded');
  assert.equal(f.app.store.db.prepare('SELECT subscription_id FROM justup_billing_accounts').get().subscription_id,'sub_Replacement');
  assert.equal(f.app.auth.session(f.owner.token).access.kind,'paid');
});

test('password-confirmed deletion retries the same termination record after three crashed task leases',async t=>{
  const f=await fixture(t);f.start();await f.work();
  await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});
  const original=f.app.store.db.prepare("SELECT * FROM justup_billing_operations WHERE kind='terminate'").get();
  for(let attempt=0;attempt<3;attempt++){
    const task=f.app.tasks.claim({workerId:`crash-${attempt}`,kinds:['billing_terminate'],leaseMs:1000});assert.ok(task);f.advance(1001);f.app.tasks.recover();
  }
  assert.equal(f.app.tasks.get(f.owner.account.id,original.task_id).status,'failed');f.advance(5001);f.queue.reconcileCompletedTasks?.();
  await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});
  const retried=f.app.store.db.prepare("SELECT * FROM justup_billing_operations WHERE kind='terminate'").get();
  assert.equal(retried.id,original.id);assert.notEqual(retried.task_id,original.task_id);
  assert.equal((await f.work()).result.status,'succeeded');assert.deepEqual(await f.app.auth.deleteAccount(f.owner.token,PASSWORD),{deleted:true});
});

for(const capacity of ['owner','global'])test(`ordinary ${capacity} operation capacity cannot block billing closure`,async t=>{
  const f=await fixture(t);f.start();await f.work();
  const db=f.app.store.db;
  if(capacity==='owner'){
    for(let index=0;index<31;index++){f.api.handleBilling(f.ctx({requestKey:`capacity-${index}`},'/account/billing/reconcile'));await f.work();}
  }else{
    const others=[];for(let index=0;index<4;index++)others.push(await f.app.auth.register({username:`other-capacity-${index}`,password:PASSWORD}));
    const source=db.prepare('SELECT * FROM justup_billing_operations LIMIT 1').get(),columns=Object.keys(source);
    const insert=db.prepare(`INSERT INTO justup_billing_operations(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`);
    for(let index=0;index<127;index++)insert.run(...columns.map(column=>column==='id'?`capacity-${index}`:column==='account_id'?others[Math.floor(index/32)].account.id:column==='request_key'?`capacity-${index}`:column==='task_id'?null:source[column]));
  }
  const before=db.prepare("SELECT count(*) n FROM justup_billing_operations WHERE kind<>'terminate'").get().n;
  await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});
  assert.equal(db.prepare('SELECT closing_revision FROM justup_billing_accounts WHERE account_id=?').get(f.owner.account.id).closing_revision,1);
  assert.equal(db.prepare("SELECT count(*) n FROM justup_billing_operations WHERE kind<>'terminate'").get().n,before);
  assert.equal((await f.work()).result.status,'succeeded');assert.deepEqual(await f.app.auth.deleteAccount(f.owner.token,PASSWORD),{deleted:true});
});

test('expired customer mutation recovery never repeats an unsafe creation or permits deletion',async t=>{
  let f,first=true;
  f=await fixture(t,{hooks:{customer:()=>{if(first){first=false;f.state.customer.id='cus_UnknownOriginal';f.advance(24*3_600_000+1001);throw new Error('synthetic response lost after remote mutation');}}}});
  const checkout=f.start();const task=f.app.tasks.claim({workerId:'crashed-checkout',kinds:['billing_checkout'],leaseMs:1000});
  assert.equal((await f.queue.runTask(task)).status,'failed');
  assert.equal(f.app.store.db.prepare('SELECT customer_id FROM justup_billing_accounts').get().customer_id,null);
  f.state.customer=null;f.api.refreshAvailability();f.app.tasks.recover();
  assert.equal((await f.work()).result.status,'failed');assert.equal(f.state.customerKeys.length,1);
  const row=f.app.store.db.prepare('SELECT * FROM justup_billing_operations WHERE id=?').get(checkout.body.operation.id);
  assert.equal(row.status,'ambiguous');assert.equal(row.error_code,'billing_operator_reconciliation_required');
  f.advance(2*86_400_000);f.api.handleBilling(f.ctx(undefined,'/account/billing','GET'));
  assert.ok(f.app.store.db.prepare('SELECT id FROM justup_billing_operations WHERE id=?').get(row.id));
  await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});
  assert.equal((await f.work()).result.status,'failed');assert.equal(f.state.customerKeys.length,1);
  await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_unavailable'});
  assert.ok(f.app.auth.session(f.owner.token));assert.equal(f.app.store.db.prepare('SELECT termination_verified_at FROM justup_billing_accounts').get().termination_verified_at,null);
});


test('96 completed task receipts leave billing termination and exact history retries available',async t=>{
  const f=await fixture(t);f.start();await f.work();const receipts=retainSyntheticHistory(f,95),db=f.app.store.db;
  assert.equal(db.prepare('SELECT count(*) n FROM justup_tasks').get().n,96);
  assert.equal(db.prepare("SELECT count(*) n FROM justup_tasks WHERE status IN ('pending','running')").get().n,0);
  const before=db.prepare('SELECT * FROM justup_tasks ORDER BY id').all();
  await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});
  const termination=db.prepare("SELECT * FROM justup_billing_operations WHERE kind='terminate'").get();assert.ok(termination.task_id);
  assert.deepEqual(db.prepare('SELECT * FROM justup_tasks WHERE id<>? ORDER BY id').all(termination.task_id),before);
  for(const receipt of receipts)assert.equal(f.app.tasks.enqueue(receipt.input).id,receipt.id);
  assert.equal((await f.work()).result.status,'succeeded');assert.deepEqual(await f.app.auth.deleteAccount(f.owner.token,PASSWORD),{deleted:true});
  for(const receipt of receipts)assert.equal(f.app.tasks.get(receipt.input.ownerId,receipt.id).status,'succeeded');
});

test('2048 fresh terminal receipts retain evidence while first deletion gets bounded termination progress',async t=>{
  const f=await fixture(t);f.start();await f.work();retainSyntheticHistory(f,2047);const db=f.app.store.db;
  assert.equal(db.prepare('SELECT count(*) n FROM justup_tasks').get().n,2048);
  assert.equal(db.prepare("SELECT count(*) n FROM justup_tasks WHERE status IN ('pending','running')").get().n,0);
  const before=db.prepare('SELECT * FROM justup_tasks ORDER BY id').all(),calls=f.state.calls.length;
  await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});
  const reserved=db.prepare("SELECT * FROM justup_billing_operations WHERE kind='terminate'").get();
  assert.equal(db.prepare('SELECT closing_revision FROM justup_billing_accounts').get().closing_revision,1);
  assert.equal(db.prepare('SELECT termination_verified_at FROM justup_billing_accounts').get().termination_verified_at,null);
  assert.ok(f.app.auth.session(f.owner.token));assert.equal(f.app.auth.session(f.owner.token).access.fullAccess,false);
  assert.equal(f.state.calls.length,calls);assert.throws(()=>f.start('closed-at-retained-cap'),{code:'billing_termination_pending'});
  assert.deepEqual(db.prepare('SELECT * FROM justup_tasks WHERE id<>? ORDER BY id').all(reserved.task_id??''),before);
  assert.ok(reserved.task_id,'fresh ordinary receipts must leave bounded billing-termination progress');
  assert.equal((await f.work()).result.status,'succeeded');assert.deepEqual(await f.app.auth.deleteAccount(f.owner.token,PASSWORD),{deleted:true});
});

test('96 active tasks keep billing closed and its single termination reservation retryable',async t=>{
  const f=await fixture(t);f.start();await f.work();
  const active=f.app.tasks.enqueue({ownerId:f.owner.account.id,kind:'synthetic_foreground',requestKey:'active',payload:{}});
  const claim=f.app.tasks.claim({workerId:'active-worker',kinds:['synthetic_foreground'],leaseMs:90_000});assert.equal(claim.id,active.id);
  for(let index=0;index<95;index++)f.app.tasks.enqueue({ownerId:`synthetic-owner-${index}`,kind:'synthetic_foreground',requestKey:`capacity-${index}`,payload:{}});
  assert.equal(f.app.store.db.prepare("SELECT count(*) n FROM justup_tasks WHERE status IN ('pending','running')").get().n,96);
  await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});
  const reserved=f.app.store.db.prepare("SELECT * FROM justup_billing_operations WHERE kind='terminate'").get();assert.equal(reserved.task_id,null);
  assert.equal(f.app.store.db.prepare('SELECT closing_revision FROM justup_billing_accounts').get().closing_revision,1);
  assert.throws(()=>f.start('closed'),{code:'billing_termination_pending'});
  assert.equal(f.app.tasks.get(f.owner.account.id,claim.id).leaseToken,claim.leaseToken);
  assert.equal(f.app.tasks.complete(claim.id,claim.leaseToken,{status:'succeeded',output:{released:true}}),true);f.advance(5001);
  await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});
  const retry=f.app.store.db.prepare("SELECT * FROM justup_billing_operations WHERE kind='terminate'").get();assert.equal(retry.id,reserved.id);assert.ok(retry.task_id);
  assert.equal((await f.work()).result.status,'succeeded');assert.deepEqual(await f.app.auth.deleteAccount(f.owner.token,PASSWORD),{deleted:true});
});

test('termination retry preserves a live task lease and requires the current password-confirmed session',async t=>{
  const f=await fixture(t);f.start();await f.work();
  await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});
  const task=f.app.tasks.claim({workerId:'live-termination',kinds:['billing_terminate'],leaseMs:90_000});f.advance(5001);
  await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});
  assert.equal(f.app.tasks.get(f.owner.account.id,task.id).leaseToken,task.leaseToken);
  f.app.auth.invalidateAllSessions();
  await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'unauthenticated'});
  assert.equal(f.app.tasks.get(f.owner.account.id,task.id).leaseToken,task.leaseToken);
});


test('checkout replacement requires authoritative expiry instead of a hosted URL deadline',async t=>{
  const f=await fixture(t);const original=f.start();await f.work();f.advance(32*60_000);
  assert.throws(()=>f.start('unresolved-replacement'),{code:'billing_pending'});
  assert.equal(f.api.handleBilling(f.ctx(undefined,'/account/billing','GET')).body.billing.canCheckout,false);
  f.state.checkouts[0].status='expired';f.api.handleBilling(f.ctx({requestKey:'verify-expired'},'/account/billing/reconcile'));assert.equal((await f.work()).result.status,'succeeded');
  assert.equal(f.app.store.db.prepare('SELECT resource_kind FROM justup_billing_operations WHERE id=?').get(original.body.operation.id).resource_kind,'expired_checkout');
  assert.equal(f.api.handleBilling(f.ctx(undefined,'/account/billing','GET')).body.billing.canCheckout,true);
  assert.equal(f.start('resolved-replacement').status,202);
});


test('an expired replacement checkout clears the prior subscription pause before another checkout',async t=>{
  const f=await fixture(t);f.start();await f.work();f.paid();
  const period={start:f.now()/1000-604740,end:f.now()/1000+60};
  Object.assign(f.state.subscription.items.data[0],{current_period_start:period.start,current_period_end:period.end});f.state.invoice.lines.data[0].period=period;
  f.api.handleWebhook(f.notification());await f.work();f.state.subscription.status='canceled';f.api.handleWebhook(f.notification('evt_CanceledForExpiry'));await f.work();
  f.advance(32*60_000);f.start('expires-without-payment');await f.work();f.state.checkouts[0].status='expired';f.advance(32*60_000);
  f.api.handleBilling(f.ctx({requestKey:'verify-replacement-expiry'},'/account/billing/reconcile'));assert.equal((await f.work()).result.status,'succeeded');
  assert.equal(f.app.auth.session(f.owner.token).access.kind,'expired');
  assert.equal(f.start('after-proven-expiry').status,202);
});


test('settled replacement retires prior reservations so a third checkout remains possible',async t=>{
  const f=await fixture(t);f.start();await f.work();
  function shortPaid(){f.paid();const period={start:f.now()/1000-604740,end:f.now()/1000+60};Object.assign(f.state.subscription.items.data[0],{current_period_start:period.start,current_period_end:period.end});f.state.invoice.lines.data[0].period=period;}
  shortPaid();f.api.handleWebhook(f.notification());await f.work();f.state.subscription.status='canceled';f.api.handleWebhook(f.notification('evt_FirstCanceled'));await f.work();f.advance(32*60_000);
  f.start('second-generation');await f.work();shortPaid();
  for(const name of ['subscription','invoice','intent','charge','checkouts'])f.state[name]=JSON.parse(JSON.stringify(f.state[name]).replaceAll('sub_Owner','sub_Second').replaceAll('in_Paid','in_Second').replaceAll('pi_Owner','pi_Second').replaceAll('ch_Owner','ch_Second'));
  f.api.handleWebhook(f.notification('evt_SecondPaid'));assert.equal((await f.work()).result.status,'succeeded');
  const first=f.app.store.db.prepare('SELECT status,reconcile_pending FROM access_subscriptions WHERE subscription_hash=?').get(hash('subscription:sub_Owner'));
  assert.deepEqual({...first},{status:'ended',reconcile_pending:0});
  f.state.subscription.status='canceled';f.api.handleWebhook(f.notification('evt_SecondCanceled'));await f.work();f.advance(32*60_000);
  assert.equal(f.app.auth.session(f.owner.token).access.kind,'expired');assert.equal(f.start('third-generation').status,202);
});

test('a checkout that failed before a mutation can reconcile its prior binding and retry safely',async t=>{
  const f=await fixture(t);f.start();await f.work();f.paid();const period={start:f.now()/1000-604740,end:f.now()/1000+60};
  Object.assign(f.state.subscription.items.data[0],{current_period_start:period.start,current_period_end:period.end});f.state.invoice.lines.data[0].period=period;
  f.api.handleWebhook(f.notification());await f.work();f.state.subscription.status='canceled';f.api.handleWebhook(f.notification('evt_PreMutationCanceled'));await f.work();f.advance(32*60_000);
  f.state.unavailable=true;const failed=f.start('failed-before-price');assert.equal((await f.work()).result.status,'failed');f.state.unavailable=false;
  const before=f.state.calls.filter(name=>name==='checkout-create').length;
  f.api.handleBilling(f.ctx({requestKey:'resolve-no-mutation'},'/account/billing/reconcile'));assert.equal((await f.work()).result.status,'succeeded');
  assert.equal(f.state.calls.filter(name=>name==='checkout-create').length,before);
  assert.equal(f.app.store.db.prepare('SELECT resource_kind FROM justup_billing_operations WHERE id=?').get(failed.body.operation.id).resource_kind,'unstarted_checkout');
  assert.equal(f.app.auth.session(f.owner.token).access.kind,'expired');assert.equal(f.start('safe-after-price-failure').status,202);
});


for(const legacy of ['single','unknown_customer','unknown_customer_failed','missing_history'])test(`legacy ${legacy} ownership requires the corresponding current provider proof`,async t=>{
  const directory=mkdtempSync(join(tmpdir(),'justup-billing-legacy-')),backupDir=join(directory,'backups'),privateGenerationPath=join(directory,'private-generation');
  mkdirSync(backupDir,{mode:0o700});writeFileSync(privateGenerationPath,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n',{mode:0o600});t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const f=await fixture(t,{storage:{dbPath:join(directory,'billing.sqlite'),backupDir,privateGenerationPath},hooks:legacy==='single'?{}:{customer:()=>{throw new Error('synthetic lost customer response');}}});
  const first=f.start();await f.work();
  if(legacy==='single')f.paid();
  else if(legacy==='unknown_customer_failed'){
    f.advance(24*3_600_000);f.app.store.db.prepare("UPDATE justup_billing_operations SET status='failed' WHERE id=?").run(first.body.operation.id);
    f.app.store.db.prepare('UPDATE justup_billing_accounts SET closing_revision=1,termination_revision=1,termination_verified_at=?').run(f.now());
  }else if(legacy==='unknown_customer'){
    f.advance(24*3_600_000);f.state.customer.id='cus_SecondUnknown';
    f.app.store.db.prepare('UPDATE justup_billing_accounts SET customer_id=?').run(f.state.customer.id);
  }else{
    const operation=f.app.store.db.prepare('SELECT task_id FROM justup_billing_operations WHERE id=?').get(first.body.operation.id);
    f.app.tasks.delete(f.owner.account.id,operation.task_id);f.app.store.db.prepare('DELETE FROM justup_billing_operations WHERE id=?').run(first.body.operation.id);
  }
  f.app.store.db.exec('ALTER TABLE justup_billing_accounts DROP COLUMN current_checkout_operation_id');await f.reopen();
  if(legacy==='single'){
    f.api.handleWebhook(f.notification('evt_LegacySingle'));assert.equal((await f.work()).result.status,'succeeded');assert.equal(f.app.auth.session(f.owner.token).access.kind,'paid');
  }else{
    const before=f.state.customerKeys.length;
    await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});
    assert.equal((await f.work()).result.errorCode,'billing_operator_reconciliation_required');assert.equal(f.state.customerKeys.length,before);
    await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_unavailable'});
    assert.ok(f.app.auth.session(f.owner.token));assert.equal(f.app.store.db.prepare('SELECT termination_verified_at FROM justup_billing_accounts').get().termination_verified_at,null);
  }
});


async function durableFixture(t,options={}){
  const directory=mkdtempSync(join(tmpdir(),'justup-billing-receipt-')),backupDir=join(directory,'backups'),privateGenerationPath=join(directory,'private-generation');
  mkdirSync(backupDir,{mode:0o700});writeFileSync(privateGenerationPath,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n',{mode:0o600});
  const f=await fixture(t,{...options,storage:{...options.storage,dbPath:join(directory,'billing.sqlite'),backupDir,privateGenerationPath}});t.after(()=>rmSync(directory,{recursive:true,force:true}));
  return {f,backupDir,privateGenerationPath};
}

for(const recovery of ['startup','beforeClaim','observed','committed'])test(`terminal completion ${recovery} is released only by protected API cleanup`,async t=>{
  const observed=['observed','committed'].includes(recovery);
  const {f,backupDir,privateGenerationPath}=await durableFixture(t);f.start();await f.work();
  await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});
  const op=f.app.store.db.prepare("SELECT * FROM justup_billing_operations WHERE kind='terminate'").get();let finished=0;
  const handler=recovery==='committed'?async(task,options)=>{const result=await f.queue.runTask(task,options);assert.equal(f.app.tasks.complete(task.id,task.leaseToken,{status:result.status,output:result.output??null,errorCode:result.errorCode??null}),true);return {...result,committed:true};}:undefined;
  const runner=f.realRunner({observe:observed,handler,onFinished:task=>{finished++;assert.equal(f.app.tasks.get(task.ownerId,task.id).status,'succeeded');}});
  assert.equal(await runner.runOnce(),true);assert.equal(finished,1);assert.ok(f.app.tasks.get(f.owner.account.id,op.task_id));
  assert.equal(f.app.store.db.prepare('SELECT resource_kind FROM justup_billing_operations WHERE id=?').get(op.id).resource_kind,observed?'termination_receipt':null);
  const generation=readFileSync(privateGenerationPath,'utf8');writeFileSync(join(backupDir,'before-release.sqlite'),'synthetic retained backup',{mode:0o600});
  if(!observed){f.api.cleanup();assert.ok(f.app.tasks.get(f.owner.account.id,op.task_id));assert.equal(readFileSync(privateGenerationPath,'utf8'),generation);}
  if(recovery==='beforeClaim')assert.equal(await f.realRunner().runOnce(),false);else if(recovery!=='committed')await f.reopen();
  if(!observed){assert.ok(f.app.tasks.get(f.owner.account.id,op.task_id));assert.equal(readFileSync(privateGenerationPath,'utf8'),generation);}
  f.api.cleanup();assert.equal(f.app.tasks.get(f.owner.account.id,op.task_id),null);
  assert.equal(f.app.store.db.prepare('SELECT task_id FROM justup_billing_operations WHERE id=?').get(op.id).task_id,null);
  assert.notEqual(readFileSync(privateGenerationPath,'utf8'),generation);assert.equal(existsSync(join(backupDir,'before-release.sqlite')),false);assert.equal(existsSync(`${privateGenerationPath}.pending`),false);
  assert.ok(f.app.auth.session(f.owner.token));assert.deepEqual(await f.app.auth.deleteAccount(f.owner.token,PASSWORD),{deleted:true});f.app.afterPrivateTransaction();
});

test('more than sixteen completed termination cycles reuse the reserve while final DELETE is delayed',async t=>{
  const f=await fixture(t);f.start();await f.work();const runner=f.realRunner();let canonical;
  for(let cycle=0;cycle<18;cycle++){
    await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});
    const op=f.app.store.db.prepare("SELECT * FROM justup_billing_operations WHERE kind='terminate'").get();
    canonical??=op;assert.equal(op.id,canonical.id);assert.equal(op.created_at,canonical.created_at);
    assert.equal(await runner.runOnce(),true);assert.ok(f.app.tasks.get(f.owner.account.id,op.task_id));
    f.api.cleanup();assert.equal(f.app.tasks.get(f.owner.account.id,op.task_id),null);
    assert.equal(f.app.store.db.prepare("SELECT count(*) n FROM justup_tasks WHERE kind='billing_terminate'").get().n,0);
    assert.ok(f.app.auth.session(f.owner.token));if(cycle<17)f.advance(31_001);
  }
  assert.equal(f.state.terminationKeys[0],`justup/${canonical.id}/expire:cs_test_Owner`);
  assert.deepEqual(await f.app.auth.deleteAccount(f.owner.token,PASSWORD),{deleted:true});
});

test('failed terminal outcomes are absorbed without deletion authority and retries keep the original mutation keys',async t=>{
  let failures=2;const f=await fixture(t,{hooks:{expire:()=>{if(failures-->0)throw Error('synthetic response unavailable');}}});f.start();await f.work();const runner=f.realRunner();let canonical;
  for(let attempt=0;attempt<3;attempt++){
    await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});
    const op=f.app.store.db.prepare("SELECT * FROM justup_billing_operations WHERE kind='terminate'").get();canonical??=op;
    assert.equal(op.id,canonical.id);assert.equal(op.created_at,canonical.created_at);assert.equal(await runner.runOnce(),true);f.api.cleanup();
    assert.equal(f.app.store.db.prepare("SELECT count(*) n FROM justup_tasks WHERE kind='billing_terminate'").get().n,0);
    if(attempt<2){assert.equal(f.app.store.db.prepare('SELECT termination_verified_at FROM justup_billing_accounts').get().termination_verified_at,null);assert.ok(f.app.auth.session(f.owner.token));f.advance(5001);}
  }
  assert.equal(f.state.terminationKeys.length,3);assert.ok(f.state.terminationKeys.every(value=>value===f.state.terminationKeys[0]));
  assert.deepEqual(await f.app.auth.deleteAccount(f.owner.token,PASSWORD),{deleted:true});
});

for(const mismatch of ['output','operation','owner','error','canonical_resource'])test(`unabsorbed ${mismatch} evidence retains its cleanup receipt and original operation pointer`,async t=>{
  const f=await fixture(t);f.start();await f.work();await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});
  const op=f.app.store.db.prepare("SELECT * FROM justup_billing_operations WHERE kind='terminate'").get(),task=f.app.tasks.claim({workerId:'unknown-result',kinds:['billing_terminate'],leaseMs:90_000});
  if(mismatch==='canonical_resource')f.app.store.db.prepare("UPDATE justup_billing_operations SET resource_kind='unabsorbed_mutation',resource_id='retained-unknown-evidence' WHERE id=?").run(op.id);
  if(mismatch==='operation')f.app.store.db.prepare('UPDATE justup_tasks SET payload_json=? WHERE id=?').run(JSON.stringify({...task.payload,operationId:'unowned-operation'}),task.id);
  if(mismatch==='owner')f.app.store.db.prepare('UPDATE justup_tasks SET owner_id=? WHERE id=?').run('unowned-account',task.id);
  assert.equal(f.app.tasks.complete(task.id,task.leaseToken,{status:'failed',output:mismatch==='output'?{unknownMutation:'only-in-task'}:null,errorCode:mismatch==='error'?'unknown_provider_mutation':'provider_unavailable'}),true);
  f.queue.taskFinished?.(task);f.queue.reconcileCompletedTasks?.();f.api.cleanup();
  assert.ok(f.app.store.db.prepare('SELECT 1 FROM justup_tasks WHERE id=?').get(task.id));assert.equal(f.app.tasks.delete(mismatch==='owner'?'unowned-account':task.ownerId,task.id),false);
  f.advance(5001);await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});
  const after=f.app.store.db.prepare('SELECT * FROM justup_billing_operations WHERE id=?').get(op.id);assert.equal(after.task_id,task.id);assert.equal(after.attempt,op.attempt);assert.equal(after.created_at,op.created_at);
  if(mismatch==='canonical_resource')assert.equal(after.resource_id,'retained-unknown-evidence');
  assert.equal(f.app.store.db.prepare("SELECT count(*) n FROM justup_tasks WHERE kind='billing_terminate'").get().n,1);
  assert.equal(f.app.store.db.prepare('SELECT termination_verified_at FROM justup_billing_accounts').get().termination_verified_at,null);
});

test('protected release and final deleteOwner roll back with the private deletion barrier',async t=>{
  const {f,privateGenerationPath}=await durableFixture(t);f.start();await f.work();await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});
  const op=f.app.store.db.prepare("SELECT * FROM justup_billing_operations WHERE kind='terminate'").get();await f.realRunner().runOnce();
  const generation=readFileSync(privateGenerationPath,'utf8');writeFileSync(`${privateGenerationPath}.pending`,'synthetic foreign deletion marker',{mode:0o600});
  await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD));
  assert.ok(f.app.tasks.get(f.owner.account.id,op.task_id));assert.equal(f.app.store.db.prepare('SELECT task_id FROM justup_billing_operations WHERE id=?').get(op.id).task_id,op.task_id);assert.equal(readFileSync(privateGenerationPath,'utf8'),generation);
  unlinkSync(`${privateGenerationPath}.pending`);f.api.cleanup();assert.equal(f.app.tasks.get(f.owner.account.id,op.task_id),null);
  const owned=f.app.tasks.enqueue({ownerId:f.owner.account.id,kind:'synthetic_private',requestKey:'rollback-delete-owner',payload:{}}),original=f.app.tasks.deleteOwner;
  f.app.tasks.deleteOwner=owner=>{original(owner);throw Error('synthetic private deletion rollback');};
  await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD));
  assert.ok(f.app.auth.session(f.owner.token));assert.ok(f.app.tasks.get(f.owner.account.id,owned.id));assert.ok(f.app.store.db.prepare('SELECT 1 FROM justup_billing_accounts WHERE account_id=?').get(f.owner.account.id));
  f.app.afterPrivateTransaction();f.app.tasks.deleteOwner=original;assert.deepEqual(await f.app.auth.deleteAccount(f.owner.token,PASSWORD),{deleted:true});f.app.afterPrivateTransaction();
  assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM justup_tasks WHERE owner_id=?').get(f.owner.account.id).n,0);assert.equal(existsSync(`${privateGenerationPath}.pending`),false);
});


test('committed provider proof cannot erase a running or not-yet-observed terminal cleanup receipt',async t=>{
  const f=await fixture(t);f.start();await f.work();await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});
  const task=f.app.tasks.claim({workerId:'commit-before-observation',kinds:['billing_terminate'],leaseMs:90_000}),result=await f.queue.runTask(task);
  assert.equal(result.status,'succeeded');assert.equal(f.app.store.db.prepare('SELECT termination_verified_at FROM justup_billing_accounts').get().termination_verified_at,f.now());
  await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});assert.equal(f.app.tasks.get(task.ownerId,task.id).status,'running');
  assert.equal(f.app.tasks.complete(task.id,task.leaseToken,{status:'succeeded',output:null}),true);
  await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});assert.ok(f.app.tasks.get(task.ownerId,task.id));
  assert.equal(f.api.handleBilling(f.ctx(undefined,'/account/billing','GET')).body.billing.termination.status,'pending');
  f.queue.taskFinished(task);f.api.cleanup();assert.equal(f.app.tasks.get(task.ownerId,task.id),null);assert.deepEqual(await f.app.auth.deleteAccount(f.owner.token,PASSWORD),{deleted:true});
});

test('unabsorbed successful cleanup evidence survives 31 days and cannot be overridden by provider proof',async t=>{
  const f=await fixture(t,{storage:{sessionTtlMs:40*86_400_000}});f.start();await f.work();await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});
  const op=f.app.store.db.prepare("SELECT * FROM justup_billing_operations WHERE kind='terminate'").get();
  const runner=f.realRunner({handler:async(task,options)=>({...await f.queue.runTask(task,options),output:{unknownMutation:'only-in-receipt'}})});assert.equal(await runner.runOnce(),true);
  assert.equal(f.app.store.db.prepare('SELECT termination_verified_at FROM justup_billing_accounts').get().termination_verified_at,f.now());
  await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});assert.ok(f.app.tasks.get(f.owner.account.id,op.task_id));
  f.advance(31*86_400_000);f.api.refreshAvailability();f.app.tasks.enqueue({ownerId:'retention-probe',kind:'synthetic_retention_probe',requestKey:'after-31-days',payload:{}});
  assert.equal(f.app.store.db.prepare("SELECT count(*) n FROM justup_tasks WHERE kind='billing_checkout'").get().n,0);
  f.queue.reconcileCompletedTasks();f.api.cleanup();const retained=f.app.tasks.get(f.owner.account.id,op.task_id);assert.deepEqual(retained.output,{unknownMutation:'only-in-receipt'});
  await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});assert.ok(f.app.auth.session(f.owner.token));
  assert.equal(f.app.store.db.prepare('SELECT task_id,created_at FROM justup_billing_operations WHERE id=?').get(op.id).task_id,op.task_id);
});


test('billing completion hooks preserve the Wire pre-claim fence and survive a records callback failure',async t=>{
  const f=await fixture(t);f.start();await f.work();await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});
  const op=f.app.store.db.prepare("SELECT * FROM justup_billing_operations WHERE kind='terminate'").get(),events=[];
  const blocked=createRunner({tasks:f.app.tasks,handlers:{billing_terminate:f.queue.runTask},...createBillingRunnerHooks({billing:{taskFinished:()=>events.push('billing'),reconcileCompletedTasks:()=>events.push('billing-maintenance')},onTaskFinished:()=>events.push('records'),beforeClaim:async()=>{events.push('wire');throw Error('synthetic Wire fence');}})});
  await assert.rejects(blocked.runOnce(),/synthetic Wire fence/);assert.deepEqual(events,['wire']);assert.equal(f.app.tasks.get(f.owner.account.id,op.task_id).attempts,0);
  const hooks=createBillingRunnerHooks({billing:{taskFinished:task=>{events.push('billing');f.queue.taskFinished(task);},reconcileCompletedTasks:()=>f.queue.reconcileCompletedTasks()},onTaskFinished:()=>{events.push('records');throw Error('synthetic records failure');},beforeClaim:async()=>{events.push('wire');}});
  const runner=createRunner({tasks:f.app.tasks,handlers:{billing_terminate:f.queue.runTask},...hooks});assert.equal(await runner.runOnce(),true);assert.deepEqual(events,['wire','wire','records','billing']);
  assert.ok(f.app.tasks.get(f.owner.account.id,op.task_id));f.api.cleanup();assert.equal(f.app.tasks.get(f.owner.account.id,op.task_id),null);
});


for(const observed of [false,true])test(`restore after successful termination ${observed?'observation':'completion before observation'} releases known receipt but requires fresh provider proof`,async t=>{
  const f=await fixture(t);f.start();await f.work();await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});
  const original=f.app.store.db.prepare("SELECT * FROM justup_billing_operations WHERE kind='terminate'").get();assert.equal(await f.realRunner({observe:observed}).runOnce(),true);
  assert.ok(f.app.tasks.get(f.owner.account.id,original.task_id));f.app.auth.invalidateAllSessions();
  const signed=await f.app.auth.login({username:'person',password:PASSWORD});f.owner.token=signed.token;f.advance(5001);f.api.refreshAvailability();
  f.queue.reconcileCompletedTasks();f.api.cleanup();
  assert.equal(f.app.tasks.get(f.owner.account.id,original.task_id),null);
  const invalidated=f.app.store.db.prepare('SELECT termination_revision,termination_verified_at FROM justup_billing_accounts').get();assert.deepEqual({...invalidated},{termination_revision:null,termination_verified_at:null});
  assert.equal(f.api.handleBilling(f.ctx(undefined,'/account/billing','GET')).body.billing.termination.status,'pending');assert.ok(f.app.auth.session(f.owner.token));
  await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});
  const retry=f.app.store.db.prepare("SELECT * FROM justup_billing_operations WHERE kind='terminate'").get();assert.equal(retry.id,original.id);assert.equal(retry.created_at,original.created_at);assert.notEqual(retry.task_id,original.task_id);assert.ok(retry.task_id);
  assert.equal(f.app.store.db.prepare('SELECT termination_verified_at FROM justup_billing_accounts').get().termination_verified_at,null);
  const reads=f.state.calls.length;assert.equal(await f.realRunner().runOnce(),true);assert.ok(f.state.calls.length>reads);assert.equal(f.app.store.db.prepare('SELECT termination_verified_at FROM justup_billing_accounts').get().termination_verified_at,f.now());
  assert.deepEqual(await f.app.auth.deleteAccount(f.owner.token,PASSWORD),{deleted:true});f.app.afterPrivateTransaction();
});


test('an unexpected canonical task kind cannot erase its unknown output through final deletion',async t=>{
  const f=await fixture(t);f.start();await f.work();await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});
  const op=f.app.store.db.prepare("SELECT * FROM justup_billing_operations WHERE kind='terminate'").get();assert.equal(await f.realRunner().runOnce(),true);
  f.app.store.db.prepare('UPDATE justup_tasks SET kind=?,output_json=? WHERE id=?').run('synthetic_unexpected',JSON.stringify({unknownMutation:'canonical-task-only'}),op.task_id);
  f.queue.reconcileCompletedTasks();f.api.cleanup();
  await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});
  assert.deepEqual(f.app.tasks.get(f.owner.account.id,op.task_id).output,{unknownMutation:'canonical-task-only'});assert.ok(f.app.auth.session(f.owner.token));
  f.advance(5001);await assert.rejects(f.app.auth.deleteAccount(f.owner.token,PASSWORD),{code:'billing_termination_pending'});
  const unchanged=f.app.store.db.prepare('SELECT task_id,attempt FROM justup_billing_operations WHERE id=?').get(op.id);assert.equal(unchanged.task_id,op.task_id);assert.equal(unchanged.attempt,op.attempt);
});
