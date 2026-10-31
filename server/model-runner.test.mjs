// Real subprocess tests with fake JSONL; never call a model or read operator auth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexArguments,codexEnvironment,checkModelIsolation,modelAttestationMatches,createCodexModel,executeCodex,validateModelData,CODEX_VERSION,LUNA_MODEL } from './model-runner.mjs';

const messages=[{type:'thread.started',thread_id:'private'},{type:'turn.started'},{type:'item.completed',item:{id:'m',type:'agent_message',text:'{"ok":true}'}},{type:'turn.completed',usage:{input_tokens:123,cached_input_tokens:100,output_tokens:4}}];
const lines=(events)=>events.map(e=>JSON.stringify(e)).join('\n')+'\n';
function fake(script,options={}) {return executeCodex({executable:process.execPath,args:['-e',script],cwd:tmpdir(),env:codexEnvironment({codexHome:tmpdir(),taskCwd:tmpdir()}),stdin:'untrusted input',timeoutMs:2000,...options});}
const emit=(events=messages)=>`process.stdout.write(${JSON.stringify(lines(events))});`;

test('exact model and read-only arguments remove inherited tool surfaces',()=>{
  const args=codexArguments({kind:'search_intent',schemaPath:'/schemas/intent.json',taskCwd:'/empty'}),settings=args.join(' ');
  assert.equal(CODEX_VERSION,'0.159.2');assert.deepEqual(args.slice(0,2),['--no-daemon','exec']);
  assert.equal(args[args.indexOf('--model')+1],LUNA_MODEL);
  for(const flag of ['--ignore-user-config','--strict-config','--ephemeral','--json'])assert.ok(args.includes(flag));
  assert.equal(args.includes('--ignore-rules'),false);
  assert.equal(args[args.indexOf('--sandbox')+1],'read-only');
  for(const feature of ['shell_tool','unified_exec','apps','plugins','memories','hooks','multi_agent','browser_use','computer_use','request_permissions_tool','view_image','sleep_tool','skill_search','default_mode_request_user_input'])assert.ok(settings.includes(`--disable ${feature}`));
  assert.ok(settings.includes('web_search="disabled"'));assert.equal(args.at(-1),'-');assert.equal(settings.includes('untrusted'),false);
  assert.ok(codexArguments({kind:'company_resolution',schemaPath:'/schemas/company.json',taskCwd:'/empty'}).includes('web_search="disabled"'));
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
test('approval binds exact current artifact and host plan, with separate company proof',()=>{
  const config={buildIdentity:'a'.repeat(64),hostPlanSha256:'b'.repeat(64),toolCatalogSha256:'c'.repeat(64),socketPath:'/root-controlled/model.sock',companyResearchVerified:true};
  const report={...config,cliVersion:CODEX_VERSION,model:LUNA_MODEL,approved:true,executorBoundary:'dedicated_uid_broker',deniedPathsVerified:true,retentionVerified:true};
  assert.equal(modelAttestationMatches(report,config),true);assert.equal(modelAttestationMatches(report,config,{company:true}),true);
  for(const patch of [{buildIdentity:'d'.repeat(64)},{hostPlanSha256:'e'.repeat(64)},{toolCatalogSha256:'f'.repeat(64)},{cliVersion:'0.143.0'},{approved:false},{deniedPathsVerified:false},{retentionVerified:false},{model:'other'}])assert.equal(modelAttestationMatches({...report,...patch},config),false);
  for(const field of ['buildIdentity','hostPlanSha256']){const old={...report};delete old[field];assert.equal(modelAttestationMatches(old,config),false);assert.equal(modelAttestationMatches(report,{...config,[field]:undefined}),false);}
  assert.equal(modelAttestationMatches({...report,companyResearchVerified:false},config),true);
  assert.equal(modelAttestationMatches({...report,companyResearchVerified:false},config,{company:true}),false);
  assert.equal(modelAttestationMatches(report,{...config,companyResearchVerified:false},{company:true}),false);
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
test('native tool allowances cannot be re-enabled by per-call overrides',async()=>{
  await assert.rejects(()=>fake(emit(),{allowWeb:true}),{code:'invalid_input'});
  await assert.rejects(()=>fake(emit(),{maxToolCalls:1}),{code:'invalid_input'});
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
