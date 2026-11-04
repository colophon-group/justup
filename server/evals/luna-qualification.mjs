// Fixed, redacted Luna quality measurement. The queue UID owns execution;
// this module has no socket, credential, host or provider entrypoint by itself.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { compileIntent,intentCapabilities,intentModelInput } from '../intent.mjs';
import { validateModelData } from '../model-runner.mjs';

const MANIFEST_URL=new URL('./luna-qualification-v1.json',import.meta.url);
const INTENT_SCHEMA=JSON.parse(readFileSync(new URL('../model-schemas/intent.schema.json',import.meta.url)));
const FILTERS=new Set(['companyInclude','companyExclude','titleAny','bodyAll','bodyNone','locations','workplaces','employmentTypes','postingLanguages','seniority']);
const SAFE_CODES=new Set(['dependency_unavailable','provider_unavailable','invalid_input','invalid_output','task_timeout','output_limit','tool_limit','tool_not_allowed','token_limit','task_limit']);
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fold=value=>value.normalize('NFKC').toLocaleLowerCase('en');
const fail=()=>{throw new Error('Luna qualification manifest is unavailable.');};

export function fixedQualificationManifest(){
  const bytes=readFileSync(MANIFEST_URL);
  if(bytes.length<1||bytes.length>64_000)fail();
  const manifest=JSON.parse(bytes);
  validateQualificationManifest(manifest);
  return {manifest,sha256:sha(bytes)};
}

export function validateQualificationManifest(manifest){
  if(!plain(manifest)||Object.keys(manifest).sort().join(',')!=='company,intent,purpose,repeats,version'||manifest.version!==1||typeof manifest.purpose!=='string'||!plain(manifest.intent)||!plain(manifest.company)||!plain(manifest.repeats))fail();
  const seen=new Set();
  for(const [kind,count] of [['intent',20],['company',18]]){
    const section=manifest[kind];
    if(!Array.isArray(section.cases)||section.cases.length!==count||section.minimumCases!==count||section.minimumAccuracy!==0.95||section.maximumP95LatencyMs!==(kind==='intent'?30_000:60_000))fail();
    for(const entry of section.cases){
      if(!plain(entry)||typeof entry.id!=='string'||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id)||seen.has(entry.id))fail();
      seen.add(entry.id);
      if(kind==='intent'){
        if(Object.keys(entry).sort().join(',')!=='expected,id,query'||typeof entry.query!=='string'||!entry.query.trim()||entry.query.length>300||!plain(entry.expected)||!plain(entry.expected.filters)||!Array.isArray(entry.expected.terms)||!entry.expected.terms.length||entry.expected.terms.some(term=>typeof term!=='string'||!term.trim()||term.length>80)||Object.keys(entry.expected).some(key=>!['filters','terms','unsatisfied'].includes(key))||entry.expected.unsatisfied!==undefined&&entry.expected.unsatisfied!==true)fail();
        for(const [key,values] of Object.entries(entry.expected.filters))if(!FILTERS.has(key)||!Array.isArray(values)||!values.length||values.length>8||values.some(value=>typeof value!=='string'||!value.trim()||value.length>100))fail();
      }else{
        if(typeof entry.input!=='string'||!entry.input.trim()||entry.input.length>300||Object.keys(entry).some(key=>!['id','input','domain','expectedDomain','expectedStatus'].includes(key))||Boolean(entry.expectedDomain)===Boolean(entry.expectedStatus)||entry.expectedDomain!==undefined&&(entry.domain!==entry.expectedDomain||!/^[a-z0-9.-]+$/.test(entry.domain))||entry.expectedStatus!==undefined&&(entry.expectedStatus!=='clarification'||entry.domain!==undefined))fail();
      }
    }
  }
  if(manifest.intent.maximumUnsafeAcceptance!==0||manifest.intent.maximumDroppedRequirements!==0||manifest.company.maximumGuessedAmbiguous!==0||manifest.company.maximumUnverifiedCandidate!==0)fail();
  if(Object.keys(manifest.repeats).sort().join(',')!=='additionalRuns,companyCaseId,intentCaseId'||manifest.repeats.additionalRuns!==2
    ||!manifest.intent.cases.some(entry=>entry.id===manifest.repeats.intentCaseId)
    ||!manifest.company.cases.some(entry=>entry.id===manifest.repeats.companyCaseId))fail();
  return manifest;
}

