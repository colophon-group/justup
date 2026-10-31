// Account-owned search revisions and the evidence-backed v1 compiler. Read when
// changing interpretation, proposal confirmation, primary filters or result cursors.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validateModelData } from './model-runner.mjs';

const schema = JSON.parse(readFileSync(new URL('./model-schemas/intent.schema.json', import.meta.url)));
const KEYS = ['companyInclude','companyExclude','titleAny','bodyAll','bodyNone','locations','workplaces','employmentTypes','postingLanguages','seniority'];
const TEXT_KEYS = new Set(['titleAny','bodyAll','bodyNone']);
const fold = (s) => s.normalize('NFKC').trim().toLocaleLowerCase('en');
const err = (code, status = 400, message = 'Invalid request.') => Object.assign(new Error(message), { code, status });
const tx = (db, fn) => { db.exec('SAVEPOINT intent_write'); try { const r=fn(); db.exec('RELEASE intent_write'); return r; } catch(e) { db.exec('ROLLBACK TO intent_write; RELEASE intent_write'); throw e; } };
function text(v, max=4000) { if(typeof v!=='string'||!v.trim()||v.length>max||/[\u0000-\u001f\u007f]/.test(v)) throw err('invalid_input'); return v.trim(); }
function bodyKeys(body, keys) { if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!keys.includes(k))) throw err('invalid_input'); }
function revision(v) { if(!Number.isSafeInteger(v)||v<0) throw err('invalid_input'); return v; }
function key(v) { if(typeof v!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(v)) throw err('invalid_input'); return v; }
const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

export function intentCapabilities(jobs, aiAvailable = false) {
  const values = (items) => [...new Set(items.filter(Boolean))].sort();
  const companies = new Map(), seniors = new Map();
  for(const j of jobs) { companies.set(j.companyId,{id:j.companyId,name:j.companyName,aliases:[j.companyName,j.companySlug].filter(Boolean)}); if(j.seniority?.id) seniors.set(j.seniority.id,{id:j.seniority.id,name:j.seniority.name,aliases:[j.seniority.name].filter(Boolean)}); }
  return { schemaVersion:1, operators:{ companyInclude:'any canonical company ID',companyExclude:'exclude every canonical company ID',titleAny:'case-insensitive substring OR',bodyAll:'case-insensitive substring AND; missing text unknown',bodyNone:'exclude substring OR; missing text unknown',locations:'exact canonical label OR; no remote eligibility inference',workplaces:'known workplace OR',employmentTypes:'known employment type OR',postingLanguages:'known posting language OR',seniority:'known seniority ID OR' },
    values:{companies:[...companies.values()].sort((a,b)=>a.id.localeCompare(b.id)),locations:values(jobs.flatMap(j=>j.locations.map(l=>l.name))),workplaces:values(jobs.flatMap(j=>j.locations.map(l=>l.workplace))),employmentTypes:values(jobs.flatMap(j=>j.employmentTypes)),postingLanguages:values(jobs.flatMap(j=>j.locales)),seniority:[...seniors.values()].sort((a,b)=>a.id.localeCompare(b.id))},
    aiAvailable, unknownEvidence:'Unknown never proves a requirement; location labels do not prove cross-border remote eligibility.' };
}

