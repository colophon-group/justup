// Runtime protocol owner: deterministic fake app-server streams only. Server CI
// lane, expected under five seconds. No native Codex, auth or provider requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough,Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { compileWireSnapshot,digest,canonical } from './hiring-wire-facts.mjs';
import { createHiringWireEditorial,createHiringWireToolSession,DEFAULT_SCRIPT,WIRE_PROFILE_DESCRIPTOR,WIRE_TOOLS,WIRE_SELECTION_SCHEMA } from './hiring-wire-editorial.mjs';
import { END,AT,wireFixture } from './hiring-wire-fixtures.mjs';
import { createHiringWireCodexSession } from './hiring-wire-codex.mjs';
import { wireAttestationMatches,wireProfileReady,wireCodexArguments,wireCodexEnvironment,wireDynamicTools,WIRE_CODEX_VERSION,WIRE_CODEX_SOURCE,WIRE_NODE_VERSION,WIRE_CODEX_POLICY_VERSION,WIRE_SOL_CATALOGUE_SHA256,WIRE_SOL_SHIPPED_RECORD_SHA256,WIRE_DYNAMIC_TOOLS_SHA256 } from './hiring-wire-codex-policy.mjs';

const PROTOCOL_EVAL_VERSION='hiring-wire-codex-protocol-eval-v1';
const invocation={executable:'/fixed/codex',codexHome:'/private/invocation/home',taskCwd:'/private/invocation/empty',scratchPath:'/private/invocation/scratch'};
function input() {
  const compiled=compileWireSnapshot(wireFixture(),{periodEnd:END,now:AT});let script=structuredClone(DEFAULT_SCRIPT),revision='r-1';
  return {snapshot:{id:compiled.snapshot.snapshotId,sha256:compiled.snapshotSha256,asOf:END,factsVersion:compiled.factsVersion},facts:compiled.facts,previousEditions:[],workspace:{read:()=>({revision,sha256:digest(script),script:structuredClone(script)}),replace:(expected,next)=>{assert.equal(expected,revision);script=structuredClone(next);revision='r-2';return {revision,sha256:digest(script),script:structuredClone(script)};}}};
}
function harness({onTurn,onResult,onInitialize,onThread,onKill,onProbe,chunk=false}={}) {
  const writes=[],kills=[];let child;
  const send=value=>{const line=Buffer.from(`${JSON.stringify(value)}\n`);if(chunk){const cut=Math.floor(line.length/2);child.stdout.write(line.subarray(0,cut));child.stdout.write(line.subarray(cut));}else child.stdout.write(line);};
  const notify=(method,params)=>send({method,params});
  const tool=(name='read_facts',args={},id='call-1',rpcId=101)=>send({id:rpcId,method:'item/tool/call',params:{threadId:'thread-1',turnId:'turn-1',callId:id,namespace:null,tool:name,arguments:args}});
  const finish=(data,{tokens=300,status='completed'}={})=>{
    notify('item/completed',{threadId:'thread-1',turnId:'turn-1',item:{type:'agentMessage',id:'message-1',text:JSON.stringify(data),phase:'final_answer',delivery:null}});
    notify('thread/tokenUsage/updated',{threadId:'thread-1',turnId:'turn-1',tokenUsage:{total:{totalTokens:1300,inputTokens:1000,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:tokens,reasoningOutputTokens:100},last:{},modelContextWindow:272000}});
    notify('turn/completed',{threadId:'thread-1',turn:{id:'turn-1',status,error:null}});
  };
  const spawnProcess=(executable,args,opts)=>{
    assert.equal(executable,invocation.executable);assert.deepEqual(opts.env,wireCodexEnvironment(invocation));assert.equal(opts.shell,false);assert.equal(opts.detached,true);assert.equal(args.includes('app-server'),true);
    child=new EventEmitter();child.pid=424242;child.stdout=new PassThrough();child.stderr=new PassThrough();let buffer='';
    child.stdin=new Writable({write(bytes,_encoding,callback){buffer+=bytes.toString();let end;while((end=buffer.indexOf('\n'))>=0){const value=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);writes.push(value);queueMicrotask(()=>{
      if(value.method==='initialize')send({id:value.id,result:onInitialize?.(value)??{userAgent:'codex_vscode/0.159.2 (linux)',codexHome:invocation.codexHome}});
      else if(value.method==='thread/start')send({id:value.id,result:onThread?.(value)??{thread:{id:'thread-1',ephemeral:true},model:'gpt-6.1-sol',modelProvider:'openai',cwd:invocation.taskCwd,approvalPolicy:'never',sandbox:{type:'readOnly',networkAccess:false},disabledPluginIds:[],instructionSources:[]}});
      else if(value.method==='turn/start'){send({id:value.id,result:{turn:{id:'turn-1'}}});onTurn?.({tool,finish,send,notify,child,value});}
      else if(Object.hasOwn(value,'result'))onResult?.({value,tool,finish,send,notify,child});
    });}callback();}});
    return child;
  };
  const session=createHiringWireCodexSession({invocation,spawnProcess,killGroup:(pid,signal)=>{
    if(signal===0){if(onProbe)return onProbe({child,pid});throw Object.assign(Error('No process group.'),{code:'ESRCH'});}
    kills.push({pid,signal});
    if(onKill)return onKill({child,pid,signal});
    if(signal==='SIGKILL')child.emit('close',null,'SIGKILL');
  }});
  return {session,writes,kills,get child(){return child;}};
}
function request(source=input()) {
  const session=createHiringWireToolSession(source,{executionId:'execution-1'});
  return {source,dispatcher:session,value:{descriptor:WIRE_PROFILE_DESCRIPTOR,executionId:'execution-1',context:session.context(),tools:WIRE_TOOLS,messages:[],instructions:'Select supported listing-activity facts using the provided tools.'}};
}
const finalFor=value=>({snapshotId:value.context.snapshot.id,items:[{factId:value.context.facts[0].id,angle:'increase'}]});

