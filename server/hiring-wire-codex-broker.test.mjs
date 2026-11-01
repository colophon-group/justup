// Private socket owner: fixed admissions, one shared slot and cleanup across
// disconnects. Synthetic sessions only, no auth/native/provider calls. <2s CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { createModelBroker,createBrokerExecutor,hiringWireBrokerReady } from './model-broker.mjs';
import { createHiringWireCodexClient,createHiringWireCodexTransport,validWireConfiguration } from './hiring-wire-codex-broker.mjs';
import { WIRE_PROFILE_DESCRIPTOR,WIRE_TOOLS } from './hiring-wire-editorial.mjs';
import { compileWireSnapshot } from './hiring-wire-facts.mjs';
import { END,AT,wireFixture } from './hiring-wire-fixtures.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function intent(){return {title:'Backend',configuration:{schemaVersion:1,filters:Object.fromEntries(['companyInclude','companyExclude','titleAny','bodyAll','bodyNone','locations','workplaces','employmentTypes','postingLanguages','seniority'].map(key=>[key,key==='titleAny'?['backend']:null])),residualAi:null},requirements:[{id:'r',text:'backend',handling:'primary',reason:'Title evidence.',companyReference:null,bindings:[{field:'titleAny',values:['backend']}]}]};}
const usage={inputTokens:10,cachedInputTokens:0,outputTokens:10,reasoningOutputTokens:0};
function request(){const c=compileWireSnapshot(wireFixture(),{periodEnd:END,now:AT});return {descriptor:WIRE_PROFILE_DESCRIPTOR,executionId:'wire-1',context:{snapshot:{id:c.snapshot.snapshotId,sha256:c.snapshotSha256,asOf:END,factsVersion:c.factsVersion},facts:c.facts,previousEditions:[]},tools:WIRE_TOOLS,messages:[],instructions:'Select supported aggregate listing activity.'};}
async function fixture(t,{step,cancel,execute}={}){
  const dir=mkdtempSync(join(tmpdir(),'justup-wire-broker-')),socketPath=join(dir,'model.sock');const events=[];
  const broker=createModelBroker({testOnly:true,config:{taskCwd:'/immutable-empty'},execute:execute??(async args=>{events.push(args.kind);return {data:intent(),usage};}),createWireSession:args=>{
    assert.equal(args.invocation,undefined);events.push('open');
    return {step:async(value,options)=>{events.push('step');if(step)return step(value,options);return {type:'tools',calls:[{id:'call-1',name:'read_facts',arguments:{}}]};},cancel:async()=>{events.push('cancel-start');await cancel?.();events.push('cancel-done');}};
  }});
  await broker.listen({socketPath});t.after(async()=>{await broker.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,broker,socketPath,events,client:(executionId='wire-1')=>createHiringWireCodexClient({socketPath,executionId}),luna:createBrokerExecutor({socketPath})};
}
function raw(socketPath,value){return new Promise((resolve,reject)=>{let result='';const socket=createConnection(socketPath,()=>socket.write(`${JSON.stringify(value)}\n`));socket.on('error',reject);socket.on('data',bytes=>result+=bytes);socket.on('end',()=>resolve(JSON.parse(result)));});}

test('persistent Wire tools retain the same slot as unchanged intent and company admissions',async t=>{
  const f=await fixture(t),client=f.client();assert.equal((await client.step(request())).type,'tools');
  await assert.rejects(f.luna({schemaId:'intent',stdin:'backend',timeoutMs:500}),{code:'task_limit'});
  await assert.rejects(f.luna({schemaId:'company',stdin:JSON.stringify({input:'Acme',domain:'acme.com',careerUrl:null,scope:null}),timeoutMs:500}),{code:'task_limit'});
  await assert.rejects(f.client('wire-2').step({...request(),executionId:'wire-2'}),{code:'task_limit'});
  client.cancel();for(let i=0;i<10&&!f.events.includes('cancel-done');i++)await tick();
  assert.equal(f.events.includes('cancel-done'),true);assert.deepEqual((await f.luna({schemaId:'intent',stdin:'backend',timeoutMs:500})).data,intent());assert.equal(f.events.includes('search_intent'),true);
});
test('interactive inference occupies the shared slot before a Wire open can be admitted',async t=>{
  let resolveIntent,called;const began=new Promise(resolve=>called=resolve);
  const f=await fixture(t,{execute:async()=>{called();await new Promise(resolve=>resolveIntent=resolve);return {data:intent(),usage};}});
  const interactive=f.luna({schemaId:'intent',stdin:'backend',timeoutMs:1000});await began;
  await assert.rejects(f.client().step(request()),{code:'task_limit'});assert.equal(f.events.includes('open'),false);
  resolveIntent();await interactive;
});
test('unknown first frames and company payload fields cannot invoke the Wire profile',async t=>{
  const f=await fixture(t);
  const invalid=[
    {profile:'hiring_wire',operation:'step',executionId:'wire-1',request:request()},
    {profile:'hiring_wire',operation:'open',executionId:'wire-1',descriptor:{...WIRE_PROFILE_DESCRIPTOR,model:'gpt-6-luna'}},
    {profile:'hiring_wire',operation:'open',executionId:'wire-1',descriptor:WIRE_PROFILE_DESCRIPTOR,executable:'/bin/sh'},
    {profile:'hiring_wire_other',operation:'open',executionId:'wire-1',descriptor:WIRE_PROFILE_DESCRIPTOR},
    {schemaId:'hiring_wire',prompt:'backend',timeoutMs:500},
    {schemaId:'company',prompt:'{}',timeoutMs:500,profile:'hiring_wire'}
  ];
  for(const value of invalid)assert.equal((await raw(f.socketPath,value)).error.code,'invalid_input');
  await assert.rejects(f.luna({schemaId:'company',stdin:JSON.stringify({input:'Acme',domain:'acme.com',careerUrl:null,scope:null,profile:'hiring_wire'}),timeoutMs:500}),{code:'invalid_input'});
  assert.equal(f.events.includes('open'),false);
});
test('final reply waits for cancellation cleanup and broker close awaits paused session cleanup',async t=>{
  let releaseCancel,startedCancel;const began=new Promise(resolve=>startedCancel=resolve);
  const f=await fixture(t,{step:async value=>({type:'final',data:{snapshotId:value.context.snapshot.id,items:[{factId:value.context.facts[0].id,angle:'increase'}]}}),cancel:async()=>{startedCancel();await new Promise(resolve=>releaseCancel=resolve);}});
  let completed=false;const pending=f.client().step(request()).then(value=>{completed=true;return value;});await began;await tick();assert.equal(completed,false);
  await assert.rejects(f.luna({schemaId:'intent',stdin:'backend',timeoutMs:500}),{code:'task_limit'});releaseCancel();assert.equal((await pending).type,'final');assert.equal(f.events.at(-1),'cancel-done');
  const g=await fixture(t,{cancel:async()=>{await new Promise(resolve=>setTimeout(resolve,20));}});const paused=g.client();await paused.step(request());await g.broker.close();assert.equal(g.events.at(-1),'cancel-done');paused.cancel();
});
test('abort during a pending step aborts native signal and releases the slot only after cleanup',async t=>{
  let signal,entered;const began=new Promise(resolve=>entered=resolve),f=await fixture(t,{step:async(_value,options)=>{signal=options.signal;entered();return new Promise(()=>{});}});
  const abort=new AbortController(),client=f.client(),pending=client.step(request(),{signal:abort.signal});await began;abort.abort();await assert.rejects(pending,{code:'task_timeout'});
  for(let i=0;i<10&&!f.events.includes('cancel-done');i++)await tick();assert.equal(signal.aborted,true);assert.equal(f.events.includes('cancel-done'),true);
  assert.deepEqual((await f.luna({schemaId:'intent',stdin:'backend',timeoutMs:500})).data,intent());
});
test('protocol errors cannot leak provider diagnostics or retain the slot',async t=>{
  const f=await fixture(t,{step:async()=>{throw Error('private raw provider trace');}});
  await assert.rejects(f.client().step(request()),error=>error.code==='provider_unavailable'&&!error.message.includes('private'));
  assert.equal(f.events.at(-1),'cancel-done');assert.deepEqual((await f.luna({schemaId:'intent',stdin:'backend',timeoutMs:500})).data,intent());
});
test('production transport requires separate immutable qualification and rejects enabled-shape drift',()=>{
  const transport=createHiringWireCodexTransport();assert.equal(transport.qualified(WIRE_PROFILE_DESCRIPTOR),false);assert.equal(hiringWireBrokerReady(),false);
  assert.equal(validWireConfiguration(undefined),true);assert.equal(validWireConfiguration({enabled:false}),true);
  const value={enabled:true,attestationPath:'/private/wire.json',providerCatalogueSha256:'c'.repeat(64),modelUid:1005,socketPath:'/private/model.sock'};assert.equal(validWireConfiguration(value),true);
  for(const config of [{enabled:false,profile:'hiring_wire'},{enabled:true},{...value,command:'/bin/sh'},{...value,providerCatalogueSha256:null},{...value,modelUid:0}])assert.equal(validWireConfiguration(config),false);
});
