// Provider-free Stripe object contracts use only synthetic IDs and fixed clocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stripeOffer,stripeEventReference,stripeHostedUrl,stripeCheckoutFields,stripePortalFields,
  stripeSettledPeriod,stripeEntitlementSnapshot,stripeTerminationReady,
} from './stripe-billing-protocol.mjs';

const AT = Date.parse('2026-11-01T12:00:00.000Z'), SECOND = AT/1000, WEEK = 7*86_400;
const prices = {weekly:'price_Weekly',monthly:'price_Monthly'};
const binding = {accountId:'local-account',customerId:'cus_Owner',subscriptionId:'sub_Owner',billingReference:'b'.repeat(43)};
const list = data => ({object:'list',has_more:false,data});
function fixture() {
  const price = {id:prices.weekly,object:'price',livemode:false,active:true,type:'recurring',billing_scheme:'per_unit',
    unit_amount:100,currency:'usd',custom_unit_amount:null,transform_quantity:null,
    recurring:{interval:'week',interval_count:1,usage_type:'licensed',trial_period_days:null}};
  const subscription = {id:binding.subscriptionId,object:'subscription',livemode:false,customer:binding.customerId,
    metadata:{justup_reference:binding.billingReference},collection_method:'charge_automatically',status:'active',cancel_at_period_end:false,
    application:null,on_behalf_of:null,transfer_data:null,latest_invoice:'in_Current',
    items:list([{id:'si_Owner',object:'subscription_item',subscription:binding.subscriptionId,quantity:1,price,
      current_period_start:SECOND-100,current_period_end:SECOND+WEEK-100}])};
  const invoice = {id:'in_Current',object:'invoice',livemode:false,customer:binding.customerId,status:'paid',currency:'usd',
    collection_method:'charge_automatically',billing_reason:'subscription_cycle',
    parent:{type:'subscription_details',subscription_details:{subscription:binding.subscriptionId}},
    amount_due:100,amount_paid:100,amount_remaining:0,pre_payment_credit_notes_amount:0,post_payment_credit_notes_amount:0,
    // These intentionally disagree with service dates and must not grant time.
    period_start:SECOND-60,period_end:SECOND+62*86_400,
    lines:list([{id:'il_Line',object:'line_item',livemode:false,quantity:1,amount:100,currency:'usd',
      parent:{type:'subscription_item_details',subscription_item_details:{subscription:binding.subscriptionId,subscription_item:'si_Owner',proration:false}},
      pricing:{type:'price_details',price_details:{price:prices.weekly}},period:{start:SECOND-100,end:SECOND+WEEK-100}}]),
    payments:list([{id:'inpay_Paid',object:'invoice_payment',livemode:false,status:'paid',invoice:'in_Current',amount_paid:100,currency:'usd',
      payment:{type:'payment_intent',payment_intent:'pi_Paid'}}])};
  const paymentIntent = {id:'pi_Paid',object:'payment_intent',livemode:false,customer:binding.customerId,status:'succeeded',currency:'usd',
    amount:100,amount_received:100,latest_charge:'ch_Paid',client_secret:'synthetic-not-to-be-projected'};
  const charge = {id:'ch_Paid',object:'charge',livemode:false,customer:binding.customerId,payment_intent:'pi_Paid',currency:'usd',amount:100,
    amount_captured:100,amount_refunded:0,paid:true,captured:true,refunded:false,disputed:false,status:'succeeded'};
  return {subscription,invoice,paymentIntent,charge,binding:structuredClone(binding),prices:{...prices},now:AT};
}

test('approved test prices expose their actual recurring offer and reject incompatible fixtures',()=>{
  const value=fixture().subscription.items.data[0].price;
  assert.deepEqual(stripeOffer(value,{plan:'weekly',prices}),{plan:'weekly',currency:'usd',amount:100,interval:'week'});
  for(const mutate of [p=>p.livemode=true,p=>p.id='price_Unapproved',p=>p.recurring.interval='year',p=>p.recurring.interval_count=2,
    p=>p.recurring.trial_period_days=7,p=>p.recurring.usage_type='metered',p=>p.active=false,p=>p.unit_amount=0,p=>p.unit_amount=0.5]) {
    const price=structuredClone(value);mutate(price);assert.throws(()=>stripeOffer(price,{plan:'weekly',prices}),{code:'billing_evidence_invalid'});
  }
  assert.throws(()=>stripeOffer(value,{plan:'weekly',prices:{weekly:prices.weekly,monthly:prices.weekly}}),{code:'billing_unavailable'});
});