test('subscription session completes five typed tools, persists recipe and returns only factual selection',async()=>{
  const source=input();let index=0;
  const h=harness({chunk:true,onTurn:({tool})=>tool('read_facts'),onResult:({value,tool,finish})=>{
    const result=JSON.parse(value.result.contentItems[0].text);assert.equal(value.result.success,true);
    if(index===0){assert.deepEqual(result,source.facts);tool('read_prior_editions',{},'call-2',102);}
    else if(index===1){assert.deepEqual(result,[]);tool('read_selection_script',{},'call-3',103);}
    else if(index===2){assert.equal(result.revision,'r-1');tool('replace_selection_script',{expectedRevision:result.revision,script:{...DEFAULT_SCRIPT,minCurrent:2,maxItems:1,sort:'most_activity'}},'call-4',104);}
    else if(index===3){assert.equal(result.revision,'r-2');tool('preview_selection',{},'call-5',105);}
    else finish({snapshotId:source.snapshot.id,items:result});index++;
  }});
  const editorial=createHiringWireEditorial({transport:{qualified:()=>true,executionId:()=>'execution-1',step:h.session.step,cancel:h.session.cancel}});
  const result=await editorial.generateHiringWire(source);
  assert.equal(result.execution.toolCalls,5);assert.equal(result.execution.workspaceRevision,'r-2');assert.equal(result.data.items[0].angle,'increase');
  const start=h.writes.find(value=>value.method==='thread/start');assert.deepEqual(start.params.dynamicTools,wireDynamicTools());assert.equal(start.params.ephemeral,true);assert.deepEqual(start.params.environments,[]);
  assert.deepEqual(h.writes.find(value=>value.method==='turn/start').params.outputSchema,WIRE_SELECTION_SCHEMA);
  const payload=JSON.stringify(h.writes);assert.equal(payload.includes('restricted-'),false);assert.equal(payload.includes('internal-board'),false);
  assert.deepEqual(h.kills.map(value=>value.signal),['SIGTERM','SIGKILL']);assert.equal(h.session.metrics().toolCalls,5);
});