export function compileIntent(raw, capabilities) {
  const diagnostics = validateModelData(raw, schema);
  if(diagnostics.length) return {ok:false,diagnostics};
  const data = structuredClone(raw), f=data.configuration.filters;
  for(const field of KEYS) if(f[field]===null) delete f[field];
  const catalog = capabilities.values;
  const canonical = { companyInclude:catalog.companies,companyExclude:catalog.companies,seniority:catalog.seniority,
    ...Object.fromEntries(['locations','workplaces','employmentTypes','postingLanguages'].map(k=>[k,catalog[k].map(v=>({id:v,aliases:[]}))])) };
  for(const [field, values] of Object.entries(f)) {
    f[field] = [...new Set(values.map((value,index)=> {
      if(TEXT_KEYS.has(field)) return value.trim();
      const matches=canonical[field].filter(v=>[v.id,v.name,...(v.aliases??[])].filter(Boolean).some(s=>fold(s)===fold(value)));
      if(matches.length!==1) { diagnostics.push({path:`$.configuration.filters.${field}[${index}]`,code:matches.length?'ambiguous_value':'unknown_value'}); return value; }
      return matches[0].id;
    }))];
  }
  for(const [a,b] of [['companyInclude','companyExclude'],['bodyAll','bodyNone']]) if((f[a]??[]).some(v=>(f[b]??[]).some(x=>fold(v)===fold(x)))) diagnostics.push({path:`$.configuration.filters.${b}`,code:'conflicting_value'});
  const ids=data.requirements.map(r=>r.id);
  if(new Set(ids).size!==ids.length) diagnostics.push({path:'$.requirements',code:'duplicate_id'});
  const residual=data.configuration.residualAi;
  for(const r of data.requirements) {
    if(r.handling==='primary'&&!Object.keys(f).length) diagnostics.push({path:`$.requirements[${ids.indexOf(r.id)}].handling`,code:'missing_primary_filter'});
    if(r.handling==='ai'&&(!residual||!residual.requirementIds.includes(r.id))) diagnostics.push({path:`$.requirements[${ids.indexOf(r.id)}].handling`,code:'missing_ai_condition'});
  }
  if(residual) {
    if(!capabilities.aiAvailable) diagnostics.push({path:'$.configuration.residualAi',code:'ai_unavailable'});
    if(residual.requirementIds.some(id=>!data.requirements.some(r=>r.id===id&&r.handling==='ai'))) diagnostics.push({path:'$.configuration.residualAi.requirementIds',code:'unknown_ai_requirement'});
  }
  if(diagnostics.length) return {ok:false,diagnostics};
  const warnings=data.requirements.filter(r=>r.handling==='unsatisfied').map(r=>({code:'unsupported_requirement',message:r.reason,requirementIds:[r.id]}));
  const labels={companyInclude:'Companies',companyExclude:'Exclude companies',titleAny:'Title contains any',bodyAll:'Body contains all',bodyNone:'Body excludes',locations:'Location labels',workplaces:'Workplace',employmentTypes:'Employment',postingLanguages:'Posting languages',seniority:'Seniority'};
  // Description is derived from the normalized configuration, never trusted model prose.
  const parts=Object.entries(f).map(([k,v])=>`${labels[k]}: ${v.join(', ')}.`);
  if(residual) parts.push(`Additional evidence required: ${residual.condition}`);
  return {ok:true,value:{title:data.title,configuration:data.configuration,requirements:data.requirements,warnings,description:parts.join(' ')||'All eligible imported jobs.'}};
}

export function primaryMatches(job, {filters:f}) {
  const includes=(list,value)=>list?.includes(value), contains=(s,t)=>fold(s).includes(fold(t));
  if(f.companyInclude&&!includes(f.companyInclude,job.companyId)) return false;
  if(includes(f.companyExclude,job.companyId)) return false;
  if(f.titleAny&&!f.titleAny.some(t=>contains(job.title,t))) return false;
  if((f.bodyAll||f.bodyNone)&&!job.bodyText) return false;
  if(f.bodyAll&&!f.bodyAll.every(t=>contains(job.bodyText,t))) return false;
  if(f.bodyNone&&f.bodyNone.some(t=>contains(job.bodyText,t))) return false;
  if(f.locations&&!job.locations.some(l=>includes(f.locations,l.name))) return false;
  if(f.workplaces&&!job.locations.some(l=>includes(f.workplaces,l.workplace))) return false;
  if(f.employmentTypes&&!job.employmentTypes.some(t=>includes(f.employmentTypes,t))) return false;
  if(f.postingLanguages&&!job.locales.some(t=>includes(f.postingLanguages,t))) return false;
  if(f.seniority&&!includes(f.seniority,job.seniority?.id)) return false;
  return true;
}

