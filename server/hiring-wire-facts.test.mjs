// Fact/evaluation owner: Hiring Wire. Deterministic history and claim contracts;
// under one second, server CI lane, no network or provider execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { compileWireSnapshot,periodFor,renderWireItems,validateWireSelection } from './hiring-wire-facts.mjs';
import { AT,END,wireFixture } from './hiring-wire-fixtures.mjs';
const compile=snapshot=>compileWireSnapshot(snapshot,{periodEnd:END,now:AT});

test('counts distinct first observations in two fixed half-open weeks',()=>{
  const snapshot=wireFixture();snapshot.postings.push({...snapshot.postings[0]},{...snapshot.postings[2]});
  const result=compile(snapshot),fact=result.facts[0];
  assert.deepEqual({current:fact.current,previous:fact.previous,change:fact.change,percentageChange:fact.percentageChange},{current:3,previous:2,change:1,percentageChange:50});
  assert.equal(result.period.previousStart,'2026-10-19T00:00:00.000Z');
  assert.throws(()=>periodFor('2026-11-01T00:00:00.000Z'));
  snapshot.postings.push({id:'at-end',scopeId:'internal-board',firstObserved:END});assert.throws(()=>compile(snapshot));
});
test('new, interrupted, stale, sparse and unknown history cannot generate facts',()=>{
  for(const alter of [
    scope=>scope.trackedSince='2026-10-20T00:00:00.000Z',
    scope=>scope.coverage[0].state='interrupted',
    scope=>scope.lastVerifiedAt='2026-11-01T00:00:00.000Z',
    scope=>scope.coverage[0].start='2026-10-20T00:00:00.000Z',
    scope=>scope.coverage[0].state='unknown',
    scope=>scope.coverage=[]
  ]) {const snapshot=wireFixture();alter(snapshot.scopes[0]);const result=compile(snapshot);assert.deepEqual(result.facts,[]);assert.equal(result.suppressed.length,1);}
});
test('only the same comparable scopes contribute, even when a company adds a board',()=>{
  const snapshot=wireFixture();snapshot.scopes.push({...snapshot.scopes[0],id:'new-board',trackedSince:'2026-10-30T00:00:00.000Z'});
  snapshot.postings.push({id:'new-board-posting',scopeId:'new-board',firstObserved:'2026-11-01T00:00:00.000Z'});
  assert.equal(compile(snapshot).facts[0].current,3);
  snapshot.postings.push({...snapshot.postings[0],firstObserved:'2026-10-21T00:00:00.000Z'});assert.throws(()=>compile(snapshot));
});
test('untrusted fields, unsafe company links and stale captures fail closed',()=>{
  for(const alter of [s=>s.accountId='private',s=>s.postings[0].body='restricted body',s=>s.companies[0].url='http://example.com/',s=>s.companies[0].url='https://127.0.0.1/',s=>s.generatedAt='2026-11-01T00:00:00.000Z',s=>s.scopes[0].coverage[0].revision='changed']) {const snapshot=wireFixture();alter(snapshot);assert.throws(()=>compile(snapshot));}
});
test('versioned reviewed and held-out cases meet exact factual and unsafe-claim thresholds',()=>{
  const cases=JSON.parse(readFileSync(new URL('./hiring-wire-evals-v1.json',import.meta.url))),started=performance.now();
  let accepted=0,unsafe=0;
  for(const item of [...cases.reviewed,...cases.heldOut]) {
    const snapshot=wireFixture();snapshot.postings=[];
    for(let i=0;i<item.previous;i++)snapshot.postings.push({id:`old-${i}`,scopeId:'internal-board',firstObserved:'2026-10-20T00:00:00.000Z'});
    for(let i=0;i<item.current;i++)snapshot.postings.push({id:`new-${i}`,scopeId:'internal-board',firstObserved:'2026-10-30T00:00:00.000Z'});
    const {facts}=compile(snapshot),data={snapshotId:snapshot.snapshotId,items:[{factId:facts[0].id,angle:item.angle}]};
    const selection=validateWireSelection(data,facts,snapshot.snapshotId),view=renderWireItems(selection,facts)[0];
    assert.equal(view.activity.current,item.current);assert.equal(view.activity.previous,item.previous);
    if(item.previous===0)assert.equal(view.activity.percentageChange,null);
    accepted++;
    for(const claim of cases.rejectedClaims) {try{validateWireSelection({...data,[claim]:'invented'},facts,snapshot.snapshotId);unsafe++;}catch{}}
  }
  assert.equal(accepted/(cases.reviewed.length+cases.heldOut.length),cases.thresholds.factualAcceptance);
  assert.equal(unsafe,cases.thresholds.unsafeAcceptance);assert.ok(performance.now()-started<cases.thresholds.maxDeterministicMs);
});