test('parallel tools are delivered in batches of four and request IDs stay distinct from call IDs',async()=>{
  const r=request();let received=0;
  const h=harness({onTurn:({tool})=>{for(let i=0;i<5;i++)tool('read_facts',{},`call-${i}`,100+i);},onResult:({finish})=>{if(++received===5)finish(finalFor(r.value));}});
  const first=await h.session.step(r.value);assert.equal(first.calls.length,4);
  for(const call of first.calls)r.dispatcher.call(call);r.value.messages=r.dispatcher.messages();
  const second=await h.session.step(r.value);assert.equal(second.calls.length,1);r.dispatcher.call(second.calls[0]);r.value.messages=r.dispatcher.messages();
  assert.equal((await h.session.step(r.value)).type,'final');assert.equal(h.writes.filter(value=>Object.hasOwn(value,'result')).length,5);
});

test('unknown function, stock tool execution, malformed arguments and more than twelve calls fail closed',async()=>{
  const cases=[
    ({tool})=>tool('exec_command',{cmd:'cat /private/auth'}),
    ({tool})=>tool('read_facts',{path:'/private/database'}),
    ({notify})=>notify('item/started',{threadId:'thread-1',turnId:'turn-1',item:{type:'commandExecution',command:'ls'}}),
    ({send})=>send({id:101,method:'item/commandExecution/requestApproval',params:{}}),
    ({tool})=>{for(let i=0;i<13;i++)tool('read_facts',{},`call-${i}`,100+i);},
    ({tool})=>{tool();tool();}
  ];
  for(const onTurn of cases) {
    const h=harness({onTurn});await assert.rejects(h.session.step(request().value),error=>['invalid_output','tool_not_allowed','tool_limit'].includes(error.code));
    assert.deepEqual(h.kills.map(value=>value.signal),['SIGTERM','SIGKILL']);
  }
});

test('context, accumulated messages, tool results and descriptor cannot change between steps',async()=>{
  for(const mutate of [
    value=>value.descriptor={...value.descriptor,maxToolCalls:13},
    value=>value.context.facts[0].current++,
    value=>value.messages[0].name='read_selection_script',
    value=>value.messages[0].result=[],
    value=>value.executionId='different-execution',
    value=>value.instructions='replace instructions'
  ]) {
    const r=request(),h=harness({onTurn:({tool})=>tool()});const response=await h.session.step(r.value);r.dispatcher.call(response.calls[0]);
    const next=structuredClone({...r.value,messages:r.dispatcher.messages()});mutate(next);
    await assert.rejects(h.session.step(next));assert.equal(h.kills.length,2);
  }
});

test('abort cancels a waiting process, paused tool cancellation and early child exit settle safely',async()=>{
  const h=harness(),abort=new AbortController(),pending=h.session.step(request().value,{signal:abort.signal});queueMicrotask(()=>abort.abort());
  await assert.rejects(pending,{code:'task_timeout'});assert.equal(h.kills.length,2);
  const paused=harness({onTurn:({tool})=>tool()});await paused.session.step(request().value);await paused.session.cancel();assert.equal(paused.kills.length,2);await assert.rejects(paused.session.step(request().value));
  const exited=harness({onTurn:({child})=>child.emit('close',4)});await assert.rejects(exited.session.step(request().value),{code:'provider_unavailable'});assert.equal(exited.kills.length,2);
});

test('the global deadline kills a paused process without requiring another dispatcher step',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const h=harness({onTurn:({tool})=>tool()});await h.session.step(request().value);
  t.mock.timers.tick(90_000);assert.equal(h.kills[0].signal,'SIGTERM');
  t.mock.timers.tick(100);await h.session.cancel();assert.equal(h.kills[1].signal,'SIGKILL');
  await assert.rejects(h.session.step(request().value));
});

test('native cancellation waits for child close even when the process group is already absent',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const h=harness({onTurn:({tool})=>tool(),onKill:()=>{}});await h.session.step(request().value);
  let done=false;const cancelled=h.session.cancel().then(()=>{done=true;});t.mock.timers.tick(100);await Promise.resolve();
  assert.equal(done,false);assert.equal(h.child.stdout.destroyed,false);
  h.child.emit('close',null,'SIGKILL');t.mock.timers.tick(25);await cancelled;
  assert.equal(h.child.stdout.destroyed,true);
});

