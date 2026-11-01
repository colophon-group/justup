// Account-owned company follows and interface preferences, plus search option
// storage. Read when changing owner isolation, option revisions or language sets.
import { problem } from './store.mjs';

export const SUPPORTED_INTERFACE_LOCALES = Object.freeze(['en','de','fr','it','es']);
export const DEFAULT_SEARCH_OPTIONS = Object.freeze({followedOnly:false,postingLanguages:Object.freeze([])});
const exact = (body,keys) => { if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(body,k)))throw problem('invalid_input'); };
const revision = v => {if(!Number.isSafeInteger(v)||v<0)throw problem('invalid_input');return v;};
const transaction = (db,work) => {db.exec('SAVEPOINT reading_write');try{const r=work();db.exec('RELEASE reading_write');return r;}catch(error){db.exec('ROLLBACK TO reading_write; RELEASE reading_write');throw error;}};
export function canonicalLanguage(value) {
  if(typeof value!=='string'||value.length>200)return null;
  try{return Intl.getCanonicalLocales(value)[0]??null;}catch{return null;}
}
export function resolveInterfaceLocale(browserLanguages=[],override=null,supported=SUPPORTED_INTERFACE_LOCALES) {
  if(override&&supported.includes(override))return override;
  for(const tag of browserLanguages){const locale=canonicalLanguage(tag)?.split('-')[0];if(supported.includes(locale))return locale;}
  return 'en';
}
export function applySearchOptions(configuration,options=DEFAULT_SEARCH_OPTIONS,followedCompanyIds=[]) {
  const combined=structuredClone(configuration),filters=combined.filters;
  const intersect=(field,values)=>{filters[field]=filters[field]?filters[field].filter(v=>values.includes(v)):[...values];};
  if(options.postingLanguages.length)intersect('postingLanguages',options.postingLanguages);
  if(options.followedOnly)intersect('companyInclude',followedCompanyIds);
  return combined;
}