// The same compiler catalogue shape used by product search, with no user or
// production job data. Its small fixed values make every expected binding
// attributable to a synthetic field rather than an inferred eligibility claim.
export function qualificationCapabilities(){
  return intentCapabilities([
    {companyId:'acme-labs',companyName:'Acme Labs',companySlug:'acme-labs',locations:[{name:'Zurich, Switzerland',workplace:'remote'},{name:'Berlin, Germany',workplace:'hybrid'}],employmentTypes:['full-time'],locales:['en','de'],seniority:{id:'senior',name:'Senior'}},
    {companyId:'redwood-health',companyName:'Redwood Health',companySlug:'redwood-health',locations:[{name:'Berlin, Germany',workplace:'remote'},{name:'Zurich, Switzerland',workplace:'hybrid'}],employmentTypes:['contract'],locales:['en','de'],seniority:{id:'junior',name:'Junior'}}
  ],false);
}

export function createQualificationObserver(){
  let current=null;
  return {
    begin(kind,id){if(current)throw new Error('A Luna case is already active.');current={kind,id,replies:[],metrics:[]};},
    onReply(value){
      if(!current||!plain(value)||value.schemaId!==(current.kind==='intent'?'intent':'company')||!Number.isSafeInteger(value.toolCalls)||value.toolCalls<0||value.toolCalls>(current.kind==='intent'?0:2)||!plain(value.usage)||current.replies.length>=(current.kind==='intent'?2:1))throw new Error('Luna broker reply counters are unavailable.');
      current.replies.push({toolCalls:value.toolCalls});
    },
    onMetric(value){
      if(!current||current.metrics.length>=(current.kind==='intent'?2:1)||!plain(value)||value.kind!==(current.kind==='intent'?'search_intent':'company_resolution')||!Number.isSafeInteger(value.durationMs)||value.durationMs<0||typeof value.code!=='string')throw new Error('Luna model counters are unavailable.');
      const usage=value.usage;
      if(usage!==null&&(!plain(usage)||['inputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens'].some(key=>!Number.isSafeInteger(usage[key])||usage[key]<0)))throw new Error('Luna model usage is unavailable.');
      current.metrics.push({durationMs:value.durationMs,code:SAFE_CODES.has(value.code)||value.code==='succeeded'?value.code:'provider_unavailable',usage:usage===null?null:Object.fromEntries(['inputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens'].map(key=>[key,usage[key]]))});
    },
    end(){
      if(!current)throw new Error('No Luna case is active.');
      const complete=current.metrics.length>0&&current.metrics.length===current.replies.length&&current.metrics.every(metric=>metric.usage!==null&&metric.code==='succeeded');
      const usage=complete?Object.fromEntries(['inputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens'].map(key=>[key,current.metrics.reduce((sum,metric)=>sum+metric.usage[key],0)])):null;
      const result={durationMs:current.metrics.reduce((sum,metric)=>sum+metric.durationMs,0),usage,
        webStarts:complete?current.replies.reduce((sum,reply)=>sum+reply.toolCalls,0):null,
        metricObserved:complete,attempts:current.metrics.length};
      current=null;return result;
    }
  };
}

