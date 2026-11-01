// Hiring Wire protocol owner: least-privilege tool/session boundary. Fake
// transport only, server CI lane, expected under one second.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHiringWireService } from './hiring-wire.mjs';
import { compileWireSnapshot } from './hiring-wire-facts.mjs';
import { createHiringWireEditorial,createHiringWireToolSession,DEFAULT_SCRIPT,previewSelection } from './hiring-wire-editorial.mjs';
import { AT,END,wireFixture } from './hiring-wire-fixtures.mjs';

function context(t) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());const service=createHiringWireService({db,now:()=>AT}),compiled=compileWireSnapshot(wireFixture(),{periodEnd:END,now:AT});
  return {snapshot:{id:compiled.snapshot.snapshotId,sha256:compiled.snapshotSha256,asOf:END,factsVersion:compiled.factsVersion},facts:compiled.facts,previousEditions:[],workspace:service.workspace};
}
test('Sol can inspect aggregates and prior editions, maintain a durable recipe and execute it',async t=>{
  const input=context(t);let turn=0;
  const editorial=createHiringWireEditorial({transport:{qualified:()=>true,executionId:()=>'fixture-tools',step:async request=>{
    const bytes=JSON.stringify(request);assert.equal(bytes.includes('restricted-'),false);assert.equal(bytes.includes('internal-board'),false);
    turn++;
    if(turn===1)return {type:'tools',calls:[{id:'facts',name:'read_facts',arguments:{}},{id:'prior',name:'read_prior_editions',arguments:{}},{id:'script',name:'read_selection_script',arguments:{}}]};
    if(turn===2)return {type:'tools',calls:[{id:'replace',name:'replace_selection_script',arguments:{expectedRevision:request.messages.find(m=>m.id==='script').result.revision,script:{...DEFAULT_SCRIPT,minCurrent:2,maxItems:1,sort:'most_activity'}}}]};
    if(turn===3)return {type:'tools',calls:[{id:'preview',name:'preview_selection',arguments:{}}]};
    return {type:'final',data:{snapshotId:request.context.snapshot.id,items:request.messages.find(m=>m.id==='preview').result}};
  }}});
  const result=await editorial.generateHiringWire(input);assert.equal(result.execution.toolCalls,5);assert.equal(input.workspace.read().script.minCurrent,2);
  assert.deepEqual(result.data.items,previewSelection(input.workspace.read().script,input.facts,[]));
});
test('prior selections change the executed recipe outcome',async t=>{
  const input=context(t),prior=[{items:[{company:input.facts[0].company}]}];
  assert.deepEqual(previewSelection(DEFAULT_SCRIPT,input.facts,prior),[]);
  assert.equal(previewSelection({...DEFAULT_SCRIPT,excludeRecent:false},input.facts,prior).length,1);
});
test('unknown tools, arbitrary script execution, excess calls and wrong final claims are rejected',async t=>{
  for(const response of [
    {type:'tools',calls:[{id:'shell',name:'exec',arguments:{command:'cat /auth'}}]},
    {type:'tools',calls:[{id:'files',name:'read_facts',arguments:{path:'/private/database'}}]},
    {type:'tools',calls:Array.from({length:5},(_,i)=>({id:`call-${i}`,name:'read_facts',arguments:{}}))},
    {type:'final',data:{snapshotId:'fixture-snapshot',items:[],headline:'invented'}},
    {type:'final',data:{snapshotId:'fixture-snapshot',items:[]},execution:{approved:true}}
  ]) {const input=context(t),editorial=createHiringWireEditorial({transport:{qualified:()=>true,executionId:()=>'reject-tools',step:async()=>response}});await assert.rejects(editorial.generateHiringWire(input));}
});
test('an unqualified transport and an aborted session cannot execute editorial work',async t=>{
  const input=context(t);let called=0;
  const unqualified=createHiringWireEditorial({transport:{qualified:()=>false,step:async()=>called++}});
  assert.equal(unqualified.available('hiring_wire'),false);await assert.rejects(unqualified.generateHiringWire(input));assert.equal(called,0);
  const qualified=createHiringWireEditorial({transport:{qualified:()=>true,executionId:()=>'aborted',step:async()=>called++}}),abort=new AbortController();abort.abort();
  await assert.rejects(qualified.generateHiringWire(input,{signal:abort.signal}));assert.equal(called,0);
});
test('expired tool sessions and more than twelve calls cannot continue',t=>{
  const input=context(t);let at=0;
  const session=createHiringWireToolSession(input,{executionId:'deadline',clock:()=>at});
  at=90_000;assert.throws(()=>session.call({id:'late',name:'read_facts',arguments:{}}),{code:'task_timeout'});
  const limited=createHiringWireToolSession(input,{executionId:'calls'});
  for(let i=0;i<12;i++)limited.call({id:`call-${i}`,name:'read_selection_script',arguments:{}});
  assert.throws(()=>limited.call({id:'call-13',name:'read_facts',arguments:{}}),{code:'invalid_output'});
});
test('protocol failure always cancels a paused native execution',async t=>{
  const input=context(t),cancelled=[];
  const editorial=createHiringWireEditorial({transport:{qualified:()=>true,executionId:()=>'paused',step:async()=>({type:'tools',calls:[{id:'bad',name:'shell',arguments:{}}]}),cancel:async id=>cancelled.push(id)}});
  await assert.rejects(editorial.generateHiringWire(input));assert.deepEqual(cancelled,['paused']);
});
test('abort terminates a pending transport step and runs final cleanup',async t=>{
  const input=context(t),abort=new AbortController();let observed=false,cleaned=false;
  const editorial=createHiringWireEditorial({transport:{qualified:()=>true,executionId:()=>'waiting',step:async(_,{signal})=>new Promise(()=>{signal.addEventListener('abort',()=>observed=true,{once:true});abort.abort();}),cancel:async()=>cleaned=true}});
  await assert.rejects(editorial.generateHiringWire(input,{signal:abort.signal}),{code:'task_timeout'});assert.equal(observed,true);assert.equal(cleaned,true);
});
