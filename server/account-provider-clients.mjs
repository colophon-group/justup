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
    const response=await fetchImpl(url,{...options,redirect:'error',signal:controller.signal});
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
  async function get(path,{signal}={}){
    const account=await requestJson(fetchImpl,'https://api.stripe.com/v1/account',{method:'GET',headers},{signal});
    if(account.object!=='account'||account.id!==accountId)throw failure('provider_account_mismatch');
    const result=await requestJson(fetchImpl,`https://api.stripe.com/v1/${path}`,{method:'GET',headers},{signal});
    if(result.livemode!==false)throw failure('provider_mode_mismatch');
    return result;
  }
  return {
    async retrieveSubscription(id,options){if(!identifier(id,'sub'))throw failure('invalid_input',400);const result=await get(`subscriptions/${id}`,options);if(result.object!=='subscription'||result.id!==id)throw failure();return result;},
    async retrieveInvoice(id,options){if(!identifier(id,'in'))throw failure('invalid_input',400);const result=await get(`invoices/${id}`,options);if(result.object!=='invoice'||result.id!==id)throw failure();return result;},
  };
}
