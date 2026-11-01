// Published Hiring Wire reads and system-owned weekly tasks. Read before wiring
// source history, editorial transport, publication or retention into the runner.
import { randomUUID } from 'node:crypto';
import { DAY, METHOD, bounded, canonical, compileWireSnapshot, digest, exact, iso, periodFor, renderWireItems, token, validateWireSelection, wireError } from './hiring-wire-facts.mjs';
import { DEFAULT_SCRIPT, validateEditorialExecution, validateSelectionScript } from './hiring-wire-editorial.mjs';

export const WIRE_OWNER='__hiring_wire__';
const tx=(db,fn)=>{
  db.exec('SAVEPOINT hiring_wire_write');
  try {const result=fn();db.exec('RELEASE hiring_wire_write');return result;}
  catch(error){db.exec('ROLLBACK TO hiring_wire_write; RELEASE hiring_wire_write');throw error;}
};
const parse=value=>value===null?null:JSON.parse(value);
export function createHiringWireService({db,tasks=null,now=Date.now,source=null,editorial=null,config={}}={}) {
  if(!db || typeof now!=='function' || Object.keys(config).some(key=>!['publicationLagMs','retainedEditions'].includes(key))) throw new TypeError('Invalid Hiring Wire configuration.');
  const publicationLagMs=config.publicationLagMs??2*DAY,retainedEditions=config.retainedEditions??52;
  if(!Number.isInteger(publicationLagMs) || publicationLagMs<DAY || publicationLagMs>7*DAY || !Number.isInteger(retainedEditions) || retainedEditions<8 || retainedEditions>52) throw new TypeError('Invalid Hiring Wire configuration.');
  db.exec(`CREATE TABLE IF NOT EXISTS hiring_wire_editions (
    period_id TEXT PRIMARY KEY, period_end TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('pending','published')),
    created_at INTEGER NOT NULL, published_at INTEGER, snapshot_json TEXT, snapshot_sha256 TEXT, facts_json TEXT,
    prior_json TEXT, selection_json TEXT, execution_json TEXT, workspace_json TEXT, public_json TEXT, publication_outcome TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS hiring_wire_executions (
    id TEXT PRIMARY KEY,period_id TEXT NOT NULL,task_id TEXT NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER,
    outcome TEXT NOT NULL CHECK(outcome IN ('running','published','failed')),error_code TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS hiring_wire_tool_versions (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,revision TEXT NOT NULL UNIQUE,sha256 TEXT NOT NULL,script_json TEXT NOT NULL,created_at INTEGER NOT NULL
  ) STRICT;
  CREATE TRIGGER IF NOT EXISTS hiring_wire_published_immutable BEFORE UPDATE ON hiring_wire_editions WHEN OLD.status='published'
    BEGIN SELECT RAISE(ABORT,'Published Hiring Wire editions are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS hiring_wire_period_immutable BEFORE UPDATE ON hiring_wire_editions WHEN NEW.period_id IS NOT OLD.period_id OR NEW.period_end IS NOT OLD.period_end
    BEGIN SELECT RAISE(ABORT,'Hiring Wire periods are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS hiring_wire_snapshot_immutable BEFORE UPDATE ON hiring_wire_editions
    WHEN OLD.snapshot_json IS NOT NULL AND (NEW.snapshot_json IS NOT OLD.snapshot_json OR NEW.snapshot_sha256 IS NOT OLD.snapshot_sha256 OR NEW.facts_json IS NOT OLD.facts_json OR NEW.prior_json IS NOT OLD.prior_json OR NEW.period_end IS NOT OLD.period_end)
    BEGIN SELECT RAISE(ABORT,'Hiring Wire snapshots are immutable'); END;`);
  const row=id=>db.prepare('SELECT * FROM hiring_wire_editions WHERE period_id=?').get(id);
  const latest=()=>db.prepare("SELECT public_json FROM hiring_wire_editions WHERE status='published' AND period_end>? AND period_end<=? ORDER BY period_end DESC LIMIT 1").get(new Date(now()-7*DAY).toISOString(),new Date(now()).toISOString());
  function readWorkspace() {
    let value=db.prepare('SELECT revision,sha256,script_json FROM hiring_wire_tool_versions ORDER BY sequence DESC LIMIT 1').get();
    if(!value) {
      const script=canonical(DEFAULT_SCRIPT),sha256=digest(DEFAULT_SCRIPT);
      db.prepare('INSERT INTO hiring_wire_tool_versions(revision,sha256,script_json,created_at) VALUES (?,?,?,?)').run(`r-${sha256.slice(0,20)}`,sha256,script,now());
      value=db.prepare('SELECT revision,sha256,script_json FROM hiring_wire_tool_versions ORDER BY sequence DESC LIMIT 1').get();
    }
    return {revision:value.revision,sha256:value.sha256,script:parse(value.script_json)};
  }
  function replaceWorkspace(expectedRevision,script) {
    token(expectedRevision);validateSelectionScript(script);
    return tx(db,()=>{
      const current=readWorkspace();if(current.revision!==expectedRevision)throw wireError('revision_conflict');
      const sha256=digest(script);if(sha256===current.sha256)return current;
      const revision=`r-${randomUUID()}`;
      db.prepare('INSERT INTO hiring_wire_tool_versions(revision,sha256,script_json,created_at) VALUES (?,?,?,?)').run(revision,sha256,canonical(script),now());
      db.exec('DELETE FROM hiring_wire_tool_versions WHERE sequence NOT IN (SELECT sequence FROM hiring_wire_tool_versions ORDER BY sequence DESC LIMIT 32)');
      return readWorkspace();
    });
  }
  const workspace={read:readWorkspace,replace:replaceWorkspace};
  function enqueuePeriod(periodEnd) {
    if(!tasks?.enqueue)throw wireError('dependency_unavailable');
    const period=periodFor(periodEnd),end=iso(periodEnd);
    if(end>now() || now()-end>publicationLagMs)throw wireError('invalid_input');
    let requestKey=`edition-${period.id}`;
    for(let retry=0;retry<8;retry++) {
      const task=tasks.enqueue({ownerId:WIRE_OWNER,kind:'hiring_wire',requestKey,payload:{periodEnd}});
      if(!['failed','cancelled'].includes(task.status))return task;
      requestKey=`retry-${task.id}`;
    }
    throw wireError('task_limit');
  }
  function liveTask(task) {
    const current=tasks?.get(WIRE_OWNER,task.id);
    if(current?.kind!=='hiring_wire' || current.status!=='running' || current.leaseToken!==task.leaseToken || current.leaseUntil<=now())throw wireError('revision_conflict');
  }
  function previousEditions(periodEnd) {
    return db.prepare("SELECT public_json FROM hiring_wire_editions WHERE status='published' AND period_end<? ORDER BY period_end DESC LIMIT 8").all(periodEnd).map(item=>parse(item.public_json));
  }
  async function runTask(task,{signal}={}) {
    if(task?.kind!=='hiring_wire' || task.ownerId!==WIRE_OWNER)return {status:'failed',errorCode:'invalid_output'};
    let period,attempt;
    try {
      exact(task.payload,['periodEnd']);period=periodFor(task.payload.periodEnd);liveTask(task);
      if(iso(period.end)>now() || now()-iso(period.end)>publicationLagMs)throw wireError('dependency_unavailable');
      const existing=row(period.id);
      if(existing?.status==='published')return tx(db,()=>{liveTask(task);const output={editionId:period.id};if(!tasks.complete(task.id,task.leaseToken,{status:'succeeded',output}))throw wireError('revision_conflict');return {status:'succeeded',output,committed:true};});
      attempt=randomUUID();
      tx(db,()=>{
        liveTask(task);
        db.prepare("INSERT OR IGNORE INTO hiring_wire_editions(period_id,period_end,status,created_at,publication_outcome) VALUES (?,?,'pending',?,'pending')").run(period.id,period.end,now());
        db.prepare("UPDATE hiring_wire_executions SET outcome='failed',finished_at=?,error_code='task_interrupted' WHERE period_id=? AND outcome='running'").run(now(),period.id);
        db.prepare("INSERT INTO hiring_wire_executions(id,period_id,task_id,started_at,outcome) VALUES (?,?,?,?,'running')").run(attempt,period.id,task.id,now());
      });
      let edition=row(period.id);
      if(!edition.snapshot_json) {
        if(source?.authoritative!==true || typeof source.readSnapshot!=='function')throw wireError('dependency_unavailable');
        const snapshot=await source.readSnapshot({periodEnd:period.end,signal});
        if(signal?.aborted)throw wireError('task_timeout');
        if(snapshot?.sourceVersion!==source.version)throw wireError('dependency_unavailable');
        const compiled=compileWireSnapshot(snapshot,{periodEnd:period.end,now:now()});
        // Evidence stays bounded separately from the public edition and never
        // enters the editorial model context, browser projection or task result.
        bounded(compiled.snapshot,4*1024*1024);
        tx(db,()=>{
          liveTask(task);const current=row(period.id);if(current.snapshot_json)return;
          db.prepare('UPDATE hiring_wire_editions SET snapshot_json=?,snapshot_sha256=?,facts_json=?,prior_json=? WHERE period_id=?').run(canonical(compiled.snapshot),compiled.snapshotSha256,canonical({version:compiled.factsVersion,facts:compiled.facts,suppressed:compiled.suppressed}),canonical(previousEditions(period.end)),period.id);
        });
        edition=row(period.id);
      }
      const snapshot=parse(edition.snapshot_json),factSet=parse(edition.facts_json),previous=parse(edition.prior_json);
      if(!factSet.facts.some(f=>f.current+f.previous>0))throw wireError('dependency_unavailable');
      if(editorial?.available?.('hiring_wire')!==true || typeof editorial.generateHiringWire!=='function')throw wireError('dependency_unavailable');
      const shortlist=[...factSet.facts].sort((a,b)=>Math.abs(b.change)-Math.abs(a.change)||b.current-a.current||a.company.id.localeCompare(b.company.id)).slice(0,64);
      const result=bounded(await editorial.generateHiringWire({snapshot:{id:snapshot.snapshotId,sha256:edition.snapshot_sha256,asOf:period.end,factsVersion:factSet.version},facts:shortlist,previousEditions:previous,workspace},{signal}),65_536);
      if(signal?.aborted)throw wireError('task_timeout');
      exact(result,['data','execution']);const selection=validateWireSelection(result.data,factSet.facts,snapshot.snapshotId),execution=validateEditorialExecution(result.execution);
      const usedWorkspace=readWorkspace();
      if(execution.workspaceRevision!==usedWorkspace.revision || execution.workspaceSha256!==usedWorkspace.sha256)throw wireError('invalid_output');
      return tx(db,()=>{
        liveTask(task);
        if(now()-iso(period.end)>publicationLagMs || canonical(previousEditions(period.end))!==canonical(previous) || db.prepare("SELECT 1 FROM hiring_wire_editions WHERE status='published' AND period_end>=?").get(period.end))throw wireError('revision_conflict');
        const publicEdition=bounded({id:period.id,title:'Hiring Wire',period:{start:period.start,end:period.end,previousStart:period.previousStart},snapshotAt:period.end,publishedAt:new Date(now()).toISOString(),expiresAt:new Date(iso(period.end)+7*DAY).toISOString(),methodology:METHOD,items:renderWireItems(selection,factSet.facts)},16_384);
        const output={editionId:period.id};
        if(!tasks.complete(task.id,task.leaseToken,{status:'succeeded',output}))throw wireError('revision_conflict');
        db.prepare("UPDATE hiring_wire_editions SET status='published',published_at=?,selection_json=?,execution_json=?,workspace_json=?,public_json=?,publication_outcome='published' WHERE period_id=?").run(now(),canonical(selection),canonical(execution),canonical(usedWorkspace),canonical(publicEdition),period.id);
        db.prepare("UPDATE hiring_wire_executions SET outcome='published',finished_at=? WHERE id=?").run(now(),attempt);
        db.prepare("DELETE FROM hiring_wire_editions WHERE status='published' AND period_id NOT IN (SELECT period_id FROM hiring_wire_editions WHERE status='published' ORDER BY period_end DESC LIMIT ?)").run(retainedEditions);
        cleanup();
        return {status:'succeeded',output,committed:true};
      });
    } catch(error) {
      const code=['dependency_unavailable','task_timeout','revision_conflict','invalid_output'].includes(error.code)?error.code:'invalid_output';
      if(attempt)tx(db,()=>{
        db.prepare("UPDATE hiring_wire_executions SET outcome='failed',finished_at=?,error_code=? WHERE id=? AND outcome='running'").run(now(),code,attempt);
        db.prepare("UPDATE hiring_wire_editions SET publication_outcome=? WHERE period_id=? AND status='pending'").run(code,period.id);
      });
      return {status:'failed',errorCode:code};
    }
  }
  function cleanup() {
    db.prepare("DELETE FROM hiring_wire_editions WHERE status='pending' AND created_at<?").run(now()-30*DAY);
    db.prepare('DELETE FROM hiring_wire_executions WHERE started_at<?').run(now()-30*DAY);
    db.exec('DELETE FROM hiring_wire_executions WHERE id NOT IN (SELECT id FROM hiring_wire_executions ORDER BY started_at DESC,id DESC LIMIT 256)');
  }
  function publicRoute(ctx) {
    if(ctx.method!=='GET')return null;
    let value;
    if(ctx.path==='/hiring-wire')value=latest();
    else if(/^\/hiring-wire\/editions\/\d{4}-\d\d-\d\d$/u.test(ctx.path))value=db.prepare("SELECT public_json FROM hiring_wire_editions WHERE period_id=? AND status='published'").get(ctx.path.slice(-10));
    else return null;
    return {status:200,body:{state:value?'published':'unavailable',edition:value?parse(value.public_json):null}};
  }
  return {publicRoute,capabilities:()=>({hiringWire:!!latest()}),enqueuePeriod,runTask,cleanup,
    taskResult:()=>undefined,deleteAccountData:()=>{},workspace};
}
