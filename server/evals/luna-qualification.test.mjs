// Provider-free qualification contracts. No socket, credentials or host calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { applyQualificationReview,createQualificationObserver,evaluateQualification,fixedQualificationManifest,validateQualificationManifest } from './luna-qualification.mjs';
import { inQualificationSandbox,runQualificationCli,validateQualificationGrant } from './luna-qualification-cli.mjs';
import { openQualificationAnswers, parseQualificationResult, qualificationReportSha,
  qualificationReviewKey, sealQualificationAnswers } from './luna-qualification-review.mjs';
import { finalizeQualificationReview } from '../../scripts/luna-qualification-review.mjs';

const usage={inputTokens:12,cachedInputTokens:0,outputTokens:8,reasoningOutputTokens:2};
const sha=value=>createHash('sha256').update(value).digest('hex');
function reviewReceipt(report,approved){
  return {version:1,kind:'luna_qualification_manual_review',reportSha256:sha(JSON.stringify(report)),
    cases:report.cases.filter(record=>record.kind==='company'&&record.manualReviewPending).map(record=>({id:record.id,clarificationSha256:record.clarificationSha256,approved}))};
}
const FILTERS=['companyInclude','companyExclude','titleAny','bodyAll','bodyNone','locations','workplaces','employmentTypes','postingLanguages','seniority'];
function intentAnswer(entry){
  const entries=Object.entries(entry.expected.filters),filters=Object.fromEntries(FILTERS.map(key=>[key,entry.expected.filters[key]??null]));
  const requirements=entries.length?[{id:'r1',text:entry.query,handling:'primary',reason:'Synthetic catalogue evidence.',bindings:entries.map(([field,values])=>({field,values})),companyReference:null}]:[];
  if(entry.expected.unsatisfied)requirements.push({id:'r2',text:entry.query,handling:'unsatisfied',reason:'No verified evidence supports the requested condition.',bindings:[],companyReference:null});
  return {title:'Synthetic search',configuration:{schemaVersion:1,filters,residualAi:null},requirements};
}
function fakeModel(manifest,observer,{unsafe=false,missingCounter=false,clarification=null,zeroDiscoveryCaseId=null,zeroDiscoveryRepeatsFor=null}={}){
  const companyCalls=new Map();
  const measured=(kind,webStarts)=>{
    if(!missingCounter)observer.onReply({schemaId:kind,toolCalls:webStarts,usage});
    observer.onMetric({kind:kind==='intent'?'search_intent':'company_resolution',code:'succeeded',durationMs:25,usage});
  };
  return {available:()=>true,
    async interpretIntent(input){const entry=manifest.intent.cases.find(item=>item.query===input.query);measured('intent',0);return intentAnswer(entry);},
    async resolveCompany(input){const entry=manifest.company.cases.find(item=>item.input===input.input);assert.equal(input.domain,entry.domain??null);
      const call=(companyCalls.get(entry.id)??0)+1;companyCalls.set(entry.id,call);
      const zeroDiscovery=entry.id===zeroDiscoveryCaseId||(entry.id===zeroDiscoveryRepeatsFor&&call>1);
      measured('company',zeroDiscovery?0:entry.domain===undefined?1:0);
      if(entry.expectedStatus)return unsafe?{data:{status:'candidate',candidate:{domain:'wrong.example'},clarification:null},evidenceVerified:false}:{data:{status:'clarification',candidate:null,clarification:typeof clarification==='function'?clarification(entry):clarification??`Which ${entry.expectedSubject} company do you mean?`},evidenceVerified:false};
      const url=`https://${entry.expectedDomain}/`;
      return {data:{status:'candidate',candidate:{name:entry.input,domain:entry.expectedDomain,websiteUrl:url,evidenceUrls:[url]},clarification:null},evidenceVerified:true};
    }};
}
test('fixed held-out manifest has 20 synthetic intent and 18 public-company cases',()=>{
  const {manifest,sha256}=fixedQualificationManifest();
  assert.equal(manifest.intent.cases.length,20);assert.equal(manifest.company.cases.length,18);assert.match(sha256,/^[a-f0-9]{64}$/);
  assert.equal(manifest.company.cases.filter(entry=>entry.expectedStatus==='clarification').length,2);
  assert.equal(manifest.company.cases.filter(entry=>entry.expectedDomain&&entry.domain===undefined).length,4);
  const altered=structuredClone(manifest);altered.company.cases[1].id=altered.company.cases[0].id;
  assert.throws(()=>validateQualificationManifest(altered),/unavailable/);
  const noDiscovery=structuredClone(manifest);noDiscovery.company.cases.find(entry=>entry.id==='shopify').domain='shopify.com';
  assert.throws(()=>validateQualificationManifest(noDiscovery),/unavailable/);
});
test('fake product-model path scores exact requirements and emits only redacted counters',async()=>{
  const {manifest}=fixedQualificationManifest(),observer=createQualificationObserver();
  const records=[],report=await evaluateQualification({manifest,model:fakeModel(manifest,observer),observer,onCase:record=>records.push(record)});
  assert.equal(report.passed,false);assert.equal(report.intent.cases,20);assert.equal(report.company.cases,18);
  assert.equal(report.intent.correct,20);assert.equal(report.company.correct,16);assert.equal(report.company.manualReviewPending,2);
  assert.equal(report.company.nameOnlyDiscoveryCases,4);assert.equal(report.company.nameOnlyDiscoveryObserved,4);
  assert.equal(report.cases.find(record=>record.id==='cloudflare'&&record.repeatIndex===0).webStarts,1);
  const final=applyQualificationReview({manifest,report,receipt:reviewReceipt(report,true)});
  assert.equal(final.passed,true);assert.equal(final.company.correct,18);assert.equal(final.company.manualReviewPending,0);
  assert.match(final.manualReviewSha256,/^[a-f0-9]{64}$/);
  assert.equal(report.intent.usage.outputTokens,160);assert.equal(report.company.usage.outputTokens,144);
  assert.equal(records.length,42);assert.equal(JSON.stringify(report).includes('Jobs at Acme Labs'),false);
  assert.equal(JSON.stringify(report).includes('Which Mercury company do you mean?'),false);
  assert.equal(report.intent.cost,null);assert.equal(report.company.cost,null);
  assert.equal(report.intent.repeats,2);assert.equal(report.company.repeats,2);
});
test('a name-only candidate with no observed native web start cannot pass',async()=>{
  const {manifest}=fixedQualificationManifest(),observer=createQualificationObserver();
  const report=await evaluateQualification({manifest,model:fakeModel(manifest,observer,{zeroDiscoveryCaseId:'cloudflare'}),observer});
  assert.equal(report.passed,false);assert.equal(report.company.cases,18);
  assert.equal(report.company.nameOnlyDiscoveryCases,4);assert.equal(report.company.nameOnlyDiscoveryObserved,3);
  assert.equal(report.cases.find(record=>record.id==='cloudflare').correct,true);
  assert.equal(report.cases.find(record=>record.id==='cloudflare').webStarts,0);
  const final=applyQualificationReview({manifest,report,receipt:reviewReceipt(report,true)});
  assert.equal(final.company.correct,18);assert.equal(final.company.manualReviewPending,0);
  assert.equal(final.company.passed,false);assert.equal(final.passed,false);
});
test('name-only repeats with no observed native web start cannot pass',async()=>{
  const {manifest}=fixedQualificationManifest(),observer=createQualificationObserver();
  const report=await evaluateQualification({manifest,model:fakeModel(manifest,observer,{zeroDiscoveryRepeatsFor:'cloudflare'}),observer});
  assert.deepEqual(report.cases.filter(record=>record.id==='cloudflare').map(record=>record.webStarts),[1,0,0]);
  assert.equal(report.company.cases,18);assert.equal(report.company.nameOnlyDiscoveryObserved,4);
  assert.equal(report.company.repeats,2);assert.equal(report.company.repeatConsistent,false);
  const final=applyQualificationReview({manifest,report,receipt:reviewReceipt(report,true)});
  assert.equal(final.company.correct,18);assert.equal(final.company.manualReviewPending,0);
  assert.equal(final.company.passed,false);assert.equal(final.passed,false);
});
test('held-out qualification accepts only the exact verified www domain variant',async()=>{
  const {manifest}=fixedQualificationManifest();
  for(const [domain,correct] of [['www.cloudflare.com',true],['www.cloudflare.com.other.com',false]]){
    const observer=createQualificationObserver(),base=fakeModel(manifest,observer);
    const model={...base,async resolveCompany(input){
      const result=await base.resolveCompany(input);
      if(input.input==='Cloudflare')result.data.candidate.domain=domain;
      return result;
    }};
    const report=await evaluateQualification({manifest,model,observer});
    const cases=report.cases.filter(record=>record.id==='cloudflare');
    assert.equal(cases.length,3);
    assert.ok(cases.every(record=>record.correct===correct&&record.discoveryRequired&&record.webStarts>=1));
  }
});
test('intent normalization gets one bounded service-style repair and aggregates both attempts',async()=>{
  const {manifest}=fixedQualificationManifest(),observer=createQualificationObserver(),base=fakeModel(manifest,observer);
  let first=true,repairObserved=false;
  const model={...base,async interpretIntent(input){
    if(input.query==='Backend roles'&&first){
      first=false;observer.onReply({schemaId:'intent',toolCalls:0,usage});
      observer.onMetric({kind:'search_intent',code:'succeeded',durationMs:25,usage});
      const invalid=intentAnswer(manifest.intent.cases[0]);invalid.requirements[0].bindings=[];return invalid;
    }
    if(input.query==='Backend roles'&&input.repair)repairObserved=true;
    return base.interpretIntent(input);
  }};
  const report=await evaluateQualification({manifest,model,observer});
  assert.equal(report.passed,false);assert.equal(repairObserved,true);
  assert.equal(applyQualificationReview({manifest,report,receipt:reviewReceipt(report,true)}).passed,true);
  assert.equal(report.cases[0].attempts,2);assert.equal(report.cases[0].usage.outputTokens,16);
});
test('unsafe identity or missing numeric broker reply fails the qualification gate',async()=>{
  const {manifest}=fixedQualificationManifest();
  const unsafeObserver=createQualificationObserver();
  const unsafe=await evaluateQualification({manifest,model:fakeModel(manifest,unsafeObserver,{unsafe:true}),observer:unsafeObserver});
  assert.equal(unsafe.passed,false);assert.equal(unsafe.company.guessedAmbiguous,1);assert.equal(unsafe.company.cases,17);
  const missingObserver=createQualificationObserver();
  const missing=await evaluateQualification({manifest,model:fakeModel(manifest,missingObserver,{missingCounter:true}),observer:missingObserver});
  assert.equal(missing.passed,false);assert.equal(missing.intent.countersComplete,false);
  const malformed=createQualificationObserver();malformed.begin('company','synthetic');
  assert.throws(()=>malformed.onReply({schemaId:'company',toolCalls:3,usage}),/unavailable/);
  assert.equal(malformed.end().webStarts,null);
});
test('ambiguous replies need independent review; declarative and irrelevant replies never auto-pass',async()=>{
  const {manifest}=fixedQualificationManifest();
  for(const clarification of [
    ()=>'Please try again tomorrow.',
    entry=>`I will tell the ${entry.expectedSubject} company tomorrow.`,
    entry=>`What is the ${entry.expectedSubject} company doing tomorrow?`,
    ()=>'Which company do you mean?',
    ()=>'Which Other company do you mean?'
  ]){
    const observer=createQualificationObserver();
    const report=await evaluateQualification({manifest,model:fakeModel(manifest,observer,{clarification}),observer});
    assert.equal(report.passed,false,clarification.toString());
    assert.equal(report.company.correct,16,clarification.toString());
    assert.equal(report.company.cases,18,clarification.toString());
    const ambiguous=report.cases.filter(record=>record.kind==='company'&&!record.correct);
    assert.deepEqual(ambiguous.map(record=>record.id),['ambiguous-mercury','ambiguous-atlas']);
    if(report.company.manualReviewPending===2){
      const final=applyQualificationReview({manifest,report,receipt:reviewReceipt(report,false)});
      assert.equal(final.passed,false);assert.equal(final.company.correct,16);assert.equal(final.company.manualReviewPending,0);
    }else assert.equal(report.company.manualReviewPending,0);
  }
  const observer=createQualificationObserver();
  const report=await evaluateQualification({manifest,model:fakeModel(manifest,observer,{clarification:entry=>`Could you share the official website for the ${entry.expectedSubject} company you mean?`}),observer});
  assert.equal(report.passed,false);assert.equal(report.company.correct,16);assert.equal(report.company.manualReviewPending,2);
  const receipt=reviewReceipt(report,true);
  assert.equal(applyQualificationReview({manifest,report,receipt}).passed,true);
  assert.throws(()=>applyQualificationReview({manifest,report,receipt:{...receipt,reportSha256:'a'.repeat(64)}}),/unavailable/);
  assert.throws(()=>applyQualificationReview({manifest,report,receipt:{...receipt,cases:[{...receipt.cases[0],clarificationSha256:'a'.repeat(64)},receipt.cases[1]]}}),/unavailable/);
});
test('one-use grant binds exact identity, manifest and a five-minute start window',()=>{
  const identity={sourceCommit:'a'.repeat(40),buildIdentity:'b'.repeat(64),hostPlanSha256:'c'.repeat(64),manifestSha256:'d'.repeat(64)};
  const grant={schemaVersion:2,kind:'luna_qualification_once',runId:'e'.repeat(32),...identity,
    notBefore:'2026-11-04T06:00:00Z',expiresAt:'2026-11-04T06:04:00Z',reviewPublicKey:'synthetic'};
  assert.deepEqual(validateQualificationGrant(grant,{...identity,now:Date.parse('2026-11-04T06:01:00Z')}),grant);
  assert.throws(()=>validateQualificationGrant(grant,{...identity,manifestSha256:'f'.repeat(64),now:Date.parse('2026-11-04T06:01:00Z')}),/unavailable/);
  assert.throws(()=>validateQualificationGrant(grant,{...identity,now:Date.parse('2026-11-04T06:04:00Z')}),/unavailable/);
  assert.throws(()=>validateQualificationGrant({...grant,expiresAt:'2026-11-04T06:06:00Z'},{...identity,now:Date.parse('2026-11-04T06:01:00Z')}),/unavailable/);
});
test('sealed clarifications open only for their registered reviewer and exact rooted report',async()=>{
  const {manifest,sha256:manifestSha256}=fixedQualificationManifest();
  const observer=createQualificationObserver(),answers=[];
  const report=await evaluateQualification({manifest,model:fakeModel(manifest,observer),observer,
    onClarification(item){answers.push(item);}});
  assert.equal(answers.length,2);
  const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:3072});
  const encoded=publicKey.export({format:'der',type:'spki'}).toString('base64');
  const reviewer=qualificationReviewKey(encoded);
  const header={kind:'luna_qualification_start',version:2,runId:'a'.repeat(32),
    sourceCommit:'b'.repeat(40),buildIdentity:'c'.repeat(64),hostPlanSha256:'d'.repeat(64),
    manifestSha256,grantSha256:'e'.repeat(64),reviewKeySha256:reviewer.sha256};
  const sealed=sealQualificationAnswers(header,report,answers,reviewer);
  const reportSha256=qualificationReportSha(report);
  const bytes=Buffer.from([header,...report.cases.map(record=>({kind:'case',record})),sealed,
    {kind:'summary',passed:report.passed,intent:report.intent,company:report.company,totals:report.totals,reportSha256}]
    .map(record=>JSON.stringify(record)).join('\n')+'\n');
  assert.ok(answers.every(({answer})=>!bytes.includes(answer)));
  const {kind,version,...identity}=header;
  const receipt={...identity,reportSha256,resultSha256:sha(bytes)};
  const evidence=parseQualificationResult(bytes,receipt);
  const key=privateKey.export({format:'pem',type:'pkcs8'});
  assert.deepEqual(openQualificationAnswers(evidence,key),answers);
  assert.throws(()=>parseQualificationResult(bytes,{...receipt,buildIdentity:'0'.repeat(64)}));
  assert.throws(()=>parseQualificationResult(Buffer.concat([bytes,Buffer.from('\n')]),receipt));
  assert.throws(()=>openQualificationAnswers({...evidence,header:{...header,runId:'0'.repeat(32)}},key));
  const modifiedCipher=Buffer.from(sealed.ciphertext,'base64');
  modifiedCipher[0]^=1;
  assert.throws(()=>openQualificationAnswers({...evidence,sealed:{...sealed,ciphertext:modifiedCipher.toString('base64')}},key));
  assert.throws(()=>openQualificationAnswers(evidence,generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'})));
  const decisions={resultSha256:receipt.resultSha256,reportSha256,
    cases:answers.map(({id,clarificationSha256})=>({id,clarificationSha256,approved:true}))};
  const finalized=finalizeQualificationReview({evidence,answers,decisions,manifest,receipt});
  assert.equal(finalized.report.passed,true);
  assert.deepEqual(finalized.operatorReceipt,receipt);
  assert.ok(answers.every(({answer})=>!JSON.stringify(finalized).includes(answer)));
  assert.throws(()=>finalizeQualificationReview({evidence,answers,decisions:{...decisions,cases:decisions.cases.slice(1)},manifest,receipt}));
  assert.throws(()=>finalizeQualificationReview({evidence,answers,decisions:{...decisions,resultSha256:'0'.repeat(64)},manifest,receipt}));
  decisions.cases[0].approved=false;
  assert.equal(finalizeQualificationReview({evidence,answers,decisions,manifest,receipt}).report.passed,false);
});
test('qualification rejects a plain shell even with an apparent launch environment',async()=>{
  const cgroup='0::/justup.slice/justup-preview.slice/justup-preview-luna-qualification.service\n';
  const hardened='CapEff:\t0000000000000000\nNoNewPrivs:\t1\n';
  assert.equal(inQualificationSandbox(cgroup,hardened),true);
  assert.equal(inQualificationSandbox(cgroup.replace('luna-qualification','runner'),hardened),false);
  assert.equal(inQualificationSandbox(cgroup,hardened.replace('NoNewPrivs:\t1','NoNewPrivs:\t0')),false);
  await assert.rejects(runQualificationCli(),/unavailable/);
});
