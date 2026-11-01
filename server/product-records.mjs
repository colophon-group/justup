// Private, fixed-schema journey and execution evidence. Read before adding an
// event: these records contain metadata only and never establish model quality.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { JEV_MODEL, CLASSIFIER_VERSION, PROMPT_VERSION } from './jev.mjs';
import { modelProfile } from './model-runner.mjs';
import { createEvaluationRecords } from './evaluation-records.mjs';
import { DAY_MS, transaction } from './store.mjs';

export const RECORD_RETENTION_MS = 7 * DAY_MS;
export const JOURNEY_EVENTS = Object.freeze(['search_submitted','search_completed','results_served','source_open_reported','account_registered','free_activated','subscription_transition','company_accepted','company_progress','report_served','coverage_served','search_use']);
const EVENTS = new Set(JOURNEY_EVENTS);
const OUTCOMES = new Set(['accepted','succeeded','warning','failed','usable','no_results','paused','pending','candidate','clarification','unresolved','active','cancelled','past_due','ended','unknown']);
const TASKS = new Set(['search_intent','ai_match','company_resolution']);
const CODES = new Set(['succeeded','warning','failed','invalid_output','processing_unavailable','dependency_unavailable','provider_unavailable','task_timeout','task_interrupted','revision_conflict','preview_conflict','budget_exhausted','budget_unavailable','budget_locked','usage_overrun']);
const LOCALES = new Set(['en','de','fr','it','es']);
const token = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const number = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000_000;
const hash = value => createHash('sha256').update(value).digest('hex');
const promptHashes=Object.fromEntries(['search_intent','company_resolution'].map(kind=>[kind,hash(readFileSync(new URL(kind==='search_intent'?'./model-runner.mjs':'./model-broker.mjs',import.meta.url)))]));
export function accessSegment(viewer) {
  if(viewer?.visitor || viewer?.access?.kind==='guest')return 'visitor';
  const access=viewer?.access;
  if(access?.legacy===true)return 'legacy';
  if(['paid','cancelled','past_due'].includes(access?.kind)&&access.fullAccess===true)return 'paid';
  if(['free','expired'].includes(access?.kind))return access.kind;
  if(['ready','limited','pending'].includes(access?.kind))return 'account_limited';
  return 'unknown';
}

