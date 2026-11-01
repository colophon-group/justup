// Real subprocess tests with fake JSONL; never call a model or read operator auth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,rmSync,writeFileSync,symlinkSync,linkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL,fileURLToPath } from 'node:url';
import { codexArguments,codexEnvironment,checkModelIsolation,modelAttestationMatches,createCodexModel,executeCodex,validateModelData,modelCatalogueReady,CODEX_VERSION,LUNA_MODEL,EMPTY_TOOL_CATALOG_SHA256,MODEL_CATALOGUE_SHA256,MODEL_PROFILES,CODEX_SOURCE_COMMIT } from './model-runner.mjs';
import { inspectWireCatalogue,assertEmptyWireCatalogue,assertTaskWireCatalogue } from './evals/luna-wire-catalogue.mjs';

const messages=[{type:'thread.started',thread_id:'private'},{type:'turn.started'},{type:'item.completed',item:{id:'m',type:'agent_message',text:'{"ok":true}'}},{type:'turn.completed',usage:{input_tokens:123,cached_input_tokens:100,output_tokens:4}}];
const lines=(events)=>events.map(e=>JSON.stringify(e)).join('\n')+'\n';
function fake(script,options={}) {return executeCodex({executable:process.execPath,args:['-e',script],cwd:tmpdir(),env:codexEnvironment({codexHome:tmpdir(),taskCwd:tmpdir()}),stdin:'untrusted input',timeoutMs:2000,...options});}
const emit=(events=messages)=>`process.stdout.write(${JSON.stringify(lines(events))});`;

test('both task profiles pin static Luna metadata and disable independent utility surfaces',()=>{
  const args=codexArguments({kind:'search_intent',schemaPath:'/schemas/intent.json',taskCwd:'/empty'}),settings=args.join(' ');
  assert.equal(CODEX_VERSION,'0.159.2');assert.deepEqual(args.slice(0,2),['--no-daemon','exec']);
  assert.equal(args[args.indexOf('--model')+1],LUNA_MODEL);
  for(const flag of ['--ignore-user-config','--strict-config','--ephemeral','--json'])assert.ok(args.includes(flag));
  assert.equal(args.includes('--ignore-rules'),false);
  assert.equal(args[args.indexOf('--sandbox')+1],'read-only');
  for(const feature of ['shell_tool','unified_exec','apps','plugins','memories','hooks','multi_agent','multi_agent_v2','agent_message_board','browser_use','computer_use','request_permissions_tool','view_image','sleep_tool','skill_search','default_mode_request_user_input','send_message_to_user_async','token_budget','current_time_reminder'])assert.ok(settings.includes(`--disable ${feature}`));
  assert.ok(settings.includes('web_search="disabled"'));assert.equal(args.at(-1),'-');assert.equal(settings.includes('untrusted'),false);
  const path=fileURLToPath(new URL('./model-catalogue.json',import.meta.url));
  for(const kind of ['search_intent','company_resolution']){
    const profile=codexArguments({kind,schemaPath:'/schemas/output.json',taskCwd:'/empty',cataloguePath:'/caller/substitute.json'});
    for(const setting of [`model_catalog_json=${JSON.stringify(path)}`,`web_search=${JSON.stringify(kind==='company_resolution'?'live':'disabled')}`,'tools.experimental_request_user_input.enabled=false','tools.update_plan.enabled=false','agents.enabled=false','cloud.skills.enabled=false','orchestrator.mcp.enabled=false','skills.bundled.enabled=false','skills.include_instructions=false'])assert.ok(profile.includes(setting));
    assert.equal(profile.join(' ').includes('/caller/substitute.json'),false);
  }
});