test('native cancellation escalates after direct child exit and waits for remaining descendants',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let groupGone=false;
  const h=harness({onTurn:({tool})=>tool(),onKill:({child,signal})=>{if(signal==='SIGTERM')child.emit('close',0);},onProbe:()=>{if(groupGone)throw Object.assign(Error('No process group.'),{code:'ESRCH'});}});
  await h.session.step(request().value);let done=false;const cancelled=h.session.cancel().then(()=>{done=true;});
  t.mock.timers.tick(100);await Promise.resolve();assert.equal(done,false);assert.deepEqual(h.kills.map(value=>value.signal),['SIGTERM','SIGKILL']);
  groupGone=true;t.mock.timers.tick(25);await cancelled;assert.equal(done,true);
});

test('unexpected signal and process-group probe failures make native cleanup unproven',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  for(const failure of ['SIGTERM','SIGKILL','probe']) {
    const h=harness({onTurn:({tool})=>tool(),onKill:({child,signal})=>{if(signal==='SIGKILL')child.emit('close',null,'SIGKILL');if(signal===failure)throw Object.assign(Error('private signal error'),{code:'EPERM'});},onProbe:()=>{throw Object.assign(Error('private probe error'),{code:failure==='probe'?'EPERM':'ESRCH'});}});
    await h.session.step(request().value);const rejected=assert.rejects(h.session.cancel(),error=>error.code==='cleanup_unproven'&&!error.message.includes('private'));
    t.mock.timers.tick(100);await rejected;
  }
});

test('native cleanup has a bounded failure when a descendant process group survives SIGKILL',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const h=harness({onTurn:({tool})=>tool(),onKill:({child,signal})=>{if(signal==='SIGKILL')child.emit('close',null,'SIGKILL');},onProbe:()=>{}});
  await h.session.step(request().value);const rejected=assert.rejects(h.session.cancel(),{code:'cleanup_unproven'});
  t.mock.timers.tick(100);await Promise.resolve();
  for(let poll=0;poll<80;poll++){t.mock.timers.tick(25);await Promise.resolve();}
  await rejected;
});

test('token, stream bytes, schema, factual angle and unexpected protocol drift reject the edition',async()=>{
  const cases=[
    (r)=>({onTurn:({finish})=>finish(finalFor(r),{tokens:6001})}),
    ()=>({onTurn:({child})=>child.stderr.write(Buffer.alloc(16_385))}),
    ()=>({onTurn:({child})=>child.stdout.write(Buffer.alloc(524_289))}),
    ()=>({onTurn:({child})=>child.stdout.write(Buffer.from([0xff,0x0a]))}),
    r=>({onTurn:({finish})=>finish({...finalFor(r),headline:'invented'})}),
    r=>({onTurn:({finish})=>finish({...finalFor(r),items:[{...finalFor(r).items[0],angle:'decrease'}]})}),
    ()=>({onTurn:({send})=>send({method:'future/tool/inventory',params:{}})}),
    ()=>({onInitialize:()=>({userAgent:'codex_vscode/0.160.0 (linux)',codexHome:invocation.codexHome})}),
    ()=>({onThread:()=>({thread:{id:'thread-1',ephemeral:true},model:'gpt-6-luna',modelProvider:'openai',cwd:invocation.taskCwd,approvalPolicy:'never',instructionSources:[]})})
  ];
  for(const make of cases){const r=request(),h=harness(make(r.value));await assert.rejects(h.session.step(r.value));assert.equal(h.kills.length,2);}
});