test('webhook references ignore event time and owner metadata and reject cross-account or live resources',()=>{
  const value={id:'evt_Update',object:'event',livemode:false,type:'customer.subscription.updated',created:SECOND+999999,
    data:{object:{id:'sub_Owner',object:'subscription',livemode:false,customer:binding.customerId,metadata:{accountId:'attacker'}}}};
  assert.deepEqual(stripeEventReference(value,{accountId:'acct_Sandbox'}),{eventId:'evt_Update',kind:'subscription',resourceId:'sub_Owner',customerId:binding.customerId});
  value.created=1;assert.equal(stripeEventReference(value,{accountId:'acct_Sandbox'}).resourceId,'sub_Owner');
  assert.equal(stripeEventReference({...value,type:'customer.created'},{accountId:'acct_Sandbox'}),null);
  assert.equal(stripeEventReference({...value,type:'__proto__'},{accountId:'acct_Sandbox'}),null);
  for(const mutate of [v=>v.account='acct_Other',v=>v.context='acct_Organization',v=>v.livemode=true,
    v=>v.data.object.livemode=true,v=>v.data.object.object='customer']){
    const event=structuredClone(value);mutate(event);assert.throws(()=>stripeEventReference(event,{accountId:'acct_Sandbox'}));
  }
  assert.deepEqual(stripeEventReference({...value,type:'charge.dispute.created',data:{object:{id:'dp_Dispute',object:'dispute',livemode:false,charge:'ch_Paid'}}},
    {accountId:'acct_Sandbox'}),{eventId:'evt_Update',kind:'charge',resourceId:'ch_Paid',customerId:null});
});

test('hosted URLs and checkout fields cannot redirect to arbitrary or live sessions',()=>{
  const checkout='https://checkout.stripe.com/c/pay/cs_test_Owned#synthetic';
  assert.equal(stripeHostedUrl('checkout',checkout),checkout);
  for(const url of ['https://checkout.stripe.com.evil.example/c/pay/cs_test_Owned','https://checkout.stripe.com/c/pay/cs_live_Owned',
    'https://user@checkout.stripe.com/c/pay/cs_test_Owned','https://checkout.stripe.com/c/pay/cs_test_Owned?redirect=elsewhere',
    'http://checkout.stripe.com/c/pay/cs_test_Owned','https://billing.stripe.com/p/session?secret=live_abc'])assert.throws(()=>stripeHostedUrl('checkout',url));
  for(const url of ['https://billing.stripe.com/p/session/test_Synthetic','https://billing.stripe.com/p/session?secret=test_Synthetic'])assert.equal(stripeHostedUrl('portal',url),url);
  assert.throws(()=>stripeHostedUrl('portal','https://billing.stripe.com/p/session?secret=test_A&secret=test_B'));
  const args={plan:'weekly',prices,customerId:binding.customerId,billingReference:binding.billingReference,returnTo:'https://preview.example/',expiresAt:SECOND+1800,now:AT};
  const fields=stripeCheckoutFields(args);
  assert.equal(fields['line_items[0][price]'],prices.weekly);assert.equal(fields.mode,'subscription');
  assert.equal(fields.success_url,args.returnTo);assert.equal(fields.cancel_url,args.returnTo);
  assert.equal(fields['subscription_data[metadata][justup_reference]'],binding.billingReference);
  for(const change of [{returnTo:'https://preview.example/?token=private'},{returnTo:'https://preview.example/account'},
    {expiresAt:SECOND+1799},{expiresAt:SECOND+3600},{plan:'annual'},{customerId:'cus_../Other'}])assert.throws(()=>stripeCheckoutFields({...args,...change}));
  assert.deepEqual(stripePortalFields({customerId:binding.customerId,configurationId:'bpc_Approved',returnTo:args.returnTo}),
    {customer:binding.customerId,configuration:'bpc_Approved',return_url:args.returnTo});
});

test('settlement uses the actual service line and current successful unrefunded charge',()=>{
  const f=fixture(),period=stripeSettledPeriod(f);
  assert.deepEqual(period,{invoiceId:'in_Current',paidThroughAt:AT+(WEEK-100)*1000});
  const projected=stripeEntitlementSnapshot({...f,settledPeriods:[period],observedAt:AT});
  assert.deepEqual(projected,{accountId:binding.accountId,subscriptionId:binding.subscriptionId,observedAt:AT,status:'active',plan:'weekly',paidThroughAt:period.paidThroughAt});
  assert.equal(JSON.stringify(projected).includes('synthetic-not-to-be-projected'),false);
});