export function createProductRecords({db,tasks,ownerAuthority,now=Date.now,beforePrivateDelete,withPrivateTransaction,maxEvents=10_000,maxExecutions=5_000}={}) {
  if(!db||typeof ownerAuthority!=='function'||![maxEvents,maxExecutions].every(n=>Number.isInteger(n)&&n>0)||maxEvents>10_000||maxExecutions>5_000)throw new TypeError('Invalid product record configuration.');
  db.exec(`CREATE TABLE IF NOT EXISTS justup_journey_events(
    owner_id TEXT NOT NULL,event_key TEXT NOT NULL,event TEXT NOT NULL,at INTEGER NOT NULL,
    segment TEXT NOT NULL,locale TEXT NOT NULL,outcome TEXT NOT NULL,value INTEGER,
    reference_id TEXT,PRIMARY KEY(owner_id,event_key)) STRICT;
    CREATE INDEX IF NOT EXISTS justup_journey_events_time ON justup_journey_events(at);
    CREATE TABLE IF NOT EXISTS justup_model_executions(
    owner_id TEXT NOT NULL,task_id TEXT NOT NULL,attempt INTEGER NOT NULL,kind TEXT NOT NULL,at INTEGER NOT NULL,
    model TEXT NOT NULL,prompt_version TEXT NOT NULL,tool_version TEXT NOT NULL,outcome TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,input_tokens INTEGER,output_tokens INTEGER,cost_nanodollars INTEGER,
    compilation_failures INTEGER NOT NULL,repairs INTEGER NOT NULL,evaluated INTEGER,cache_hits INTEGER,insufficient INTEGER,
    PRIMARY KEY(owner_id,task_id,attempt)) STRICT;`);
  const context=new AsyncLocalStorage();
  const authority=owner=>token(owner)?ownerAuthority(owner,{allowUnavailable:true}):null;
  const save=work=>{db.exec('SAVEPOINT product_record');try{const result=work();db.exec('RELEASE product_record');return result;}catch(error){db.exec('ROLLBACK TO product_record; RELEASE product_record');throw error;}};
  function erase(work) {
    const run=()=>{beforePrivateDelete?.();return work();};
    if(typeof beforePrivateDelete!=='function'&&db.prepare('PRAGMA database_list').all().some(r=>r.name==='main'&&r.file))throw new Error('Private record cleanup is unavailable.');
    if(db.isTransaction)return run();
    return withPrivateTransaction?withPrivateTransaction(run):transaction(db,run);
  }
  const evaluations=createEvaluationRecords({db,now,erase,ownerAuthority});
  function cleanup() {
    evaluations.cleanup();
    const tables=[['justup_journey_events',maxEvents],['justup_model_executions',maxExecutions]];
    if(!tables.some(([table,max])=>db.prepare(`SELECT count(*) n FROM ${table}`).get().n>max||db.prepare(`SELECT 1 FROM ${table} WHERE at<=? LIMIT 1`).get(now()-RECORD_RETENTION_MS)))return;
    erase(()=>{for(const [table,max] of tables){db.prepare(`DELETE FROM ${table} WHERE at<=?`).run(now()-RECORD_RETENTION_MS);db.prepare(`DELETE FROM ${table} WHERE rowid NOT IN(SELECT rowid FROM ${table} ORDER BY at DESC,rowid DESC LIMIT ?)`).run(max);}});
  }
  function observe(data) {
    try {
      if(!data||Object.keys(data).some(k=>!['ownerId','event','key','viewer','locale','outcome','value','referenceId'].includes(k))||!EVENTS.has(data.event)||!token(data.key)||!OUTCOMES.has(data.outcome)||data.value!=null&&!number(data.value)||data.referenceId!=null&&!token(data.referenceId))return false;
      const current=authority(data.ownerId);if(!current)return false;
      const locale=data.locale??current.interfaceLocale??'en';if(!LOCALES.has(locale))return false;
      return save(()=>{
        const changed=db.prepare('INSERT OR IGNORE INTO justup_journey_events VALUES(?,?,?,?,?,?,?,?,?)').run(data.ownerId,hash(`${data.event}:${data.key}`),data.event,now(),accessSegment(data.viewer??current),locale,data.outcome,data.value??null,data.referenceId??null).changes===1;
        cleanup();return changed;
      });
    }catch{return false;}
  }
  function onModelMetric(metric) {
    const active=context.getStore();if(!active||!TASKS.has(metric?.kind)||!token(metric.model))return;
    active.model=metric.model;
    if(number(metric.usage?.inputTokens)&&number(metric.usage?.outputTokens)) {
      active.inputTokens=(active.inputTokens??0)+metric.usage.inputTokens;
      active.outputTokens=(active.outputTokens??0)+metric.usage.outputTokens;
    }else active.missingUsage=true;
  }
  function compilation(ok) {const active=context.getStore();if(active){if(!ok)active.compilationFailures++;if(active.compilations++)active.repairs++;}}
  async function runTask(task,handler,options) {
    if(!TASKS.has(task.kind))return handler(task,options);
    const state={compilations:0,compilationFailures:0,repairs:0},started=now();let result;
    try{return result=await context.run(state,()=>handler(task,options));}
    finally {
      try {
        const current=tasks?.get(task.ownerId,task.id);
        if(authority(task.ownerId)&&current&&current.status!=='cancelled'&&current.attempts===task.attempts&&(current.status!=='running'||current.leaseToken===task.leaseToken&&current.leaseUntil>now()))save(()=>{
          const output=result?.output,matching=task.kind==='ai_match',usageKnown=matching?number(output?.inputTokens)&&number(output?.outputTokens)&&output.ambiguousAttempts===0:!state.missingUsage&&state.inputTokens!=null;
          const code=result?.errorCode??result?.status??'failed',outcome=CODES.has(code)?code:'failed';
          const model=matching?JEV_MODEL:state.model??'unobserved';
          const prompt=matching?PROMPT_VERSION:promptHashes[task.kind];
          db.prepare('INSERT OR IGNORE INTO justup_model_executions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(task.ownerId,task.id,task.attempts,task.kind,now(),model,prompt,matching?CLASSIFIER_VERSION:modelProfile(task.kind).toolPolicySha256,outcome,Math.max(0,now()-started),usageKnown?(matching?output.inputTokens:state.inputTokens):null,usageKnown?(matching?output.outputTokens:state.outputTokens):null,matching&&usageKnown&&output.attempts>0&&number(output.costNanodollars)?output.costNanodollars:null,state.compilationFailures,state.repairs,matching&&number(output?.evaluated)?output.evaluated:null,matching&&number(output?.cacheHits)?output.cacheHits:null,matching&&number(output?.insufficient)?output.insufficient:null);
          if(task.kind==='search_intent'&&result?.committed===true)taskFinished(task);
          cleanup();
        });
      }catch{ /* Evidence failure cannot change the task result. */ }
    }
  }
  function taskFinished(task) {
    try{const current=tasks?.get(task.ownerId,task.id);if(task.kind==='search_intent'&&current?.attempts===task.attempts&&['succeeded','warning','failed'].includes(current.status))observe({ownerId:task.ownerId,event:'search_completed',key:task.id,referenceId:task.payload.searchId,outcome:current.status,locale:task.payload.presentationLocale});}catch{}
  }
  function deleteAccountData(owner) {evaluations.deleteAccountData(owner);for(const table of ['justup_journey_events','justup_model_executions'])db.prepare(`DELETE FROM ${table} WHERE owner_id=?`).run(owner);}
  function deleteReference(owner,reference) {evaluations.deleteReference(owner,reference);for(const row of db.prepare('SELECT task_id FROM justup_model_executions WHERE owner_id=?').all(owner)){const task=tasks?.get(owner,row.task_id);if(!task||task.payload?.searchId===reference||task.payload?.requestId===reference)db.prepare('DELETE FROM justup_model_executions WHERE owner_id=? AND task_id=?').run(owner,row.task_id);}
    db.prepare('DELETE FROM justup_journey_events WHERE owner_id=? AND reference_id=?').run(owner,reference);}
  function transferOwner(from,to) {
    if(!db.isTransaction||!authority(to))throw new TypeError('Record handoff requires the authenticated transaction.');
    evaluations.transferOwner(from,to);
    for(const table of ['justup_journey_events','justup_model_executions']){db.prepare(`UPDATE OR IGNORE ${table} SET owner_id=? WHERE owner_id=?`).run(to,from);db.prepare(`DELETE FROM ${table} WHERE owner_id=?`).run(from);}
  }
  function inspect(ctx,event) {
    const ownerId=ctx.viewer?.account?.id??ctx.viewer?.visitor?.id;if(!ownerId)return false;
    return observe({ownerId,event,key:`day:${Math.floor(now()/DAY_MS)}`,outcome:'accepted',locale:ctx.interfaceLocale});
  }
  return {observe,onModelMetric,compilation,runTask,taskFinished,cleanup:()=>{try{cleanup();return true;}catch{return false;}},evaluations,deleteAccountData,deleteReference,transferOwner,inspect,report:()=>productReport({db,now})};
}

export function productReport({db,now=Date.now}={}) {
  const from=now()-RECORD_RETENTION_MS;
  const cohorts=db.prepare(`SELECT segment,locale,count(DISTINCT owner_id) observedOwners,count(*) events FROM justup_journey_events WHERE at>? GROUP BY segment,locale ORDER BY segment,locale`).all(from);
  const events=db.prepare(`SELECT event,outcome,segment,count(*) n FROM justup_journey_events WHERE at>? GROUP BY event,outcome,segment ORDER BY event,outcome,segment`).all(from);
  const returnUse=db.prepare(`SELECT count(*) n FROM(SELECT owner_id FROM justup_journey_events WHERE event='search_use' AND at>? GROUP BY owner_id HAVING count(DISTINCT CAST(at/${DAY_MS} AS INTEGER))>1)`).get(from).n;
  const executions=db.prepare(`SELECT kind,model,outcome,count(*) runs,avg(duration_ms) meanDurationMs,sum(input_tokens) knownInputTokens,sum(output_tokens) knownOutputTokens,sum(cost_nanodollars) knownCostNanodollars,sum(cost_nanodollars IS NULL) unknownCostRuns,sum(compilation_failures) compilationFailures,sum(repairs) repairs FROM justup_model_executions WHERE at>? GROUP BY kind,model,outcome ORDER BY kind,model,outcome`).all(from);
  const reviewQueue=db.prepare('SELECT task,reason,count(*) n FROM justup_evaluation_candidates WHERE at>? GROUP BY task,reason ORDER BY task,reason').all(from);
  return {version:1,reviewQueue,from:new Date(from).toISOString(),through:new Date(now()).toISOString(),cohorts,events,returnUse:{observedOwnersOnMultipleSearchDays:returnUse},executions,warnings:['Bounded seven-day retained observations; deletion, failed collection and row eviction make cohorts incomplete.','Observed owners are account or cookie ownership records, not unique people; segments overlap after access changes and handoff.','Served results and client-reported views/source openings do not establish applications, hires or model correctness.','Public unauthenticated inspections, unobserved browser activity and authoritative billing not wired by the operator are missing; no conversion rate or launch threshold is inferred.','Unknown monetary cost stays null; subscription inference has no confirmed per-call price here.','Live model quality, latency and cost qualification and launch go/no-go thresholds remain unmeasured.']};
}
