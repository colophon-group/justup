// Server-owned search revisions and the evidence-backed v1 compiler. Read when
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
const words=s=>fold(s).replace(/[^\p{L}\p{N}]+/gu,' ').trim();
function entries(caps,field){
  const v=caps.values;
  if(field==='companyInclude'||field==='companyExclude')return v.companies;
  if(field==='seniority')return v.seniority;
  return v[field].map(id=>{let aliases=[];if(field==='locations')aliases=id.split(',').map(s=>s.trim()).filter(Boolean);if(field==='postingLanguages')try{aliases=[new Intl.DisplayNames(['en'],{type:'language'}).of(id)];}catch{}return {id,aliases};});
}
function normalizeValue(caps,field,value){
  if(TEXT_KEYS.has(field))return {values:[value.trim()]};
  const all=entries(caps,field),exact=all.filter(v=>fold(v.id)===fold(value));
  if(exact.length===1)return {values:[exact[0].id]};
  const matched=all.filter(v=>[v.name,...(v.aliases??[])].filter(Boolean).some(s=>words(s)===words(value)));
  // Country/region labels expand to every actually observed location under that
  // label. A shared city name across countries remains ambiguous.
  if(field==='locations'&&matched.length&&matched.every(v=>words(v.id.split(',').at(-1))===words(value)))return {values:[matched[0].id.split(',').at(-1).trim()],group:true};
  return matched.length===1?{values:[matched[0].id]}:{values:[],code:matched.length?'ambiguous_value':'unknown_value'};
}
function alternatives(caps,field,value){
  if(!KEYS.includes(field)||TEXT_KEYS.has(field))return [];
  const tokens=words(value).split(' ').filter(t=>t.length>1);
  return entries(caps,field).map(v=>({id:v.id,score:[v.id,v.name,...(v.aliases??[])].filter(Boolean).reduce((n,s)=>n+tokens.filter(t=>words(s).includes(t)).length,0)})).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id)).slice(0,6).map(v=>v.id);
}
export function projectIntentCapabilities(caps,{query,prior,diagnostics=[]}={},maxBytes=8500){
  const relevant=[query,prior?.query,...Object.values(prior?.configuration?.filters??{}).flatMap(v=>v.slice(0,8)),...diagnostics.flatMap(d=>[d.value,...(d.alternatives??[])])].filter(v=>typeof v==='string').join(' '),tokens=[...new Set(words(relevant).split(' ').filter(t=>t.length>2))].slice(0,128);
  const select=(values,max)=>values.map(value=>{const encoded=JSON.stringify(value),normalized=words(typeof value==='string'?value:encoded);return {value,encoded,score:tokens.reduce((n,t)=>n+(normalized.includes(t)?1:0),0)};}).sort((a,b)=>b.score-a.score||a.encoded.localeCompare(b.encoded)).slice(0,max).map(v=>v.value);
  const projected={...caps,values:{companies:select(caps.values.companies,12),locations:select(caps.values.locations,24),workplaces:caps.values.workplaces,employmentTypes:caps.values.employmentTypes,postingLanguages:select(caps.values.postingLanguages,32),seniority:select(caps.values.seniority,16)},catalogue:{partial:true,totals:Object.fromEntries(Object.entries(caps.values).map(([k,v])=>[k,v.length])),omissionIsNotUnsupported:true,instruction:'Company/location values shown are relevant examples. Propose exact user names or observed country/city labels even if omitted; the compiler checks the full catalogue and returns bounded alternatives. Never drop a requirement because a value is omitted.'}};
  while(Buffer.byteLength(JSON.stringify(projected))>maxBytes){const field=['companies','locations','seniority','postingLanguages'].sort((a,b)=>JSON.stringify(projected.values[b]).length-JSON.stringify(projected.values[a]).length).find(k=>projected.values[k].length);if(!field)throw err('invalid_output');projected.values[field].pop();}
  return projected;
}
function boundedPrior(prior,max=2){if(!prior)return null;const configuration=structuredClone(prior.configuration),omitted={};for(const [field,values] of Object.entries(configuration.filters)){if(values.length>max){configuration.filters[field]=values.slice(0,max);omitted[field]={count:values.length-max,fullValueHash:hash(values)};}}return {query:prior.query,configuration,...(Object.keys(omitted).length?{configurationContextPartial:true,omitted,instruction:'Current query is complete and authoritative. Omitted prior values are context, never permission to drop current requirements.'}:{})};}
export function intentModelInput({query,prior,capabilities,repair}){
  const diagnostics=(repair?.diagnostics??[]).slice(0,4).map(d=>({...d,...(d.alternatives?{alternatives:d.alternatives.slice(0,3)}:{})}));
  const input={query,prior:boundedPrior(prior),capabilities:projectIntentCapabilities(capabilities,{query,prior,diagnostics},6500),aiAvailable:capabilities.aiAvailable,...(repair?{repair:{diagnostics,previous:repair.previous??null}}:{})};
  if(Buffer.byteLength(JSON.stringify(input))>22000&&input.repair){input.repair.previous=null;input.repair.previousOmittedForBudget=true;}
  if(Buffer.byteLength(JSON.stringify(input))>22000){input.capabilities=projectIntentCapabilities(capabilities,{query,prior,diagnostics},3500);input.prior=boundedPrior(prior,1);}
  if(Buffer.byteLength(JSON.stringify(input))>22000)throw err('invalid_output');
  return input;
}

