// Real SQLite/auth/task contracts; every Stripe response is a local synthetic
// object. No test credentials, provider request or hosted page is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {createApplication} from './main.mjs';
import {createAuth} from './auth.mjs';
import {createStripeBillingRunner,validateStripeBillingConfig} from './stripe-billing.mjs';
import {STRIPE_API_VERSION} from './account-provider-clients.mjs';

const PASSWORD='a sufficiently long password';
const ORIGIN='https://preview.justup.work';
const offers={weekly:{priceId:'price_Weekly',currency:'usd',amount:100},monthly:{priceId:'price_Monthly',currency:'usd',amount:400}};
const list=data=>({object:'list',has_more:false,data});
const hash=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t,{storage={},hooks={}}={}) {
  let at=Date.parse('2026-11-01T15:00:00.000Z');const now=()=>at;
  const base={enabled:true,accountId:'acct_Sandbox',offers,portalConfigurationId:'bpc_Justup',origin:ORIGIN};
  const config={dbPath:':memory:',sourceCommit:'a'.repeat(40),buildIdentity:'b'.repeat(64),csrfSecret:'c'.repeat(32),
    allowedOrigin:ORIGIN,privacyUrl:`${ORIGIN}/privacy.html`,usageUrl:`${ORIGIN}/usage.html`,policiesReviewed:true,policyVersion:'test-v1',requiresInvitation:false,
    stripeBilling:{...base,webhookSecret:'whsec_synthetic_endpoint_secret_value'},readiness:()=>({capabilities:{stripeBilling:true}}),...storage};
  const app=await createApplication({config,now});t.after(()=>app.close());const api=app.services.find(service=>service.stripeBilling);
  const state={customer:null,checkouts:[],subscription:null,invoice:null,intent:null,charge:null,calls:[],customerKeys:[],unavailable:false};
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
    async retrieveSubscription(){called('subscription-read');await hooks.subscription?.();return structuredClone(state.subscription);},
    async retrieveInvoice(identifier){called('invoice-read');if(identifier==='in_Unpaid')return {id:identifier,object:'invoice',livemode:false,customer:'cus_Owner',status:'open'};return structuredClone(state.invoice);},
    async retrievePaymentIntent(){called('intent-read');return structuredClone(state.intent);},
    async retrieveCharge(){called('charge-read');return structuredClone(state.charge);},
    async listCheckouts(){called('checkout-list');return list(structuredClone(state.checkouts));},
    async listSubscriptions(){called('subscription-list');return list(state.subscription?[structuredClone(state.subscription)]:[]);},
    async expireCheckout(identifier){called('checkout-expire');const value=state.checkouts.find(value=>value.id===identifier);value.status='expired';return structuredClone(value);},
    async cancelSubscription(){called('subscription-cancel');state.subscription.status='canceled';return structuredClone(state.subscription);},
  };
  const queueConfig={...config,stripeBilling:{...base,apiKey:'rk_test_Synthetic'}};
  const queue=createStripeBillingRunner({db:app.store.db,tasks:app.tasks,config:queueConfig,now,client});
  const owner=await app.auth.register({username:'person',password:PASSWORD});
  app.store.db.prepare('INSERT INTO access_identities VALUES(?,?,NULL,?)').run(owner.account.id,hash('synthetic verified subject'),at);
  const ctx=(body,path='/account/billing/checkout',method='POST',person=owner)=>({method,path,url:new URL(`${ORIGIN}/api/v1${path}`),body,accountId:person.account.id,sessionHash:hash(person.token),interfaceLocale:'en'});
  const start=(requestKey='first')=>api.handleBilling(ctx({plan:'weekly',requestKey}));
  async function work(options){const task=app.tasks.claim({workerId:'test-worker',kinds:queue.kinds,leaseMs:90_000});assert.ok(task);const result=await queue.runTask(task,options);app.tasks.complete(task.id,task.leaseToken,{status:result.status,errorCode:result.errorCode??null,output:result.output??null});return {task,result};}
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
  return {app,api,queue,config,queueConfig,state,owner,ctx,start,work,paid,notification,now,advance:ms=>{at+=ms;}};
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