test('unpaid, out-of-band, refunded, disputed, mismatched and incomplete evidence cannot establish paid access',()=>{
  const cases={
    'wrong customer':f=>f.invoice.customer='cus_Other',
    'wrong subscription':f=>f.invoice.parent.subscription_details.subscription='sub_Other',
    'unpaid invoice':f=>{f.invoice.status='open';f.invoice.amount_paid=0;},
    'out of band paid':f=>f.invoice.payments=list([]),
    'credit note':f=>f.invoice.post_payment_credit_notes_amount=1,
    'refund':f=>{f.charge.refunded=true;f.charge.amount_refunded=100;},
    'partial refund':f=>f.charge.amount_refunded=1,
    'dispute':f=>f.charge.disputed=true,
    'uncaptured charge':f=>f.charge.captured=false,
    'wrong intent':f=>f.charge.payment_intent='pi_Other',
    'wrong amount':f=>f.paymentIntent.amount_received=99,
    'live charge':f=>f.charge.livemode=true,
    'unowned subscription':f=>f.subscription.metadata.justup_reference='other'.repeat(11),
    'extra item':f=>f.subscription.items.data.push(structuredClone(f.subscription.items.data[0])),
    'proration':f=>f.invoice.lines.data[0].parent.subscription_item_details.proration=true,
    'line mismatch':f=>f.invoice.lines.data[0].pricing.price_details.price=prices.monthly,
    'unread lines':f=>f.invoice.lines.has_more=true,
    'unread payments':f=>f.invoice.payments.has_more=true,
    'future service':f=>f.invoice.lines.data[0].period.start=SECOND+1,
    'service beyond current item':f=>f.invoice.lines.data[0].period.end+=1,
    'unbounded service':f=>f.invoice.lines.data[0].period.end=SECOND+63*86_400,
  };
  for(const [name,mutate] of Object.entries(cases)){const f=fixture();mutate(f);assert.throws(()=>stripeSettledPeriod(f),{code:'billing_evidence_invalid'},name);}
});

test('cancelled and past-due states retain only freshly verified settled periods, not event-suggested extensions',()=>{
  const f=fixture(),period=stripeSettledPeriod(f);
  f.subscription.cancel_at_period_end=true;
  assert.equal(stripeEntitlementSnapshot({...f,settledPeriods:[period],observedAt:AT}).status,'cancelled');
  f.subscription.status='past_due';f.subscription.latest_invoice='in_Unpaid';
  f.binding.settledInvoiceId='in_Current';
  const result=stripeEntitlementSnapshot({...f,settledPeriods:[period],observedAt:AT});
  assert.equal(result.status,'past_due');assert.equal(result.paidThroughAt,period.paidThroughAt);
  assert.equal(stripeEntitlementSnapshot({...f,settledPeriods:[],observedAt:AT}).paidThroughAt,null);
  assert.throws(()=>stripeEntitlementSnapshot({...f,settledPeriods:[{invoiceId:'in_Unrelated',paidThroughAt:period.paidThroughAt}],observedAt:AT}));
  f.subscription.status='unpaid';assert.equal(stripeEntitlementSnapshot({...f,settledPeriods:[period],observedAt:AT}).paidThroughAt,null);
});

test('billing termination requires current closure proof, complete owned lists and no ambiguous operation',()=>{
  const f=fixture(),proof={closureRevision:3,unresolvedOperations:0,verifiedAt:AT,
    customer:{id:binding.customerId,object:'customer',livemode:false,metadata:{justup_reference:binding.billingReference}},
    checkouts:list([{id:'cs_test_Owned',object:'checkout.session',livemode:false,customer:binding.customerId,status:'expired'}]),
    subscriptions:list([{...f.subscription,status:'canceled'}])};
  assert.equal(stripeTerminationReady({closingRevision:3,proof,binding,now:AT}),true);
  for(const mutate of [p=>p.closureRevision=2,p=>p.unresolvedOperations=1,p=>p.verifiedAt=AT-30_001,
    p=>p.checkouts.has_more=true,p=>p.subscriptions.has_more=true,p=>p.checkouts.data[0].status='open',
    p=>p.subscriptions.data[0].status='active',p=>p.customer.metadata.justup_reference='wrong',
    p=>p.subscriptions.data[0].customer='cus_Other',p=>p.checkouts.data[0].livemode=true]){
    const changed=structuredClone(proof);mutate(changed);assert.equal(stripeTerminationReady({closingRevision:3,proof:changed,binding,now:AT}),false);
  }
});
