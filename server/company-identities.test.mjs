// Source identity boundaries use real SQLite and public projections. A shared
// website host is metadata, not proof that two companies are the same entity.
import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore,DAY_MS} from './store.mjs';
import {createFeed} from './feed.mjs';
import {createReadingPreferencesService} from './reading-preferences.mjs';
import {createCompanyReports} from './company-reports.mjs';
import {createTasks} from './tasks.mjs';
import {createCompanyService} from './companies.mjs';

const AT=Date.parse('2026-11-01T12:00:00.000Z'),iso=new Date(AT).toISOString();
const candidate=name=>({name,domain:'group.example.org',websiteUrl:'https://group.example.org/',evidenceUrls:['https://group.example.org/about']});
function fixture(t) {
  const store=openStore();t.after(()=>store.close());
  const db=store.db,feed=createFeed({db,now:()=>AT}),reading=createReadingPreferencesService({db,feed,now:()=>AT,ownerAuthority:id=>({account:{id},access:{fullAccess:true}})});
  const load=(companies)=>store.importSnapshot({schemaVersion:1,snapshotAt:iso,verifiedAt:iso,observations:[],unknownIds:[],
    companyIdentities:companies.map(([companyId])=>({companyId,officialDomain:'group.example.org'})),
    jobs:companies.map(([companyId,companyName])=>({id:`job-${companyId}`,companyId,companyName,companySlug:companyId,title:'Engineer',sourceUrl:`https://group.example.org/jobs/${companyId}`,
      firstObserved:new Date(AT-3*DAY_MS).toISOString(),lastObserved:null,active:true,reserved:false,hasContent:true,locales:[],locations:[],employmentTypes:[],seniority:null,salary:null,bodyText:null,
      evidence:{source:'jobseek_public',metadataFetchedAt:iso,bodyFetchedAt:null,bodyUrl:null,bodySha256:null,textSha256:null,normalizationVersion:1,bodyBytes:0,truncated:false}}))});
  return {store,db,feed,reading,load,reports:createCompanyReports({db,feed,now:()=>AT})};
}

test('distinct source IDs sharing an official host keep separate catalogue, follow and report identities after refresh',t=>{
  const f=fixture(t);f.load([['source-a','Subsidiary A'],['source-b','Subsidiary B']]);
  assert.deepEqual(f.feed.companies().items.map(company=>[company.id,company.name]),[['source-a','Subsidiary A'],['source-b','Subsidiary B']]);
  f.reading.followAcceptedCompany('alice','source-a');
  assert.deepEqual(f.reading.follows('alice').items.map(item=>item.companyId),['source-a']);
  assert.equal(f.reports.report('source-a').companyId,'source-a');assert.equal(f.reports.report('source-a').hiringRoles.sampleSize,1);
  assert.equal(f.reports.report('source-b').companyId,'source-b');assert.equal(f.reports.report('source-b').hiringRoles.sampleSize,1);
  assert.deepEqual(f.feed.eligibleJobs({viewer:{account:{id:'alice'},access:{fullAccess:true}}}).map(job=>job.companyId),['source-a','source-b']);
  f.load([['source-b','Subsidiary B'],['source-a','Subsidiary A']]);
  assert.equal(f.feed.company('source-a').id,'source-a');assert.equal(f.feed.company('source-b').id,'source-b');
  assert.deepEqual(f.db.prepare('SELECT DISTINCT company_id FROM job_source_identities ORDER BY company_id').all().map(row=>row.company_id),['source-a','source-b']);
});

test('a different requested entity on an occupied domain conflicts instead of adopting its ID',t=>{
  const f=fixture(t),id=f.feed.publishCompany(candidate('Subsidiary A'));
  assert.equal(f.feed.publishCompany(candidate('Subsidiary A')),id);
  assert.throws(()=>f.feed.publishCompany(candidate('Subsidiary B')),{code:'preview_conflict',status:409});
  assert.equal(f.feed.companies().items.length,1);assert.equal(f.feed.company(id).name,'Subsidiary A');
});

test('refresh preserves an existing stored mapping without spreading it to another source on the same host',t=>{
  const f=fixture(t),id=f.feed.publishCompany(candidate('Existing requested company'));f.load([['source-a','Subsidiary A']]);
  // Exercise persisted alias compatibility. The importer does not approve this
  // mapping; any preexisting cross-ID row needs operator review before launch.
  f.db.prepare('UPDATE justup_company_aliases SET company_id=? WHERE source_company_id=?').run(id,'source-a');
  f.load([['source-a','Subsidiary A'],['source-b','Subsidiary B']]);
  assert.equal(f.feed.company('source-a').id,id);assert.equal(f.feed.company('source-b').id,'source-b');
  assert.equal(f.db.prepare('SELECT company_id FROM job_source_identities WHERE id=?').get('job-source-a').company_id,'source-a');
});

test('host metadata cannot bind a source identity to a request in either import order',async t=>{
  for(const requestFirst of [true,false])await t.test(requestFirst?'request first':'import first',t=>{
    const f=fixture(t);let requestedId;
    if(requestFirst)requestedId=f.feed.publishCompany(candidate('Requested parent'));
    f.load([['source-a','Subsidiary A'],['source-b','Subsidiary B']]);
    if(!requestFirst)requestedId=f.feed.publishCompany(candidate('Requested parent'));
    assert.notEqual(requestedId,'source-a');assert.notEqual(requestedId,'source-b');
    assert.equal(f.feed.company(requestedId).coverage.state,'requested');
    for(const id of ['source-a','source-b'])assert.equal(f.feed.company(id).id,id);
    assert.equal(f.feed.companies().items.length,3);
    assert.equal(f.feed.publishCompany({companyId:'source-b'}),'source-b');
  });
});

test('known-company preview selects an exact catalogue ID while shared hosts and ambiguous names require research',async t=>{
  const f=fixture(t);f.load([['source-a','Subsidiary A'],['source-b','Subsidiary B'],['source-c','Same name'],['source-d','Same name']]);
  const tasks=createTasks({db:f.db,now:()=>AT}),companies=createCompanyService({db:f.db,feed:f.feed,tasks,now:()=>AT,
    beforePrivateDelete:()=>{},model:{resolveCompany(){assert.fail('A catalogue lookup must not invoke inference.');}}});
  const submit=(body)=>companies.route({method:'POST',path:'/company-requests',url:new URL('https://preview.example/api/v1/company-requests'),accountId:'alice',viewer:{account:{id:'alice'}},body});
  const known=await submit({input:'Subsidiary B',requestKey:'known-source'});
  assert.equal(known.status,201);assert.equal(known.body.request.candidate.companyId,'source-b');
  for(const [input,requestKey] of [['Requested parent','host-alone'],['Same name','ambiguous-name']]){
    const response=await submit({input,domain:'group.example.org',requestKey});
    assert.equal(response.status,202);assert.equal(response.body.request.status,'pending');assert.equal(response.body.request.candidate,null);
  }
});
