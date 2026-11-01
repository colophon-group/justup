// Private socket owner: fixed admissions, one shared slot and cleanup across
// disconnects. Synthetic sessions only, no auth/native/provider calls. <2s CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection,createServer } from 'node:net';
import { EventEmitter } from 'node:events';
import { createModelBroker,createBrokerExecutor,hiringWireBrokerReady } from './model-broker.mjs';
import { createHiringWireCodexClient,createHiringWireCodexTransport,handleHiringWireCodexConnection,validWireConfiguration } from './hiring-wire-codex-broker.mjs';
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
  await client.cancel();
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
  const g=await fixture(t,{cancel:async()=>{await new Promise(resolve=>setTimeout(resolve,20));}});const paused=g.client();await paused.step(request());await g.broker.close();assert.equal(g.events.at(-1),'cancel-done');await assert.rejects(paused.cancel(),{code:'cleanup_unproven'});
});
test('abort during a pending step aborts native signal and releases the slot only after cleanup',async t=>{
  let signal,entered;const began=new Promise(resolve=>entered=resolve),f=await fixture(t,{step:async(_value,options)=>{signal=options.signal;entered();return new Promise(()=>{});}});
  const abort=new AbortController(),client=f.client(),pending=client.step(request(),{signal:abort.signal});await began;abort.abort();await assert.rejects(pending,{code:'task_timeout'});
  await client.cancel();assert.equal(signal.aborted,true);assert.equal(f.events.includes('cancel-done'),true);
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

test('cancel acknowledgement waits for native cancellation, invocation disposal and shared slot release',async()=>{
  const socket=new EventEmitter(),replies=[],events=[];socket.destroyed=false;
  socket.write=value=>replies.push(JSON.parse(value));socket.end=socket.write;socket.destroy=()=>{socket.destroyed=true;};
  let open,cancel,dispose,release;
  const connection=handleHiringWireCodexConnection(socket,{
    firstFrame:{profile:'hiring_wire',operation:'open',executionId:'wire-1',descriptor:WIRE_PROFILE_DESCRIPTOR},
    openSession:()=>new Promise(resolve=>{open=()=>resolve({session:{step:()=>assert.fail('Cancelled before open.'),cancel:()=>new Promise(resolveCancel=>{events.push('cancel');cancel=resolveCancel;})},dispose:()=>new Promise(resolveDispose=>{events.push('dispose');dispose=resolveDispose;})});}),
    release:()=>new Promise(resolve=>{events.push('release');release=resolve;})
  });
  await tick();socket.emit('data',Buffer.from(`${JSON.stringify({profile:'hiring_wire',operation:'cancel',executionId:'wire-1'})}\n`));
  await tick();assert.deepEqual(events,[]);assert.deepEqual(replies,[]);
  open();await tick();assert.deepEqual(events,['cancel']);assert.deepEqual(replies,[]);
  cancel();await tick();assert.deepEqual(events,['cancel','dispose']);assert.deepEqual(replies,[]);
  dispose();await tick();assert.deepEqual(events,['cancel','dispose','release']);assert.deepEqual(replies,[]);
  release();await connection.done;assert.deepEqual(replies,[{ok:true,executionId:'wire-1',type:'cancelled'}]);
});

test('final and failure replies carry cleanup proof only after the shared slot is released',async()=>{
  for(const failure of [false,true]) {
    const socket=new EventEmitter(),replies=[];socket.destroyed=false;socket.write=value=>replies.push(JSON.parse(value));socket.end=socket.write;socket.destroy=()=>{socket.destroyed=true;};
    let release,entered;const releasing=new Promise(resolve=>entered=resolve),response={type:'final',data:{value:'fixed'}};
    const connection=handleHiringWireCodexConnection(socket,{
      firstFrame:{profile:'hiring_wire',operation:'open',executionId:'wire-1',descriptor:WIRE_PROFILE_DESCRIPTOR},
      openSession:async()=>({session:{step:async()=>{if(failure)throw Error('private provider failure');return response;},cancel:async()=>{}},dispose:async()=>{}}),
      release:()=>new Promise(resolve=>{release=resolve;entered();})
    });
    await tick();socket.emit('data',Buffer.from(`${JSON.stringify({profile:'hiring_wire',operation:'step',executionId:'wire-1',request:request()})}\n`));
    await releasing;assert.deepEqual(replies,[{ok:true,executionId:'wire-1',type:'opened'}]);
    release();await connection.done;
    assert.deepEqual(replies[1],failure?{ok:false,executionId:'wire-1',error:{code:'provider_unavailable'},cleanup:'complete'}:{ok:true,executionId:'wire-1',response,cleanup:'complete'});
  }
});

test('invocation disposal failure never acknowledges cancellation or releases the shared slot',async()=>{
  const socket=new EventEmitter(),replies=[];socket.destroyed=false;socket.write=value=>replies.push(JSON.parse(value));socket.end=socket.write;socket.destroy=()=>{socket.destroyed=true;};
  let released=false;
  const connection=handleHiringWireCodexConnection(socket,{
    firstFrame:{profile:'hiring_wire',operation:'open',executionId:'wire-1',descriptor:WIRE_PROFILE_DESCRIPTOR},
    openSession:async()=>({session:{step:async()=>{},cancel:async()=>{}},dispose:async()=>{throw Error('private disposal failure');}}),release:()=>{released=true;}
  });
  await tick();socket.emit('data',Buffer.from(`${JSON.stringify({profile:'hiring_wire',operation:'cancel',executionId:'wire-1'})}\n`));await connection.done;
  assert.equal(released,false);assert.deepEqual(replies.at(-1),{ok:false,executionId:'wire-1',error:{code:'cleanup_unproven'},cleanup:'unproven'});
});

test('pending-step cancellation is idempotent and holds both client and global slot until cleanup',async t=>{
  let enter,finishCancel,beginCancel;const entered=new Promise(resolve=>enter=resolve),cancelling=new Promise(resolve=>beginCancel=resolve);
  const f=await fixture(t,{step:async()=>{enter();return new Promise(()=>{});},cancel:()=>new Promise(resolve=>{finishCancel=resolve;beginCancel();})});
  const client=f.client(),pending=client.step(request());await entered;
  const cancelled=client.cancel();assert.equal(client.cancel(),cancelled);let done=false;void cancelled.then(()=>{done=true;});
  await cancelling;await tick();assert.equal(done,false);
  await assert.rejects(f.luna({schemaId:'intent',stdin:'backend',timeoutMs:500}),{code:'task_limit'});
  finishCancel();await cancelled;await assert.rejects(pending,{code:'task_timeout'});
  assert.deepEqual((await f.luna({schemaId:'intent',stdin:'backend',timeoutMs:500})).data,intent());
  assert.equal(f.events.filter(value=>value==='cancel-start').length,1);
});

test('cleanup failure does not release the broker slot or become a successful cancel',async t=>{
  const f=await fixture(t,{cancel:()=>{throw Error('private cleanup failure');}}),client=f.client();await client.step(request());
  const cancelled=client.cancel();await assert.rejects(cancelled,error=>error.code==='cleanup_unproven'&&!error.message.includes('private'));
  assert.equal(client.cancel(),cancelled);
  await assert.rejects(f.luna({schemaId:'intent',stdin:'backend',timeoutMs:500}),{code:'task_limit'});
});

async function protocolFixture(t,onFrame) {
  const dir=mkdtempSync(join(tmpdir(),'justup-wire-protocol-')),socketPath=join(dir,'model.sock'),sockets=new Set();
  const server=createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});let buffer='';socket.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const value=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);onFrame(socket,value);}});});
  await new Promise(resolve=>server.listen(socketPath,resolve));
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});});
  return createHiringWireCodexClient({socketPath,executionId:'wire-1'});
}
const send=(socket,value)=>socket.write(`${JSON.stringify({ok:true,executionId:'wire-1',...value})}\n`);