export function intentCapabilities(jobs, aiAvailable = false) {
  const values = (items) => [...new Set(items.filter(Boolean))].sort();
  const companies = new Map(), seniors = new Map();
  for(const j of jobs) {
    const existing=companies.get(j.companyId),aliases=[j.companyName,j.companySlug].filter(Boolean);
    if(existing)existing.aliases=[...new Set([...existing.aliases,...aliases])];else companies.set(j.companyId,{id:j.companyId,name:j.companyName,aliases});
    if(j.seniority?.id)seniors.set(j.seniority.id,{id:j.seniority.id,name:j.seniority.name,aliases:[j.seniority.name].filter(Boolean)});
  }
  return { schemaVersion:1, operators:{ companyInclude:'any canonical company ID',companyExclude:'exclude every canonical company ID',titleAny:'case-insensitive substring OR',bodyAll:'case-insensitive substring AND; missing text unknown',bodyNone:'exclude substring OR; missing text unknown',locations:'observed label or unambiguous city/country suffix OR; country suffix includes all observed labels; no remote eligibility inference',workplaces:'known workplace OR',employmentTypes:'known employment type OR',postingLanguages:'known posting language OR',seniority:'known seniority ID OR' },
    values:{companies:[...companies.values()].sort((a,b)=>a.id.localeCompare(b.id)),locations:values(jobs.flatMap(j=>j.locations.map(l=>l.name))),workplaces:values(jobs.flatMap(j=>j.locations.map(l=>l.workplace))),employmentTypes:values(jobs.flatMap(j=>j.employmentTypes)),postingLanguages:values(jobs.flatMap(j=>j.locales)),seniority:[...seniors.values()].sort((a,b)=>a.id.localeCompare(b.id))},
    aiAvailable, unknownEvidence:'Unknown never proves a requirement; location labels do not prove cross-border remote eligibility.' };
}

