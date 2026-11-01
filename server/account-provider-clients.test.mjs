// Fixed-host account provider protocol contracts; all responses are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createResendClient, verifyStripeWebhook, createStripeTestClient } from './account-provider-clients.mjs';

const now = () => Date.parse('2026-11-01T15:00:00.000Z');
const secret = 'whsec_synthetic_endpoint_secret';
const signature = (body, timestamp = now()/1000) => `t=${timestamp},v1=${createHmac('sha256',secret).update(`${timestamp}.`).update(body).digest('hex')}`;

test('Stripe verifies exact raw bytes, rotated v1 signatures and five-minute recency before parsing', () => {
  const body = Buffer.from('{"id":"evt_synthetic","livemode":false}');
  assert.equal(verifyStripeWebhook({body,signature:`${signature(body)},v1=${'0'.repeat(64)}`,secret,now}).id,'evt_synthetic');
  for (const input of [
    {body:Buffer.from(`${body}\n`),signature:signature(body)},
    {body,signature:signature(body,now()/1000-301)},
    {body,signature:signature(body,now()/1000+301)},
    {body,signature:`${signature(body)},t=${now()/1000}`},
    {body,signature:'t=1793545200,v0=unsupported'},
  ]) assert.throws(()=>verifyStripeWebhook({...input,secret,now}),{code:'invalid_provider_signature'});
  const live=Buffer.from('{"id":"evt_live","livemode":true}');
  assert.throws(()=>verifyStripeWebhook({body:live,signature:signature(live),secret,now}),{code:'provider_mode_mismatch'});
});

