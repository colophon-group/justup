// Real SQLite/auth/queue contracts for email proof; delivery is always synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from './main.mjs';
import { createEmailVerificationRunner,emailSessionHash,validateEmailVerificationConfig } from './email-verification.mjs';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PASSWORD='a sufficiently long password';
async function fixture(t,{provider={},send,storage={}}={}) {
  let at=Date.parse('2026-11-01T15:00:00.000Z');
  const now=()=>at,config={dbPath:':memory:',sourceCommit:'a'.repeat(40),buildIdentity:'b'.repeat(64),csrfSecret:'c'.repeat(32),
    allowedOrigin:'https://preview.justup.work',privacyUrl:'https://preview.justup.work/privacy.html',usageUrl:'https://preview.justup.work/usage.html',
    policiesReviewed:true,policyVersion:'test-v1',requiresInvitation:false,emailVerificationEnabled:true,
    readiness:()=>({capabilities:{emailVerification:true}}),...storage};
  const app=await createApplication({config,now});t.after(()=>app.close());
  const api=app.services.find(service=>service.emailVerification),sent=[];
  const queueConfig={...config,emailVerification:{enabled:true,apiKey:'synthetic_sending_key',verificationKey:'v'.repeat(32),maxDaily:10,maxMonthly:100,...provider}};
  const queue=createEmailVerificationRunner({db:app.store.db,tasks:app.tasks,config:queueConfig,now,client:{async sendVerification(value){sent.push(value);await send?.(value);return {sent:true};}}});
  const account=async(username='person')=>app.auth.register({username,password:PASSWORD});
  const ctx=(owner,body,path='/account/verification',method='POST')=>({method,path,url:new URL(`https://preview.justup.work/api/v1${path}`),body,accountId:owner.account.id,sessionHash:emailSessionHash(owner.token),interfaceLocale:'en'});
  const start=(owner,email='person@example.org',requestKey='first')=>api.handleVerification(ctx(owner,{email,requestKey}));
  const deliver=async()=>{const task=app.tasks.claim({workerId:'test-worker',kinds:['email_verification'],leaseMs:30_000});return {task,result:await queue.runTask(task)};};
  const confirm=(owner,value=sent.at(-1),code=value.code)=>api.handleVerification(ctx(owner,{challengeId:value.challengeId,code},'/account/verification/confirm'));
  return {app,api,queue,queueConfig,config,now,advance:ms=>{at+=ms;},sent,account,ctx,start,deliver,confirm};
}
test('one challenge survives exact retry, queue payload stays private, proof requires explicit free activation',async t=>{
  const f=await fixture(t),owner=await f.account();
  const first=await f.start(owner),retry=await f.start(owner);
  assert.deepEqual(retry,first);assert.equal(first.status,202);assert.equal(first.body.verification.state,'pending');
  const row=f.app.store.db.prepare('SELECT * FROM justup_tasks').get();
  assert.equal(row.payload_json.includes('person@example.org'),false);assert.equal(row.payload_json.includes('code'),false);
  await assert.rejects(f.confirm(owner,{challengeId:first.body.verification.challengeId,code:'12345678'}),{code:'verification_pending'});
  const {task,result}=await f.deliver();assert.equal(result.status,'succeeded');
  assert.deepEqual(f.app.tasks.publicView(f.app.tasks.get(owner.account.id,task.id)).result,null);
  const state=await f.api.handleVerification(f.ctx(owner,undefined,'/account/verification','GET'));
  assert.equal(state.body.verification.state,'sent');assert.equal(f.app.store.db.prepare('SELECT email FROM justup_email_challenges').get().email,null);
  await assert.rejects(f.start(owner,'other@example.org'),{code:'idempotency_conflict'});
  await f.confirm(owner);
  assert.equal(f.app.auth.session(owner.token).access.kind,'ready');assert.equal(f.app.auth.session(owner.token).access.fullAccess,false);
  assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM justup_email_challenges').get().n,0);
  assert.equal(JSON.stringify(f.app.store.db.prepare('SELECT * FROM access_identities').get()).includes('person@example.org'),false);
  assert.equal(f.app.auth.activateFreePeriod(owner.token).kind,'free');
  await assert.rejects(f.confirm(owner),{code:'verification_invalid'});
});
test('original session, attempt budget, expiry and restore prevent proof replay',async t=>{
  const f=await fixture(t),owner=await f.account();await f.start(owner);await f.deliver();
  const other=await f.app.auth.login({username:'person',password:PASSWORD});
  const otherState=await f.api.handleVerification(f.ctx(other,undefined,'/account/verification','GET'));
  assert.equal(otherState.body.verification.challengeLocale,null);assert.equal(otherState.body.verification.challengeId,null);
  await assert.rejects(f.confirm(other),{code:'verification_invalid'});
  const wrong=f.sent[0].code==='00000000'?'11111111':'00000000';
  for(let n=0;n<5;n++)await assert.rejects(f.confirm(owner,f.sent[0],wrong),{code:'verification_invalid'});
  await assert.rejects(f.confirm(owner),{code:'verification_locked'});
  f.advance(600_001);f.api.cleanup();
  assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM justup_email_challenges').get().n,0);
  await f.start(owner,'person@example.org','after-expiry');
  f.app.auth.invalidateAllSessions();
  assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM justup_email_challenges').get().n,0);
  assert.equal(f.app.auth.session(owner.token),null);
});
test('same verified email cannot overlap active accounts; deletion erases proof and allows a fresh claim',async t=>{
  const f=await fixture(t),first=await f.account('first'),second=await f.account('second');
  await f.start(first);await f.deliver();await f.confirm(first);f.app.auth.activateFreePeriod(first.token);
  await f.start(second);await f.deliver();
  await assert.rejects(f.confirm(second),{code:'verification_conflict'});
  assert.equal(f.app.auth.session(second.token).access.kind,'limited');
  await f.app.auth.deleteAccount(first.token,PASSWORD);f.app.afterPrivateTransaction();
  assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM access_identities WHERE account_id=?').get(first.account.id).n,0);
  assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM access_free_periods WHERE account_id=?').get(first.account.id).n,0);
  await f.confirm(second);assert.equal(f.app.auth.activateFreePeriod(second.token).kind,'free');
});
test('deletion during delivery cannot restore challenge, identity or task data',async t=>{
  let release,started;const waiting=new Promise(resolve=>{started=resolve;});
  const f=await fixture(t,{send:async()=>{started();await new Promise(resolve=>{release=resolve;});}}),owner=await f.account();
  await f.start(owner);const delivery=f.deliver();await waiting;
  await f.app.auth.deleteAccount(owner.token,PASSWORD);f.app.afterPrivateTransaction();release();
  assert.equal((await delivery).result.status,'failed');
  for(const table of ['justup_email_challenges','access_identities','justup_tasks'])assert.equal(f.app.store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
});
test('policy closure after delivery wait prevents proof material from being committed',async t=>{
  const f=await fixture(t,{send:()=>{f.config.policiesReviewed=false;f.api.refreshAvailability();}}),owner=await f.account();
  await f.start(owner);const {result}=await f.deliver();assert.equal(result.status,'failed');
  const row=f.app.store.db.prepare('SELECT * FROM justup_email_challenges').get();
  assert.equal(row.code_hash,null);assert.equal(row.subject_key,null);
  await assert.rejects(f.confirm(owner),{code:'policy_unavailable'});
  f.api.cleanup();assert.equal(f.app.store.db.prepare('SELECT email FROM justup_email_challenges').get().email,null);
});
test('daily/monthly send reservations are bounded, and a changed identity key fails closed',async t=>{
  const f=await fixture(t,{provider:{maxDaily:1,maxMonthly:1}}),first=await f.account('first'),second=await f.account('second');
  await f.start(first);await f.deliver();await f.start(second,'second@example.org');
  assert.equal((await f.deliver()).result.errorCode,'rate_limit');assert.equal(f.sent.length,1);
  assert.throws(()=>createEmailVerificationRunner({db:f.app.store.db,tasks:f.app.tasks,config:{...f.queueConfig,emailVerification:{...f.queueConfig.emailVerification,verificationKey:'different verification secret key here'}}}),{code:'verification_key_changed'});
  for(const invalid of [{enabled:true},{enabled:false,apiKey:'extra'},{...f.queueConfig.emailVerification,maxDaily:11},{...f.queueConfig.emailVerification,maxMonthly:101}])assert.throws(()=>validateEmailVerificationConfig(invalid),{code:'verification_unavailable'});
});
test('HTTP verification keeps ordinary Origin/CSRF/locale admission and never returns recipient or code',async t=>{
  const f=await fixture(t),owner=await f.account();
  await new Promise(resolve=>f.app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${f.app.server.address().port}/api/v1`,cookie=`__Host-justup_session=${owner.token}`;
  const session=await(await fetch(`${base}/session`,{headers:{Cookie:cookie}})).json();
  assert.equal(session.capabilities.emailVerification,true);assert.equal(session.capabilities.search,false);assert.equal(session.capabilities.aiMatching,false);
  const headers={Cookie:cookie,Origin:f.config.allowedOrigin,'X-CSRF-Token':session.csrfToken,'Content-Type':'application/json'};
  const body=JSON.stringify({email:'person@example.org',requestKey:'http-request'});
  assert.equal((await fetch(`${base}/account/verification`,{method:'POST',headers:{...headers,Origin:'https://other.example'},body})).status,403);
  assert.equal((await fetch(`${base}/account/verification`,{method:'POST',headers:{...headers,'X-CSRF-Token':'a'.repeat(43)},body})).status,403);
  assert.equal((await fetch(`${base}/account/verification`,{method:'POST',headers:{...headers,'X-Justup-Locale':'de'},body})).status,503);
  const response=await fetch(`${base}/account/verification`,{method:'POST',headers,body});assert.equal(response.status,202);
  const serialized=JSON.stringify(await response.json());assert.equal(serialized.includes('person@example.org'),false);assert.equal(serialized.includes('code'),false);
  await f.deliver();const sent=f.sent[0];
  const verified=await fetch(`${base}/account/verification/confirm`,{method:'POST',headers,body:JSON.stringify({challengeId:sent.challengeId,code:sent.code})});
  assert.equal(verified.status,200);assert.equal((await verified.json()).verification.state,'verified');
  const after=await(await fetch(`${base}/session`,{headers:{Cookie:cookie}})).json();assert.equal(after.access.kind,'ready');assert.equal(after.access.fullAccess,false);
});
test('queue outage blocks new sends while a delivered original-session code remains confirmable',async t=>{
  const f=await fixture(t),owner=await f.account();await f.start(owner);await f.deliver();
  f.config.readiness=()=>({capabilities:{emailVerification:false,search:false,aiMatching:false}});
  await assert.rejects(f.start(owner,'other@example.org','new-request'),{code:'verification_unavailable'});
  await f.confirm(owner);assert.equal(f.app.auth.session(owner.token).access.kind,'ready');
});
test('recipient scrub rotates the real deletion generation and removes retained old backups',async t=>{
  const root=mkdtempSync(join(tmpdir(),'justup-email-proof-')),backupDir=join(root,'backups'),generationPath=join(root,'private-generation');
  mkdirSync(backupDir,{mode:0o700});writeFileSync(generationPath,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n',{mode:0o600});
  const f=await fixture(t,{storage:{dbPath:join(root,'application.sqlite'),privateGenerationPath:generationPath,backupDir}});
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const owner=await f.account();await f.start(owner);await f.deliver();
  const before=readFileSync(generationPath,'utf8');writeFileSync(join(backupDir,'old.sqlite'),'old private snapshot',{mode:0o600});
  await f.api.handleVerification(f.ctx(owner,undefined,'/account/verification','GET'));
  assert.notEqual(readFileSync(generationPath,'utf8'),before);assert.deepEqual(readdirSync(backupDir),[]);
  assert.equal(f.app.store.db.prepare('SELECT email FROM justup_email_challenges').get().email,null);
  await f.confirm(owner);assert.equal(f.app.auth.session(owner.token).access.kind,'ready');
});
test('HTTP exposes original challenge locale after language changes without bypassing its current policy',async t=>{
  const origin='https://preview.justup.work',f=await fixture(t,{storage:{
    policyLocales:{de:{privacyUrl:`${origin}/privacy.de.html`,usageUrl:`${origin}/usage.de.html`,version:'test-v1',reviewed:true}},
    policyAssetProof:{origin,sourceCommit:'a'.repeat(40),assetsSha256:'d'.repeat(64),locales:{de:{version:'test-v1',privacySha256:'e'.repeat(64),usageSha256:'f'.repeat(64)}}},
  }}),owner=await f.account();
  const initial=await f.api.handleVerification(f.ctx(owner,undefined,'/account/verification','GET'));
  assert.equal(initial.body.verification.challengeLocale,null);
  await f.start(owner);await f.deliver();
  await new Promise(resolve=>f.app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${f.app.server.address().port}/api/v1`,cookie=`__Host-justup_session=${owner.token}`;
  const session=await(await fetch(`${base}/session`,{headers:{Cookie:cookie,'X-Justup-Locale':'de'}})).json();
  assert.equal(session.policies.locale,'de');assert.equal(session.policies.reviewed,true);
  const headers={Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':session.csrfToken,'X-Justup-Locale':'de'};
  const response=await fetch(`${base}/account/verification`,{headers});assert.equal(response.status,200);
  const {verification}=await response.json();assert.equal(verification.state,'sent');assert.equal(verification.challengeLocale,'en');
  const body=JSON.stringify({challengeId:verification.challengeId,code:f.sent[0].code});
  const mismatch=await fetch(`${base}/account/verification/confirm`,{method:'POST',headers,body});
  assert.equal(mismatch.status,503);assert.equal((await mismatch.json()).error.code,'policy_unavailable');
  assert.equal(f.app.store.db.prepare('SELECT attempts FROM justup_email_challenges').get().attempts,0);
  f.config.policyLocales.en={privacyUrl:`${origin}/privacy.html`,usageUrl:`${origin}/usage.html`,version:'test-v1',reviewed:false};f.api.refreshAvailability();
  const revoked=await fetch(`${base}/account/verification/confirm`,{method:'POST',headers:{...headers,'X-Justup-Locale':verification.challengeLocale},body});
  assert.equal(revoked.status,503);assert.equal((await revoked.json()).error.code,'policy_unavailable');
  assert.equal(f.app.auth.session(owner.token).access.kind,'limited');
  f.config.policyLocales.en.reviewed=true;f.api.refreshAvailability();
  const confirmed=await fetch(`${base}/account/verification/confirm`,{method:'POST',headers:{...headers,'X-Justup-Locale':verification.challengeLocale},body});
  assert.equal(confirmed.status,200);const completed=(await confirmed.json()).verification;
  assert.equal(completed.state,'verified');assert.equal(completed.challengeLocale,null);assert.equal(completed.challengeId,null);
});
