// Fact/evaluation owner: Hiring Wire. Deterministic history and claim contracts;
// under one second, server CI lane, no network or provider execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { compileWireSnapshot,digest,periodFor,renderWireItems,validateWireSelection } from './hiring-wire-facts.mjs';
import { AT,END,wireFixture } from './hiring-wire-fixtures.mjs';
const compile=snapshot=>compileWireSnapshot(snapshot,{periodEnd:END,now:AT});

const approvedLink = () => ({url:'https://careers.example.com/team/jobs',status:'approved',provenance:'employer-careers',approvedAt:'2026-10-01T00:00:00.000Z'});
function v2Fixture() {
  const value=wireFixture();value.schemaVersion=2;value.sourceVersion='jobseek-coverage-v2';
  for(const scope of value.scopes)scope.publicLink=approvedLink();
  return value;
}

test('v1 immutable hash and deterministic facts survive explicit v2 metadata',()=>{
  const v1=wireFixture(), original=structuredClone(v1), before=compile(v1), v2=v2Fixture(), next=compile(v2);
  assert.equal(before.snapshotSha256,'4b78732b44534b7a86d3649cbe22642c19f973b5af3e0b9030743d19191ed995');
  assert.deepEqual(v1,original);assert.deepEqual(before.snapshot,original);
  assert.deepEqual(next.facts,before.facts);assert.deepEqual(next.suppressed,before.suppressed);
  assert.equal(next.factsVersion,before.factsVersion);assert.deepEqual(next.snapshot,v2);
  for(const provenance of ['employer-careers','ats-careers','reviewed-redirect']) {
    const value=v2Fixture();value.scopes[0].publicLink.provenance=provenance;assert.deepEqual(compile(value).facts,before.facts);
  }
  v2.scopes[0].publicLink=null;assert.deepEqual(compile(v2).facts,before.facts);
  v2.scopes[0].publicLink=approvedLink();v2.scopes[0].publicLink.approvedAt=v2.generatedAt;
  assert.deepEqual(compile(v2).facts,before.facts);
});

test('v2 missing, unapproved, malformed or future public-link approval fails closed',()=>{
  for(const alter of [
    s=>delete s.scopes[0].publicLink, s=>s.scopes[0].publicLink={},
    s=>s.scopes[0].publicLink.status='pending',s=>s.scopes[0].publicLink.provenance='guessed',
    s=>s.scopes[0].publicLink.approvedAt=new Date(Date.parse(s.generatedAt)+1).toISOString(),
    s=>s.scopes[0].publicLink.approvedAt='2026-10-01',s=>s.scopes[0].publicLink.secret='endpoint',
    s=>s.schemaVersion=1,s=>s.sourceVersion='unreviewed-v2',s=>s.schemaVersion=3
  ]) {const value=v2Fixture();alter(value);assert.throws(()=>compile(value),{code:'invalid_output'});}
  for(const url of [
    'http://careers.example.com/jobs','https://u:p@careers.example.com/jobs','https://@careers.example.com/jobs',
    'https://127.0.0.1/jobs','https://[::1]/jobs','https://2130706433/jobs','https://0x7f000001/jobs',
    'https://jobs.internal/jobs','https://jobs.test/jobs','https://careers.example/jobs','https://jobs.onion/jobs',
    'https://careers.example.com:8080/jobs','https://careers.example.com:443/jobs',
    'https://careers.example.com/jobs?token=private','https://careers.example.com/jobs#fragment',
    'https://careers.example.com/jobs%2Fprivate','https://careers.example.com/a/../jobs',
    'https://careers.example.com/jobs here','https://careers.example.com/jobs\\private',
    'https://careers.example.com/jobs\nprivate','https://careers.example.com/é'
  ]) {const value=v2Fixture();value.scopes[0].publicLink.url=url;assert.throws(()=>compile(value),{code:'invalid_output'},url);}
});

