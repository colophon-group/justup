// Bounded fixed-origin account provider protocols. Read before changing email
// delivery, Stripe test isolation or raw-body webhook signature verification.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const STRIPE_API_VERSION='2026-10-28.endive';
const MAX_RESPONSE=32_768, TIMEOUT_MS=5_000;
const failure=(code='provider_unavailable',status=503)=>Object.assign(new Error('Account provider is unavailable.'),{code,status});
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const identifier=(value,prefix)=>typeof value==='string'&&new RegExp(`^${prefix}_[A-Za-z0-9]{1,128}$`).test(value);
const VERIFICATION_COPY={
  en:{subject:'Your Justup verification code',text:code=>`Your Justup verification code is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this email.`},
  de:{subject:'Dein Code für Justup',text:code=>`Dein Code für Justup ist ${code}. Er ist 10 Minuten gültig. Wenn du ihn nicht angefordert hast, kannst du diese E-Mail ignorieren.`},
  fr:{subject:'Votre code de vérification Justup',text:code=>`Votre code de vérification Justup est ${code}. Il expire dans 10 minutes. Si vous ne l’avez pas demandé, vous pouvez ignorer cet e-mail.`},
  it:{subject:'Il tuo codice di verifica Justup',text:code=>`Il tuo codice di verifica Justup è ${code}. Scade tra 10 minuti. Se non lo hai richiesto, puoi ignorare questa email.`},
  es:{subject:'Tu código de verificación de Justup',text:code=>`Tu código de verificación de Justup es ${code}. Caduca en 10 minutos. Si no lo has solicitado, puedes ignorar este correo.`},
};

export function normalizedEmail(value) {
  if(typeof value!=='string'||value.length>254||value!==value.trim()||!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value))throw failure('invalid_input',400);
  const [local,domain]=value.split('@');
  if(local.startsWith('.')||local.endsWith('.')||local.includes('..')||domain.split('.').some(label=>label.length>63||label.startsWith('-')||label.endsWith('-')||!label))throw failure('invalid_input',400);
  // Do not collapse plus addressing, dots, aliases or provider-specific domains.
  return `${local.toLowerCase()}@${domain.toLowerCase()}`;
}
async function requestJson(fetchImpl,url,options,{signal}={}) {
  const controller=new AbortController(),abort=()=>controller.abort();
  const timer=setTimeout(abort,TIMEOUT_MS);timer.unref?.();
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  try {
    if(controller.signal.aborted)throw failure();
    const response=await fetchImpl(url,{...options,redirect:'error',signal:controller.signal});
    if(controller.signal.aborted)throw failure();
    if(!response?.ok||!response.body)throw failure(response?.status===429?'provider_rate_limit':'provider_unavailable');
    const length=response.headers.get('content-length');
    if(length!==null&&(!/^\d+$/.test(length)||Number(length)>MAX_RESPONSE))throw failure();
    const chunks=[];let bytes=0;
    for await(const chunk of response.body){bytes+=chunk.byteLength;if(bytes>MAX_RESPONSE){controller.abort();throw failure();}chunks.push(Buffer.from(chunk));}
    const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
    if(!plain(result))throw failure();
    return result;
  } catch(error) {throw failure(error?.code==='provider_rate_limit'?'provider_rate_limit':'provider_unavailable');}
  finally {clearTimeout(timer);controller.abort();signal?.removeEventListener('abort',abort);}
}
export function createResendClient({apiKey,fetchImpl=fetch}={}) {
  if(typeof apiKey!=='string'||apiKey.length<8||apiKey.length>512||/[\x00-\x20\x7f]/.test(apiKey)||typeof fetchImpl!=='function')throw failure();
  return {
    async sendVerification({email,code,challengeId,locale='en',signal}={}) {
      email=normalizedEmail(email);
      if(typeof code!=='string'||!/^\d{8}$/.test(code)||typeof challengeId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(challengeId)||!Object.hasOwn(VERIFICATION_COPY,locale))throw failure('invalid_input',400);
      const copy=VERIFICATION_COPY[locale];
      const value=await requestJson(fetchImpl,'https://api.resend.com/emails',{
        method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json','Idempotency-Key':`justup-verification/${challengeId}`},
        body:JSON.stringify({from:'Justup <accounts@notify.justup.work>',to:[email],subject:copy.subject,text:copy.text(code)}),
      },{signal});
      if(typeof value.id!=='string'||!value.id||value.id.length>128)throw failure();
      return {sent:true}; // Provider message IDs are unnecessary local identity data.
    },
  };
}

export function verifyStripeWebhook({body,signature,secret,now=Date.now}={}) {
  if(!Buffer.isBuffer(body)||body.length===0||body.length>262_144||typeof signature!=='string'||signature.length>2048
      ||typeof secret!=='string'||secret.length<16||secret.length>512||typeof now!=='function')throw failure('invalid_provider_signature',400);
  let timestamp=null;const signatures=[];
  for(const part of signature.split(',')){
    const entry=part.trim().split('=');if(entry.length!==2)throw failure('invalid_provider_signature',400);
    const [scheme,value]=entry;
    if(scheme==='t'){if(timestamp!==null||!/^\d{1,12}$/.test(value))throw failure('invalid_provider_signature',400);timestamp=value;}
    if(scheme==='v1'){if(!/^[a-f0-9]{64}$/.test(value)||signatures.length>=10)throw failure('invalid_provider_signature',400);signatures.push(value);}
  }
  const at=now();
  if(timestamp===null||!signatures.length||!Number.isSafeInteger(at)||Math.abs(at-Number(timestamp)*1000)>300_000)throw failure('invalid_provider_signature',400);
  const expected=createHmac('sha256',secret).update(`${timestamp}.`).update(body).digest();
  let valid=false;for(const value of signatures)valid=timingSafeEqual(expected,Buffer.from(value,'hex'))||valid;
  if(!valid)throw failure('invalid_provider_signature',400);
  let event;try{event=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));}catch{throw failure('invalid_provider_signature',400);}
  if(!plain(event))throw failure('invalid_provider_signature',400);
  if(event.livemode!==false)throw failure('provider_mode_mismatch',400);
  return event;
}

