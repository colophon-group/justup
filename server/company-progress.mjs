// Shared company setup milestones and the bounded private operator handoff.
// No crawler write or operator flag can establish live monitoring here.
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
}

export function createCompanyProgress({db,canonicalCompanyId=id=>id,now=Date.now,accessForAccount=()=>null}={}) {
  if(!db||typeof canonicalCompanyId!=='function'||typeof now!=='function'||typeof accessForAccount!=='function')throw new TypeError('Invalid company setup dependencies.');
  const exists=name=>Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
  const row=id=>exists('justup_company_setups')?db.prepare('SELECT * FROM justup_company_setups WHERE company_id=?').get(canonicalCompanyId(id)):null;
  const safe=value=>value?{state:value.state,reason:value.reason,nextAction:value.next_action,updatedAt:iso(value.updated_at)}:{...DEFAULT};
  function snapshot(id) {const found=row(id);return {companyId:canonicalCompanyId(id),revision:found?.revision??0,...safe(found)};}
  function ensure(id) {
    id=canonicalCompanyId(id);const at=now();
    db.prepare("INSERT OR IGNORE INTO justup_company_setups VALUES(?,1,'queued','operator_handoff_pending','await_setup',?,?)").run(id,at,at);
    return snapshot(id);
  }
  function accepted() {
    const groups=new Map();
    if(!exists('justup_company_requests'))return groups;
    const priorityColumn=db.prepare('PRAGMA table_info(justup_company_requests)').all().some(column=>column.name==='acceptance_priority')
      ? 'acceptance_priority' : "'standard' AS acceptance_priority";
    const access=new Map();
    for(const request of db.prepare(`SELECT owner_id,scope,created_at,candidate_json,${priorityColumn} FROM justup_company_requests WHERE status='accepted' AND candidate_json IS NOT NULL ORDER BY created_at,id`).all()) {
      const candidate=JSON.parse(request.candidate_json);if(typeof candidate.companyId!=='string')continue;
      if(!access.has(request.owner_id))access.set(request.owner_id,accessForAccount(request.owner_id));
      if(!access.get(request.owner_id))continue; // Unavailable/deleted accounts cannot contribute private requests.
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
    return id=>safe(values.get(id));
  }
  return {ensure,snapshot,publicSnapshot:id=>safe(row(id)),publicReader,pending,update};
}