test('v2 scope resets after the weekly boundary suppress only the changed scope',()=>{
  const resetAt='2026-11-02T00:30:00.000Z';
  for(const publicLink of [{...approvedLink(),approvedAt:resetAt},null]) {
    for(const lastVerifiedAt of [null,'2026-11-02T00:45:00.000Z']) {
      const value=v2Fixture(),stable=structuredClone(value.scopes[0]);
      value.companies.push({id:'stable-company',name:'Stable Company',url:'https://stable.example.com/'});
      value.scopes.push({...stable,id:'stable-board',companyId:'stable-company'});
      value.postings.push(...value.postings.map(posting=>({...posting,id:`stable-${posting.id}`,scopeId:'stable-board'})));
      Object.assign(value.scopes[0],{revision:'reset-revision',trackedSince:resetAt,lastVerifiedAt,publicLink,
        coverage:stable.coverage.map(interval=>({...interval,state:'unknown'}))});
      const original=structuredClone(value),result=compile(value);
      assert.deepEqual(result.facts.map(fact=>[fact.company.id,fact.current,fact.previous,fact.scopeCount]),[['stable-company',3,2,1]]);
      assert.deepEqual(result.suppressed,[{scopeId:'internal-board',reason:lastVerifiedAt===null?'never_verified_scope':'new_scope'}]);
      assert.deepEqual(value,original);assert.deepEqual(result.snapshot,original);assert.equal(result.snapshotSha256,digest(original));
    }
  }
});

test('scope tracking and verification evidence cannot follow snapshot generation or precede a reset',()=>{
  for(const create of [wireFixture,v2Fixture]) {
    for(const alter of [
      value=>{value.scopes[0].trackedSince=new Date(Date.parse(value.generatedAt)+1).toISOString();value.scopes[0].lastVerifiedAt=null;},
      value=>value.scopes[0].lastVerifiedAt=new Date(Date.parse(value.generatedAt)+1).toISOString(),
      value=>{value.scopes[0].trackedSince='2026-11-02T00:30:00.000Z';value.scopes[0].lastVerifiedAt=END;}
    ]) {const value=create();alter(value);assert.throws(()=>compile(value),{code:'invalid_output'});}
  }
});

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
test('real-source bare origins and homepage paths canonicalize only factual company projections',()=>{
  for(const [input,expected] of [['https://example.com','https://example.com/'],['https://EXAMPLE.com/company','https://example.com/company'],['https://example.com:443/about/','https://example.com/about/']]) {
    const snapshot=wireFixture();snapshot.sourceVersion='jobseek-coverage-v1';snapshot.companies[0].url=input;
    const original=structuredClone(snapshot),result=compile(snapshot);
    assert.equal(result.facts[0].company.url,expected);
    assert.deepEqual(result.snapshot,original);assert.deepEqual(snapshot,original);
    assert.equal(result.snapshotSha256,digest(original));
  }
});
test('never-verified scopes suppress unknown activity even with claimed complete history or no postings',()=>{
  for(const postings of [true,false]) {
    const snapshot=wireFixture();snapshot.sourceVersion='jobseek-coverage-v1';snapshot.scopes[0].lastVerifiedAt=null;
    if(!postings)snapshot.postings=[];
    const result=compile(snapshot);
    assert.deepEqual(result.facts,[]);
    assert.deepEqual(result.suppressed,[{scopeId:'internal-board',reason:'never_verified_scope'}]);
    // Suppression never bypasses validation of an asserted history interval.
    snapshot.scopes[0].coverage[0].end=snapshot.scopes[0].coverage[0].start;
    assert.throws(()=>compile(snapshot),{code:'invalid_output'});
  }
  const snapshot=wireFixture();snapshot.scopes.push({...snapshot.scopes[0],id:'never-verified',lastVerifiedAt:null});
  snapshot.postings.push({id:'unknown-posting',scopeId:'never-verified',firstObserved:'2026-11-01T00:00:00.000Z'});
  const result=compile(snapshot);assert.equal(result.facts[0].current,3);assert.equal(result.facts[0].scopeCount,1);
});
test('homepage normalization rejects credentials, local destinations, unsafe ports and query/control syntax',()=>{
  for(const url of ['http://example.com/path','https://user:password@example.com/','https://@example.com/','https://127.0.0.1/',
    'https://[::1]/','https://2130706433/','https://localhost/','https://app.local/','https://app.internal/','https://app.lan/',
    'https://app.localdomain/','https://example.com:8443/','https://example.com/?','https://example.com/#','https://example.com/?a=1',
    'https://example.com/#about','https://example.com/\npath','https://example.com/%0apath',' https://example.com/',
    'https://example.com\\private','https://example.com./','https://-bad.example.com/']) {
    const snapshot=wireFixture();snapshot.companies[0].url=url;
    assert.throws(()=>compile(snapshot),{code:'invalid_output'},url);
  }
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
