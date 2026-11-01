// Fixed public-reader and private weekly-runner composition. Read before wiring
// Wire into the existing API/queue; this module starts no process or timer.
import { isAbsolute,resolve } from 'node:path';
import { createHiringWireService,WIRE_OWNER } from './hiring-wire.mjs';

const DAY=86_400_000,MAX_ATTEMPTS=3,LAG=2*DAY;
const RETRY_MS=[0,15*60_000,2*60*60_000];
const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)
  &&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const invalid=()=>new TypeError('Invalid Hiring Wire integration configuration.');

// The API deliberately accepts only published storage and a clock. Private
// configuration and source/model constructors are loaded only in runner setup.
export function createHiringWireApi({db,now=Date.now}={}) {
  const reader=createHiringWireService({db,now});
  return Object.freeze({publicRoute:reader.publicRoute,capabilities:reader.capabilities});
}

export function hiringWirePeriodEnd(at) {
  if(!Number.isSafeInteger(at)||at<0)throw invalid();
  const day=new Date(at);day.setUTCHours(0,0,0,0);
  day.setUTCDate(day.getUTCDate()-(day.getUTCDay()+6)%7);
  return day.toISOString();
}

// Factories are an isolated-test seam. Production composition supplies none;
// operator JSON cannot select a module, command, provider, schema or factory.
export async function createHiringWireRunner({db,tasks,now=Date.now,hiringWire,sourceCoverage,buildIdentity,hostPlanSha256,factories={}}={}) {
  const {validWireConfiguration,createHiringWireCodexTransport}=await import('./hiring-wire-codex-broker.mjs');
  if(!validWireConfiguration(hiringWire)||typeof now!=='function'||!db||!tasks)throw invalid();
  if(Object.keys(factories).some(key=>!['source','transport'].includes(key))||Object.values(factories).some(value=>typeof value!=='function'))throw invalid();
  let source=null,editorial=null;
  if(sourceCoverage!==undefined) {
    if(!exact(sourceCoverage,['directory','sourceVersion'])||typeof sourceCoverage.directory!=='string'
      ||!isAbsolute(sourceCoverage.directory)||resolve(sourceCoverage.directory)!==sourceCoverage.directory)throw invalid();
    const {createSourceCoverageReader,SOURCE_COVERAGE_VERSIONS}=await import('./source-coverage.mjs');
    if(!SOURCE_COVERAGE_VERSIONS.includes(sourceCoverage.sourceVersion))throw invalid();
    if(hiringWire?.enabled===true) {
      source=(factories.source??createSourceCoverageReader)({...sourceCoverage});
      if(source?.version!==sourceCoverage.sourceVersion)throw invalid();
    }
  }
  if(hiringWire?.enabled===true) {
    if(!/^[a-f0-9]{64}$/u.test(buildIdentity??'')||!/^[a-f0-9]{64}$/u.test(hostPlanSha256??''))throw invalid();
    const {createHiringWireEditorial}=await import('./hiring-wire-editorial.mjs');
    editorial=createHiringWireEditorial({transport:(factories.transport??createHiringWireCodexTransport)({config:{...hiringWire,buildIdentity,hostPlanSha256}})});
  }
  const service=createHiringWireService({db,tasks,now,source,editorial});
  db.exec(`CREATE TABLE IF NOT EXISTS hiring_wire_schedule (
    period_end TEXT PRIMARY KEY,task_id TEXT,attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 3),
    next_attempt INTEGER NOT NULL,outcome TEXT NOT NULL
  ) STRICT;`);
  const scheduled=end=>db.prepare('SELECT * FROM hiring_wire_schedule WHERE period_end=?').get(end);
  function beforeClaim() {
    if(tasks.halted?.())return {state:'cleanup_unproven'};
    if(hiringWire?.enabled!==true)return {state:'disabled'};
    const at=now(),end=hiringWirePeriodEnd(at),endAt=Date.parse(end);
    if(at-endAt>LAG)return {state:'publication_window_closed',periodEnd:end};
    // One row per UTC week bounds restart/poll behavior independently of task
    // retention. No source history is inferred or synthesized by the schedule.
    db.prepare('INSERT OR IGNORE INTO hiring_wire_schedule VALUES (?,NULL,0,?,\'pending\')').run(end,endAt);
    db.prepare('DELETE FROM hiring_wire_schedule WHERE period_end<?').run(new Date(endAt-52*7*DAY).toISOString());
    let schedule=scheduled(end),task=schedule.task_id?tasks.get(WIRE_OWNER,schedule.task_id):null;
    if(task&&['pending','running'].includes(task.status))return {state:task.status,periodEnd:end};
    if(task?.status==='succeeded') {
      if(schedule.outcome!=='published')db.prepare("UPDATE hiring_wire_schedule SET outcome='published' WHERE period_end=?").run(end);
      return {state:'published',periodEnd:end};
    }
    if(task) {
      const outcome=task.status==='cancelled'?'cancelled':task.errorCode??'task_failed';
      if(schedule.outcome!==outcome) {
        const retryAt=Date.parse(task.updatedAt)+(RETRY_MS[schedule.attempts]??0);
        db.prepare('UPDATE hiring_wire_schedule SET outcome=?,next_attempt=? WHERE period_end=?').run(outcome,retryAt,end);
        schedule=scheduled(end);
      }
      // Factual/quality/timeout/preemption failures require a decision. Only
      // unavailable dependencies get the fixed bounded automatic backoff.
      if(outcome!=='dependency_unavailable')return {state:outcome,periodEnd:end};
    } else if(schedule.task_id) {
      // A removed terminal task is not permission to recreate an old edition.
      return {state:'task_unavailable',periodEnd:end};
    } else if(schedule.attempts>0&&schedule.outcome!=='task_limit') {
      return {state:schedule.outcome,periodEnd:end};
    }
    if(schedule.attempts>=MAX_ATTEMPTS||at<schedule.next_attempt)return {state:schedule.outcome,periodEnd:end};
    // enqueuePeriod has its own immediate transaction. A crash before the
    // reference update rediscovers that same durable task, never a new turn.
    try {
      task=service.enqueuePeriod(end);
      db.prepare("UPDATE hiring_wire_schedule SET attempts=min(3,attempts+CASE WHEN task_id IS ? THEN 0 ELSE 1 END),task_id=?,outcome='queued' WHERE period_end=?")
        .run(task.id,task.id,end);
      return {state:task.status,periodEnd:end};
    } catch(error) {
      const outcome=error?.code==='task_limit'?'task_limit':'invalid_output';
      db.prepare('UPDATE hiring_wire_schedule SET attempts=min(3,attempts+1),outcome=?,next_attempt=? WHERE period_end=?')
        .run(outcome,at+(RETRY_MS[schedule.attempts+1]??LAG),end);
      return {state:outcome,periodEnd:end};
    }
  }
  return Object.freeze({runTask:service.runTask,beforeClaim});
}
