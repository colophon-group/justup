// Fixed Sol subscription policy. Read before qualifying Hiring Wire: these
// checks establish local policy identity, never unobserved account/tool access.
import { createHash } from 'node:crypto';
import { closeSync,constants,fstatSync,openSync,readFileSync,realpathSync,statSync } from 'node:fs';
import { dirname,isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical,digest,exact,plain,wireError } from './hiring-wire-facts.mjs';
import { WIRE_PROFILE_DESCRIPTOR,WIRE_TOOLS } from './hiring-wire-editorial.mjs';

export const WIRE_CODEX_VERSION='0.159.2';
export const WIRE_CODEX_SOURCE='ff6aec96948b70d94983af2641a6b67c94faeff5';
export const WIRE_NODE_VERSION='24.22.2';
export const WIRE_SOL_CATALOGUE_SHA256='5ed662f51bb5a9eda38e52fae474954574504286a851bfbad4a4aa6d32b4ed61';
export const WIRE_SOL_SHIPPED_RECORD_SHA256='4c65b06042eb8a47682708ec1fb86dc537676fa358830500f8e3c3c0840fbc03';
export const WIRE_CODEX_POLICY_VERSION='hiring-wire-codex-v1';
export const WIRE_REPORTED_OUTPUT_TOKEN_LIMIT=6000;
export const WIRE_REPORTED_TOTAL_TOKEN_LIMIT=98_304;
const cataloguePath=fileURLToPath(new URL('./hiring-wire-sol-catalogue.json',import.meta.url));
const fail=()=>wireError('dependency_unavailable');
const sha=value=>createHash('sha256').update(value).digest('hex');
export function wireDescriptorMatches(value) {return plain(value)&&canonical(value)===canonical(WIRE_PROFILE_DESCRIPTOR);}
export function wireDynamicTools() {return WIRE_TOOLS.map(tool=>({type:'function',...structuredClone(tool),deferLoading:false}));}
// This is the app-server declaration hash, NOT the as-yet unobserved provider
// request catalogue hash. Responses Lite can carry tools in additional_tools.
export const WIRE_DYNAMIC_TOOLS_SHA256=digest(wireDynamicTools());

function protectedFile(path,maxBytes,{immutable=false}={}) {
  let fd;
  try {
    if(!isAbsolute(path)||realpathSync(path)!==path)throw fail();
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    const before=fstatSync(fd);
    if(!before.isFile()||before.nlink!==1||before.size<1||before.size>maxBytes)throw fail();
    if(immutable) {
      if(before.uid!==0||(before.mode&0o222)!==0)throw fail();
      for(let parent=dirname(path);;parent=dirname(parent)) {
        const meta=statSync(parent);
        if(!meta.isDirectory()||meta.uid!==0||(meta.mode&0o022)!==0)throw fail();
        if(parent===dirname(parent))break;
      }
    }
    const bytes=readFileSync(fd),after=fstatSync(fd);
    if(['dev','ino','size','mtimeMs','ctimeMs'].some(key=>before[key]!==after[key]))throw fail();
    return bytes;
  }catch{throw fail();}finally{if(fd!==undefined)closeSync(fd);}
}
export function wireCataloguePath({immutable=false}={}) {
  if(sha(protectedFile(cataloguePath,131_072,{immutable}))!==WIRE_SOL_CATALOGUE_SHA256)throw fail();
  return cataloguePath;
}
export function wireCatalogueReady(){try{wireCataloguePath({immutable:true});return true;}catch{return false;}}