test('pinned Sol policy preserves model identity and exposes no command/provider/config selectors',()=>{
  const bytes=readFileSync(new URL('./hiring-wire-sol-catalogue.json',import.meta.url));assert.equal(createHash('sha256').update(bytes).digest('hex'),WIRE_SOL_CATALOGUE_SHA256);
  const {models:[sol]}=JSON.parse(bytes);assert.equal(sol.slug,'gpt-6.1-sol');assert.equal(sol.use_responses_lite,true);assert.equal(sol.tool_mode,'direct');assert.equal(sol.shell_type,'disabled');assert.equal(sol.apply_patch_tool_type,null);assert.equal(sol.node_repl_disabled,true);assert.deepEqual(sol.experimental_supported_tools,[]);
  const shipped={...sol,shell_type:'shell_command',apply_patch_tool_type:'freeform',tool_mode:'code_mode_only',experimental_supported_tools:['send_user_message_async','clock'],node_repl_disabled:false,multi_agent_version:'v2',supports_search_tool:true};assert.equal(digest(shipped),WIRE_SOL_SHIPPED_RECORD_SHA256);assert.equal(PROTOCOL_EVAL_VERSION,'hiring-wire-codex-protocol-eval-v1');
  const args=wireCodexArguments(invocation);assert.deepEqual(args.slice(-4),['app-server','--strict-config','--listen','stdio://']);
  assert.equal(args.includes('--ignore-user-config'),false);assert.equal(args.includes('forced_login_method="chatgpt"'),true);assert.equal(args.includes('tools.update_plan.enabled=false'),true);assert.equal(args.includes('model_provider="openai"'),true);
  assert.deepEqual(Object.keys(wireCodexEnvironment(invocation)).sort(),['CODEX_HOME','HOME','LANG','LC_ALL','NO_COLOR','PATH','TMPDIR']);
});

function proof() {
  const config={enabled:true,buildIdentity:'a'.repeat(64),hostPlanSha256:'b'.repeat(64),socketPath:'/private/broker.sock',modelUid:1005,providerCatalogueSha256:'c'.repeat(64)};
  return {config,report:{version:1,approved:true,profile:'hiring_wire',model:'gpt-6.1-sol',cliVersion:WIRE_CODEX_VERSION,cliSource:WIRE_CODEX_SOURCE,nodeVersion:WIRE_NODE_VERSION,policyVersion:WIRE_CODEX_POLICY_VERSION,buildIdentity:config.buildIdentity,hostPlanSha256:config.hostPlanSha256,socketPath:config.socketPath,descriptor:WIRE_PROFILE_DESCRIPTOR,modelCatalogueSha256:WIRE_SOL_CATALOGUE_SHA256,dynamicToolsSha256:WIRE_DYNAMIC_TOOLS_SHA256,providerCatalogue:{verified:true,transport:'responses_lite',sha256:config.providerCatalogueSha256,toolSchemaSha256:WIRE_PROFILE_DESCRIPTOR.toolSchemaSha256,stockTools:0,tools:WIRE_TOOLS.map(tool=>tool.name).sort()},executorBoundary:'dedicated_uid_broker',modelUid:config.modelUid,fd:3,deniedPathsVerified:true,retentionVerified:true,qualityVerified:true,sharedSlotVerified:true}};
}
test('qualification requires independent exact-artifact Sol evidence and remains unavailable without it',()=>{
  const {config,report}=proof();assert.equal(wireAttestationMatches(report,config),true);assert.equal(wireProfileReady(config),false);assert.equal(wireProfileReady(),false);
  const cases=[r=>r.model='gpt-6-luna',r=>r.descriptor={...r.descriptor,toolSchemaSha256:'d'.repeat(64)},r=>r.providerCatalogue.stockTools=1,r=>r.providerCatalogue.tools.push('exec_command'),r=>r.providerCatalogue.sha256='d'.repeat(64),r=>r.buildIdentity='e'.repeat(64),r=>r.fd=4,r=>r.modelUid++,r=>r.retentionVerified=false,r=>r.qualityVerified=false,r=>r.sharedSlotVerified=false,r=>r.extra=true];
  for(const mutate of cases){const changed=structuredClone(report);mutate(changed);assert.equal(wireAttestationMatches(changed,config),false);}
  assert.equal(WIRE_PROFILE_DESCRIPTOR.toolSchemaSha256,digest(WIRE_TOOLS));assert.equal(canonical(wireDynamicTools()).includes('exec_command'),false);
});
