// Locale approval, request selection and shared proof upgrade contracts. All
// approval values are synthetic; tests never call a provider or activate users.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { policyState,requestLocale,validatePolicyConfig } from './policies.mjs';
import { createProcessingAdmission } from './processing-admission.mjs';
import { configFromEnv } from './main.mjs';
const origin='https://preview.example';
const entry=(locale,reviewed=true)=>({privacyUrl:`${origin}/privacy${locale==='en'?'':'.'+locale}.html`,usageUrl:`${origin}/usage${locale==='en'?'':'.'+locale}.html`,version:'synthetic-reviewed',reviewed});
const config={allowedOrigin:origin,policiesReviewed:true,privacyUrl:origin+'/privacy.html',usageUrl:origin+'/usage.html',policyVersion:'synthetic-reviewed'};

test('legacy English approval, exact locale reviews and explicit fallback never imply another locale approval',()=>{
  assert.equal(policyState(config,'en').reviewed,true);
  for(const locale of ['de','fr','it','es']){const p=policyState(config,locale);assert.equal(p.reviewed,false);assert.equal(p.version,'product-draft-5');assert.equal(p.privacyUrl,entry(locale).privacyUrl);assert.equal(p.reviewedLocale,null);}
  assert.equal(policyState({...config,privacyUrl:'https://elsewhere.example/privacy.html'}).reviewed,false);
  for(const patch of [{privacyUrl:origin+'/usage.html',usageUrl:origin+'/privacy.html'},
    {privacyUrl:origin+'/arbitrary.html'},{privacyUrl:origin+'/privacy.fr.html'},
    {privacyUrl:origin+'/privacy.html?reviewed=1'},{usageUrl:origin+'/usage.html#reviewed'},
    {privacyUrl:origin+'/privacy.html/'}]){
    assert.equal(policyState({...config,...patch},'en').reviewed,false);
    assert.throws(()=>validatePolicyConfig({...config,...patch}),/legacy English policy/);
  }
  const localized={...config,policyLocales:{en:entry('en'),de:entry('de',false)}};
  assert.equal(policyState(localized,'de').reviewed,false);
  const fallback={...localized,policyFallbacks:{de:'en'}};validatePolicyConfig(fallback);
  assert.deepEqual(policyState(fallback,'de'),{...entry('en'),reviewed:true,locale:'de',reviewedLocale:'en',fallback:true});
  assert.equal(policyState({...fallback,policiesReviewed:false},'de').reviewed,false);
  for(const patch of [{policyLocales:{de:entry('en')}},{policyLocales:{de:{...entry('de'),privacyUrl:origin+'/privacy.de.html?tracking=1'}}},{policyLocales:{xx:entry('de')}},{policyFallbacks:{de:'fr'}},{policyFallbacks:{de:'de'}},{policyLocales:{de:{...entry('de'),version:''}}}])assert.throws(()=>validatePolicyConfig({...config,...patch}),/policy/);
});

test('saved account override or browser default ignores guest locale cookies while guests retain their explicit choice',()=>{
  assert.equal(requestLocale({savedLocale:'fr',cookie:'justup_interface_locale=de',acceptLanguage:'it-CH'}),'fr');
  assert.equal(requestLocale({savedLocale:null,cookie:'justup_interface_locale=es',acceptLanguage:'fr-CH'}),'fr');
  assert.equal(requestLocale({cookie:'justup_interface_locale=es',acceptLanguage:'fr-CH'}),'es');
  assert.equal(requestLocale({cookie:'justup_interface_locale=de',acceptLanguage:'it-CH'}),'de');
  assert.equal(requestLocale({cookie:'justup_interface_locale=invalid',acceptLanguage:'ja-JP,es-MX;q=0.9,de-CH;q=0.8'}),'es');
  assert.equal(requestLocale({cookie:'justup_interface_locale=de; justup_interface_locale=it',acceptLanguage:'fr-CH'}),'fr');
  for(const value of ['de;q=0','*','de\nCookie:evil','de,'+'x'.repeat(513)])assert.equal(requestLocale({acceptLanguage:value}),'en');
  assert.equal(requestLocale({acceptLanguage:'de-CH;q=0.5,it-CH;q=0.9'}),'it');
  assert.equal(requestLocale({cookie:'justup_interface_locale=',acceptLanguage:'de-CH'}),'de');
});

test('trusted environment JSON validates fixed locale URLs and fallback targets',()=>{
  const env={JUSTUP_ORIGIN:origin,JUSTUP_POLICIES_REVIEWED:'false',JUSTUP_POLICY_LOCALES:JSON.stringify({de:entry('de')}),JUSTUP_POLICY_FALLBACKS:'{"it":"de"}'};
  const parsed=configFromEnv(env);assert.equal(parsed.policyLocales.de.reviewed,true);assert.equal(policyState(parsed,'de').reviewed,false);
  for(const patch of [{JUSTUP_POLICY_LOCALES:'[]'},{JUSTUP_POLICY_LOCALES:'bad'},{JUSTUP_POLICY_LOCALES:JSON.stringify({de:{...entry('de'),reviewed:'true'}})},{JUSTUP_POLICY_FALLBACKS:'{"it":"en"}'}])assert.throws(()=>configFromEnv({...env,...patch}),/policy/);
});

test('shared admission upgrades the existing row in place and binds exact policy scope, build and expiry',()=>{
  const db=new DatabaseSync(':memory:');let time=100_000;
  try{
    db.exec("CREATE TABLE justup_visitor_admission(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL,source_commit TEXT,build_identity TEXT,policy_version TEXT,private_generation TEXT,checked_at INTEGER NOT NULL) STRICT; INSERT INTO justup_visitor_admission VALUES(1,1,'prior','prior','prior','prior',1)");
    const c={...config,dbPath:':memory:',sourceCommit:'a'.repeat(40),buildIdentity:'synthetic-build'};
    const queue=createProcessingAdmission({db,config:c,now:()=>time});assert.equal(queue.processingAvailable(),false);
    assert.equal(db.prepare('SELECT source_commit FROM justup_processing_admission').get().source_commit,'prior');
    assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='justup_visitor_admission'").get(),undefined);
    const api=createProcessingAdmission({db,config:c,now:()=>time,availability:()=>true});assert.equal(api.processingAvailable('en'),true);assert.equal(queue.processingAvailable('de'),false);
    const key=queue.processingPolicy('en').key;c.policyVersion='synthetic-revision';api.refreshAvailability();assert.notEqual(queue.processingPolicy('en').key,key);
    assert.equal(createProcessingAdmission({db,config:{...c,buildIdentity:'other'},now:()=>time}).processingAvailable(),false);
    time+=90_000;assert.equal(queue.processingAvailable(),false);
    c.policiesReviewed=false;api.refreshAvailability();assert.equal(queue.processingAvailable(),false);
  }finally{db.close();}
});