test('cancel during connection opening waits for admission and the explicit cleanup acknowledgement',async t=>{
  let opened,ack,noticeOpen,noticeCancel;const opening=new Promise(resolve=>noticeOpen=resolve),cancelling=new Promise(resolve=>noticeCancel=resolve),operations=[];
  const client=await protocolFixture(t,(socket,value)=>{
    operations.push(value.operation);
    if(value.operation==='open'){opened=()=>send(socket,{type:'opened'});noticeOpen();}
    else if(value.operation==='cancel'){ack=()=>send(socket,{type:'cancelled'});noticeCancel();}
  });
  const pending=client.step(request());await opening;const cancelled=client.cancel();let done=false;void cancelled.then(()=>{done=true;});
  await tick();assert.deepEqual(operations,['open']);assert.equal(done,false);
  opened();await cancelling;assert.deepEqual(operations,['open','cancel']);assert.equal(done,false);
  ack();await cancelled;await assert.rejects(pending,{code:'task_timeout'});
});

test('closed socket, malformed acknowledgement and unmarked terminal reply cannot prove native cleanup',async t=>{
  for(const mode of ['close','malformed','unmarked_error','unmarked_final']) {
    const client=await protocolFixture(t,(socket,value)=>{
      if(value.operation==='open')send(socket,{type:'opened'});
      else if(value.operation==='step')send(socket,{response:{type:'tools',calls:[{id:'call-1',name:'read_facts',arguments:{}}]}});
      else if(mode==='close')socket.end();
      else if(mode==='unmarked_error')send(socket,{ok:false,error:{code:'task_timeout'}});
      else if(mode==='unmarked_final')send(socket,{response:{type:'final',data:{}}});
      else send(socket,{type:'cancelled',unexpected:true});
    });
    await client.step(request());await assert.rejects(client.cancel(),{code:'cleanup_unproven'});
  }
});

test('missing cancellation acknowledgement fails closed at the fixed cleanup deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const client=await protocolFixture(t,(socket,value)=>{
    if(value.operation==='open')send(socket,{type:'opened'});
    else if(value.operation==='step')send(socket,{response:{type:'tools',calls:[{id:'call-1',name:'read_facts',arguments:{}}]}});
  });
  await client.step(request());
  const cancelled=client.cancel(),rejected=assert.rejects(cancelled,{code:'cleanup_unproven'});t.mock.timers.tick(5000);await rejected;
});

test('cancel before the first step needs no connection and cannot later start one',async t=>{
  const f=await fixture(t),client=f.client(),cancelled=client.cancel();assert.equal(client.cancel(),cancelled);await cancelled;
  await assert.rejects(client.step(request()),{code:'dependency_unavailable'});assert.deepEqual(f.events,[]);
});
