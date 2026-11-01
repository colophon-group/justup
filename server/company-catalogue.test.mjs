// Bounded owner-scoped company catalogue contracts with real SQLite and local
// HTTP. No identity research, native tools, crawler or external provider runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {openStore} from './store.mjs';
import {createFeed} from './feed.mjs';
import {createTasks} from './tasks.mjs';
import {createCompanyService} from './companies.mjs';
import {createReadingPreferencesService} from './reading-preferences.mjs';
import {createHandler} from './http.mjs';

const AT=Date.parse('2026-11-01T12:00:00Z');
function fixture(t) {
  const store=openStore(),db=store.db; t.after(()=>store.close());
  let clock=AT;
  const feed=createFeed({db,now:()=>clock,cursorSecret:'catalogue-test-secret'.repeat(2)}),tasks=createTasks({db,now:()=>clock});
  const authority=id=>['alice','bob'].includes(id)?{account:{id},access:{fullAccess:false,premium:false}}:null;
  const reading=createReadingPreferencesService({db,feed,ownerAuthority:authority,now:()=>clock});
  const companies=createCompanyService({db,feed,tasks,readingPreferences:reading,ownerAuthority:authority,now:()=>clock,beforePrivateDelete:()=>{},model:{resolveCompany(){assert.fail('Known catalogue operations spend no inference.');}}});
  const ids=Array.from({length:60},(_,i)=>feed.publishCompany({name:`Company ${String(i).padStart(2,'0')}`,domain:`company${i}.example.org`,websiteUrl:`https://company${i}.example.org/`,evidenceUrls:[`https://company${i}.example.org/about`]}));
  const ctx=(method,path,body,owner='alice',extra={})=>({method,path:path.split('?')[0],url:new URL(`https://preview.example/api/v1${path}`),body,accountId:owner,viewer:authority(owner),interfaceLocale:'fr',...extra});
  const page=(query='view=followed',owner='alice')=>companies.route(ctx('GET',`/account/companies?${query}`,undefined,owner));
  const follow=(i,followed=true,owner='alice')=>reading.route(ctx('PATCH',`/follows/${ids[i]}`,{followed,expectedRevision:reading.follows(owner).revision},owner));
  async function accept(i,owner='alice',key=`request-${i}`) {
    const created=(await companies.route(ctx('POST','/company-requests',{input:`Company ${String(i).padStart(2,'0')}`,requestKey:key},owner))).body.request;
    return (await companies.route(ctx('POST',`/company-requests/${created.id}/accept`,{candidateId:created.candidate.id,previewRevision:created.previewRevision},owner,{idempotencyKey:`accept-${key}`}))).body.request;
  }
  return {store,db,feed,tasks,reading,companies,ids,authority,ctx,page,follow,accept,advance:ms=>clock+=ms};
}

test('private pages select followed companies beyond the first public page and isolate owners',async t=>{
  const f=fixture(t);f.follow(40);f.follow(41);f.follow(59);f.follow(1,true,'bob');
  const first=(await f.page('view=followed&q=COMPANY&limit=1')).body;
  assert.equal(first.accountId,'alice');assert.equal(first.view,'followed');assert.deepEqual(first.items,[f.feed.company(f.ids[40])]);assert(first.nextCursor);
  const second=(await f.page(`view=followed&q=company&limit=1&cursor=${first.nextCursor}`)).body;
  assert.equal(second.items[0].id,f.ids[41]);
  const last=(await f.page(`view=followed&q=company&limit=1&cursor=${second.nextCursor}`)).body;
  assert.equal(last.items[0].id,f.ids[59]);assert.equal(last.nextCursor,null);
  assert.deepEqual((await f.page('view=followed','bob')).body.items.map(c=>c.id),[f.ids[1]]);
  assert.equal(f.feed.companies({limit:20}).items.some(c=>c.id===f.ids[40]),false);
  await assert.rejects(f.page(`view=followed&q=company&cursor=${first.nextCursor}`,'bob'),{code:'invalid_cursor',status:400});
  await assert.rejects(f.companies.route({...f.ctx('GET','/account/companies?view=followed'),accountId:'bob'}),{code:'unauthenticated',status:401});
});

test('requested pages contain only accepted canonical relationships and deletion removes membership without publication',async t=>{
  const f=fixture(t);
  await f.companies.route(f.ctx('POST','/company-requests',{input:'Company 55',requestKey:'unconfirmed'}));
  await f.companies.route(f.ctx('POST','/company-requests',{input:'Absent company',requestKey:'pending'}));
  assert.deepEqual((await f.page('view=requested')).body.items,[]);
  const accepted=await f.accept(40);await f.accept(41);await f.accept(40);await f.accept(59,'bob');
  assert.deepEqual((await f.page('view=requested')).body.items.map(c=>c.id),[f.ids[40],f.ids[41]]);
  f.follow(40,false);assert.equal((await f.page('view=requested')).body.items.length,2);
  const first=(await f.page('view=requested&limit=1')).body;
  await f.companies.route(f.ctx('DELETE',`/company-requests/${accepted.id}`));
  assert.deepEqual((await f.page('view=requested')).body.items.map(c=>c.id),[f.ids[41]]);
  await assert.rejects(f.page(`view=requested&cursor=${first.nextCursor}`),{code:'stale_cursor',status:409});
  f.companies.deleteAccountData('alice');f.reading.deleteAccountData('alice');
  assert.deepEqual((await f.page('view=requested')).body.items,[]);assert.deepEqual((await f.page()).body.items,[]);
  assert.equal(f.feed.company(f.ids[40]).id,f.ids[40]);assert.equal((await f.page('view=requested','bob')).body.items[0].id,f.ids[59]);
});