const filtersEqual=(actual,expected)=>{
  if(!plain(actual)||Object.keys(actual).sort().join(',')!==Object.keys(expected).sort().join(','))return false;
  return Object.entries(expected).every(([key,values])=>Array.isArray(actual[key])&&JSON.stringify([...actual[key]].sort())===JSON.stringify([...values].sort()));
};
function scoreIntent(raw,entry,caps){
  const compiled=compileIntent(raw,caps,{query:entry.query});
  if(!compiled.ok)return {correct:false,unsafeAcceptance:false,droppedRequirements:true,normalization:'rejected',feedback:[...new Set(compiled.diagnostics.map(item=>item.code))].sort().slice(0,8)};
  const requirements=compiled.value.requirements;
  const dropped=entry.expected.terms.some(term=>!requirements.some(item=>fold(item.text).includes(fold(term))&&item.handling!=='preference'));
  const warning=compiled.value.warnings.length>0;
  const correct=filtersEqual(compiled.value.configuration.filters,entry.expected.filters)&&warning===Boolean(entry.expected.unsatisfied)&&!dropped;
  return {correct,unsafeAcceptance:Boolean(entry.expected.unsatisfied)&&!warning,droppedRequirements:dropped,normalization:'accepted',feedback:[]};
}
function scoreCompany(value,entry){
  const data=value?.data,evidenceVerified=value?.evidenceVerified===true;
  if(entry.expectedStatus==='clarification'){
    const correct=data?.status==='clarification'&&data?.candidate===null&&typeof data?.clarification==='string'&&data.clarification.trim().length>0;
    return {correct,guessedAmbiguous:data?.status==='candidate',unverifiedCandidate:data?.status==='candidate'&&!evidenceVerified,normalization:correct?'clarification':'incorrect',feedback:[]};
  }
  const correct=data?.status==='candidate'&&evidenceVerified&&data?.candidate?.domain===entry.expectedDomain;
  return {correct,guessedAmbiguous:false,unverifiedCandidate:data?.status==='candidate'&&!evidenceVerified,normalization:correct?'candidate':'incorrect',feedback:[]};
}
const percentile95=values=>values.length?[...values].sort((a,b)=>a-b)[Math.ceil(values.length*0.95)-1]:null;
function aggregate(records,kind,section,repeatCaseId){
  const values=records.filter(record=>record.kind===kind&&record.repeatIndex===0),accuracy=values.filter(record=>record.correct).length/section.minimumCases;
  const repeats=records.filter(record=>record.kind===kind&&record.repeatIndex>0),base=values.find(record=>record.id===repeatCaseId);
  const repeatConsistent=Boolean(base?.correct)&&repeats.length===2&&repeats.every(record=>record.id===repeatCaseId&&record.correct&&record.normalization===base.normalization&&record.metricObserved&&record.webStarts!==null);
  const repeatDurations=[base,...repeats].filter(Boolean).map(record=>record.durationMs);
  const repeatLatencyRangeMs=repeatDurations.length===3?Math.max(...repeatDurations)-Math.min(...repeatDurations):null;
  const usage=Object.fromEntries(['inputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens'].map(key=>[key,values.reduce((sum,record)=>sum+(record.usage?.[key]??0),0)]));
  const p95LatencyMs=percentile95(values.map(record=>record.durationMs).filter(Number.isSafeInteger));
  const unsafeAcceptance=values.filter(record=>record.unsafeAcceptance).length,droppedRequirements=values.filter(record=>record.droppedRequirements).length;
  const guessedAmbiguous=values.filter(record=>record.guessedAmbiguous).length,unverifiedCandidate=values.filter(record=>record.unverifiedCandidate).length;
  const countersComplete=values.every(record=>record.metricObserved&&record.webStarts!==null&&record.usage!==null);
  const passed=values.length===section.minimumCases&&accuracy>=section.minimumAccuracy&&p95LatencyMs!==null&&p95LatencyMs<=section.maximumP95LatencyMs&&countersComplete&&repeatConsistent&&
    (kind==='intent'?unsafeAcceptance===0&&droppedRequirements===0&&values.every(record=>record.webStarts===0):guessedAmbiguous===0&&unverifiedCandidate===0&&values.every(record=>record.webStarts<=2));
  return {cases:values.length,correct:values.filter(record=>record.correct).length,accuracy,p95LatencyMs,unsafeAcceptance,droppedRequirements,guessedAmbiguous,unverifiedCandidate,countersComplete,
    repeats:repeats.length,repeatConsistent,repeatLatencyRangeMs,usage,cost:null,passed};
}