export function createReadingPreferencesService({db,feed,ownerAuthority,now=Date.now,config={}}={}) {
  if(!db||!feed||typeof ownerAuthority!=='function')throw new TypeError('Reading preferences need current account authority.');
  const supported=config.supportedInterfaceLocales??SUPPORTED_INTERFACE_LOCALES;
  if(!Array.isArray(supported)||!supported.includes('en')||new Set(supported).size!==supported.length||supported.some(v=>!SUPPORTED_INTERFACE_LOCALES.includes(v)))throw new TypeError('Unsupported interface locale configuration.');
  db.exec(`CREATE TABLE IF NOT EXISTS justup_company_follows(owner_id TEXT NOT NULL,company_id TEXT NOT NULL,followed INTEGER NOT NULL CHECK(followed IN (0,1)),followed_at INTEGER NOT NULL,PRIMARY KEY(owner_id,company_id)) STRICT;
    CREATE TABLE IF NOT EXISTS justup_follow_revisions(owner_id TEXT PRIMARY KEY,revision INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS justup_preferences(owner_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,interface_locale TEXT) STRICT;
    CREATE TABLE IF NOT EXISTS justup_search_options(owner_id TEXT NOT NULL,search_id TEXT NOT NULL,options_json TEXT NOT NULL,PRIMARY KEY(owner_id,search_id)) STRICT;`);
  let invalidateFollowedSearches=()=>[];
  const options=(owner,id)=>{const r=db.prepare('SELECT options_json FROM justup_search_options WHERE owner_id=? AND search_id=?').get(owner,id);return r?JSON.parse(r.options_json):structuredClone(DEFAULT_SEARCH_OPTIONS);};
  function requireOwner(ctx) {
    const id=ctx.accountId,current=typeof id==='string'?ownerAuthority(id,{allowUnavailable:ctx.method==='GET'}):null;
    if(!id||ctx.viewer?.account?.id!==id||current?.account?.id!==id||typeof current.access?.fullAccess!=='boolean')throw problem('unauthenticated',401);
    return id;
  }
  const followedIds=owner=>db.prepare('SELECT company_id FROM justup_company_follows WHERE owner_id=? AND followed=1 ORDER BY company_id').all(owner).map(r=>r.company_id);
  const followsRevision=owner=>db.prepare('SELECT revision FROM justup_follow_revisions WHERE owner_id=?').get(owner)?.revision??0;
  function follows(owner,invalidatedSearchIds=[]) {
    return {accountId:owner,revision:followsRevision(owner),items:db.prepare('SELECT company_id,followed_at FROM justup_company_follows WHERE owner_id=? AND followed=1 ORDER BY company_id').all(owner).map(r=>({companyId:r.company_id,followedAt:new Date(r.followed_at).toISOString()})),invalidatedSearchIds};
  }
  function updateFollow(owner,companyId,followed,{automatic=false,expectedRevision}={}) {
    return transaction(db,()=>{
      if(ownerAuthority(owner)?.account?.id!==owner)throw problem('unauthenticated',401);
      feed.company(companyId); // Only a canonical catalogue identity can be followed.
      const previous=db.prepare('SELECT followed FROM justup_company_follows WHERE owner_id=? AND company_id=?').get(owner,companyId);
      if(automatic&&previous)return follows(owner);
      if(!automatic&&expectedRevision!==followsRevision(owner)) {
        if(previous?.followed===Number(followed))return follows(owner);
        throw problem('revision_conflict',409);
      }
      if(previous?.followed===Number(followed))return follows(owner);
      db.prepare('INSERT INTO justup_company_follows VALUES(?,?,?,?) ON CONFLICT(owner_id,company_id) DO UPDATE SET followed=excluded.followed,followed_at=excluded.followed_at').run(owner,companyId,Number(followed),now());
      db.prepare('INSERT INTO justup_follow_revisions VALUES(?,1) ON CONFLICT(owner_id) DO UPDATE SET revision=revision+1').run(owner);
      return follows(owner,invalidateFollowedSearches(owner));
    });
  }
  function preferences(owner,browserLanguages=[]) {
    const r=db.prepare('SELECT * FROM justup_preferences WHERE owner_id=?').get(owner);
    const interfaceLocale=supported.includes(r?.interface_locale)?r.interface_locale:null;
    return {accountId:owner,revision:r?.revision??0,interfaceLocale,supportedInterfaceLocales:[...supported],defaultInterfaceLocale:'en',resolvedInterfaceLocale:resolveInterfaceLocale(browserLanguages,interfaceLocale,supported)};
  }
  function browserLanguages(url) {
    const raw=url.searchParams.get('languages');if(raw===null)return [];
    if(raw.length>4000)throw problem('invalid_input');
    return raw.split(',').map(v=>{const tag=canonicalLanguage(v.trim());if(!tag)throw problem('invalid_input');return tag;});
  }
  function validateOptions(value,availableLanguages,prior=DEFAULT_SEARCH_OPTIONS) {
    exact(value,['followedOnly','postingLanguages']);
    if(typeof value.followedOnly!=='boolean'||!Array.isArray(value.postingLanguages))throw problem('invalid_input');
    const allowed=new Set([...availableLanguages,...prior.postingLanguages]);
    for(const id of value.postingLanguages)if(!canonicalLanguage(id)||!allowed.has(id))throw problem('invalid_input');
    return {followedOnly:value.followedOnly,postingLanguages:[...new Set(value.postingLanguages)].sort()};
  }
  const saveOptions=(owner,id,value)=>db.prepare('INSERT INTO justup_search_options VALUES(?,?,?) ON CONFLICT(owner_id,search_id) DO UPDATE SET options_json=excluded.options_json').run(owner,id,JSON.stringify(value));
  function deleteAccountData(owner) {for(const table of ['justup_company_follows','justup_follow_revisions','justup_preferences','justup_search_options'])db.prepare(`DELETE FROM ${table} WHERE owner_id=?`).run(owner);}
  function route(ctx) {
    if(ctx.path!=='/follows'&&!/^\/follows\/[^/]+$/.test(ctx.path)&&ctx.path!=='/preferences')return null;
    const owner=requireOwner(ctx);
    if(ctx.method==='GET'&&ctx.path==='/follows')return {status:200,body:follows(owner)};
    if(ctx.method==='PATCH'&&ctx.path.startsWith('/follows/')) {
      exact(ctx.body,['followed','expectedRevision']);revision(ctx.body.expectedRevision);
      if(typeof ctx.body.followed!=='boolean')throw problem('invalid_input');
      let id;try{id=decodeURIComponent(ctx.path.split('/')[2]);}catch{throw problem('invalid_input');}
      if(!id||id.length>128)throw problem('invalid_input');
      return {status:200,body:updateFollow(owner,id,ctx.body.followed,{expectedRevision:ctx.body.expectedRevision})};
    }
    if(ctx.method==='GET'&&ctx.path==='/preferences')return {status:200,body:preferences(owner,browserLanguages(ctx.url))};
    if(ctx.method==='PATCH'&&ctx.path==='/preferences') {
      exact(ctx.body,['expectedRevision','interfaceLocale']);revision(ctx.body.expectedRevision);
      const chosen=ctx.body.interfaceLocale;if(chosen!==null&&!supported.includes(chosen))throw problem('invalid_input');
      return transaction(db,()=>{
        const current=preferences(owner);
        if(current.revision!==ctx.body.expectedRevision&&current.interfaceLocale!==chosen)throw problem('revision_conflict',409);
        if(current.interfaceLocale!==chosen)db.prepare('INSERT INTO justup_preferences VALUES(?,1,?) ON CONFLICT(owner_id) DO UPDATE SET revision=revision+1,interface_locale=excluded.interface_locale').run(owner,chosen);
        return {status:200,body:preferences(owner)};
      });
    }
    return null;
  }
  return {route,capabilities:{follows:true,preferences:true},follows,followedIds,preferences,options,validateOptions,saveOptions,
    configurationForSearch:(owner,search)=>applySearchOptions(search.configuration,options(owner,search.id),followedIds(owner)),
    followAcceptedCompany:(owner,id)=>updateFollow(owner,id,true,{automatic:true}),
    setFollowInvalidator(fn){if(typeof fn!=='function')throw new TypeError('Search invalidator required.');invalidateFollowedSearches=fn;},
    deleteSearchData(owner,id){db.prepare('DELETE FROM justup_search_options WHERE owner_id=? AND search_id=?').run(owner,id);},
    transferSearches(from,to){db.prepare('UPDATE justup_search_options SET owner_id=? WHERE owner_id=?').run(to,from);},deleteAccountData};
}
