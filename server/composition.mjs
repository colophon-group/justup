// Fixed API feature composition and same-build queue availability. The API never
// loads provider credentials, connects to the model socket or executes inference.
import { lstatSync,readFileSync } from 'node:fs';
import { dirname,isAbsolute,join } from 'node:path';
import { createIntentService } from './intent.mjs';
import { createCompanyService } from './companies.mjs';
import { createMatchingService } from './matching.mjs';
import { createVisitorIdentity,createVisitorService } from './visitor.mjs';
import { createLiveResultsService } from './live-results.mjs';
import { createReadingPreferencesService } from './reading-preferences.mjs';
import { createHiringWireApi } from './hiring-wire-integration.mjs';
import { createCompanyReports } from './company-reports.mjs';
import { createProductRecords } from './product-records.mjs';

const disabled=()=>({search:false,companyRequests:false,aiMatching:false});
export function runnerStatusPath(config){return config.runnerStatusPath??(typeof config.dbPath==='string'&&isAbsolute(config.dbPath)?join(dirname(config.dbPath),'runner-status.json'):null);}
export function readRunnerStatus({config={},now=Date.now}={}){
  const absent={ready:false,identity:null,sourceCommit:null,buildIdentity:null,lastHeartbeat:null,capabilities:disabled()};
  try{
    const path=runnerStatusPath(config);if(!isAbsolute(path)||!/^[a-f0-9]{40}$/.test(config.sourceCommit??'')||typeof config.buildIdentity!=='string'||!config.buildIdentity||config.buildIdentity.length>200)return absent;
    const meta=lstatSync(path);if(!meta.isFile()||meta.isSymbolicLink()||meta.size>8192||(meta.mode&0o007)!==0)return absent;
    const status=JSON.parse(readFileSync(path,'utf8'));
    if(status.schemaVersion!==1||status.sourceCommit!==config.sourceCommit||status.buildIdentity!==config.buildIdentity||typeof status.identity!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(status.identity)||typeof status.ready!=='boolean'||typeof status.updatedAt!=='string')return absent;
    const at=Date.parse(status.updatedAt);if(!Number.isFinite(at)||at>now()+1000||now()-at>30_000)return absent;
    const c=status.capabilities;if(!c||!['aiMatching','companyRequests','search'].every(key=>typeof c[key]==='boolean')||Object.keys(c).some(key=>!['aiMatching','companyRequests','search','emailVerification','stripeBilling'].includes(key))||Object.values(c).some(v=>typeof v!=='boolean'))return absent;
    return {ready:status.ready,identity:status.identity,sourceCommit:status.sourceCommit,buildIdentity:status.buildIdentity,lastHeartbeat:status.updatedAt,capabilities:status.ready?{...c}:disabled()};
  }catch{return absent;}
}
export function createApiReadiness({config={},now=Date.now}={}){
  return ()=>{const {capabilities,...runner}=readRunnerStatus({config,now});return {ready:runner.ready,runner,capabilities};};
}
export function createApiServices(deps){
  const {config={},now=Date.now}=deps;
  // Explicit allowlist: even an accidental caller config containing secrets is
  // never passed into feature providers or retained in an API-side model object.
  const apiConfig={maxCompanyRequestsPerOwner:config.maxCompanyRequestsPerOwner,matching:config.matching,visitor:config.visitor};
  const identityConfig={...apiConfig,dbPath:config.dbPath??':memory:',sourceCommit:config.sourceCommit,buildIdentity:config.buildIdentity,privateGenerationPath:config.privateGenerationPath};
  // Policy closure and exact metadata changes must reach the published proof,
  // without reading any provider configuration from the caller.
  for(const key of ['policyVersion','policiesReviewed','policyLocales','policyFallbacks','policyAssetProof','privacyUrl','usageUrl','allowedOrigin','allowInsecureLocalhost'])Object.defineProperty(identityConfig,key,{enumerable:true,get:()=>config[key]});
  const identity=createVisitorIdentity({...deps,config:identityConfig});
  const records=createProductRecords({...deps,ownerAuthority:identity.principal});
  deps={...deps,records};
  const ownership={ownerAuthority:identity.principal,visitorIdentity:identity,taskAdmission:identity.admitMatching};
  const readingPreferences=createReadingPreferencesService({...deps,ownerAuthority:identity.principal});
  const heartbeat=()=>readRunnerStatus({config:{dbPath:config.dbPath,runnerStatusPath:config.runnerStatusPath,sourceCommit:config.sourceCommit,buildIdentity:config.buildIdentity},now}).capabilities;
  const matching=createMatchingService({...deps,...ownership,readingPreferences,config:apiConfig,readOnlyProvider:true,availability:()=>heartbeat().aiMatching});
  const intent=createIntentService({...deps,...ownership,readingPreferences,config:apiConfig,model:undefined,matching,availability:()=>heartbeat().search,onSearchCreated:event=>visitor.searchCreated(event),onSearchDeleted:event=>visitor.searchDeleted(event)});
  const companies=createCompanyService({...deps,...ownership,readingPreferences,config:apiConfig,model:undefined,availability:()=>heartbeat().companyRequests});
  const visitor=createVisitorService({...deps,config:apiConfig,identity,intent,matching});
  const liveResults=createLiveResultsService({...deps,intent});
  const wire=createHiringWireApi({db:deps.db,now});
  const reports=createCompanyReports({db:deps.db,feed:deps.feed,now});
  return [intent,companies,matching,visitor,readingPreferences,liveResults,reports,records,wire];
}
