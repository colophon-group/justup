// Cookie-bound temporary search ownership and verified-account handoff. Read when
// changing anonymous retention, admission, workspace state or shared-browser isolation.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { POLICY_LOCALES } from './policies.mjs';
import { problem } from './store.mjs';
import { createProcessingAdmission,privateGeneration as visitorPrivateGeneration } from './processing-admission.mjs';
export { visitorPrivateGeneration };

const DAY = 86_400_000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const GUEST = Object.freeze({kind:'guest',fullAccess:false,legacy:false,premium:false,billingEnabled:false,until:null});
const keys = (body, allowed) => { if(!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).some(k=>!allowed.includes(k))) throw problem('invalid_input'); };
const savepoint = (db, work) => { db.exec('SAVEPOINT visitor_write'); try { const value=work(); db.exec('RELEASE visitor_write'); return value; } catch(error) { db.exec('ROLLBACK TO visitor_write; RELEASE visitor_write'); throw error; } };

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
    CREATE TABLE IF NOT EXISTS justup_viewed (owner_id TEXT NOT NULL, job_id TEXT NOT NULL, first_viewed_at INTEGER NOT NULL, PRIMARY KEY(owner_id,job_id)) STRICT;`);
  if(!db.prepare('PRAGMA table_info(justup_visitors)').all().some(c=>c.name==='matching_tasks'))db.exec('ALTER TABLE justup_visitors ADD COLUMN matching_tasks INTEGER NOT NULL DEFAULT 0');
  if(!db.prepare('PRAGMA table_info(justup_workspaces)').all().some(c=>c.name==='revision'))db.exec('ALTER TABLE justup_workspaces ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
  if(!db.prepare('PRAGMA table_info(justup_visitors)').all().some(c=>c.name==='interface_locale'))db.exec("ALTER TABLE justup_visitors ADD COLUMN interface_locale TEXT NOT NULL DEFAULT 'en'");
  const visitorRow=id=>db.prepare('SELECT * FROM justup_visitors WHERE id=? AND handed_to IS NULL AND expires_at>?').get(id,now());
  // A not-yet-allocated cookie is valid only in the current deletion epoch.
  // Isolated databases have no recovery file, so keep a per-instance nonce.
  const isolated=config.dbPath==null||config.dbPath===':memory:';
  let isolatedIssuanceEpoch=isolated?randomBytes(32).toString('base64url'):null;
  const issuanceEpoch=()=>isolated?isolatedIssuanceEpoch:visitorPrivateGeneration(config);
  const rotateIssuanceEpoch=()=>{if(isolated)isolatedIssuanceEpoch=randomBytes(32).toString('base64url');};
  const {processingAvailable,refreshAvailability,processingPolicy}=createProcessingAdmission({db,now,config,availability:visitorAvailability});
  function principal(id,{allowUnavailable=false,locale}={}) {
    if(typeof id!=='string')return null;
    locale??=id.startsWith('visitor:')?visitorRow(id)?.interface_locale:db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='justup_preferences'").get()?db.prepare('SELECT interface_locale FROM justup_preferences WHERE owner_id=?').get(id)?.interface_locale:null;
    locale??='en';
    const policy=allowUnavailable?null:processingPolicy(locale);
    if(!allowUnavailable&&!policy)return null;
    if(id.startsWith('visitor:')) {
      const row=visitorRow(id);return row?{visitor:{id},expiresAt:row.expires_at,access:GUEST,interfaceLocale:locale,...(policy?{processingPolicy:policy}:{})}:null;
    }
    // Queued flags and a copied account ID never grant access. This adapter must
    // synchronously reload the persisted current entitlement on every call.
    const access=accessForAccount?.(id);
    if(!access || typeof access.then==='function' || typeof access.fullAccess!=='boolean')return null;
    return {account:{id},access,interfaceLocale:locale,...(policy?{processingPolicy:policy}:{})};
  }
  function fromToken(token,options) {
    if(!TOKEN.test(token??''))return null;
    const row=db.prepare('SELECT id FROM justup_visitors WHERE token_hash=? AND handed_to IS NULL AND expires_at>?').get(hash(token),now());
    return row?principal(row.id,options):null;
  }
  const tokenRetired=token=>TOKEN.test(token??'')&&Boolean(db.prepare('SELECT 1 FROM justup_visitors WHERE token_hash=? AND handed_to IS NOT NULL').get(hash(token)));
  function open(token,{locale='en',issuanceEpoch:expectedEpoch}={}) {
    if(!POLICY_LOCALES.includes(locale)||!processingAvailable(locale))throw problem('dependency_unavailable',503);
    function allocate() {
      const current=fromToken(token,{locale});if(current)return {principal:current,token};
      if(!TOKEN.test(token??'')||expectedEpoch==null||expectedEpoch!==issuanceEpoch()||tokenRetired(token))throw problem('unauthenticated',401);
      if(db.prepare('SELECT count(*) AS n FROM justup_visitors').get().n>=maxVisitors)throw problem('rate_limit',429);
      const id=`visitor:${randomUUID()}`,at=now();
      db.prepare('INSERT INTO justup_visitors(id,token_hash,created_at,expires_at,interface_locale) VALUES(?,?,?,?,?)').run(id,hash(token),at,at+ttl,locale);
      const owner=principal(id,{locale});if(!owner)throw problem('dependency_unavailable',503);
      return {principal:owner,token};
    }
    // A deletion writer must obtain this same SQLite write reservation before
    // rotating its generation. Validate the hint after taking that reservation.
    if(db.isTransaction)return allocate();
    db.exec('BEGIN IMMEDIATE');try{const result=allocate();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}
  }
  function admit(owner,{creating=false}={}) {
    const row=visitorRow(owner);if(!row)throw problem('unauthenticated',401);
    if(row.submissions>=maxSubmissions || creating&&db.prepare('SELECT count(*) AS n FROM demo_searches WHERE owner_id=?').get(owner).n>=maxSearches)throw problem('task_limit',429);
  }
  function recordSubmission(owner) { if(db.prepare('UPDATE justup_visitors SET submissions=submissions+1 WHERE id=? AND handed_to IS NULL AND expires_at>? AND submissions<?').run(owner,now(),maxSubmissions).changes!==1)throw problem('task_limit',429); }
  function admitMatching(owner,locale) {
    if(!principal(owner,{locale}))throw problem('policy_unavailable',503);
    if(!owner.startsWith('visitor:'))return;
    if(db.prepare('UPDATE justup_visitors SET matching_tasks=matching_tasks+1 WHERE id=? AND handed_to IS NULL AND expires_at>? AND matching_tasks<32').run(owner,now()).changes!==1)throw problem('task_limit',429);
  }
  return {principal,fromToken,tokenRetired,open,admit,recordSubmission,admitMatching,processingAvailable,processingPolicy,refreshAvailability,issuanceEpoch,rotateIssuanceEpoch};
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
    identity.rotateIssuanceEpoch();
  }
  function semanticallyEmpty(owner) {
    if(!db.prepare('SELECT 1 FROM justup_visitors WHERE id=? AND handed_to IS NULL').get(owner))return false;
    const saved=db.prepare('SELECT state_json FROM justup_workspaces WHERE owner_id=?').get(owner);
    if(saved){
      let state;try{state=JSON.parse(saved.state_json);}catch{return false;}
      if(!state||typeof state!=='object'||Array.isArray(state)||Object.keys(state).some(k=>!['activeSearchId','drafts'].includes(k))||state.activeSearchId!==null&&typeof state.activeSearchId!=='string'||!state.drafts||typeof state.drafts!=='object'||Array.isArray(state.drafts)||Object.values(state.drafts).some(v=>typeof v!=='string'||v.length>0))return false;
    }
    // Count every persisted owner-scoped record, including a future feature's
    // private work. Empty workspace bookkeeping alone has no user content.
    const quote=name=>'"'+name.replaceAll('"','""')+'"';
    for(const table of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'justup_workspaces'").all()){
      const columns=db.prepare("SELECT name FROM pragma_table_info(?) WHERE name IN ('owner_id','account_id','principal_id','visitor_id')").all(table.name);
      if(columns.length&&db.prepare(`SELECT 1 FROM ${quote(table.name)} WHERE ${columns.map(c=>quote(c.name)+'=?').join(' OR ')} LIMIT 1`).get(...columns.map(()=>owner)))return false;
    }
    return true;
  }
  function reclaimEmptyVisitor(owner) {
    if(!semanticallyEmpty(owner))return false;
    const reclaimed=deletion(()=>{
      // The write transaction serializes this final check with a concurrent
      // draft, viewed action, search submission or another feature's work.
      if(!semanticallyEmpty(owner))return false;
      db.prepare('DELETE FROM justup_workspaces WHERE owner_id=?').run(owner);
      return db.prepare('DELETE FROM justup_visitors WHERE id=? AND handed_to IS NULL').run(owner).changes===1;
    });
    if(reclaimed)identity.rotateIssuanceEpoch();
    return reclaimed;
  }
  function workspace(owner) {
    const visible=new Set(feed.eligibleJobs({viewer:identity.principal(owner,{allowUnavailable:true})}).map(job=>job.id));
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
      if(!identity.principal(owner,{allowUnavailable:true}))throw problem('unauthenticated',401);
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
    if(db.prepare('DELETE FROM justup_visitors WHERE handed_to=?').run(owner).changes)identity.rotateIssuanceEpoch();
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
    if(ctx.method==='GET'&&ctx.path==='/visitor/search-options'){
      if(!identity.processingAvailable(ctx.interfaceLocale))throw problem('dependency_unavailable',503);
      return intent.route({...ctx,path:'/search-options'});
    }
    const viewer=identity.fromToken(ctx.visitorToken,{locale:ctx.interfaceLocale,allowUnavailable:ctx.method==='DELETE'});if(!viewer)throw problem('unauthenticated',401);
    const ownerId=viewer.visitor.id,path=ctx.path.slice('/visitor'.length);
    const privateCtx={...ctx,path,url:new URL(ctx.url),viewer,ownerId,accountId:null};
    if(/^\/searches(?:\/|$)/.test(path)||path==='/search-options'){
      const result=await intent.route(privateCtx);
      if(ctx.method==='DELETE'&&/^\/searches\/[^/]+$/.test(path)&&result?.body?.deleted===true)reclaimEmptyVisitor(ownerId);
      return result;
    }
    if(ctx.method==='GET'&&/^\/tasks\/[^/]+$/.test(path)){
      const task=tasks.get(ownerId,path.split('/')[2]);if(!task)throw problem('not_found',404);
      return {status:200,body:tasks.publicView(task,intent.taskResult(task,privateCtx)??null)};
    }
    if(path==='/workspace'||/^\/workspace\/recovered-drafts\/[^/]+$/.test(path)||path==='/viewed')return stateRoute(privateCtx);
    if(ctx.method==='DELETE'&&path==='/session') {deletion(()=>{intent.deleteAccountData(ownerId);matching?.deleteAccountData?.(ownerId);tasks.deleteOwner(ownerId);deleteAccountData(ownerId);db.prepare('DELETE FROM justup_visitors WHERE id=?').run(ownerId);});identity.rotateIssuanceEpoch();return {status:200,body:{deleted:true}};}
    return null;
  }
  function stateRoute(ctx) {
    const owner=ownerOf(ctx.viewer),current=identity.principal(owner,{allowUnavailable:ctx.method==='GET'||ctx.method==='DELETE',locale:ctx.interfaceLocale});if(!owner||!current)throw problem('unauthenticated',401);ctx={...ctx,viewer:current};
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
      return savepoint(db,()=>{
        const current=identity.principal(owner,{allowUnavailable:true});if(!current)throw problem('unauthenticated',401);
        // The caller cannot use this write to probe withheld identifiers.
        if(!feed.eligibleJobs({viewer:current}).some(j=>j.id===ctx.body.jobId))throw problem('not_found',404);
        if(db.prepare('SELECT count(*) n FROM justup_viewed WHERE owner_id=?').get(owner).n>=1000&&!db.prepare('SELECT 1 FROM justup_viewed WHERE owner_id=? AND job_id=?').get(owner,ctx.body.jobId))throw problem('task_limit',429);
        db.prepare('INSERT OR IGNORE INTO justup_viewed VALUES(?,?,?)').run(owner,ctx.body.jobId,now());return {status:200,body:{viewed:true}};
      });
    }
    return null;
  }
  return {identity,publicVisitor,cleanup,handoff,visitorRoute,route:stateRoute,deleteAccountData,
    currentSession(token,options){cleanup();return identity.fromToken(token,options);},sessionExists:token=>identity.fromToken(token,{allowUnavailable:true})!==null,
    tokenRetired:token=>identity.tokenRetired(token),issuanceEpoch:()=>identity.issuanceEpoch(),admitCreation:body=>intent.admitVisitorCreation(body),refreshAvailability:()=>identity.refreshAvailability(),
    discardEmptySession(token){const current=identity.fromToken(token,{allowUnavailable:true});if(current)reclaimEmptyVisitor(current.visitor.id);},
    openSession(token,options){cleanup();return identity.open(token,options);},
    capabilities:()=>({visitorSearch:POLICY_LOCALES.some(locale=>identity.processingAvailable(locale)),viewed:true,hiddenMatchCounts:typeof feed.restrictedLatestJobs==='function'})};
}