export function createIntentService({db,feed,tasks,config={},now=Date.now,beforePrivateDelete,afterPrivateTransaction,withPrivateTransaction,model,matching}={}) {
  if(!db||!feed||!tasks) throw new TypeError('Search dependencies are required.');
  db.exec(`CREATE TABLE IF NOT EXISTS demo_searches(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,accepted_json TEXT,draft_json TEXT,task_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;
    CREATE INDEX IF NOT EXISTS demo_searches_owner ON demo_searches(owner_id);
    CREATE TABLE IF NOT EXISTS demo_search_submissions(owner_id TEXT NOT NULL,request_key TEXT NOT NULL,search_id TEXT NOT NULL,input_hash TEXT NOT NULL,task_id TEXT NOT NULL,PRIMARY KEY(owner_id,request_key)) STRICT;
    CREATE TABLE IF NOT EXISTS demo_search_proposals(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,search_id TEXT NOT NULL,expected_revision INTEGER NOT NULL,task_id TEXT NOT NULL,proposal_json TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS demo_search_cursors(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,search_id TEXT NOT NULL,revision INTEGER NOT NULL,generation TEXT,access_hash TEXT NOT NULL,position INTEGER NOT NULL,created_at INTEGER NOT NULL) STRICT;`);
  const row=(owner,id)=>db.prepare('SELECT * FROM demo_searches WHERE owner_id=? AND id=?').get(owner,id);
  const available=()=>typeof model?.interpretIntent==='function'&&(typeof model.available!=='function'||model.available('search_intent'));
  function publicSearch(r) {
    if(!r) return null;
    const accepted=r.accepted_json?JSON.parse(r.accepted_json):{id:r.id,revision:0,query:JSON.parse(r.draft_json)?.query??'',title:'New search',description:'',configuration:null,requirements:[],warnings:[],status:'pending'};
    return r.draft_json?{...accepted,draft:JSON.parse(r.draft_json)}:accepted;
  }
  function purgeSearch(owner,id) {
    for(const s of db.prepare('SELECT task_id FROM demo_search_submissions WHERE owner_id=? AND search_id=?').all(owner,id)) tasks.delete(owner,s.task_id);
    for(const table of ['demo_search_proposals','demo_search_cursors','demo_search_submissions']) db.prepare(`DELETE FROM ${table} WHERE owner_id=? AND search_id=?`).run(owner,id);
    db.prepare('DELETE FROM demo_searches WHERE owner_id=? AND id=?').run(owner,id);
    matching?.deleteSearchData?.(owner,id);
  }
  function deleteAccountData(owner) {
    for(const s of db.prepare('SELECT id FROM demo_searches WHERE owner_id=?').all(owner)) purgeSearch(owner,s.id);
  }
  function live(task) { const t=tasks.get(task.ownerId,task.id); return t?.status==='running'&&t.leaseToken===task.leaseToken&&t.leaseUntil>now(); }
  function taskResult(task,ctx) {
    if(task.kind!=='search_intent'||task.ownerId!==ctx.accountId||!['succeeded','warning'].includes(task.status)) return undefined;
    const r=row(ctx.accountId,task.output?.searchId);
    if(!r) return undefined;
    if(task.status==='warning') { const p=db.prepare('SELECT proposal_json FROM demo_search_proposals WHERE id=? AND owner_id=? AND search_id=? AND expected_revision=? AND task_id=?').get(task.output?.proposalId,ctx.accountId,r.id,r.revision,task.id); return p?{proposal:JSON.parse(p.proposal_json)}:undefined; }
    return r.revision===task.output?.revision&&r.accepted_json?{search:JSON.parse(r.accepted_json)}:undefined;
  }
  async function runTask(task,{signal}={}) {
    if(task.kind!=='search_intent') throw new TypeError('Wrong task kind.');
    const r=row(task.ownerId,task.payload.searchId);
    if(!r||r.task_id!==task.id||r.revision!==task.payload.expectedRevision||!live(task)) return {status:'failed',errorCode:'revision_conflict'};
    if(!available()) return {status:'failed',errorCode:'dependency_unavailable'};
    const accepted=r.accepted_json?JSON.parse(r.accepted_json):null;
    const caps=intentCapabilities(feed.eligibleJobs({viewer:{account:{id:task.ownerId}}}),Boolean(matching?.available?.()??config.aiMatchingAvailable));
    const input={query:task.payload.query,prior:accepted?{query:accepted.query,configuration:accepted.configuration}:null,capabilities:caps,aiAvailable:caps.aiAvailable};
    let result,previous;
    for(let attempt=0;attempt<2;attempt++) {
      if(signal?.aborted) return {status:'failed',errorCode:'task_timeout'};
      let raw;
      try { raw=await model.interpretIntent({...input,...(attempt?{repair:{diagnostics:result.diagnostics,previous}}:{})},{signal}); }
      catch { return {status:'failed',errorCode:signal?.aborted?'task_timeout':'provider_unavailable'}; }
      result=compileIntent(raw,caps);
      if(result.ok) break;
      // Invalid JSON/schema data is never echoed into a repair. Valid bounded
      // model data can accompany field diagnostics in the one new invocation.
      previous=validateModelData(raw,schema).length?null:raw;
    }
    if(!result.ok) return {status:'failed',errorCode:'invalid_output'};
    if(signal?.aborted) return {status:'failed',errorCode:'task_timeout'};
    return tx(db,()=>{
      const current=row(task.ownerId,r.id);
      if(!current||current.task_id!==task.id||current.revision!==r.revision||!live(task)) return {status:'failed',errorCode:'revision_conflict'};
      const complete=(result)=>{if(!tasks.complete(task.id,task.leaseToken,result)) throw err('revision_conflict',409,'This search changed. Reload it and try again.');return {...result,committed:true};};
      if(result.value.warnings.length) {
        const proposal={proposalId:randomUUID(),searchId:r.id,expectedRevision:r.revision,query:task.payload.query,...result.value};
        db.prepare('INSERT INTO demo_search_proposals VALUES(?,?,?,?,?,?)').run(proposal.proposalId,task.ownerId,r.id,r.revision,task.id,JSON.stringify(proposal));
        return complete({status:'warning',output:{searchId:r.id,proposalId:proposal.proposalId}});
      }
      const search={id:r.id,revision:r.revision+1,query:task.payload.query,...result.value,status:'ready'};
      db.prepare('UPDATE demo_searches SET revision=?,accepted_json=?,draft_json=NULL,task_id=NULL,updated_at=? WHERE id=? AND owner_id=? AND revision=? AND task_id=?').run(search.revision,JSON.stringify(search),now(),r.id,task.ownerId,r.revision,task.id);
      db.prepare('DELETE FROM demo_search_proposals WHERE search_id=? AND owner_id=?').run(r.id,task.ownerId);
      return complete({status:'succeeded',output:{searchId:r.id,revision:search.revision}});
    });
  }
  async function results(r,ctx) {
    const requested=Number(ctx.url.searchParams.get('revision'));
    if(!r.accepted_json||!ctx.url.searchParams.has('revision')||requested!==r.revision) throw err('revision_conflict',409,'This search changed. Reload it and try again.');
    const search=JSON.parse(r.accepted_json), limit=Number(ctx.url.searchParams.get('limit')??12), cursor=ctx.url.searchParams.get('cursor');
    if(!Number.isInteger(limit)||limit<1||limit>50) throw err('invalid_limit');
    const generation=feed.generation?.()??null,accessHash=hash({accountId:ctx.accountId,access:ctx.viewer?.access??null});
    const jobs=feed.eligibleJobs({viewer:ctx.viewer}).filter(j=>primaryMatches(j,search.configuration));
    const coverage=feed.coverage();
    if(search.configuration.residualAi&&matching?.page) return {searchId:r.id,revision:r.revision,asOf:new Date(now()).toISOString(),coverage,...await matching.page({ownerId:ctx.accountId,searchId:r.id,revision:r.revision,configuration:search.configuration,jobs,viewer:ctx.viewer,cursor,limit,coverage,generation,now})};
    db.prepare('DELETE FROM demo_search_cursors WHERE created_at<=?').run(now()-600_000);
    let position=0;
    if(cursor) {
      if(cursor.length>128) throw err('invalid_cursor');
      const c=db.prepare('SELECT * FROM demo_search_cursors WHERE id=? AND owner_id=? AND search_id=?').get(cursor,ctx.accountId,r.id);
      if(!c||c.revision!==r.revision||c.generation!==generation||c.access_hash!==accessHash||c.created_at>now()) throw err('stale_cursor',409,'This search changed. Reload it and try again.');
      position=c.position;
    }
    if(search.configuration.residualAi) {
      const id=cursor??randomUUID();
      if(!cursor) db.prepare('INSERT INTO demo_search_cursors VALUES(?,?,?,?,?,?,?,?)').run(id,ctx.accountId,r.id,r.revision,generation,accessHash,position,now());
      return {searchId:r.id,revision:r.revision,asOf:new Date(now()).toISOString(),items:[],continuation:{cursor:id,state:'paused',retryAfterMs:5000},ai:{status:'dependency_unavailable'},coverage};
    }
    const page=jobs.slice(position,position+limit),more=position+page.length<jobs.length;
    let next=null;
    if(more) { next=randomUUID(); db.prepare('INSERT INTO demo_search_cursors VALUES(?,?,?,?,?,?,?,?)').run(next,ctx.accountId,r.id,r.revision,generation,accessHash,position+page.length,now()); }
    return {searchId:r.id,revision:r.revision,asOf:new Date(now()).toISOString(),items:page.map(j=>feed.publicJob(j)),continuation:{cursor:next,state:more?'open':'exhausted',retryAfterMs:null},ai:{status:'not_required'},coverage};
  }
  async function route(ctx) {
    if(!/^\/searches(?:\/|$)/.test(ctx.path)) return null;
    if(!ctx.accountId||!ctx.viewer) throw err('unauthenticated',401,'Sign in to continue.');
    const id=ctx.path.split('/')[2],r=id?row(ctx.accountId,id):null;
    if(id&&!r) throw err('not_found',404,'Not found.');
    if(ctx.method==='GET'&&ctx.path==='/searches') return {status:200,body:{items:db.prepare('SELECT * FROM demo_searches WHERE owner_id=? ORDER BY created_at,id').all(ctx.accountId).map(publicSearch)}};
    if(ctx.method==='GET'&&ctx.path===`/searches/${id}/results`) return {status:200,body:await results(r,ctx)};
    if(ctx.method==='DELETE'&&ctx.path===`/searches/${id}`) {
      if(typeof beforePrivateDelete!=='function') throw err('deletion_unavailable',503,'Deletion is temporarily unavailable.');
      const remove=()=>{const barrier=beforePrivateDelete();if(barrier&&typeof barrier.then==='function') throw new TypeError('Deletion barrier must be synchronous.');purgeSearch(ctx.accountId,id);};
      if(withPrivateTransaction)withPrivateTransaction(remove);
      else try{tx(db,remove);}finally{if(!db.isTransaction)afterPrivateTransaction?.();}
      return {status:200,body:{deleted:true}};
    }
    if(ctx.method==='POST'&&ctx.path===`/searches/${id}/confirm`) {
      bodyKeys(ctx.body,['proposalId','expectedRevision']); const expected=revision(ctx.body.expectedRevision);
      return tx(db,()=>{
        const current=row(ctx.accountId,id),p=db.prepare('SELECT * FROM demo_search_proposals WHERE id=? AND owner_id=? AND search_id=?').get(text(ctx.body.proposalId,128),ctx.accountId,id);
        if(!p||!current||current.revision!==expected||p.expected_revision!==expected||current.task_id!==p.task_id) throw err('revision_conflict',409,'This search changed. Reload it and try again.');
        const {proposalId,searchId,expectedRevision,...data}=JSON.parse(p.proposal_json),search={id,revision:expected+1,...data,status:'ready'};
        db.prepare('UPDATE demo_searches SET revision=?,accepted_json=?,draft_json=NULL,task_id=NULL,updated_at=? WHERE id=? AND owner_id=?').run(search.revision,JSON.stringify(search),now(),id,ctx.accountId);
        db.prepare('DELETE FROM demo_search_proposals WHERE search_id=? AND owner_id=?').run(id,ctx.accountId);
        return {status:200,body:{search}};
      });
    }
    const creating=ctx.method==='POST'&&ctx.path==='/searches',editing=ctx.method==='PATCH'&&ctx.path===`/searches/${id}`;
    if(creating||editing) {
      bodyKeys(ctx.body,creating?['query','requestKey']:['query','requestKey','expectedRevision']);
      const query=text(ctx.body.query),requestKey=key(ctx.body.requestKey),expected=creating?0:revision(ctx.body.expectedRevision);
      const fingerprint=hash({id:creating?null:id,query,expectedRevision:expected});
      const prior=db.prepare('SELECT * FROM demo_search_submissions WHERE owner_id=? AND request_key=?').get(ctx.accountId,requestKey);
      if(prior) {
        if(prior.input_hash!==fingerprint) throw err('idempotency_conflict',409,'This request key was already used.');
        const old=row(ctx.accountId,prior.search_id),task=tasks.get(ctx.accountId,prior.task_id);
        if(!old||!task) throw err('revision_conflict',409,'This search changed. Reload it and try again.');
        return {status:202,body:{search:publicSearch(old),task:tasks.publicView(task,taskResult(task,ctx)??null)}};
      }
      if(editing&&r.revision!==expected) throw err('revision_conflict',409,'This search changed. Reload it and try again.');
      if(!available()) throw err('dependency_unavailable',503,'Search interpretation is temporarily unavailable.');
      if(creating&&db.prepare('SELECT count(*) n FROM demo_searches WHERE owner_id=?').get(ctx.accountId).n>=20) throw err('task_limit',429,'The demo search limit has been reached.');
      const searchId=creating?randomUUID():id;
      const task=tasks.enqueue({ownerId:ctx.accountId,kind:'search_intent',requestKey,payload:{searchId,query,expectedRevision:expected}});
      try { tx(db,()=>{
        if(creating) db.prepare('INSERT INTO demo_searches VALUES(?,?,0,NULL,?,?,?,?)').run(searchId,ctx.accountId,JSON.stringify({query,taskId:task.id}),task.id,now(),now());
        else {
          if(r.task_id) tasks.cancel(ctx.accountId,r.task_id);
          db.prepare('UPDATE demo_searches SET draft_json=?,task_id=?,updated_at=? WHERE id=? AND owner_id=? AND revision=?').run(JSON.stringify({query,taskId:task.id}),task.id,now(),id,ctx.accountId,expected);
          db.prepare('DELETE FROM demo_search_proposals WHERE search_id=? AND owner_id=?').run(id,ctx.accountId);
        }
        db.prepare('INSERT INTO demo_search_submissions VALUES(?,?,?,?,?)').run(ctx.accountId,requestKey,searchId,fingerprint,task.id);
      }); } catch(e) { tasks.delete(ctx.accountId,task.id); throw e; }
      return {status:202,body:{search:publicSearch(row(ctx.accountId,searchId)),task:tasks.publicView(task)}};
    }
    return null;
  }
  return {capabilities:()=>({search:available()}),compilerCapabilities:()=>intentCapabilities(feed.eligibleJobs({viewer:{account:{id:'capabilities'}}}),Boolean(matching?.available?.()??config.aiMatchingAvailable)),route,taskResult,deleteAccountData,runTask};
}
