// Cookie-bound temporary search ownership and verified-account handoff. Read when
// changing anonymous retention, admission, workspace state or shared-browser isolation.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { problem } from './store.mjs';
import { lstatSync,readFileSync } from 'node:fs';
import { dirname,isAbsolute,join } from 'node:path';

const DAY = 86_400_000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const GUEST = Object.freeze({kind:'guest',fullAccess:false,legacy:false,premium:false,billingEnabled:false,until:null});
const keys = (body, allowed) => { if(!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).some(k=>!allowed.includes(k))) throw problem('invalid_input'); };
const savepoint = (db, work) => { db.exec('SAVEPOINT visitor_write'); try { const value=work(); db.exec('RELEASE visitor_write'); return value; } catch(error) { db.exec('ROLLBACK TO visitor_write; RELEASE visitor_write'); throw error; } };

// Queue readers follow the backup consumers' stable-generation/pending-marker
// protocol. This check only reads state; it never clears or repairs a marker.
export function visitorPrivateGeneration(config={}) {
  if(config.dbPath===':memory:')return 'isolated-memory';
  const path=config.privateGenerationPath??(isAbsolute(config.dbPath??'')?join(dirname(config.dbPath),'private-generation'):null);
  if(!path||!isAbsolute(path))return null;
  const read=()=>{const meta=lstatSync(path);if(!meta.isFile()||meta.isSymbolicLink()||meta.nlink!==1||meta.size>64)throw Error('Unavailable');const value=readFileSync(path,'utf8');if(!/^[a-f0-9-]{36}\n?$/.test(value))throw Error('Unavailable');return value;};
  try{const first=read();try{lstatSync(path+'.pending');return null;}catch(error){if(error.code!=='ENOENT')return null;}return first===read()?first:null;}catch{return null;}
}