export function createStripeTestClient({apiKey,accountId,fetchImpl=fetch}={}) {
  if(typeof apiKey!=='string'||!/^rk_test_[A-Za-z0-9_]{1,256}$/.test(apiKey))throw failure('provider_mode_mismatch',503);
  if(!identifier(accountId,'acct')||typeof fetchImpl!=='function')throw failure();
  const headers={Authorization:`Bearer ${apiKey}`,'Stripe-Version':STRIPE_API_VERSION};
  async function request(path,{method='GET',fields,idempotencyKey,signal}={}){
    const account=await requestJson(fetchImpl,'https://api.stripe.com/v1/account',{method:'GET',headers},{signal});
    if(account.object!=='account'||account.id!==accountId)throw failure('provider_account_mismatch');
    const supplied={...headers};let body;
    if(method!=='GET'){
      if(typeof idempotencyKey!=='string'||!/^[A-Za-z0-9_.:/-]{16,200}$/.test(idempotencyKey))throw failure('invalid_input',400);
      supplied['Idempotency-Key']=idempotencyKey;supplied['Content-Type']='application/x-www-form-urlencoded';
      body=new URLSearchParams(fields??{}).toString();
    }
    const result=await requestJson(fetchImpl,`https://api.stripe.com/v1/${path}`,{method,headers:supplied,...(body===undefined?{}:{body})},{signal});
    if(result.object==='list'){
      if(!Array.isArray(result.data)||result.data.length>32||typeof result.has_more!=='boolean'||result.data.some(value=>value?.livemode!==false))throw failure('provider_mode_mismatch');
    }else if(result.livemode!==false)throw failure('provider_mode_mismatch');
    return result;
  }
  const optionsFor=(options,fields)=>({...options,fields});
  const owned=(result,object,id)=>{if(result.object!==object||result.id!==id)throw failure();return result;};
  const requireId=(id,prefix)=>{if(!identifier(id,prefix))throw failure('invalid_input',400);return id;};
  return {
    async retrieveSubscription(id,options){requireId(id,'sub');return owned(await request(`subscriptions/${id}`,options),'subscription',id);},
    async retrieveInvoice(id,options){requireId(id,'in');return owned(await request(`invoices/${id}?expand%5B%5D=payments`,options),'invoice',id);},
    async retrievePrice(id,options){requireId(id,'price');return owned(await request(`prices/${id}`,options),'price',id);},
    async retrieveCustomer(id,options){requireId(id,'cus');return owned(await request(`customers/${id}`,options),'customer',id);},
    async retrievePaymentIntent(id,options){requireId(id,'pi');return owned(await request(`payment_intents/${id}`,options),'payment_intent',id);},
    async retrieveCharge(id,options){requireId(id,'ch');return owned(await request(`charges/${id}`,options),'charge',id);},
    async retrieveCheckout(id,options){requireId(id,'cs_test');return owned(await request(`checkout/sessions/${id}`,options),'checkout.session',id);},
    async retrievePortalConfiguration(id,options){requireId(id,'bpc');return owned(await request(`billing_portal/configurations/${id}`,options),'billing_portal.configuration',id);},
    async createCustomer(billingReference,options){
      if(typeof billingReference!=='string'||!/^[A-Za-z0-9_-]{32,128}$/.test(billingReference))throw failure('invalid_input',400);
      const result=await request('customers',{...optionsFor(options,{'metadata[justup_reference]':billingReference}),method:'POST'});
      if(result.object!=='customer'||!identifier(result.id,'cus')||result.metadata?.justup_reference!==billingReference)throw failure();return result;
    },
    async createCheckout(fields,options){const result=await request('checkout/sessions',{...optionsFor(options,fields),method:'POST'});if(result.object!=='checkout.session'||!identifier(result.id,'cs_test'))throw failure();return result;},
    async createPortal(fields,options){const result=await request('billing_portal/sessions',{...optionsFor(options,fields),method:'POST'});if(result.object!=='billing_portal.session'||!identifier(result.id,'bps'))throw failure();return result;},
    async expireCheckout(id,options){requireId(id,'cs_test');return owned(await request(`checkout/sessions/${id}/expire`,{...options,method:'POST'}),'checkout.session',id);},
    async cancelSubscription(id,options){requireId(id,'sub');return owned(await request(`subscriptions/${id}`,{...options,method:'DELETE',fields:{invoice_now:'false',prorate:'false'}}),'subscription',id);},
    async listSubscriptions(customerId,options){requireId(customerId,'cus');return request(`subscriptions?customer=${customerId}&status=all&limit=32`,options);},
    async listCheckouts(customerId,options){requireId(customerId,'cus');return request(`checkout/sessions?customer=${customerId}&limit=32`,options);},
  };
}
