// Trusted locale-specific policy identities and bounded presentation selection.
// Read when changing approval configuration, session metadata or admission scope.
export const POLICY_LOCALES = Object.freeze(['en','de','fr','it','es']);
const version = v => typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,100}$/.test(v);
const object = v => v&&typeof v==='object'&&!Array.isArray(v);
function url(value,config={}) {try{const u=new URL(value);return (u.protocol==='https:'||config.allowInsecureLocalhost===true&&u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname))&&!u.username&&!u.password&&!u.search&&!u.hash?u:null;}catch{return null;}}
export function validatePolicyConfig(config={}) {
  const origin=config.allowedOrigin??'https://preview.justup.work';
  for(const [locale,entry] of Object.entries(config.policyLocales??{})) {
    if(!POLICY_LOCALES.includes(locale)||!object(entry)||Object.keys(entry).sort().join(',')!=='privacyUrl,reviewed,usageUrl,version'||typeof entry.reviewed!=='boolean'||!version(entry.version))throw new TypeError('Invalid policy locale configuration.');
    const suffix=locale==='en'?'':`.${locale}`;
    for(const kind of ['privacy','usage']){const u=url(entry[`${kind}Url`],config);if(!u||u.origin!==origin||entry[`${kind}Url`]!==`${origin}/${kind}${suffix}.html`)throw new TypeError('Invalid policy locale configuration.');}
  }
  for(const [from,to] of Object.entries(config.policyFallbacks??{}))if(!POLICY_LOCALES.includes(from)||!POLICY_LOCALES.includes(to)||from===to||config.policyLocales?.[to]?.reviewed!==true)throw new TypeError('Invalid policy fallback configuration.');
  if(config.policyLocales!=null&&!object(config.policyLocales)||config.policyFallbacks!=null&&!object(config.policyFallbacks))throw new TypeError('Invalid policy locale configuration.');
  return config;
}
export function policyState(config={},locale='en') {
  if(!POLICY_LOCALES.includes(locale))locale='en';
  const legacy=locale==='en'&&url(config.privacyUrl,config)?.origin===(config.allowedOrigin??'https://preview.justup.work')&&url(config.usageUrl,config)?.origin===(config.allowedOrigin??'https://preview.justup.work')&&version(config.policyVersion)?{privacyUrl:config.privacyUrl,usageUrl:config.usageUrl,version:config.policyVersion,reviewed:true}:null;
  const local=config.policyLocales?.[locale]??legacy;
  const fallback=config.policyFallbacks?.[locale];
  const target=local?.reviewed===true?locale:fallback??locale;
  const entry=target===locale?local:config.policyLocales?.[target];
  const reviewed=config.policiesReviewed===true&&entry?.reviewed===true;
  const suffix=locale==='en'?'':`.${locale}`,origin=config.allowedOrigin??'https://preview.justup.work';
  return {privacyUrl:entry?.privacyUrl??`${origin}/privacy${suffix}.html`,usageUrl:entry?.usageUrl??`${origin}/usage${suffix}.html`,version:entry?.version??'product-draft-5',reviewed,
    locale,reviewedLocale:reviewed?target:null,fallback:reviewed&&target!==locale};
}
export function policyScopes(config) {return Object.fromEntries(POLICY_LOCALES.map(locale=>[locale,policyState(config,locale)]));}
export function policyJson(value) {
  if(value===undefined)return undefined;
  if(typeof value!=='string'||value.length>8192)throw new TypeError('Invalid policy locale configuration.');
  try{const result=JSON.parse(value);if(!object(result))throw Error();return result;}catch{throw new TypeError('Invalid policy locale configuration.');}
}
export function requestLocale({cookie,acceptLanguage,savedLocale}={}) {
  if(POLICY_LOCALES.includes(savedLocale))return savedLocale;
  if(savedLocale===undefined&&typeof cookie==='string'&&cookie.length<=8192){const values=cookie.split(';').map(v=>v.trim()).filter(v=>v.startsWith('justup_interface_locale='));if(values.length===1){const v=values[0].slice(24);if(POLICY_LOCALES.includes(v))return v;}}
  if(typeof acceptLanguage==='string'&&acceptLanguage.length<=512){
    const tags=acceptLanguage.split(',').slice(0,16).map((part,index)=>{const [tag,q]=part.trim().split(';');const quality=q===undefined?1:/^q=(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?)$/.test(q)?Number(q.slice(2)):0;return {tag,quality,index};}).sort((a,b)=>b.quality-a.quality||a.index-b.index);
    for(const {tag,quality} of tags){if(!quality||tag.length>80||!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(tag))continue;try{const v=Intl.getCanonicalLocales(tag)[0].split('-')[0];if(POLICY_LOCALES.includes(v))return v;}catch{}}
  }
  return 'en';
}