test('Resend sends only the fixed sender, text template and challenge idempotency key', async () => {
  const requests=[];
  const client=createResendClient({apiKey:'synthetic_sending_key',fetchImpl:async(url,options)=>{requests.push({url,options});return new Response('{"id":"synthetic-message"}',{status:200});}});
  await client.sendVerification({email:'person@example.org',code:'12345678',challengeId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'});
  assert.equal(requests.length,1);
  const {url,options}=requests[0];
  assert.equal(url,'https://api.resend.com/emails');
  assert.equal(options.redirect,'error');
  assert.equal(options.headers['Idempotency-Key'],'justup-verification/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.deepEqual(JSON.parse(options.body),{
    from:'Justup <accounts@notify.justup.work>',to:['person@example.org'],subject:'Your Justup verification code',
    text:'Your Justup verification code is 12345678. It expires in 10 minutes. If you did not request this, you can ignore this email.',
  });
  for(const email of ['person@example.org\r\nBcc: victim@example.org','https://person@example.org','bad address']) {
    await assert.rejects(client.sendVerification({email,code:'12345678',challengeId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}),{code:'invalid_input'});
  }
  assert.equal(requests.length,1);
});

test('Provider errors and oversized responses are redacted and never retried implicitly', async () => {
  for(const response of [new Response('private provider error detail',{status:429}),new Response('x'.repeat(32769),{status:200})]) {
    let requests=0;
    const client=createResendClient({apiKey:'synthetic_key',fetchImpl:async()=>{requests++;return response;}});
    await assert.rejects(client.sendVerification({email:'person@example.org',code:'12345678',challengeId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}),error=>error.message==='Account provider is unavailable.'&&!error.message.includes('private'));
    assert.equal(requests,1);
  }
});

test('verification uses fixed templates for all five interface locales without provider-selected prose',async()=>{
  const bodies=[],client=createResendClient({apiKey:'synthetic_sending_key',fetchImpl:async(_url,options)=>{bodies.push(JSON.parse(options.body));return new Response('{"id":"synthetic-message"}',{status:200});}});
  for(const locale of ['en','de','fr','it','es'])await client.sendVerification({email:'person@example.org',code:'12345678',challengeId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',locale});
  assert.equal(new Set(bodies.map(body=>body.subject)).size,5);
  for(const body of bodies){assert.ok(body.text.includes('12345678'));assert.ok(body.text.includes('10'));assert.equal(Object.hasOwn(body,'html'),false);}
  for(const locale of ['__proto__','en,de','nl'])await assert.rejects(client.sendVerification({email:'person@example.org',code:'12345678',challengeId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',locale}),{code:'invalid_input'});
  assert.equal(bodies.length,5);
});

test('Stripe test client pins API version and sandbox account before resource access', async () => {
  const requests=[];
  const client=createStripeTestClient({apiKey:'rk_test_synthetic',accountId:'acct_justuptest',fetchImpl:async(url,options)=>{requests.push({url,options});return new Response(JSON.stringify(url.endsWith('/account')?{id:'acct_justuptest',object:'account'}:{id:'sub_test',object:'subscription',livemode:false}),{status:200});}});
  const result=await client.retrieveSubscription('sub_test');
  assert.equal(result.id,'sub_test');
  assert.deepEqual(requests.map(r=>r.url),['https://api.stripe.com/v1/account','https://api.stripe.com/v1/subscriptions/sub_test']);
  assert.equal(requests[1].options.headers['Stripe-Version'],'2026-10-28.endive');
  assert.throws(()=>createStripeTestClient({apiKey:'rk_live_forbidden',accountId:'acct_justuptest'}),{code:'provider_mode_mismatch'});
  const wrong=createStripeTestClient({apiKey:'rk_test_synthetic',accountId:'acct_justuptest',fetchImpl:async()=>new Response('{"id":"acct_other","object":"account"}',{status:200})});
  await assert.rejects(wrong.retrieveSubscription('sub_test'),{code:'provider_account_mismatch'});
});

test('Stripe mutations preserve stable keys and fixed form fields while invoice evidence requests payments',async()=>{
  const requests=[],reference='b'.repeat(43),client=createStripeTestClient({apiKey:'rk_test_Synthetic',accountId:'acct_Sandbox',fetchImpl:async(url,options)=>{
    requests.push({url,options});let result;
    if(url.endsWith('/account'))result={id:'acct_Sandbox',object:'account'};
    else if(url.endsWith('/customers'))result={id:'cus_Owner',object:'customer',livemode:false,metadata:{justup_reference:reference}};
    else if(url.includes('/invoices/'))result={id:'in_Owner',object:'invoice',livemode:false};
    else if(url.endsWith('/subscriptions/sub_Owner'))result={id:'sub_Owner',object:'subscription',livemode:false,status:'canceled'};
    else if(url.includes('/subscriptions?'))result={object:'list',has_more:false,data:[]};
    else throw new Error('Unexpected synthetic destination');
    return new Response(JSON.stringify(result),{status:200});
  }});
  const key='justup/synthetic-operation/customer';
  await client.createCustomer(reference,{idempotencyKey:key});
  await client.createCustomer(reference,{idempotencyKey:key});
  const writes=requests.filter(value=>value.options.method==='POST');
  assert.equal(writes.length,2);assert.deepEqual(writes.map(value=>value.options.headers['Idempotency-Key']),[key,key]);
  assert.deepEqual([...new URLSearchParams(writes[0].options.body)],[[ 'metadata[justup_reference]',reference]]);
  await client.retrieveInvoice('in_Owner');assert.equal(requests.at(-1).url,'https://api.stripe.com/v1/invoices/in_Owner?expand%5B%5D=payments');
  await client.cancelSubscription('sub_Owner',{idempotencyKey:'justup/synthetic-operation/cancel'});
  assert.equal(requests.at(-1).options.method,'DELETE');assert.equal(requests.at(-1).options.body,'invoice_now=false&prorate=false');
  await client.listSubscriptions('cus_Owner');assert.equal(requests.at(-1).url,'https://api.stripe.com/v1/subscriptions?customer=cus_Owner&status=all&limit=32');
  const before=requests.length;
  await assert.rejects(client.retrieveInvoice('in_../Other'),{code:'invalid_input'});assert.equal(requests.length,before);
  const controller=new AbortController();controller.abort();
  await assert.rejects(client.retrieveInvoice('in_Owner',{signal:controller.signal}));assert.equal(requests.length,before);
});
