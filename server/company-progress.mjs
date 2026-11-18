// Shared company setup milestones and the bounded private operator handoff.
import {initializeCompanyMonitoring, monitoringStatus} from './company-monitoring.mjs';

const problem=(code,status=400)=>Object.assign(new Error('Company setup could not be updated.'),{code,status});
const iso=value=>value==null?null:new Date(value).toISOString();
const DEFAULT=Object.freeze({state:'blocked',reason:'source_evidence_unavailable',nextAction:'await_validation',updatedAt:null});
const TRANSITIONS=Object.freeze({queued:{reason:'operator_handoff_pending',nextAction:'await_setup'},in_progress:{reason:'source_validation_pending',nextAction:'await_validation'},blocked:null});
const BLOCKED=Object.freeze({source_validation_pending:'await_validation',source_evidence_unavailable:'retry_later'});

export function initializeCompanyProgress(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS justup_company_setups(
    company_id TEXT PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision>=1),
    state TEXT NOT NULL CHECK(state IN ('queued','in_progress','blocked')),
    reason TEXT NOT NULL CHECK(reason IN ('operator_handoff_pending','source_validation_pending','source_evidence_unavailable')),
    next_action TEXT NOT NULL CHECK(next_action IN ('await_setup','await_validation','retry_later')),
    created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
  ) STRICT;`);
  initializeCompanyMonitoring(db);
}

export function createCompanyProgress({db,canonicalCompanyId=id=>id,now=Date.now,accessForAccount=()=>null}={}) {
  if(!db||typeof canonicalCompanyId!=='function'||typeof now!=='function'||typeof accessForAccount!=='function')throw new TypeError('Invalid company setup dependencies.');
  const exists=name=>Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
  const row=id=>exists('justup_company_setups')?db.prepare('SELECT * FROM justup_company_setups WHERE company_id=?').get(canonicalCompanyId(id)):null;
  const safe=value=>value?{state:value.state,reason:value.reason,nextAction:value.next_action,updatedAt:iso(value.updated_at)}:{...DEFAULT};
  const sources = id => exists('justup_company_monitoring')
    ? db.prepare('SELECT * FROM justup_company_monitoring WHERE company_id=?').all(id)
    : [];
  function snapshot(id, request) {
    const companyId = canonicalCompanyId(id), found = row(companyId);
    const stored = request?.monitoring_boards_json;
    const status = stored ? monitoringStatus(sources(companyId), now(), JSON.parse(stored)) : null;
    return {companyId, revision:found?.revision ?? 0, ...(status ?? safe(found))};
  }
  function publicSnapshot(id) {
    id = canonicalCompanyId(id);
    return monitoringStatus(sources(id), now()) ?? safe(row(id));
  }
  function ensure(id) {
    id=canonicalCompanyId(id);const at=now();
    db.prepare("INSERT OR IGNORE INTO justup_company_setups VALUES(?,1,'queued','operator_handoff_pending','await_setup',?,?)").run(id,at,at);
    return snapshot(id);
  }
  function accepted() {
    const groups=new Map();
    if(!exists('justup_company_requests'))return groups;
    const names = new Set(db.prepare('PRAGMA table_info(justup_company_requests)').all().map(column => column.name));
    const priorityColumn = names.has('acceptance_priority') ? 'acceptance_priority' : "'standard' AS acceptance_priority";
    const boardsColumn = names.has('monitoring_boards_json') ? ',monitoring_boards_json' : '';
    const access=new Map();
    for(const request of db.prepare(`SELECT owner_id,scope,created_at,candidate_json,${priorityColumn}${boardsColumn}
      FROM justup_company_requests WHERE status='accepted' AND candidate_json IS NOT NULL ORDER BY created_at,id`).all()) {
      const candidate=JSON.parse(request.candidate_json);if(typeof candidate.companyId!=='string')continue;
      if(!access.has(request.owner_id))access.set(request.owner_id,accessForAccount(request.owner_id));
      if(!access.get(request.owner_id))continue; // Unavailable/deleted accounts cannot contribute private requests.
      if (request.monitoring_boards_json && snapshot(candidate.companyId, request).state === 'monitoring') continue;
      const id=canonicalCompanyId(candidate.companyId),previous=groups.get(id);
      if(previous) {
        if(request.acceptance_priority==='premium')previous.priority='premium';
        if(request.scope!==null)previous.requestedScopes.add(request.scope);
      } else groups.set(id,{companyId:id,name:candidate.name,websiteUrl:candidate.websiteUrl,
        priority:request.acceptance_priority==='premium'?'premium':'standard',firstRequestedAt:iso(request.created_at),requestedScopes:new Set(request.scope===null?[]:[request.scope])});
    }
    return groups;
  }
  function pending({limit=20}={}) {
    if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw problem('invalid_limit');
    const all=[...accepted().values()].sort((a,b)=>(a.priority===b.priority?0:a.priority==='premium'?-1:1)||a.firstRequestedAt.localeCompare(b.firstRequestedAt)||a.companyId.localeCompare(b.companyId));
    return {items:all.slice(0,limit).map(value=>({...value,requestedScopes:[...value.requestedScopes].sort().slice(0,8),requestedScopeCount:value.requestedScopes.size,...snapshot(value.companyId)})),truncated:all.length>limit};
  }
  function update({companyId,expectedRevision,state,reason}) {
    if(typeof companyId!=='string'||!companyId||companyId.length>128||!Number.isSafeInteger(expectedRevision)||expectedRevision<1
        ||!Object.hasOwn(TRANSITIONS,state))throw problem('invalid_input');
    const transition=state==='blocked'?Object.hasOwn(BLOCKED,reason)?{reason,nextAction:BLOCKED[reason]}:null:TRANSITIONS[state];
    if(!transition||reason!==transition.reason)throw problem('invalid_input');
    companyId=canonicalCompanyId(companyId);
    db.exec('SAVEPOINT company_setup_write');
    try {
      if(!accepted().has(companyId))throw problem('not_found',404);
      const found=row(companyId);if(!found)throw problem('not_found',404);
      // Exact retries are harmless even if their prior CAS revision is stale.
      if(found.state===state&&found.reason===reason&&found.next_action===transition.nextAction) {
        const result=snapshot(companyId);db.exec('RELEASE company_setup_write');return result;
      }
      if(found.revision!==expectedRevision)throw problem('revision_conflict',409);
      db.prepare('UPDATE justup_company_setups SET revision=revision+1,state=?,reason=?,next_action=?,updated_at=? WHERE company_id=? AND revision=?')
        .run(state,reason,transition.nextAction,now(),companyId,expectedRevision);
      const result=snapshot(companyId);db.exec('RELEASE company_setup_write');return result;
    } catch(error) {db.exec('ROLLBACK TO company_setup_write; RELEASE company_setup_write');throw error;}
  }
  function publicReader() {
    const values=new Map(exists('justup_company_setups')?db.prepare('SELECT * FROM justup_company_setups').all().map(value=>[value.company_id,value]):[]);
    const grouped = new Map();
    if (exists('justup_company_monitoring')) {
      for (const source of db.prepare('SELECT * FROM justup_company_monitoring').all()) {
        const entries = grouped.get(source.company_id) ?? [];
        entries.push(source);
        grouped.set(source.company_id, entries);
      }
    }
    const at = now();
    return id => monitoringStatus(grouped.get(id) ?? [], at) ?? safe(values.get(id));
  }
  function monitoringRequests(companyId, after = '') {
    const revision = row(companyId)?.revision ?? 0;
    const requests = db.prepare(`SELECT id,scope,owner_id,candidate_json FROM justup_company_requests
      WHERE id>? AND status='accepted' AND candidate_json IS NOT NULL ORDER BY id`);
    const items = [];
    for (const request of requests.iterate(after)) {
      if (canonicalCompanyId(JSON.parse(request.candidate_json).companyId) !== companyId || !accessForAccount(request.owner_id)) continue;
      if (items.length === 50) return {companyId, revision, items, nextRequest:items.at(-1).id};
      items.push({id:request.id, scope:request.scope});
    }
    return {companyId, revision, items, nextRequest:null};
  }
  function applyMonitoring({companyId, expectedRevision, sourceCompanyId, receipts, requests}) {
    if (!db.isTransaction) throw new Error('Monitoring intake requires an operator write transaction.');
    const canonical = canonicalCompanyId(sourceCompanyId);
    if (canonicalCompanyId(companyId) !== companyId || (canonical !== sourceCompanyId && canonical !== companyId)
        || (sourceCompanyId !== companyId && canonical === sourceCompanyId && db.prepare(`SELECT 1 FROM justup_requested_companies WHERE id=?
           UNION ALL SELECT 1 FROM justup_jobs WHERE company_id=? LIMIT 1`).get(sourceCompanyId, sourceCompanyId))
        || db.prepare('SELECT 1 FROM justup_company_monitoring WHERE source_company_id=? AND company_id<>?').get(sourceCompanyId,companyId)) {
      throw problem('revision_conflict', 409);
    }
    const found = row(companyId);
    if (!found && !db.prepare(`SELECT 1 FROM justup_requested_companies WHERE id=?
        UNION ALL SELECT 1 FROM justup_jobs WHERE company_id=? OR company_id IN
        (SELECT source_company_id FROM justup_company_aliases WHERE company_id=?) LIMIT 1`).get(companyId,companyId,companyId)) {
      throw problem('not_found', 404);
    }
    const at = now();
    if (receipts.some(receipt => receipt.expiresAt !== null && receipt.expiresAt <= at)) throw problem('invalid_input');
    const attached = [];
    for (const request of requests) {
      const current = db.prepare(`SELECT * FROM justup_company_requests WHERE id=? AND status='accepted'`).get(request.id);
      if (!current || current.scope !== request.scope || !accessForAccount(current.owner_id)
          || canonicalCompanyId(JSON.parse(current.candidate_json).companyId) !== companyId) throw problem('revision_conflict', 409);
      attached.push(current);
    }
    const bindings = JSON.stringify(receipts.map(receipt => [receipt.boardId, receipt.revision]).sort(([a],[b]) => a.localeCompare(b)));
    const changed = receipts.filter(receipt => {
      const previous = db.prepare('SELECT * FROM justup_company_monitoring WHERE board_id=?').get(receipt.boardId);
      if (!previous) return true;
      if (previous.company_id !== companyId || previous.source_company_id !== sourceCompanyId
          || (previous.sha256 !== receipt.sha256 && previous.observed_at >= receipt.observedAt)) throw problem('revision_conflict', 409);
      return previous.sha256 !== receipt.sha256;
    });
    const newBindings = attached.filter(request => request.monitoring_boards_json !== bindings);
    if (!changed.length && !newBindings.length) return {companyId, revision:found.revision, changed:false};
    if ((found?.revision ?? 0) !== expectedRevision) throw problem('revision_conflict', 409);
    if (!found) ensure(companyId);
    const save = db.prepare(`INSERT INTO justup_company_monitoring VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(board_id) DO UPDATE SET scope_revision=excluded.scope_revision, sha256=excluded.sha256,
      observed_at=excluded.observed_at, verified_at=excluded.verified_at, expires_at=excluded.expires_at`);
    for (const receipt of changed) save.run(receipt.boardId,companyId,sourceCompanyId,receipt.revision,receipt.sha256,
      receipt.observedAt,receipt.verifiedAt,receipt.expiresAt);
    if (newBindings.length) {
      const attach = db.prepare(`UPDATE justup_company_requests SET monitoring_boards_json=?,
        monitoring_started_at=coalesce(monitoring_started_at,?) WHERE id=?`);
      for (const request of newBindings) attach.run(bindings,at,request.id);
    }
    const revision = expectedRevision + 1;
    db.prepare('UPDATE justup_company_setups SET revision=? WHERE company_id=?').run(revision,companyId);
    return {companyId,revision,changed:true};
  }
  return {ensure,snapshot,publicSnapshot,publicReader,pending,update,monitoringRequests,applyMonitoring};
}