test('static policy changes only the seven reviewed tool selectors of the public shipped Luna record',()=>{
  const bytes=readFileSync(new URL('./model-catalogue.json',import.meta.url)),catalogue=JSON.parse(bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),MODEL_CATALOGUE_SHA256);
  assert.deepEqual(Object.keys(catalogue),['models']);assert.equal(catalogue.models.length,1);
  const model=catalogue.models[0];assert.equal(model.slug,LUNA_MODEL);
  const selectors={shell_type:'disabled',apply_patch_tool_type:null,experimental_supported_tools:[],supports_search_tool:false,tool_mode:'direct',multi_agent_version:null,node_repl_disabled:true};
  for(const [key,value] of Object.entries(selectors))assert.deepEqual(model[key],value);
  const original={...model,shell_type:'shell_command',apply_patch_tool_type:'freeform',experimental_supported_tools:['send_user_message_async','clock'],supports_search_tool:true,tool_mode:'code_mode_only',multi_agent_version:'v2',node_repl_disabled:false};
  const canonical=value=>JSON.stringify(Array.isArray(value)?value.map(item=>JSON.parse(canonical(item))):value!==null&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,JSON.parse(canonical(value[key]))])):value);
  const sha=value=>createHash('sha256').update(canonical(value)).digest('hex');
  assert.equal(sha(original),'7377f1a8e9415591c0d13d68ea2b0a11e1a92afe50df7a85759e9ce2df839186');
  assert.equal(sha(model.model_messages),'9d286e8de45c124fecce60edd216999ad14aca808e982581f4409c5581246cde');
  assert.equal(model.use_responses_lite,true);assert.equal(modelCatalogueReady(),false,'a writable worktree is not a production immutable release');
});