test('private continuations bind scope, normalized filter, catalogue and membership generations with strict bounds',async t=>{
  const f=fixture(t);f.follow(40);f.follow(41);
  const first=(await f.page('view=followed&q=company&limit=1')).body,cursor=first.nextCursor;
  await assert.rejects(f.page(`view=followed&cursor=${cursor}x`),{code:'invalid_cursor'});
  await assert.rejects(f.page(`view=requested&q=company&cursor=${cursor}`),{code:'invalid_cursor'});
  assert.throws(()=>f.feed.companies({cursor}),{code:'invalid_cursor'});
  await assert.rejects(f.page(`view=followed&q=40&cursor=${cursor}`),{code:'stale_cursor'});
  f.follow(59);await assert.rejects(f.page(`view=followed&q=company&cursor=${cursor}`),{code:'stale_cursor'});
  const next=(await f.page('view=followed&limit=1')).body.nextCursor;
  f.store.importSnapshot({schemaVersion:1,snapshotAt:new Date(AT).toISOString(),verifiedAt:new Date(AT).toISOString(),jobs:[],observations:[],unknownIds:[]});
  await assert.rejects(f.page(`view=followed&cursor=${next}`),{code:'stale_cursor'});
  const expires=(await f.page('view=followed&limit=1')).body.nextCursor;f.advance(600_000);
  await assert.rejects(f.page(`view=followed&cursor=${expires}`),{code:'stale_cursor'});
  for(const query of ['','view=all','view=followed&view=requested','view=followed&ownerId=bob','view=followed&q=a&q=b',`view=followed&q=${'a'.repeat(101)}`])await assert.rejects(f.page(query),{code:'invalid_query'});
  for(const limit of ['0','51','01','1.5',''])await assert.rejects(f.page(`view=followed&limit=${limit}`),{code:'invalid_limit'});
});

test('verified source aliases retain one canonical row in private requested and followed pages',async t=>{
  const f=fixture(t),accepted=await f.accept(40),iso=new Date(AT).toISOString();
  f.store.importSnapshot({schemaVersion:1,snapshotAt:iso,verifiedAt:iso,observations:[],unknownIds:[],companyIdentities:[{companyId:'source-company',officialDomain:'company40.example.org'}],jobs:[{
    id:'source-job',companyId:'source-company',companyName:'Company 40',companySlug:'company-40',title:'Engineer',sourceUrl:'https://company40.example.org/jobs/1',active:true,reserved:false,hasContent:true,
    firstObserved:new Date(AT-3*86_400_000).toISOString(),lastObserved:null,locales:[],locations:[],employmentTypes:[],seniority:null,salary:null,bodyText:null,
    evidence:{source:'jobseek_public',metadataFetchedAt:iso,bodyFetchedAt:null,bodyUrl:null,bodySha256:null,textSha256:null,bodyBytes:0,normalizationVersion:1,truncated:false}
  }]});
  f.db.prepare('INSERT INTO justup_company_follows VALUES(?,?,1,?)').run('bob','source-company',AT);
  assert.equal(accepted.companyId,f.ids[40]);
  for(const [view,owner] of [['requested','alice'],['followed','alice'],['followed','bob']]) {
    const items=(await f.page(`view=${view}`,owner)).body.items;
    assert.equal(items.length,1);assert.equal(items[0].id,f.ids[40]);assert.equal(items[0].coverage.state,'imported_snapshot');
  }
});

test('private HTTP catalogue uses the validated session during a policy pause and public reads stay owner-free',async t=>{
  const f=fixture(t);f.follow(59);
  const token='a'.repeat(43),auth={session:value=>value===token?f.authority('alice'):null};
  const server=createServer(createHandler({auth,feed:f.feed,tasks:f.tasks,db:f.db,services:[f.companies,f.reading],config:{allowedOrigin:'https://preview.example',csrfSecret:'x'.repeat(32),policiesReviewed:false}}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const base=`http://127.0.0.1:${server.address().port}/api/v1`,headers={Cookie:`__Host-justup_session=${token}`,'X-Justup-Locale':'fr'};
  const response=await fetch(`${base}/account/companies?view=followed`,{headers});
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.headers.get('set-cookie'),null);
  assert.deepEqual((await response.json()).items.map(c=>c.id),[f.ids[59]]);
  assert.equal((await fetch(`${base}/account/companies?view=followed`)).status,401);
  const publicResponse=await fetch(`${base}/companies?limit=1`,{headers}),publicBody=await publicResponse.json();
  assert.equal(publicResponse.status,200);assert.equal(Object.hasOwn(publicBody,'accountId'),false);assert.equal(Object.hasOwn(publicBody.items[0],'followed'),false);
  assert.equal((await fetch(`${base}/companies?view=followed`,{headers})).status,400);
});