function companyPrefill(r,caps,query){
  const ref=r.companyReference;if(!ref||r.handling!=='unsatisfied')return null;
  const name=words(ref.input),request=typeof query==='string'?query:r.text;
  const unsafe=/[\u0000-\u001f\u007f<>]|\b[a-z][a-z\d+.-]*:|www\.|[\p{L}\p{N}][\p{L}\p{N}.-]*\.[\p{L}]{2,}/iu;
  if(name.length<2||unsafe.test(ref.input)||!words(r.text).includes(name)||!words(request).includes(name)||normalizeValue(caps,'companyInclude',ref.input).code!=='unknown_value')return null;
  const clauses=request.split(/[.;!?\n]/u).filter(s=>words(s).includes(name));
  const negative=/\b(not|no|exclude|excluding|except|avoid|without|prefer|preferably|ideally|optional|mention|example|nicht|ohne|sans)\b|(?:^|\s)-\s*\p{L}/iu;
  if(!clauses.length||negative.test(r.text)||clauses.some(s=>negative.test(s)))return null;
  const scope=typeof ref.scope==='string'&&!unsafe.test(ref.scope)&&words(ref.scope).length>1&&words(request).includes(words(ref.scope))?ref.scope.trim():null;
  return {input:ref.input.trim(),scope};
}
export function compileIntent(raw, capabilities,{query}={}) {
  const diagnostics = validateModelData(raw, schema);
  if(diagnostics.length) return {ok:false,diagnostics};
  const data = structuredClone(raw), f=data.configuration.filters;
  for(const field of KEYS) if(f[field]===null) delete f[field];
  for(const [field, values] of Object.entries(f)) {
    f[field] = [...new Set(values.flatMap((value,index)=> {const normalized=normalizeValue(capabilities,field,value);if(normalized.code)diagnostics.push({path:`$.configuration.filters.${field}[${index}]`,code:normalized.code,value,alternatives:alternatives(capabilities,field,value)});return normalized.values;}))];
  }
  for(const [a,b] of [['companyInclude','companyExclude'],['bodyAll','bodyNone']]) if((f[a]??[]).some(v=>(f[b]??[]).some(x=>fold(v)===fold(x)))) diagnostics.push({path:`$.configuration.filters.${b}`,code:'conflicting_value'});
  const ids=data.requirements.map(r=>r.id);
  if(new Set(ids).size!==ids.length) diagnostics.push({path:'$.requirements',code:'duplicate_id'});
  const residual=data.configuration.residualAi;
  const covered=new Set();
  for(const r of data.requirements) {
    const path=`$.requirements[${ids.indexOf(r.id)}]`;
    if(r.handling==='primary'&&!r.bindings.length)diagnostics.push({path:`${path}.bindings`,code:'missing_primary_binding'});
    if(r.handling!=='primary'&&r.bindings.length)diagnostics.push({path:`${path}.bindings`,code:'unexpected_binding'});
    for(const [i,b] of r.bindings.entries())for(const value of b.values){
      const normalized=normalizeValue(capabilities,b.field,value),all=TEXT_KEYS.has(b.field)?[{id:value,aliases:[]}]:entries(capabilities,b.field).filter(e=>normalized.values.includes(e.id)||normalized.group&&normalized.values.includes(e.id.split(',').at(-1).trim()));
      const stated=all.some(e=>[e.id,e.name,...(e.aliases??[])].filter(Boolean).some(alias=>words(alias).length>1&&words(r.text).includes(words(alias))));
      if(normalized.code||!normalized.values.length||normalized.values.some(v=>!f[b.field]?.includes(v))||!stated)diagnostics.push({path:`${path}.bindings[${i}]`,code:'unimplemented_primary_requirement'});
      else for(const v of normalized.values)covered.add(`${b.field}\0${v}`);
    }
    if(r.handling==='ai'&&(!residual||!residual.requirementIds.includes(r.id))) diagnostics.push({path:`$.requirements[${ids.indexOf(r.id)}].handling`,code:'missing_ai_condition'});
  }
  for(const [field,values] of Object.entries(f))if(values.some(v=>!covered.has(`${field}\0${v}`)))diagnostics.push({path:`$.configuration.filters.${field}`,code:'unaccounted_filter'});
  if(residual) {
    if(!capabilities.aiAvailable) diagnostics.push({path:'$.configuration.residualAi',code:'ai_unavailable'});
    if(residual.requirementIds.some(id=>!data.requirements.some(r=>r.id===id&&r.handling==='ai'))) diagnostics.push({path:'$.configuration.residualAi.requirementIds',code:'unknown_ai_requirement'});
  }
  if(diagnostics.length) return {ok:false,diagnostics};
  const warnings=data.requirements.filter(r=>r.handling==='unsatisfied').map(r=>{const prefill=companyPrefill(r,capabilities,query);return {code:prefill?'company_not_found':'unsupported_requirement',message:r.reason,requirementIds:[r.id],...(prefill?{companyRequestPrefill:prefill}:{})};});
  const labels={companyInclude:'Companies',companyExclude:'Exclude companies',titleAny:'Title contains any',bodyAll:'Body contains all',bodyNone:'Body excludes',locations:'Location labels',workplaces:'Workplace',employmentTypes:'Employment',postingLanguages:'Posting languages',seniority:'Seniority'};
  // Description is derived from the normalized configuration, never trusted model prose.
  const parts=Object.entries(f).map(([k,v])=>`${labels[k]}: ${v.join(', ')}.`);
  if(residual) parts.push(`Additional evidence required: ${residual.condition}`);
  return {ok:true,value:{title:data.title,configuration:data.configuration,requirements:data.requirements.map(({bindings,companyReference,...r})=>r),warnings,description:parts.join(' ')||'All eligible imported jobs.'}};
}

