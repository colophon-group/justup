// Operator-reviewed synthetic/redacted examples and provider-free comparisons.
// No user text is sampled here; private review candidates contain references only.
import { boundedJson, DAY_MS } from './store.mjs';

export const CASE_RETENTION_MS=180*DAY_MS;
const TASKS=['search_intent','ai_match','company_resolution'];
const token=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>plain(value)&&Object.keys(value).every(key=>keys.includes(key));
const canonical=value=>Array.isArray(value)?value.map(canonical):plain(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const fail=()=>{throw new TypeError('Invalid reviewed evaluation data.');};
const finite=value=>Number.isSafeInteger(value)&&value>=0&&value<=1_000_000_000_000;
function checkedOutput(task,value) {
  const fields={search_intent:['outcome','configuration'],ai_match:['decision'],company_resolution:['outcome','identity']}[task];
  if(!exact(value,fields))fail();
  if(task==='ai_match'?!['accept','reject','insufficient_evidence'].includes(value.decision):!({search_intent:['accepted','warning','invalid'],company_resolution:['candidate','clarification','unresolved']}[task].includes(value.outcome)))fail();
  if(value.configuration!==undefined&&!plain(value.configuration)||value.identity!==undefined&&(!token(value.identity)||value.outcome!=='candidate'))fail();
  return value;
}
export function checkedCase(value) {
  if(!exact(value,['id','version','task','split','status','source','consent','provenance','input','expected'])||Object.keys(value).length!==10||!token(value.id)||!Number.isSafeInteger(value.version)||value.version<1||value.version>1000||!TASKS.includes(value.task)||!['tuning','heldout'].includes(value.split)||!['draft','reviewed','rejected'].includes(value.status)||!['synthetic','operator_redacted'].includes(value.source)||value.consent!==(value.source==='synthetic'?'not_applicable':'reviewed')||!token(value.provenance))fail();
  const inputKeys={search_intent:['query','context','priorConfiguration','proposedOutput'],ai_match:['condition','evidence'],company_resolution:['hint','catalogue']}[value.task];
  if(!exact(value.input,inputKeys)||!Object.keys(value.input).length)fail();
  checkedOutput(value.task,value.expected);boundedJson(value,16_384);return value;
}
export function createEvaluationRecords({db,now=Date.now,erase,ownerAuthority}={}) {
  db.exec(`CREATE TABLE IF NOT EXISTS justup_evaluation_cases(id TEXT NOT NULL,version INTEGER NOT NULL,task TEXT NOT NULL,split TEXT NOT NULL,status TEXT NOT NULL,case_json TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(id,version)) STRICT;
    CREATE TABLE IF NOT EXISTS justup_evaluation_candidates(owner_id TEXT NOT NULL,reference_id TEXT NOT NULL,revision INTEGER NOT NULL,task TEXT NOT NULL,reason TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(owner_id,reference_id,revision,reason)) STRICT;`);
  function cleanup() {
    if(db.prepare('SELECT 1 FROM justup_evaluation_candidates WHERE at<=? LIMIT 1').get(now()-7*DAY_MS)||db.prepare('SELECT 1 FROM justup_evaluation_cases WHERE created_at<=? LIMIT 1').get(now()-CASE_RETENTION_MS))erase(()=>{db.prepare('DELETE FROM justup_evaluation_candidates WHERE at<=?').run(now()-7*DAY_MS);db.prepare('DELETE FROM justup_evaluation_cases WHERE created_at<=?').run(now()-CASE_RETENTION_MS);});
  }
  function importCase(value) {
    const record=checkedCase(value),json=boundedJson(record,16_384);
    const old=db.prepare('SELECT case_json FROM justup_evaluation_cases WHERE id=? AND version=?').get(record.id,record.version);
    if(old){if(old.case_json!==json)fail();return false;}
    if(db.prepare('SELECT count(*) n FROM justup_evaluation_cases').get().n>=200)throw new Error('Evaluation collection is full.');
    const prior=db.prepare('SELECT version,task,split FROM justup_evaluation_cases WHERE id=? ORDER BY version DESC LIMIT 1').get(record.id);
    if(prior&&(record.version<=prior.version||record.task!==prior.task||record.split!==prior.split))fail();
    db.prepare('INSERT INTO justup_evaluation_cases VALUES(?,?,?,?,?,?,?)').run(record.id,record.version,record.task,record.split,record.status,json,now());return true;
  }
  function stage({ownerId,referenceId,revision,task,reason}) {
    try {
      if(!token(ownerId)||!token(referenceId)||!Number.isSafeInteger(revision)||revision<0||!TASKS.includes(task)||!['edit_requires_review','candidate_rejected'].includes(reason)||!ownerAuthority(ownerId,{allowUnavailable:true}))return false;
      if(db.prepare('SELECT count(*) n FROM justup_evaluation_candidates').get().n>=200)return false;
      return db.prepare('INSERT OR IGNORE INTO justup_evaluation_candidates VALUES(?,?,?,?,?,?)').run(ownerId,referenceId,revision,task,reason,now()).changes===1;
    }catch{return false;}
  }
  function deleteAccountData(owner){db.prepare('DELETE FROM justup_evaluation_candidates WHERE owner_id=?').run(owner);}
  function deleteReference(owner,id){db.prepare('DELETE FROM justup_evaluation_candidates WHERE owner_id=? AND reference_id=?').run(owner,id);}
  function transferOwner(from,to){db.prepare('UPDATE OR IGNORE justup_evaluation_candidates SET owner_id=? WHERE owner_id=?').run(to,from);deleteAccountData(from);}
  return {importCase,stage,cleanup,deleteAccountData,deleteReference,transferOwner,exportCases:()=>exportCases({db,now})};
}
export function exportCases({db,now=Date.now}={}) {
  const cases=db.prepare("SELECT case_json FROM justup_evaluation_cases WHERE status='reviewed' AND created_at>? ORDER BY task,id,version LIMIT 200").all(now()-CASE_RETENTION_MS).map(row=>JSON.parse(row.case_json));
  return {version:1,cases};
}
export function compareEvaluation(cases,baseline,candidate) {
  if(!Array.isArray(cases)||cases.length>200)fail();cases.forEach(checkedCase);
  function summarize(observations) {
    if(!Array.isArray(observations)||observations.length>200)fail();
    const byId=new Map();
    for(const row of observations){if(!exact(row,['id','version','output','durationMs','inputTokens','outputTokens','costNanodollars','failed'])||!token(row.id)||!Number.isSafeInteger(row.version)||typeof row.failed!=='boolean'||['durationMs','inputTokens','outputTokens','costNanodollars'].some(key=>row[key]!==null&&!finite(row[key])))fail();const key=`${row.id}:${row.version}`;if(byId.has(key))fail();byId.set(key,row);}
    const results=[],latencies=[];let knownCost=0,unknownCost=0,knownInputTokens=0,knownOutputTokens=0,unknownTokenCases=0;
    for(const item of cases.filter(row=>row.status==='reviewed'&&row.split==='heldout')) {
      const row=byId.get(`${item.id}:${item.version}`);let outcome='missing';
      if(row){if(row.failed)outcome='failed';else{checkedOutput(item.task,row.output);outcome=JSON.stringify(canonical(row.output))===JSON.stringify(canonical(item.expected))?'pass':'mismatch';}if(row.durationMs!==null)latencies.push(row.durationMs);if(row.costNanodollars===null)unknownCost++;else knownCost+=row.costNanodollars;if(row.inputTokens===null||row.outputTokens===null)unknownTokenCases++;else{knownInputTokens+=row.inputTokens;knownOutputTokens+=row.outputTokens;}}else{unknownCost++;unknownTokenCases++;}
      results.push({id:item.id,version:item.version,task:item.task,outcome});
    }
    latencies.sort((a,b)=>a-b);const counts=Object.fromEntries(['pass','mismatch','failed','missing'].map(outcome=>[outcome,results.filter(row=>row.outcome===outcome).length]));
    return {heldoutCases:results.length,counts,accuracy:results.length?counts.pass/results.length:null,p95LatencyMs:latencies.length?latencies[Math.ceil(latencies.length*0.95)-1]:null,latencySamples:latencies.length,knownInputTokens,knownOutputTokens,unknownTokenCases,knownCostNanodollars:unknownCost?null:knownCost,unknownCostCases:unknownCost,results};
  }
  const a=summarize(baseline),b=summarize(candidate);
  return {version:1,baseline:a,candidate:b,status:!a.heldoutCases||[a,b].some(x=>x.counts.missing||x.latencySamples<x.heldoutCases||x.unknownCostCases)?'insufficient_evidence':'comparison_only',warnings:['Supplied observations are compared with reviewed expected outputs, never model self-reported correctness.','This provider-free comparison does not execute a model or approve quality, latency, cost or launch thresholds.','Tuning cases are excluded. Failures and missing held-out observations remain in the denominator.']};
}