test('missing, changed, symlinked and hardlinked fixed catalogues reject before argument construction',async t=>{
  const source=readFileSync(new URL('./model-runner.mjs',import.meta.url)),bytes=readFileSync(new URL('./model-catalogue.json',import.meta.url));
  for(const kind of ['search_intent','company_resolution'])for(const variant of ['missing','changed','symlink','hardlink']){
    const dir=mkdtempSync(join(tmpdir(),'justup-catalogue-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
    const module=join(dir,'model-runner.mjs'),path=join(dir,'model-catalogue.json');writeFileSync(module,source);
    if(variant==='changed')writeFileSync(path,Buffer.concat([bytes,Buffer.from(' ')]));
    if(variant==='symlink'){writeFileSync(join(dir,'substitute.json'),bytes);symlinkSync(join(dir,'substitute.json'),path);}
    if(variant==='hardlink'){writeFileSync(join(dir,'substitute.json'),bytes);linkSync(join(dir,'substitute.json'),path);}
    const isolated=await import(pathToFileURL(module).href);
    assert.throws(()=>isolated.codexArguments({kind,schemaPath:'/schema.json',taskCwd:'/empty'}),{code:'dependency_unavailable'});
    assert.equal(isolated.modelCatalogueReady(),false);
  }
});

test('complete Responses and Lite catalogues distinguish missing tools from all-carrier zero',()=>{
  const message={type:'message',role:'user',content:[{type:'input_text',text:'synthetic'}]};
  for(const kind of ['search_intent','company_resolution']){
    for(const transport of ['responses','responses_lite']){
      const body={model:LUNA_MODEL,input:transport==='responses_lite'?[{type:'additional_tools',role:'developer',tools:[]},message]:[message],...(transport==='responses'?{tools:[]}:{} )};
      const result=assertEmptyWireCatalogue(body,{transport});
      assert.equal(result.toolCatalogSha256,EMPTY_TOOL_CATALOG_SHA256);assert.equal(result.toolCount,0);
      assert.equal(result.additionalToolsItems,transport==='responses_lite'?1:0);
      const tool={type:'function',name:kind,parameters:{type:'object',properties:{}}};
      if(transport==='responses_lite')body.input[0].tools=[tool];else body.tools=[tool];
      assert.throws(()=>assertEmptyWireCatalogue(body,{transport}),{code:'unverified_catalogue'});
    }
  }
  assert.throws(()=>assertEmptyWireCatalogue({model:LUNA_MODEL,input:[message]}),{code:'unverified_catalogue'});
});

test('AdditionalTools, nested namespaces, inventory and unknown carriers cannot hide behind top-level empty tools',()=>{
  const tool={type:'function',name:'danger',parameters:{type:'object'}},base=()=>({model:LUNA_MODEL,tools:[],input:[{type:'additional_tools',role:'developer',tools:[]}]});
  const nested=base();nested.input[0].tools=[{type:'namespace',name:'one',tools:[{type:'namespace',name:'two',tools:[tool]}]}];
  const result=inspectWireCatalogue(nested);assert.equal(result.namespaceCount,2);assert.equal(result.toolCount,3);assert.equal(result.schemaHashes.length,3);assert.equal(JSON.stringify(result).includes('danger'),false);
  const direct=base();direct.tools=[tool];
  const inventory=base();inventory.client_metadata={'x-codex-turn-metadata':JSON.stringify({tool_namespaces_info:{hidden:{name:'hidden',functions:{danger:{direct:false,deferred:true}}}}})};
  const unknownInventory=base();unknownInventory.client_metadata={'x-codex-turn-metadata':JSON.stringify({tool_namespaces_info:{hidden:{name:'hidden',functions:{},future_tools:[tool]}}})};
  for(const body of [nested,direct,inventory,unknownInventory,{...base(),future_catalogue:[tool]},{...base(),input:[{type:'future_tools',tools:[tool]}]},{...base(),input:[{type:'message',role:'user',content:[],tools:[tool]}]},{...base(),input:[{type:'additional_tools',role:'developer',tools:[],future_tools:[tool]}]}])assert.throws(()=>assertEmptyWireCatalogue(body),{code:'unverified_catalogue'});
  const absent=base();delete absent.input[0].tools;assert.throws(()=>assertEmptyWireCatalogue(absent),{code:'unverified_catalogue'});
});
test('child environment excludes all inherited secret, proxy and runtime variables',()=>{
  const original={...process.env};try{Object.assign(process.env,{OPENAI_API_KEY:'secret',DOPPLER_TOKEN:'admin',DATABASE_URL:'private',DOCKER_HOST:'socket',HTTPS_PROXY:'proxy',SSH_AUTH_SOCK:'agent'});
    const env=codexEnvironment({codexHome:'/protected',taskCwd:'/empty'});assert.deepEqual(Object.keys(env).sort(),['CODEX_HOME','HOME','LANG','LC_ALL','NO_COLOR','PATH','TMPDIR']);assert.equal(JSON.stringify(env).includes('secret'),false);
  }finally{for(const k of Object.keys(process.env))if(!Object.hasOwn(original,k))delete process.env[k];Object.assign(process.env,original);}
});
test('provider stays unavailable without actual isolation attestation or dedicated broker',async()=>{
  assert.equal(checkModelIsolation({enabled:true,isolationVerified:true}),false);
  const m=createCodexModel({config:{enabled:true},execute:()=>{throw Error('must not execute');}});assert.equal(m.available('search_intent'),false);
  await assert.rejects(()=>m.interpretIntent({query:'hello'}),{code:'dependency_unavailable'});
});
test('approval binds exact artifact, per-kind policy and honest wire or static proof',()=>{
  const taskProfiles=Object.fromEntries(Object.entries(MODEL_PROFILES).map(([kind,p])=>[kind,{enabled:true,toolPolicySha256:p.toolPolicySha256,modelCatalogueSha256:p.modelCatalogueSha256}]));
  const config={buildIdentity:'a'.repeat(64),hostPlanSha256:'b'.repeat(64),taskProfiles,socketPath:'/root-controlled/model.sock',companyResearchVerified:true};
  const report={...config,taskProfiles:Object.fromEntries(Object.entries(taskProfiles).map(([kind,p])=>[kind,{...p,toolProof:{kind:'supported_static_policy',actualWireObserved:false,sourceCommit:CODEX_SOURCE_COMMIT,toolNames:MODEL_PROFILES[kind].nativeToolNames}}])),cliVersion:CODEX_VERSION,model:LUNA_MODEL,approved:true,executorBoundary:'dedicated_uid_broker',deniedPathsVerified:true,retentionVerified:true};
  for(const kind of Object.keys(MODEL_PROFILES)){
    assert.equal(modelAttestationMatches(report,config,{kind}),true);
    for(const patch of [{buildIdentity:'d'.repeat(64)},{hostPlanSha256:'e'.repeat(64)},{cliVersion:'0.143.0'},{approved:false},{deniedPathsVerified:false},{retentionVerified:false},{model:'other'}])assert.equal(modelAttestationMatches({...report,...patch},config,{kind}),false);
    for(const field of ['buildIdentity','hostPlanSha256'])assert.equal(modelAttestationMatches(report,{...config,[field]:undefined},{kind}),false);
    const actual=structuredClone(report),proof=actual.taskProfiles[kind].toolProof;
    proof.kind='actual_wire';proof.actualWireObserved=true;proof.toolCatalogSha256=kind==='search_intent'?EMPTY_TOOL_CATALOG_SHA256:'c'.repeat(64);
    assert.equal(modelAttestationMatches(actual,config,{kind}),true);
    proof.actualWireObserved=false;assert.equal(modelAttestationMatches(actual,config,{kind}),false);
    const crossed=structuredClone(report);crossed.taskProfiles[kind]=report.taskProfiles[kind==='search_intent'?'company_resolution':'search_intent'];
    assert.equal(modelAttestationMatches(crossed,config,{kind}),false);
    const falseObserved=structuredClone(report);falseObserved.taskProfiles[kind].toolProof.actualWireObserved=true;
    assert.equal(modelAttestationMatches(falseObserved,config,{kind}),false);
  }
  assert.equal(modelAttestationMatches({...report,companyResearchVerified:false},config),true);
  assert.equal(modelAttestationMatches({...report,companyResearchVerified:false},config,{kind:'company_resolution'}),false);
  const falseEmpty=structuredClone(report);falseEmpty.taskProfiles.company_resolution.toolProof={kind:'actual_wire',actualWireObserved:true,toolNames:['web.run'],toolCatalogSha256:EMPTY_TOOL_CATALOG_SHA256};
  assert.equal(modelAttestationMatches(falseEmpty,config,{kind:'company_resolution'}),false);
  assert.equal(modelAttestationMatches({...report,taskProfiles:undefined},config),false);
});
test('fake Codex JSON parses only final schema data and actual usage counters',async()=>{
  const result=await fake(emit());assert.deepEqual(result.data,{ok:true});assert.deepEqual(result.usage,{inputTokens:123,cachedInputTokens:100,outputTokens:4,reasoningOutputTokens:0});assert.equal(result.toolCalls,0);assert.equal(Object.hasOwn(result,'trace'),false);
});
test('subprocess cannot observe inherited admin or provider credentials',async()=>{
  process.env.JUSTUP_MODEL_TEST_SECRET='do-not-inherit';try{
    const events=structuredClone(messages);events[2].item.text=JSON.stringify({secret:null});
    const script=`const missing=process.env.JUSTUP_MODEL_TEST_SECRET===undefined;if(!missing)process.exit(7);${emit(events)}`;
    assert.deepEqual((await fake(script)).data,{secret:null});
  }finally{delete process.env.JUSTUP_MODEL_TEST_SECRET;}
});
test('malformed JSON, provider errors, incomplete usage and nonzero exit fail safely',async()=>{
  const scripts=['process.stdout.write("not json\\n");',emit([{type:'error',message:'secret provider message'}]),emit(messages.slice(0,3)),`${emit()}process.exitCode=4;`];
  for(const script of scripts)await assert.rejects(()=>fake(script),e=>['invalid_output','provider_unavailable'].includes(e.code)&&!e.message.includes('secret'));
});
test('tools are rejected even if fake process emits plausible final success afterwards',async()=>{
  for(const type of ['command_execution','file_change','mcp_tool_call','collab_tool_call','dynamic_tool_call','unknown_new_tool','web_search','plan'])await assert.rejects(()=>fake(emit([{type:'item.started',item:{id:'x',type}},...messages])),{code:'tool_not_allowed'});
});
const webEvents=(id='web-1',action={type:'search',query:'Acme official website'})=>[
  {type:'item.started',item:{id,type:'web_search',action:{type:'other'}}},
  {type:'item.completed',item:{id,type:'web_search',action}}
];
test('company native web is allowed while intent, extra tools and over-budget web fail closed',async()=>{
  const allowed=await fake(emit([...webEvents(),...messages]),{kind:'company_resolution'});
  assert.equal(allowed.toolCalls,1);assert.equal(allowed.eventCounts.webSearches,1);assert.equal(JSON.stringify(allowed).includes('Acme'),false);
  await assert.rejects(()=>fake(emit([...webEvents(),...messages])),{code:'tool_not_allowed'});
  await assert.rejects(()=>fake(emit([...webEvents('a'),...webEvents('b'),...webEvents('c'),...messages]),{kind:'company_resolution'}),{code:'tool_limit'});
  await assert.rejects(()=>fake(emit([...webEvents(),...messages]),{kind:'company_resolution',maxToolCalls:0}),{code:'tool_limit'});
  for(const type of ['command_execution','file_change','mcp_tool_call','dynamic_tool_call','unknown_new_tool'])await assert.rejects(()=>fake(emit([{type:'item.started',item:{id:'x',type}},...messages]),{kind:'company_resolution'}),{code:'tool_not_allowed'});
  for(const events of [[webEvents()[0],...messages],[webEvents()[1],...messages]])await assert.rejects(()=>fake(emit(events),{kind:'company_resolution'}),e=>['invalid_output','provider_unavailable'].includes(e.code));
  await assert.rejects(()=>fake(emit([...webEvents('a',{type:'other'}),...messages]),{kind:'company_resolution'}),{code:'tool_not_allowed'});
  for(const opts of [{allowWeb:true},{maxToolCalls:1},{kind:'company_resolution',maxToolCalls:3},{kind:'unknown'}])await assert.rejects(()=>fake(emit(),opts),{code:'invalid_input'});
});
test('complete company catalogue permits only the pinned native web namespace and rejects tool hiding',()=>{
  const web={type:'namespace',name:'web',tools:[{type:'function',name:'run',strict:false,parameters:{type:'object',properties:{search_query:{type:'array'}}}}]};
  const body={model:LUNA_MODEL,input:[{type:'additional_tools',role:'developer',tools:[web]}]};
  const result=assertTaskWireCatalogue(body,{kind:'company_resolution'});
  assert.equal(result.namespaceCount,1);assert.equal(Object.hasOwn(result,'toolNames'),false);assert.notEqual(result.toolCatalogSha256,EMPTY_TOOL_CATALOG_SHA256);
  assert.throws(()=>assertTaskWireCatalogue(body,{kind:'search_intent'}),{code:'unverified_catalogue'});
  const variants=[{...body,tools:[{type:'function',name:'shell'}]},{...body,input:[{type:'additional_tools',role:'developer',tools:[{type:'function',name:'web.run',parameters:{}}]}]},{...body,input:[{type:'additional_tools',role:'developer',tools:[{...web,name:'shell'}]}]}, {...body,input:[{type:'additional_tools',role:'developer',tools:[{...web,tools:[...web.tools,{type:'function',name:'exec',parameters:{}}]}]}]}];
  for(const value of variants)assert.throws(()=>assertTaskWireCatalogue(value,{kind:'company_resolution'}),{code:'unverified_catalogue'});
});
test('stdin, stdout, stderr, time and observed output-token budgets fail closed',async()=>{
  await assert.rejects(()=>fake(emit(),{stdin:'x'.repeat(24577)}),{code:'invalid_input'});
  await assert.rejects(()=>fake('process.stdout.write("x".repeat(10000));',{maxStdoutBytes:100}),{code:'output_limit'});
  await assert.rejects(()=>fake('process.stderr.write("x".repeat(10000));setTimeout(()=>{},2000);',{maxStderrBytes:100}),{code:'output_limit'});
  await assert.rejects(()=>fake('setTimeout(()=>{},2000);',{timeoutMs:25}),{code:'task_timeout'});
  await assert.rejects(()=>fake(emit(),{maxOutputTokens:1}),{code:'token_limit'});
});
test('deadline terminates the process group and descendants cannot leave late writes',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'justup-model-')),marker=join(dir,'late');t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const descendant=`process.on('SIGTERM',()=>{});setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad'),500);`;
  const script=`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setTimeout(()=>{},2000);`;
  await assert.rejects(()=>fake(script,{timeoutMs:100}),{code:'task_timeout'});
  await new Promise(resolve=>setTimeout(resolve,650));
  assert.throws(()=>readFileSync(marker),{code:'ENOENT'});
});
test('abort prevents execution or kills a running child',async()=>{
  const a=new AbortController();a.abort();await assert.rejects(()=>fake(emit(),{signal:a.signal}),{code:'task_timeout'});
  const b=new AbortController(),pending=fake('setTimeout(()=>{},2000);',{signal:b.signal});b.abort();await assert.rejects(()=>pending,{code:'task_timeout'});
});
test('strict validator rejects additional fields, oversized/blank values and unsupported schemas',()=>{
  const s={type:'object',additionalProperties:false,required:['name'],properties:{name:{type:'string',minLength:1,maxLength:4}}};
  assert.deepEqual(validateModelData({name:'Luna'},s),[]);
  for(const v of [{name:'Luna',secret:'x'},{name:'     '},{name:' '},{name:1},{}])assert.ok(validateModelData(v,s).length);
  assert.ok(validateModelData({name:'x'.repeat(100)},s,10).length);assert.throws(()=>validateModelData('x',{format:'email'}),TypeError);
});
