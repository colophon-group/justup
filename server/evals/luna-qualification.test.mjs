// Provider-free qualification contracts. No socket, credentials or host calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { applyQualificationReview,createQualificationObserver,evaluateQualification,fixedQualificationManifest,validateQualificationManifest } from './luna-qualification.mjs';
import { runQualificationCli,validateQualificationGrant } from './luna-qualification-cli.mjs';

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
function fakeModel(manifest,observer,{unsafe=false,missingCounter=false,clarification=null}={}){
  const measured=(kind,webStarts)=>{
    if(!missingCounter)observer.onReply({schemaId:kind,toolCalls:webStarts,usage});
    observer.onMetric({kind:kind==='intent'?'search_intent':'company_resolution',code:'succeeded',durationMs:25,usage});
  };
  return {available:()=>true,
    async interpretIntent(input){const entry=manifest.intent.cases.find(item=>item.query===input.query);measured('intent',0);return intentAnswer(entry);},
    async resolveCompany(input){const entry=manifest.company.cases.find(item=>item.input===input.input);measured('company',entry.expectedStatus?1:0);
      if(entry.expectedStatus)return unsafe?{data:{status:'candidate',candidate:{domain:'wrong.example'},clarification:null},evidenceVerified:false}:{data:{status:'clarification',candidate:null,clarification:typeof clarification==='function'?clarification(entry):clarification??`Which ${entry.expectedSubject} company do you mean?`},evidenceVerified:false};
      const url=`https://${entry.expectedDomain}/`;
      return {data:{status:'candidate',candidate:{name:entry.input,domain:entry.expectedDomain,websiteUrl:url,evidenceUrls:[url]},clarification:null},evidenceVerified:true};
    }};
}
test('fixed held-out manifest has 20 synthetic intent and 18 public-company cases',()=>{
  const {manifest,sha256}=fixedQualificationManifest();
  assert.equal(manifest.intent.cases.length,20);assert.equal(manifest.company.cases.length,18);assert.match(sha256,/^[a-f0-9]{64}$/);
  assert.equal(manifest.company.cases.filter(entry=>entry.expectedStatus==='clarification').length,2);
  const altered=structuredClone(manifest);altered.company.cases[1].id=altered.company.cases[0].id;
  assert.throws(()=>validateQualificationManifest(altered),/unavailable/);
});
test('fake product-model path scores exact requirements and emits only redacted counters',async()=>{
  const {manifest}=fixedQualificationManifest(),observer=createQualificationObserver();
  const records=[],report=await evaluateQualification({manifest,model:fakeModel(manifest,observer),observer,onCase:record=>records.push(record)});
  assert.equal(report.passed,false);assert.equal(report.intent.cases,20);assert.equal(report.company.cases,18);
  assert.equal(report.intent.correct,20);assert.equal(report.company.correct,16);assert.equal(report.company.manualReviewPending,2);
  const final=applyQualificationReview({manifest,report,receipt:reviewReceipt(report,true)});
  assert.equal(final.passed,true);assert.equal(final.company.correct,18);assert.equal(final.company.manualReviewPending,0);
  assert.match(final.manualReviewSha256,/^[a-f0-9]{64}$/);
  assert.equal(report.intent.usage.outputTokens,160);assert.equal(report.company.usage.outputTokens,144);
  assert.equal(records.length,42);assert.equal(JSON.stringify(report).includes('Jobs at Acme Labs'),false);
  assert.equal(JSON.stringify(report).includes('Which Mercury company do you mean?'),false);
  assert.equal(report.intent.cost,null);assert.equal(report.company.cost,null);
  assert.equal(report.intent.repeats,2);assert.equal(report.company.repeats,2);
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
  const grant={schemaVersion:1,kind:'luna_qualification_once',runId:'e'.repeat(32),...identity,notBefore:'2026-11-04T06:00:00Z',expiresAt:'2026-11-04T06:04:00Z'};
  assert.deepEqual(validateQualificationGrant(grant,{...identity,now:Date.parse('2026-11-04T06:01:00Z')}),grant);
  assert.throws(()=>validateQualificationGrant(grant,{...identity,manifestSha256:'f'.repeat(64),now:Date.parse('2026-11-04T06:01:00Z')}),/unavailable/);
  assert.throws(()=>validateQualificationGrant(grant,{...identity,now:Date.parse('2026-11-04T06:04:00Z')}),/unavailable/);
  assert.throws(()=>validateQualificationGrant({...grant,expiresAt:'2026-11-04T06:06:00Z'},{...identity,now:Date.parse('2026-11-04T06:01:00Z')}),/unavailable/);
});
test('live qualification remains blocked before host, credential or provider access',async()=>{
  await assert.rejects(runQualificationCli(),/unavailable/);
});