export async function evaluateQualification({manifest,model,observer,onCase=()=>{},now=()=>performance.now()}){
  validateQualificationManifest(manifest);
  if(!model?.available?.('search_intent')||!model?.available?.('company_resolution'))throw new Error('Both attested Luna profiles are required for qualification.');
  const caps=qualificationCapabilities(),records=[];
  async function runCase(kind,entry,repeatIndex){
    observer.begin(kind,entry.id);const started=now();let score,code='provider_unavailable';
    try{
      if(kind==='intent'){
        let raw,compiled,previous;
        for(let attempt=0;attempt<2;attempt++){
          raw=await model.interpretIntent(intentModelInput({query:entry.query,prior:null,capabilities:caps,...(attempt?{repair:{diagnostics:compiled.diagnostics,previous}}:{})}));
          compiled=compileIntent(raw,caps,{query:entry.query});
          if(compiled.ok)break;
          previous=validateModelData(raw,INTENT_SCHEMA).length?null:raw;
        }
        score=scoreIntent(raw,entry,caps);
      }else score=scoreCompany(await model.resolveCompany({input:entry.input,domain:entry.domain??null,careerUrl:null,scope:null}),entry);
      code='succeeded';
    }catch(error){score={correct:false,unsafeAcceptance:false,droppedRequirements:kind==='intent',guessedAmbiguous:false,unverifiedCandidate:false,normalization:'failed',feedback:[]};code=SAFE_CODES.has(error?.code)?error.code:'provider_unavailable';}
    const observed=observer.end(),durationMs=observed.durationMs??Math.max(0,Math.round(now()-started));
    const record={id:entry.id,kind,repeatIndex,code,correct:score.correct,unsafeAcceptance:score.unsafeAcceptance??false,droppedRequirements:score.droppedRequirements??false,
      guessedAmbiguous:score.guessedAmbiguous??false,unverifiedCandidate:score.unverifiedCandidate??false,normalization:score.normalization,feedback:score.feedback,
      durationMs,attempts:observed.attempts,webStarts:observed.webStarts,metricObserved:observed.metricObserved,usage:observed.usage??null};
    records.push(record);await onCase(record);
    return code==='succeeded'&&observed.metricObserved&&observed.webStarts!==null&&observed.usage!==null&&record.normalization!=='rejected'&&!record.unsafeAcceptance&&!record.droppedRequirements&&!record.guessedAmbiguous&&!record.unverifiedCandidate;
  }
  let safe=true;
  for(const [kind,cases] of [['intent',manifest.intent.cases],['company',manifest.company.cases]])for(const entry of cases)if(safe)safe=await runCase(kind,entry,0);
  for(const [kind,id] of [['intent',manifest.repeats.intentCaseId],['company',manifest.repeats.companyCaseId]]){
    const entry=manifest[kind].cases.find(item=>item.id===id);
    for(let index=1;index<=manifest.repeats.additionalRuns&&safe;index++)safe=await runCase(kind,entry,index);
  }
  const intent=aggregate(records,'intent',manifest.intent,manifest.repeats.intentCaseId),company=aggregate(records,'company',manifest.company,manifest.repeats.companyCaseId);
  const usage=Object.fromEntries(['inputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens'].map(key=>[key,records.reduce((sum,record)=>sum+(record.usage?.[key]??0),0)]));
  const totals={calls:records.reduce((sum,record)=>sum+record.attempts,0),durationMs:records.reduce((sum,record)=>sum+record.durationMs,0),
    webStarts:records.every(record=>record.webStarts!==null)?records.reduce((sum,record)=>sum+record.webStarts,0):null,usage,cost:null};
  return {version:1,kind:'luna_qualification',passed:intent.passed&&company.passed,intent,company,totals,cases:records};
}