// Match one independent, root-reviewed Wire proof to this exact artifact and
// private boundary. A Luna proof, an enabled flag, or model text cannot qualify.
export function wireAttestationMatches(report,config={}) {
  try {
    exact(report,['version','approved','profile','model','cliVersion','cliSource','nodeVersion','policyVersion','buildIdentity','hostPlanSha256','socketPath','descriptor','modelCatalogueSha256','dynamicToolsSha256','providerCatalogue','executorBoundary','modelUid','fd','deniedPathsVerified','retentionVerified','qualityVerified','sharedSlotVerified']);
    const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
    if(report.version!==1||report.approved!==true||report.profile!=='hiring_wire'||report.model!=='gpt-6.1-sol'||report.cliVersion!==WIRE_CODEX_VERSION||report.cliSource!==WIRE_CODEX_SOURCE||report.nodeVersion!==WIRE_NODE_VERSION||report.policyVersion!==WIRE_CODEX_POLICY_VERSION)return false;
    if(!hex(config.buildIdentity)||!hex(config.hostPlanSha256)||report.buildIdentity!==config.buildIdentity||report.hostPlanSha256!==config.hostPlanSha256||report.socketPath!==config.socketPath||!wireDescriptorMatches(report.descriptor))return false;
    if(report.modelCatalogueSha256!==WIRE_SOL_CATALOGUE_SHA256||report.dynamicToolsSha256!==WIRE_DYNAMIC_TOOLS_SHA256||report.executorBoundary!=='dedicated_uid_broker'||!Number.isSafeInteger(report.modelUid)||report.modelUid<1||report.modelUid!==config.modelUid||report.fd!==3)return false;
    if(['deniedPathsVerified','retentionVerified','qualityVerified','sharedSlotVerified'].some(key=>report[key]!==true))return false;
    exact(report.providerCatalogue,['verified','transport','sha256','toolSchemaSha256','stockTools','tools']);
    const evidence=report.providerCatalogue;
    if(evidence.verified!==true||evidence.transport!=='responses_lite'||!hex(evidence.sha256)||evidence.sha256!==config.providerCatalogueSha256||evidence.toolSchemaSha256!==WIRE_PROFILE_DESCRIPTOR.toolSchemaSha256||evidence.stockTools!==0||canonical(evidence.tools)!==canonical(WIRE_TOOLS.map(tool=>tool.name).sort()))return false;
    return true;
  }catch{return false;}
}
export function wireProfileReady(config={},descriptor=WIRE_PROFILE_DESCRIPTOR) {
  try {
    if(config.enabled!==true||!wireDescriptorMatches(descriptor)||!isAbsolute(config.socketPath)||realpathSync(config.socketPath)!==config.socketPath)return false;
    const socket=statSync(config.socketPath),parent=statSync(dirname(config.socketPath));
    if(!socket.isSocket()||socket.uid!==0||(socket.mode&0o007)!==0||!parent.isDirectory()||parent.uid!==0||(parent.mode&0o022)!==0)return false;
    const report=JSON.parse(protectedFile(config.attestationPath,16_384,{immutable:true}));
    return wireAttestationMatches(report,config);
  }catch{return false;}
}

const DISABLED=['shell_tool','unified_exec','apps','plugins','remote_plugin','memories','multi_agent','multi_agent_v2','agent_message_board','hooks','request_permissions_tool','browser_use','browser_use_external','computer_use','in_app_browser','image_generation','artifact','chronicle','code_mode','code_mode_host','code_mode_only','skill_mcp_dependency_install','tool_suggest','goals','workspace_dependencies','auth_elicitation','deferred_executor','enable_fanout','shell_snapshot','network_proxy','view_image','sleep_tool','skill_search','default_mode_request_user_input','send_message_to_user_async','token_budget','current_time_reminder','remote_control','remote_models'];
export function wireCodexArguments({taskCwd}) {
  if(!isAbsolute(taskCwd))throw wireError('invalid_input');
  // app-server has no --ignore-user-config option in 0.159.2. The broker must
  // supply a new auth-only home and an empty cwd for each invocation.
  return ['--no-daemon',...DISABLED.flatMap(feature=>['--disable',feature]),
    ...[`model_catalog_json=${JSON.stringify(wireCataloguePath())}`,'model="gpt-6.1-sol"','model_provider="openai"','approval_policy="never"','sandbox_mode="read-only"','forced_login_method="chatgpt"','allow_login_shell=false','project_doc_max_bytes=0','skills.config=[]','skills.bundled.enabled=false','skills.include_instructions=false','cloud.skills.enabled=false','orchestrator.mcp.enabled=false','agents.enabled=false','tools.experimental_request_user_input.enabled=false','tools.update_plan.enabled=false','mcp_servers={}','apps._default.enabled=false','memories.generate_memories=false','memories.use_memories=false','history.persistence="none"','analytics.enabled=false','feedback.enabled=false','model_reasoning_effort="medium"','web_search="disabled"'].flatMap(value=>['--config',value]),
    'app-server','--strict-config','--listen','stdio://'];
}
export function wireCodexEnvironment({codexHome,scratchPath}) {
  if(!isAbsolute(codexHome)||!isAbsolute(scratchPath))throw wireError('invalid_input');
  return {HOME:codexHome,CODEX_HOME:codexHome,TMPDIR:scratchPath,PATH:'/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',NO_COLOR:'1'};
}