export function createVisitorIdentity({db,now=Date.now,config={},accessForAccount,visitorAvailability}={}) {
  const ttl=config.visitor?.ttlMs??DAY, maxVisitors=config.visitor?.maxVisitors??200;
  const maxSubmissions=config.visitor?.maxSubmissions??8, maxSearches=config.visitor?.maxSearches??3;
  if(!db || !Number.isSafeInteger(ttl)||ttl<60_000||ttl>7*DAY || !Number.isSafeInteger(maxVisitors)||maxVisitors<1||maxVisitors>1000
      || !Number.isSafeInteger(maxSubmissions)||maxSubmissions<1||maxSubmissions>16 || !Number.isSafeInteger(maxSearches)||maxSearches<1||maxSearches>5
      || accessForAccount!=null&&typeof accessForAccount!=='function'||visitorAvailability!=null&&typeof visitorAvailability!=='function') throw new TypeError('Invalid visitor configuration.');
  db.exec(`CREATE TABLE IF NOT EXISTS justup_visitors (
    id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    submissions INTEGER NOT NULL DEFAULT 0, handed_to TEXT, handed_at INTEGER) STRICT;
    CREATE TABLE IF NOT EXISTS justup_workspaces (owner_id TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS justup_recovered_drafts(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,text TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT;
    CREATE INDEX IF NOT EXISTS justup_recovered_drafts_owner ON justup_recovered_drafts(owner_id);
    CREATE TABLE IF NOT EXISTS justup_viewed (owner_id TEXT NOT NULL, job_id TEXT NOT NULL, first_viewed_at INTEGER NOT NULL, PRIMARY KEY(owner_id,job_id)) STRICT;
    CREATE TABLE IF NOT EXISTS justup_visitor_admission(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),source_commit TEXT,build_identity TEXT,policy_version TEXT,private_generation TEXT,checked_at INTEGER NOT NULL) STRICT;`);
  if(!db.prepare('PRAGMA table_info(justup_visitors)').all().some(c=>c.name==='matching_tasks'))db.exec('ALTER TABLE justup_visitors ADD COLUMN matching_tasks INTEGER NOT NULL DEFAULT 0');
  if(!db.prepare('PRAGMA table_info(justup_workspaces)').all().some(c=>c.name==='revision'))db.exec('ALTER TABLE justup_workspaces ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
  const visitorRow=id=>db.prepare('SELECT * FROM justup_visitors WHERE id=? AND handed_to IS NULL AND expires_at>?').get(id,now());
  const bindingValid=()=>/^[a-f0-9]{40}$/.test(config.sourceCommit??'')&&typeof config.buildIdentity==='string'&&config.buildIdentity.length>0&&config.buildIdentity.length<=200;
  function refreshAvailability() {
    if(!visitorAvailability)return;
    let enabled=false;try{enabled=visitorAvailability()===true&&bindingValid()&&/^[A-Za-z0-9_.:-]{1,100}$/.test(config.policyVersion??'');}catch{}
    const generation=visitorPrivateGeneration(config);enabled&&=generation!==null;
    const prior=db.prepare('SELECT * FROM justup_visitor_admission WHERE id=1').get();
    if(!prior||prior.enabled!==Number(enabled)||prior.source_commit!==config.sourceCommit||prior.build_identity!==config.buildIdentity||prior.policy_version!==config.policyVersion||prior.private_generation!==generation||now()-prior.checked_at>=30_000)db.prepare('INSERT INTO justup_visitor_admission VALUES(1,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,source_commit=excluded.source_commit,build_identity=excluded.build_identity,policy_version=excluded.policy_version,private_generation=excluded.private_generation,checked_at=excluded.checked_at').run(Number(enabled),config.sourceCommit??null,config.buildIdentity??null,config.policyVersion??null,generation,now());
  }
  function processingAvailable() {
    refreshAvailability();
    const proof=db.prepare('SELECT * FROM justup_visitor_admission WHERE id=1').get();
    return Boolean(bindingValid()&&proof?.enabled===1&&proof.source_commit===config.sourceCommit&&proof.build_identity===config.buildIdentity&&/^[A-Za-z0-9_.:-]{1,100}$/.test(proof.policy_version??'')&&(config.policyVersion==null||proof.policy_version===config.policyVersion)&&proof.checked_at<=now()&&now()-proof.checked_at<90_000&&proof.private_generation!==null&&proof.private_generation===visitorPrivateGeneration(config));
  }
  // An API startup revokes an earlier process's proof before exposing routes.
  // Fully composed maintenance publishes its current admission afterwards.
  if(visitorAvailability)db.prepare('INSERT INTO justup_visitor_admission VALUES(1,0,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=0,source_commit=excluded.source_commit,build_identity=excluded.build_identity,policy_version=excluded.policy_version,private_generation=excluded.private_generation,checked_at=excluded.checked_at').run(config.sourceCommit??null,config.buildIdentity??null,config.policyVersion??null,visitorPrivateGeneration(config),now());
  function principal(id,{allowUnavailable=false}={}) {
    if(typeof id!=='string')return null;
    if(id.startsWith('visitor:')) {
      if(!allowUnavailable&&!processingAvailable())return null;
      const row=visitorRow(id);return row?{visitor:{id},expiresAt:row.expires_at,access:GUEST}:null;
    }
    // Queued flags and a copied account ID never grant access. This adapter must
    // synchronously reload the persisted current entitlement on every call.
    const access=accessForAccount?.(id);
    if(!access || typeof access.then==='function' || typeof access.fullAccess!=='boolean')return null;
    return {account:{id},access};
  }
  function fromToken(token,options) {
    if(!TOKEN.test(token??''))return null;
    const row=db.prepare('SELECT id FROM justup_visitors WHERE token_hash=? AND handed_to IS NULL AND expires_at>?').get(hash(token),now());
    return row?principal(row.id,options):null;
  }
  function open(token) {
    if(!processingAvailable())throw problem('dependency_unavailable',503);
    const current=fromToken(token);if(current)return {principal:current,token};
    if(db.prepare('SELECT count(*) AS n FROM justup_visitors').get().n>=maxVisitors)throw problem('rate_limit',429);
    token=randomBytes(32).toString('base64url');const id=`visitor:${randomUUID()}`,at=now();
    db.prepare('INSERT INTO justup_visitors(id,token_hash,created_at,expires_at) VALUES(?,?,?,?)').run(id,hash(token),at,at+ttl);
    return {principal:principal(id),token};
  }
  function admit(owner,{creating=false}={}) {
    const row=visitorRow(owner);if(!row)throw problem('unauthenticated',401);
    if(row.submissions>=maxSubmissions || creating&&db.prepare('SELECT count(*) AS n FROM demo_searches WHERE owner_id=?').get(owner).n>=maxSearches)throw problem('task_limit',429);
  }
  function recordSubmission(owner) { if(db.prepare('UPDATE justup_visitors SET submissions=submissions+1 WHERE id=? AND handed_to IS NULL AND expires_at>? AND submissions<?').run(owner,now(),maxSubmissions).changes!==1)throw problem('task_limit',429); }
  function admitMatching(owner) {
    if(!owner.startsWith('visitor:'))return;
    if(db.prepare('UPDATE justup_visitors SET matching_tasks=matching_tasks+1 WHERE id=? AND handed_to IS NULL AND expires_at>? AND matching_tasks<32').run(owner,now()).changes!==1)throw problem('task_limit',429);
  }
  return {principal,fromToken,open,admit,recordSubmission,admitMatching,processingAvailable,refreshAvailability};
}

export function createVisitorService({db,feed,tasks,intent,matching,identity,config={},now=Date.now,beforePrivateDelete,withPrivateTransaction}={}) {
  if(!identity||!intent||!feed||!tasks||!db)throw new TypeError('Visitor services are required.');
  const ownerOf=viewer=>viewer?.visitor?.id??viewer?.account?.id??null;
  const publicVisitor=viewer=>viewer?.visitor?{expiresAt:new Date(viewer.expiresAt).toISOString()}:null;
  function deletion(work) {
    if(typeof beforePrivateDelete!=='function'||typeof withPrivateTransaction!=='function')throw problem('deletion_unavailable',503);
    if(db.isTransaction){beforePrivateDelete();return work();}
    return withPrivateTransaction(()=>{beforePrivateDelete();return work();});
  }
  function cleanup() {
    const expired=db.prepare('SELECT id FROM justup_visitors WHERE expires_at<=?').all(now());
    if(!expired.length)return;
    deletion(()=>{for(const row of expired){intent.deleteAccountData(row.id);matching?.deleteAccountData?.(row.id);tasks.deleteOwner(row.id);deleteAccountData(row.id);db.prepare('DELETE FROM justup_visitors WHERE id=?').run(row.id);}});
  }
  function workspace(owner) {
    const visible=new Set(feed.eligibleJobs({viewer:identity.principal(owner)}).map(job=>job.id));
    const state=db.prepare('SELECT state_json,revision FROM justup_workspaces WHERE owner_id=?').get(owner);
    return {recoveredDrafts:db.prepare('SELECT id,text,created_at FROM justup_recovered_drafts WHERE owner_id=? ORDER BY created_at,id').all(owner).map(r=>({id:r.id,text:r.text,createdAt:new Date(r.created_at).toISOString()})),revision:state?.revision??0,state:state?JSON.parse(state.state_json):{activeSearchId:null,drafts:{}},viewed:db.prepare('SELECT job_id AS jobId,first_viewed_at AS at FROM justup_viewed WHERE owner_id=? ORDER BY first_viewed_at,job_id').all(owner).filter(r=>visible.has(r.jobId)).map(r=>({jobId:r.jobId,firstViewedAt:new Date(r.at).toISOString()}))};
  }
  function writeWorkspace(owner,body) {
    keys(body,['expectedRevision','activeSearchId','drafts']);
    if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0)throw problem('invalid_input');
    if(body.activeSearchId!==null&&(typeof body.activeSearchId!=='string'||body.activeSearchId.length>128))throw problem('invalid_input');
    if(!body.drafts||typeof body.drafts!=='object'||Array.isArray(body.drafts)||Object.keys(body.drafts).length>100)throw problem('invalid_input');
    const own=new Set(db.prepare('SELECT id FROM demo_searches WHERE owner_id=?').all(owner).map(r=>r.id));
    if(body.activeSearchId!==null&&!own.has(body.activeSearchId))throw problem('not_found',404);
    for(const [id,draft] of Object.entries(body.drafts))if((id!=='new'&&!own.has(id))||typeof draft!=='string'||draft.length>4000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(draft))throw problem('invalid_input');
    const state={activeSearchId:body.activeSearchId,drafts:body.drafts};
    const json=JSON.stringify(state);if(Buffer.byteLength(json)>60_000)throw problem('invalid_input');
    savepoint(db,()=>{
      const current=workspace(owner).revision;if(current!==body.expectedRevision)throw problem('revision_conflict',409);
      db.prepare('INSERT INTO justup_workspaces(owner_id,state_json,updated_at,revision) VALUES(?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at,revision=excluded.revision').run(owner,json,now(),current+1);
    });
    return workspace(owner);
  }
  function recoveryBudget(owner) {
    const budget=db.prepare('SELECT count(*) AS n,coalesce(sum(length(CAST(text AS BLOB))),0) AS bytes FROM justup_recovered_drafts WHERE owner_id=?').get(owner);
    if(budget.n>100||budget.bytes>128_000)throw problem('task_limit',429);
  }
  function deleteAccountData(owner) {
    db.prepare('DELETE FROM justup_workspaces WHERE owner_id=?').run(owner);
    db.prepare('DELETE FROM justup_viewed WHERE owner_id=?').run(owner);
    db.prepare('DELETE FROM justup_recovered_drafts WHERE owner_id=?').run(owner);
    // An account deletion removes only its non-secret handoff receipts. A replay
    // of the spent cookie cannot recreate or attach the deleted account's data.
    db.prepare('DELETE FROM justup_visitors WHERE handed_to=?').run(owner);
  }
  function handoff(token,{db:authenticatedDb,accountId}={}) {
    if(authenticatedDb!==db||!db.isTransaction||typeof accountId!=='string'||!accountId)throw problem('unauthenticated',401);
    if(!TOKEN.test(token??''))return {status:'none'};
    const row=db.prepare('SELECT * FROM justup_visitors WHERE token_hash=?').get(hash(token));
    if(!row)return {status:'none'};
    if(row.handed_to)return row.handed_to===accountId?{status:'complete'}:{status:'none'};
    if(row.expires_at<=now())return {status:'none'};
    return deletion(()=>savepoint(db,()=>{
      const current=db.prepare('SELECT * FROM justup_visitors WHERE id=?').get(row.id);
      if(current.handed_to)return current.handed_to===accountId?{status:'complete'}:{status:'none'};
      // Existing account searches are appended to, never overwritten. Cancel and
      // remove old leases before moving state so late anonymous replies are inert.
      const visitorState=workspace(row.id).state, accountWorkspace=workspace(accountId),accountState=accountWorkspace.state;
      const total=db.prepare('SELECT count(*) AS n FROM demo_searches WHERE owner_id IN (?,?)').get(row.id,accountId).n;
      if(total>100)throw problem('task_limit',429);
      intent.transferOwner(row.id,accountId);
      matching?.transferOwner?.(row.id,accountId);tasks.cancelOwner(row.id);tasks.deleteOwner(row.id);
      for(const viewed of db.prepare('SELECT job_id,first_viewed_at FROM justup_viewed WHERE owner_id=?').all(row.id))db.prepare('INSERT INTO justup_viewed VALUES(?,?,?) ON CONFLICT(owner_id,job_id) DO UPDATE SET first_viewed_at=min(first_viewed_at,excluded.first_viewed_at)').run(accountId,viewed.job_id,viewed.first_viewed_at);
      // The visitor's active tab stays selected; account drafts retain their own
      // keys. A conflicting pre-search draft stays in durable recovery storage.
      const incoming={...visitorState.drafts};const newDraft=incoming.new;delete incoming.new;
      const state={activeSearchId:visitorState.activeSearchId??accountState.activeSearchId,drafts:{...accountState.drafts,...incoming}};
      let recoveredDraftId;
      if(newDraft!=null&&!Object.hasOwn(state.drafts,'new'))state.drafts.new=newDraft;
      else if(newDraft!=null&&newDraft!==state.drafts.new) {
        if(db.prepare('SELECT count(*) n FROM justup_recovered_drafts WHERE owner_id=?').get(accountId).n>=100)throw problem('task_limit',429);
        recoveredDraftId=randomUUID();
        db.prepare('INSERT INTO justup_recovered_drafts VALUES(?,?,?,?)').run(recoveredDraftId,accountId,newDraft,now());
      }
      db.prepare('UPDATE justup_recovered_drafts SET owner_id=? WHERE owner_id=?').run(accountId,row.id);
      recoveryBudget(accountId);
      if(Object.keys(state.drafts).length>100||Buffer.byteLength(JSON.stringify(state))>60_000)throw problem('task_limit',429);
      db.prepare('INSERT INTO justup_workspaces(owner_id,state_json,updated_at,revision) VALUES(?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at,revision=excluded.revision').run(accountId,JSON.stringify(state),now(),accountWorkspace.revision+1);
      deleteAccountData(row.id);
      db.prepare('UPDATE justup_visitors SET handed_to=?,handed_at=? WHERE id=? AND handed_to IS NULL').run(accountId,now(),row.id);
      return {status:'complete',...(recoveredDraftId?{recoveredDraftId}:{})};
    }));
  }
  async function visitorRoute(ctx) {
    if(!ctx.path.startsWith('/visitor/'))return null;
    if(ctx.viewer?.account)throw problem('forbidden',403);
    const viewer=identity.fromToken(ctx.visitorToken,{allowUnavailable:ctx.method==='DELETE'});if(!viewer)throw problem('unauthenticated',401);
    const ownerId=viewer.visitor.id,path=ctx.path.slice('/visitor'.length);
    const privateCtx={...ctx,path,url:new URL(ctx.url),viewer,ownerId,accountId:null};
    if(/^\/searches(?:\/|$)/.test(path))return intent.route(privateCtx);
    if(ctx.method==='GET'&&/^\/tasks\/[^/]+$/.test(path)){
      const task=tasks.get(ownerId,path.split('/')[2]);if(!task)throw problem('not_found',404);
      return {status:200,body:tasks.publicView(task,intent.taskResult(task,privateCtx)??null)};
    }
    if(path==='/workspace'||/^\/workspace\/recovered-drafts\/[^/]+$/.test(path)||path==='/viewed')return stateRoute(privateCtx);
    if(ctx.method==='DELETE'&&path==='/session') {deletion(()=>{intent.deleteAccountData(ownerId);matching?.deleteAccountData?.(ownerId);tasks.deleteOwner(ownerId);deleteAccountData(ownerId);db.prepare('DELETE FROM justup_visitors WHERE id=?').run(ownerId);});return {status:200,body:{deleted:true}};}
    return null;
  }
  function stateRoute(ctx) {
    const owner=ownerOf(ctx.viewer),current=identity.principal(owner);if(!owner||!current)throw problem('unauthenticated',401);ctx={...ctx,viewer:current};
    if(ctx.method==='POST'&&/^\/workspace\/recovered-drafts\/[^/]+$/.test(ctx.path)){
      keys(ctx.body,['expectedRevision','action']);
      if(!Number.isSafeInteger(ctx.body.expectedRevision)||ctx.body.expectedRevision<0||!['use','discard'].includes(ctx.body.action))throw problem('invalid_input');
      return {status:200,body:deletion(()=>{
        const current=workspace(owner);if(current.revision!==ctx.body.expectedRevision)throw problem('revision_conflict',409);
        const id=ctx.path.split('/')[3],draft=db.prepare('SELECT text FROM justup_recovered_drafts WHERE owner_id=? AND id=?').get(owner,id);if(!draft)throw problem('not_found',404);
        const state=current.state;
        if(ctx.body.action==='use'){
          const previous=state.drafts.new;state.drafts.new=draft.text;state.activeSearchId=null;
          if(previous&&previous!==draft.text)db.prepare('UPDATE justup_recovered_drafts SET text=?,created_at=? WHERE owner_id=? AND id=?').run(previous,now(),owner,id);
          else db.prepare('DELETE FROM justup_recovered_drafts WHERE owner_id=? AND id=?').run(owner,id);
        }else db.prepare('DELETE FROM justup_recovered_drafts WHERE owner_id=? AND id=?').run(owner,id);
        recoveryBudget(owner);
        if(Buffer.byteLength(JSON.stringify(state))>60_000)throw problem('task_limit',429);
        db.prepare('INSERT INTO justup_workspaces(owner_id,state_json,updated_at,revision) VALUES(?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at,revision=excluded.revision').run(owner,JSON.stringify(state),now(),current.revision+1);
        return workspace(owner);
      })};
    }
    if(ctx.method==='GET'&&ctx.path==='/workspace')return {status:200,body:workspace(owner)};
    if(ctx.method==='PATCH'&&ctx.path==='/workspace')return {status:200,body:writeWorkspace(owner,ctx.body)};
    if(ctx.method==='POST'&&ctx.path==='/viewed'){
      keys(ctx.body,['jobId']);if(typeof ctx.body.jobId!=='string'||ctx.body.jobId.length>128)throw problem('invalid_input');
      // The caller cannot use this write to probe withheld identifiers.
      if(!feed.eligibleJobs({viewer:ctx.viewer}).some(j=>j.id===ctx.body.jobId))throw problem('not_found',404);
      if(db.prepare('SELECT count(*) n FROM justup_viewed WHERE owner_id=?').get(owner).n>=1000&&!db.prepare('SELECT 1 FROM justup_viewed WHERE owner_id=? AND job_id=?').get(owner,ctx.body.jobId))throw problem('task_limit',429);
      db.prepare('INSERT OR IGNORE INTO justup_viewed VALUES(?,?,?)').run(owner,ctx.body.jobId,now());return {status:200,body:{viewed:true}};
    }
    return null;
  }
  return {identity,publicVisitor,cleanup,handoff,visitorRoute,route:stateRoute,deleteAccountData,
    currentSession(token){cleanup();return identity.fromToken(token);},admitCreation:body=>intent.admitVisitorCreation(body),refreshAvailability:()=>identity.refreshAvailability(),
    discardEmptySession(token){const current=identity.fromToken(token);if(current&&!db.prepare('SELECT 1 FROM demo_searches WHERE owner_id=?').get(current.visitor.id))db.prepare('DELETE FROM justup_visitors WHERE id=?').run(current.visitor.id);},
    openSession(token){cleanup();return identity.open(token);},
    capabilities:()=>({visitorSearch:identity.processingAvailable(),viewed:true,hiddenMatchCounts:typeof feed.restrictedLatestJobs==='function'})};
}
