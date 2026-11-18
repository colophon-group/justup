// Fixed API feature composition and same-build queue availability. The API never
// loads provider credentials, connects to the model socket or executes inference.
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
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

function readHeartbeat(path, expectedOwner) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const meta = fstatSync(fd);
    if (!meta.isFile() || meta.size < 1 || meta.size > 8192 || (meta.mode & 0o007) !== 0
        || (expectedOwner !== undefined && (meta.uid !== expectedOwner || meta.nlink !== 1 || (meta.mode & 0o020) !== 0))) return null;
    const bytes = Buffer.alloc(8193);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, null);
      if (!count) break;
      used += count;
    }
    const after = fstatSync(fd);
    if (used !== meta.size || after.size !== meta.size || after.mtimeMs !== meta.mtimeMs) return null;
    return JSON.parse(bytes.subarray(0, used).toString('utf8'));
  } finally { closeSync(fd); }
}

export function readRunnerObservation({config={},now=Date.now,expectedOwner}={}){
  try{
    const path=runnerStatusPath(config);if(!isAbsolute(path)||!/^[a-f0-9]{40}$/.test(config.sourceCommit??'')||typeof config.buildIdentity!=='string'||!config.buildIdentity||config.buildIdentity.length>200)return null;
    const status=readHeartbeat(path, expectedOwner);
    if(status?.schemaVersion!==1||status.sourceCommit!==config.sourceCommit||status.buildIdentity!==config.buildIdentity||typeof status.identity!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(status.identity)||typeof status.ready!=='boolean'||typeof status.updatedAt!=='string')return null;
    const at=Date.parse(status.updatedAt),ageMs=now()-at;if(!Number.isSafeInteger(ageMs)||ageMs< -1000)return null;
    const c=status.capabilities;if(!c||!['aiMatching','companyRequests','search'].every(key=>typeof c[key]==='boolean')||Object.keys(c).some(key=>!['aiMatching','companyRequests','search','emailVerification','stripeBilling'].includes(key))||Object.values(c).some(v=>typeof v!=='boolean'))return null;
    return {ready:status.ready&&ageMs<=30_000,identity:status.identity,sourceCommit:status.sourceCommit,buildIdentity:status.buildIdentity,
      lastHeartbeat:status.updatedAt,ageMs:Math.max(0,ageMs),capabilities:status.ready&&ageMs<=30_000?{...c}:disabled()};
  }catch{return null;}
}
export function readRunnerStatus(options){
  const observation=readRunnerObservation(options);
  if(!observation||observation.ageMs>30_000)return {ready:false,identity:null,sourceCommit:null,buildIdentity:null,lastHeartbeat:null,capabilities:disabled()};
  const {ageMs,...status}=observation;
  return status;
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