export function primaryMatches(job, {filters:f}) {
  const includes=(list,value)=>list?.includes(value), contains=(s,t)=>fold(s).includes(fold(t));
  if(f.companyInclude&&!includes(f.companyInclude,job.companyId)) return false;
  if(includes(f.companyExclude,job.companyId)) return false;
  if(f.titleAny&&!f.titleAny.some(t=>contains(job.title,t))) return false;
  if((f.bodyAll||f.bodyNone)&&!job.bodyText) return false;
  if(f.bodyAll&&!f.bodyAll.every(t=>contains(job.bodyText,t))) return false;
  if(f.bodyNone&&f.bodyNone.some(t=>contains(job.bodyText,t))) return false;
  if(f.locations&&!job.locations.some(l=>includes(f.locations,l.name)||typeof l.name==='string'&&includes(f.locations,l.name.split(',').at(-1).trim()))) return false;
  if(f.workplaces&&!job.locations.some(l=>includes(f.workplaces,l.workplace))) return false;
  if(f.employmentTypes&&!job.employmentTypes.some(t=>includes(f.employmentTypes,t))) return false;
  if(f.postingLanguages&&!job.locales.some(t=>includes(f.postingLanguages,t))) return false;
  if(f.seniority&&!includes(f.seniority,job.seniority?.id)) return false;
  return true;
}

