// Persist official-host metadata against exact source company IDs. Hosts alone
// never establish identity aliases; existing persisted mappings stay stable.
import { validateCompanyUrl } from './companies.mjs';

const invalid=()=>Object.assign(new Error('Invalid company identity evidence.'),{code:'invalid_import',status:400});
const conflict=()=>Object.assign(new Error('Source company identity changed.'),{code:'source_identity_conflict',status:409});
export function initializeCompanyIdentities(db) {
  db.exec('CREATE TABLE IF NOT EXISTS justup_company_aliases(source_company_id TEXT PRIMARY KEY,company_id TEXT NOT NULL,official_domain TEXT NOT NULL,verified_at INTEGER NOT NULL) STRICT; CREATE INDEX IF NOT EXISTS justup_company_aliases_domain ON justup_company_aliases(official_domain); CREATE INDEX IF NOT EXISTS justup_company_aliases_public ON justup_company_aliases(company_id);');
}
export function validateCompanyIdentities(values=[]) {
  if(!Array.isArray(values)||values.length>1000)throw invalid();
  const seen=new Set();
  return values.map(value=>{
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='companyId,officialDomain'||typeof value.companyId!=='string'||!value.companyId||value.companyId.length>128||/[\u0000-\u001f\u007f]/.test(value.companyId)||seen.has(value.companyId)||typeof value.officialDomain!=='string'||!/^[a-zA-Z0-9.-]{1,253}$/.test(value.officialDomain))throw invalid();
    let domain;try{domain=new URL(validateCompanyUrl(`https://${value.officialDomain}`,{official:true})).hostname;}catch{throw invalid();}
    seen.add(value.companyId);return {companyId:value.companyId,officialDomain:domain};
  }).sort((a,b)=>a.companyId.localeCompare(b.companyId));
}
export function recordCompanyIdentities(db,values,verifiedAt) {
  for(const value of values){
    if(!db.prepare('SELECT 1 FROM job_source_identities WHERE company_id=? LIMIT 1').get(value.companyId))throw invalid();
    const previous=db.prepare('SELECT * FROM justup_company_aliases WHERE source_company_id=?').get(value.companyId);
    if(previous&&previous.official_domain!==value.officialDomain)throw conflict();
    const canonical=previous?.company_id??value.companyId;
    db.prepare('INSERT INTO justup_company_aliases VALUES(?,?,?,?) ON CONFLICT(source_company_id) DO UPDATE SET verified_at=max(verified_at,excluded.verified_at)').run(value.companyId,canonical,value.officialDomain,verifiedAt);
  }
}
export function canonicalCompanyId(db,sourceId) {
  return db.prepare('SELECT company_id FROM justup_company_aliases WHERE source_company_id=?').get(sourceId)?.company_id??sourceId;
}