export function createIntentService({db,feed,tasks,config={},now=Date.now,beforePrivateDelete,afterPrivateTransaction,withPrivateTransaction,model,matching,availability,ownerAuthority,visitorIdentity}={}) {
  if(!db||!feed||!tasks) throw new TypeError('Search dependencies are required.');
  db.exec(`CREATE TABLE IF NOT EXISTS demo_searches(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,accepted_json TEXT,draft_json TEXT,task_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;
    CREATE INDEX IF NOT EXISTS demo_searches_owner ON demo_searches(owner_id);
    CREATE TABLE IF NOT EXISTS demo_search_submissions(owner_id TEXT NOT NULL,request_key TEXT NOT NULL,search_id TEXT NOT NULL,input_hash TEXT NOT NULL,task_id TEXT NOT NULL,PRIMARY KEY(owner_id,request_key)) STRICT;
    CREATE TABLE IF NOT EXISTS demo_search_proposals(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,search_id TEXT NOT NULL,expected_revision INTEGER NOT NULL,task_id TEXT NOT NULL,proposal_json TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS demo_search_cursors(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,search_id TEXT NOT NULL,revision INTEGER NOT NULL,generation TEXT,access_hash TEXT NOT NULL,position INTEGER NOT NULL,created_at INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS demo_search_delegate_cursors(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,search_id TEXT NOT NULL,revision INTEGER NOT NULL,generation TEXT,access_hash TEXT NOT NULL,delegate_cursor TEXT,created_at INTEGER NOT NULL) STRICT;`);
  const ownerOf=ctx=>ctx.viewer?.visitor?.id??ctx.accountId;
  const authority=(owner,cleanup=false)=>typeof ownerAuthority==='function'?ownerAuthority(owner,{allowUnavailable:cleanup}):null;
  const row=(owner,id)=>db.prepare('SELECT * FROM demo_searches WHERE owner_id=? AND id=?').get(owner,id);
  const executionAvailable=()=>typeof model?.interpretIntent==='function'&&(typeof model.available!=='function'||model.available('search_intent'));
  const available=()=>typeof availability==='function'?availability()===true:executionAvailable();
  function catalogueCapabilities(){
    const aiAvailable=Boolean(matching?.available?.()??config.aiMatchingAvailable);
    if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='demo_jobs'").get())return intentCapabilities(feed.eligibleJobs({viewer:{account:{id:'catalogue'}}}),aiAvailable);
    // The bounded imported metadata catalogue is independent of result eligibility.
    // SQL projects only canonical fields: no posting identity/title/body is read.
    const rows=db.prepare(`SELECT company_id AS companyId,
      json_extract(data_json,'$.companyName') AS companyName,json_extract(data_json,'$.companySlug') AS companySlug,
      json_extract(data_json,'$.locations') AS locations_json,json_extract(data_json,'$.employmentTypes') AS employment_json,
      json_extract(data_json,'$.locales') AS locales_json,json_extract(data_json,'$.seniority') AS seniority_json
      FROM demo_jobs ORDER BY first_seen_at DESC,company_id LIMIT 1001`).all();
    if(rows.length>1000)throw err('dependency_unavailable',503,'The imported catalogue exceeds its bound.');
    return intentCapabilities(rows.map(r=>({companyId:r.companyId,companyName:r.companyName,companySlug:r.companySlug,
      locations:JSON.parse(r.locations_json??'[]'),employmentTypes:JSON.parse(r.employment_json??'[]'),
      locales:JSON.parse(r.locales_json??'[]'),seniority:r.seniority_json==null?null:JSON.parse(r.seniority_json)})),aiAvailable);
  }
  function publicSearch(r) {
    if(!r) return null;
    const accepted=r.accepted_json?JSON.parse(r.accepted_json):{id:r.id,revision:0,query:JSON.parse(r.draft_json)?.query??'',title:'New search',description:'',configuration:null,requirements:[],warnings:[],status:'pending'};
    const proposal=db.prepare('SELECT proposal_json FROM demo_search_proposals WHERE owner_id=? AND search_id=? AND expected_revision=? AND task_id=?').get(r.owner_id,r.id,r.revision,r.task_id);
    return {...accepted,...(r.draft_json?{draft:JSON.parse(r.draft_json)}:{}),...(proposal?{proposal:JSON.parse(proposal.proposal_json)}:{})};
  }
  function purgeSearch(owner,id) {
    for(const s of db.prepare('SELECT task_id FROM demo_search_submissions WHERE owner_id=? AND search_id=?').all(owner,id)) tasks.delete(owner,s.task_id);
    for(const table of ['demo_search_proposals','demo_search_cursors','demo_search_delegate_cursors','demo_search_submissions']) db.prepare(`DELETE FROM ${table} WHERE owner_id=? AND search_id=?`).run(owner,id);
    db.prepare('DELETE FROM demo_searches WHERE owner_id=? AND id=?').run(owner,id);
    matching?.deleteSearchData?.(owner,id);
  }
  function deleteAccountData(owner) {
    for(const s of db.prepare('SELECT id FROM demo_searches WHERE owner_id=?').all(owner)) purgeSearch(owner,s.id);
  }
  function live(task) { const t=tasks.get(task.ownerId,task.id); return t?.status==='running'&&t.leaseToken===task.leaseToken&&t.leaseUntil>now(); }
  function taskResult(task,ctx) {
    if(task.kind!=='search_intent'||task.ownerId!==ownerOf(ctx)||!['succeeded','warning'].includes(task.status)) return undefined;
    const r=row(ownerOf(ctx),task.output?.searchId);
    if(!r) return undefined;
    if(task.status==='warning') { const p=db.prepare('SELECT proposal_json FROM demo_search_proposals WHERE id=? AND owner_id=? AND search_id=? AND expected_revision=? AND task_id=?').get(task.output?.proposalId,ownerOf(ctx),r.id,r.revision,task.id); return p?{proposal:JSON.parse(p.proposal_json)}:undefined; }
    return r.revision===task.output?.revision&&r.accepted_json?{search:JSON.parse(r.accepted_json)}:undefined;
  }
  async function runTask(task,{signal}={}) {
    if(task.kind!=='search_intent') throw new TypeError('Wrong task kind.');
    const r=row(task.ownerId,task.payload.searchId);
    if(!authority(task.ownerId)||!r||r.task_id!==task.id||r.revision!==task.payload.expectedRevision||!live(task)) return {status:'failed',errorCode:'revision_conflict'};
    const source=feed.coverage();if(source.stale||!source.verifiedAt)return {status:'failed',errorCode:'dependency_unavailable'};
    if(!executionAvailable()) return {status:'failed',errorCode:'dependency_unavailable'};
    const accepted=r.accepted_json?JSON.parse(r.accepted_json):null;
    const caps=catalogueCapabilities();
    let result,previous;
    for(let attempt=0;attempt<2;attempt++) {
      if(signal?.aborted) return {status:'failed',errorCode:'task_timeout'};
      if(!authority(task.ownerId)||!live(task))return {status:'failed',errorCode:'revision_conflict'};
      let raw;
      try {raw=await model.interpretIntent(intentModelInput({query:task.payload.query,prior:accepted,capabilities:caps,...(attempt?{repair:{diagnostics:result.diagnostics,previous}}:{})}),{signal}); }
      catch { return {status:'failed',errorCode:signal?.aborted?'task_timeout':'provider_unavailable'}; }
      result=compileIntent(raw,caps,{query:task.payload.query});
      if(result.ok) break;
      // Invalid JSON/schema data is never echoed into a repair. Valid bounded
      // model data can accompany field diagnostics in the one new invocation.
      previous=validateModelData(raw,schema).length?null:raw;
    }
    if(!result.ok) return {status:'failed',errorCode:'invalid_output'};
    if(signal?.aborted) return {status:'failed',errorCode:'task_timeout'};
    return tx(db,()=>{
      const current=row(task.ownerId,r.id);
      if(!authority(task.ownerId)||!current||current.task_id!==task.id||current.revision!==r.revision||!live(task)) return {status:'failed',errorCode:'revision_conflict'};
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
    const current=authority(ownerOf(ctx));if(!current)throw err('unauthenticated',401);ctx={...ctx,viewer:current};
    const requested=Number(ctx.url.searchParams.get('revision'));
    if(!r.accepted_json||!ctx.url.searchParams.has('revision')||requested!==r.revision) throw err('revision_conflict',409,'This search changed. Reload it and try again.');
    const search=JSON.parse(r.accepted_json), limit=Number(ctx.url.searchParams.get('limit')??12), cursor=ctx.url.searchParams.get('cursor');
    if(!Number.isInteger(limit)||limit<1||limit>50) throw err('invalid_limit');
    const generation=feed.generation?.()??null,accessHash=hash({accountId:ownerOf(ctx),access:ctx.viewer?.access??null});
    const residual=Boolean(search.configuration.residualAi),coverage=feed.coverage();
    const table=residual?'demo_search_delegate_cursors':'demo_search_cursors';
    for(const name of ['demo_search_cursors','demo_search_delegate_cursors'])db.prepare(`DELETE FROM ${name} WHERE created_at<=?`).run(now()-600_000);
    let position=0,delegateCursor=null;
    if(cursor){
      if(cursor.length>128)throw err('invalid_cursor');
      const c=db.prepare(`SELECT * FROM ${table} WHERE id=? AND owner_id=? AND search_id=?`).get(cursor,ownerOf(ctx),r.id);
      if(!c||c.revision!==r.revision||c.generation!==generation||c.access_hash!==accessHash||c.created_at>now())throw err('stale_cursor',409,'This search changed. Reload it and try again.');
      if(residual)delegateCursor=c.delegate_cursor;else position=c.position;
    }
    function continuationToken(value){const id=randomUUID();db.prepare(`INSERT INTO ${table} VALUES(?,?,?,?,?,?,?,?)`).run(id,ownerOf(ctx),r.id,r.revision,generation,accessHash,value,now());return id;}
    const hiddenJobs=ctx.viewer.access?.fullAccess===true?[]:feed.restrictedLatestJobs?.().filter(j=>primaryMatches(j,search.configuration));
    const hiddenMatches=coverage.stale||!coverage.verifiedAt||!hiddenJobs?{status:'unavailable',count:null}:residual?null:{status:'exact',count:hiddenJobs.length};
    const base={searchId:r.id,revision:r.revision,asOf:new Date(now()).toISOString(),coverage,hiddenMatches:hiddenMatches??{status:'pending',count:null}};
    if(coverage.stale||!coverage.verifiedAt){
      const id=cursor??continuationToken(residual?delegateCursor:position);
      return {...base,items:[],continuation:{cursor:id,state:'paused',retryAfterMs:5000},ai:{status:residual?'dependency_unavailable':'not_required'},coverage:{...coverage,stale:true,state:'import_unavailable',description:'Imported listings need verification.'}};
    }
    const jobs=feed.eligibleJobs({viewer:ctx.viewer}).filter(j=>primaryMatches(j,search.configuration));
    if(residual&&matching?.page){
      const page=await matching.page({ownerId:ownerOf(ctx),searchId:r.id,revision:r.revision,configuration:search.configuration,jobs,viewer:ctx.viewer,cursor:delegateCursor,limit,coverage,generation,now});
      const currentAuthority=authority(ownerOf(ctx));
      if(!currentAuthority||hash({accountId:ownerOf(ctx),access:currentAuthority.access??null})!==accessHash)throw err('stale_cursor',409);
      const next=page.continuation?.cursor;
      if(next!=null&&(typeof next!=='string'||next.length>2048))throw err('invalid_output',503,'Matching is temporarily unavailable.');
      const confirmed=hiddenJobs?matching.hiddenCount?.({ownerId:ownerOf(ctx),searchId:r.id,revision:r.revision,configuration:search.configuration,jobs:hiddenJobs,viewer:ctx.viewer,coverage,generation}):null;
      return {...base,...page,hiddenMatches:confirmed??{status:'unavailable',count:null},continuation:{...page.continuation,cursor:next==null?null:continuationToken(next)}};
    }
    if(residual){
      const id=cursor??continuationToken(delegateCursor);
      return {...base,items:[],continuation:{cursor:id,state:'paused',retryAfterMs:5000},ai:{status:'dependency_unavailable'}};
    }
    const page=jobs.slice(position,position+limit),more=position+page.length<jobs.length;
    return {...base,items:page.map(j=>feed.publicJob(j)),continuation:{cursor:more?continuationToken(position+page.length):null,state:more?'open':'exhausted',retryAfterMs:null},ai:{status:'not_required'}};
  }

  async function route(ctx) {
    if(!/^\/searches(?:\/|$)/.test(ctx.path)) return null;
    if(!ownerOf(ctx)||!ctx.viewer||!authority(ownerOf(ctx),ctx.method==='DELETE')) throw err('unauthenticated',401,'Sign in to continue.');
    const id=ctx.path.split('/')[2],r=id?row(ownerOf(ctx),id):null;
    if(id&&!r) throw err('not_found',404,'Not found.');
    if(ctx.method==='GET'&&ctx.path==='/searches') return {status:200,body:{items:db.prepare('SELECT * FROM demo_searches WHERE owner_id=? ORDER BY created_at,id').all(ownerOf(ctx)).map(publicSearch)}};
    if(ctx.method==='GET'&&ctx.path===`/searches/${id}/results`) return {status:200,body:await results(r,ctx)};
    if(ctx.method==='DELETE'&&ctx.path===`/searches/${id}`) {
      if(typeof beforePrivateDelete!=='function') throw err('deletion_unavailable',503,'Deletion is temporarily unavailable.');
      const remove=()=>{const barrier=beforePrivateDelete();if(barrier&&typeof barrier.then==='function') throw new TypeError('Deletion barrier must be synchronous.');purgeSearch(ownerOf(ctx),id);};
      if(withPrivateTransaction)withPrivateTransaction(remove);
      else try{tx(db,remove);}finally{if(!db.isTransaction)afterPrivateTransaction?.();}
      return {status:200,body:{deleted:true}};
    }
    if(ctx.method==='POST'&&ctx.path===`/searches/${id}/confirm`) {
      bodyKeys(ctx.body,['proposalId','expectedRevision']); const expected=revision(ctx.body.expectedRevision);
      return tx(db,()=>{
        const current=row(ownerOf(ctx),id),p=db.prepare('SELECT * FROM demo_search_proposals WHERE id=? AND owner_id=? AND search_id=?').get(text(ctx.body.proposalId,128),ownerOf(ctx),id);
        if(!p||!current||current.revision!==expected||p.expected_revision!==expected||current.task_id!==p.task_id) throw err('revision_conflict',409,'This search changed. Reload it and try again.');
        const {proposalId,searchId,expectedRevision,...data}=JSON.parse(p.proposal_json),search={id,revision:expected+1,...data,status:'ready'};
        db.prepare('UPDATE demo_searches SET revision=?,accepted_json=?,draft_json=NULL,task_id=NULL,updated_at=? WHERE id=? AND owner_id=?').run(search.revision,JSON.stringify(search),now(),id,ownerOf(ctx));
        db.prepare('DELETE FROM demo_search_proposals WHERE search_id=? AND owner_id=?').run(id,ownerOf(ctx));
        return {status:200,body:{search}};
      });
    }
    const creating=ctx.method==='POST'&&ctx.path==='/searches',editing=ctx.method==='PATCH'&&ctx.path===`/searches/${id}`;
    if(creating||editing) {
      bodyKeys(ctx.body,creating?['query','requestKey']:['query','requestKey','expectedRevision']);
      const query=text(ctx.body.query),requestKey=key(ctx.body.requestKey),expected=creating?0:revision(ctx.body.expectedRevision);
      const fingerprint=hash({id:creating?null:id,query,expectedRevision:expected});
      const prior=db.prepare('SELECT * FROM demo_search_submissions WHERE owner_id=? AND request_key=?').get(ownerOf(ctx),requestKey);
      if(prior) {
        if(prior.input_hash!==fingerprint) throw err('idempotency_conflict',409,'This request key was already used.');
        const old=row(ownerOf(ctx),prior.search_id),task=tasks.get(ownerOf(ctx),prior.task_id);
        if(!old||!task) throw err('revision_conflict',409,'This search changed. Reload it and try again.');
        return {status:202,body:{search:publicSearch(old),task:tasks.publicView(task,taskResult(task,ctx)??null)}};
      }
      if(editing&&r.revision!==expected) throw err('revision_conflict',409,'This search changed. Reload it and try again.');
      if(ctx.viewer.visitor)visitorIdentity?.admit(ownerOf(ctx),{creating});
      if(!available()) throw err('dependency_unavailable',503,'Search interpretation is temporarily unavailable.');
      if(creating&&db.prepare('SELECT count(*) n FROM demo_searches WHERE owner_id=?').get(ownerOf(ctx)).n>=20) throw err('task_limit',429,'The search limit has been reached.');
      const searchId=creating?randomUUID():id;
      const task=tasks.enqueue({ownerId:ownerOf(ctx),kind:'search_intent',requestKey,payload:{searchId,query,expectedRevision:expected}});
      try { tx(db,()=>{
        if(ctx.viewer.visitor)visitorIdentity?.recordSubmission(ownerOf(ctx));
        if(creating) db.prepare('INSERT INTO demo_searches VALUES(?,?,0,NULL,?,?,?,?)').run(searchId,ownerOf(ctx),JSON.stringify({query,taskId:task.id}),task.id,now(),now());
        else {
          if(r.task_id) tasks.cancel(ownerOf(ctx),r.task_id);
          db.prepare('UPDATE demo_searches SET draft_json=?,task_id=?,updated_at=? WHERE id=? AND owner_id=? AND revision=?').run(JSON.stringify({query,taskId:task.id}),task.id,now(),id,ownerOf(ctx),expected);
          db.prepare('DELETE FROM demo_search_proposals WHERE search_id=? AND owner_id=?').run(id,ownerOf(ctx));
        }
        db.prepare('INSERT INTO demo_search_submissions VALUES(?,?,?,?,?)').run(ownerOf(ctx),requestKey,searchId,fingerprint,task.id);
      }); } catch(e) { tasks.delete(ownerOf(ctx),task.id); throw e; }
      return {status:202,body:{search:publicSearch(row(ownerOf(ctx),searchId)),task:tasks.publicView(task)}};
    }
    return null;
  }
  function transferOwner(from,to) {
    tasks.cancelOwner?.(from);
    for(const r of db.prepare('SELECT * FROM demo_searches WHERE owner_id=?').all(from)) {
      const draft=r.draft_json?{...JSON.parse(r.draft_json),taskId:null,status:'interrupted'}:null;
      db.prepare('UPDATE demo_searches SET owner_id=?,draft_json=? WHERE owner_id=? AND id=?').run(to,draft?JSON.stringify(draft):null,from,r.id);
    }
    db.prepare('UPDATE demo_search_proposals SET owner_id=? WHERE owner_id=?').run(to,from);
    for(const table of ['demo_search_cursors','demo_search_delegate_cursors','demo_search_submissions'])db.prepare(`DELETE FROM ${table} WHERE owner_id=?`).run(from);
  }
  function admitVisitorCreation(body){bodyKeys(body,['query','requestKey']);text(body.query);key(body.requestKey);if(!available())throw err('dependency_unavailable',503);}
  return {transferOwner,admitVisitorCreation,capabilities:()=>({search:available()}),compilerCapabilities:catalogueCapabilities,route,taskResult,deleteAccountData,runTask};
}
