// Public report contracts: real SQLite/import/publication with synthetic source
// facts and a fake editorial transport; no external requests or native inference.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { openStore, DAY_MS } from './store.mjs';
import { createFeed } from './feed.mjs';
import { createTasks } from './tasks.mjs';
import { createReadingPreferencesService } from './reading-preferences.mjs';
import { createHiringWireService } from './hiring-wire.mjs';
import { createHiringWireEditorial } from './hiring-wire-editorial.mjs';
import { createCompanyReports } from './company-reports.mjs';
import { createHandler } from './http.mjs';
import { digest } from './hiring-wire-facts.mjs';

const AT = Date.parse('2026-11-01T12:00:00.000Z'), END = '2026-10-26T00:00:00.000Z', iso = at => new Date(at).toISOString();
function job(id, age = 3, fields = {}) {
  return { id, companyId: 'company-1', companyName: 'Example', companySlug: 'example', title: 'Engineer',
    sourceUrl: `https://employer.example/jobs/${id}`, firstObserved: iso(AT - age * DAY_MS), lastObserved: null,
    active: true, reserved: false, hasContent: true, locales: [], locations: [], employmentTypes: [], seniority: null,
    salary: null, bodyText: null, evidence: { source: 'jobseek_public', metadataFetchedAt: iso(AT), bodyFetchedAt: null,
      bodyUrl: null, bodySha256: null, textSha256: null, normalizationVersion: 1, bodyBytes: 0, truncated: false }, ...fields };
}
function snapshot() {
  return { schemaVersion: 1, sourceVersion: 'jobseek-coverage-v1', snapshotId: 'synthetic-history', asOf: END,
    generatedAt: iso(Date.parse(END) + 3_600_000), companies: [{ id: 'company-1', name: 'Example', url: 'https://employer.example/' }],
    scopes: [{ id: 'private-source-scope', companyId: 'company-1', revision: 'rev-1', trackedSince: '2026-09-01T00:00:00.000Z',
      lastVerifiedAt: END, coverage: [{ start: '2026-10-12T00:00:00.000Z', end: END, state: 'complete' }] }],
    postings: [{ id: 'closed-historical-listing', scopeId: 'private-source-scope', firstObserved: '2026-10-13T12:00:00.000Z' },
      { id: 'historical-listing-two', scopeId: 'private-source-scope', firstObserved: '2026-10-20T12:00:00.000Z' },
      { id: 'historical-listing-three', scopeId: 'private-source-scope', firstObserved: '2026-10-22T12:00:00.000Z' }] };
}
function snapshotV2() {
  const value=snapshot();value.schemaVersion=2;value.sourceVersion='jobseek-coverage-v2';
  for(const scope of value.scopes)scope.publicLink={url:'https://careers.example.com/team/jobs',status:'approved',provenance:'employer-careers',approvedAt:'2026-09-01T00:00:00.000Z'};
  return value;
}
function fixture(t, jobs = [job('visible')]) {
  const store = openStore(); t.after(() => store.close()); let at = AT;
  const now = () => at, feed = createFeed({ db: store.db, now, cursorSecret: 'x'.repeat(32) });
  const load = (rows, extra = {}) => store.importSnapshot({ schemaVersion: 1, snapshotAt: iso(at), verifiedAt: iso(at), jobs: rows, observations: [], unknownIds: [], ...extra });
  load(jobs);
  return { store, db: store.db, feed, load, now, setNow: value => { at = value; }, reports: createCompanyReports({ db: store.db, feed, now }) };
}
async function publish(f, value = snapshot()) {
  const now = () => Date.parse(END) + 2 * 3_600_000, tasks = createTasks({ db: f.db, now });
  const editorial = createHiringWireEditorial({ transport: { qualified: () => true, executionId: () => 'synthetic-publication',
    step: async ({ context }) => ({ type: 'final', data: { snapshotId: context.snapshot.id, items: [{ factId: context.facts[0].id, angle: 'counts' }] } }) } });
  const wire = createHiringWireService({ db: f.db, tasks, now, source: { authoritative: true, version: value.sourceVersion, readSnapshot: async () => value }, editorial });
  wire.enqueuePeriod(END);
  const task = tasks.claim({ workerId: 'report-test', kinds: ['hiring_wire'] });
  assert.equal((await wire.runTask(task)).committed, true);
}

test('current snapshot supports sampled roles and separate salary units without inventing history or hidden jobs', t => {
  const f = fixture(t, [job('visible-usd', 3, { occupation: { id: '23', name: 'Developer' }, salary: { min: 100, max: 200, currency: 'USD', period: 'year' } }),
    job('visible-eur', 4, { salary: { min: 10, max: null, currency: 'EUR', period: 'hour' } }),
    job('visible-month', 5, { occupation: { id: '23', name: 'Developer' }, salary: { min: 5, max: 8, currency: 'USD', period: 'month' } }),
    job('missing-unit', 6, { salary: { min: 30, max: 40, currency: null, period: 'year' } }),
    job('unlabelled', 7), job('hidden-latest', 1, { occupation: { id: 'secret-role', name: 'Restricted title' }, salary: { min: 999, max: 999, currency: 'PRIVATE', period: 'secret' } })]);
  const report = f.reports.report('company-1');
  assert.equal(report.monitoringSince, null); assert.equal(report.hiringHistory.state, 'unavailable');
  assert.deepEqual(report.sourceChecks,{state:'unavailable',items:[]});
  assert.deepEqual(report.hiringRoles, { state: 'available', sampleSize: 5, labelledSampleSize: 2, unknownSampleSize: 3, items: [{ id: '23', name: 'Developer', count: 2 }] });
  assert.equal(report.reportedSalaries.reportedSampleSize, 4); assert.equal(report.reportedSalaries.incompleteSampleSize, 1);
  assert.equal(report.reportedSalaries.unknownSampleSize, 1);
  assert.deepEqual(report.reportedSalaries.groups.map(value => [value.currency, value.period, value.min, value.max]), [['EUR', 'hour', 10, null], ['USD', 'month', 5, 8], ['USD', 'year', 100, 200]]);
  assert.equal(report.scope.completeCompanyCoverage, false);
  assert.equal(report.provenance.importVerifiedAt, iso(AT));
  assert.equal(report.provenance.sampleObservedFrom, iso(AT));
  for (const forbidden of ['hidden-latest', 'Restricted title', 'secret-role', 'PRIVATE', 'bodyText', 'positionsTotal', 'headquarters']) assert.equal(JSON.stringify(report).includes(forbidden), false);
  f.setNow(AT + DAY_MS);
  assert.equal(f.reports.report('company-1').hiringRoles.state, 'unavailable');
  assert.equal(f.reports.report('company-1').provenance.sampleObservedThrough, null);
});

test('published frozen history stays attributable after 24 hours and closures do not rewrite historical activity', async t => {
  const f = fixture(t); await publish(f);
  const report = f.reports.report('company-1');
  assert.equal(report.monitoringSince, '2026-09-01T00:00:00.000Z');
  assert.equal(report.hiringHistory.state, 'available');
  assert.deepEqual(report.hiringHistory.points.map(value => value.newListings), [1, 2]);
  assert.equal(report.provenance.history.asOf, END); assert.notEqual(report.asOf, END);
  assert.equal(report.freshness.history, 'fresh');
  f.load([], { observations: [{ id: 'visible', active: false, observedAt: iso(AT + 1), reserved: false }], verifiedAt: iso(AT + 1) });
  assert.deepEqual(f.reports.report('company-1').hiringHistory.points.map(value => value.newListings), [1, 2]);
  assert.equal(f.reports.report('company-1').hiringRoles.sampleSize, 0);
  f.setNow(Date.parse(END) + 8 * DAY_MS);
  assert.equal(f.reports.report('company-1').freshness.history, 'stale');
  assert.deepEqual(f.reports.report('company-1').hiringHistory.points.map(value => value.newListings), [1, 2]);
  for (const forbidden of ['closed-historical-listing', 'historical-listing-two', 'private-source-scope', 'rev-1', 'snapshot_json']) assert.equal(JSON.stringify(report).includes(forbidden), false);
});

test('published v1 and v2 retain the same activity and their original immutable snapshot hashes',async t=>{
  const first=fixture(t),second=fixture(t),v1=snapshot(),v2=snapshotV2();
  await publish(first,v1);await publish(second,v2);
  const before=first.db.prepare('SELECT snapshot_json,snapshot_sha256 FROM hiring_wire_editions').get();
  assert.equal(before.snapshot_sha256,digest(v1));assert.deepEqual(JSON.parse(before.snapshot_json),v1);
  const older=first.reports.report('company-1'),newer=second.reports.report('company-1');
  assert.deepEqual(newer.hiringHistory,older.hiringHistory);assert.equal(newer.monitoringSince,older.monitoringSince);
  assert.deepEqual(older.sourceChecks,{state:'unavailable',items:[{publicLink:null,trackedSince:v1.scopes[0].trackedSince,lastVerifiedAt:END}]});
  assert.deepEqual(newer.sourceChecks,{state:'available',items:[{publicLink:v2.scopes[0].publicLink,trackedSince:v2.scopes[0].trackedSince,lastVerifiedAt:END}]});
  assert.equal(newer.provenance.history.sourceVersion,'jobseek-coverage-v2');
  assert.equal(newer.provenance.history.sha256,digest(v2));
  assert.deepEqual(first.db.prepare('SELECT snapshot_json,snapshot_sha256 FROM hiring_wire_editions').get(),before);
});

test('malformed v2 approval metadata makes published history unavailable even with a matching stored hash',async t=>{
  for(const change of [
    value=>delete value.scopes[0].publicLink,
    value=>value.scopes[0].publicLink.status='pending',
    value=>value.scopes[0].publicLink.url='https://private.internal/secret',
    value=>value.scopes[0].publicLink.provenance='inferred',
    value=>value.scopes[0].publicLink.approvedAt=iso(Date.parse(value.generatedAt)+1),
    value=>value.sourceVersion='jobseek-coverage-v3'
  ]) {
    const f=fixture(t),value=snapshotV2();await publish(f,value);change(value);
    f.db.exec('DROP TRIGGER hiring_wire_published_immutable; DROP TRIGGER hiring_wire_period_immutable; DROP TRIGGER hiring_wire_snapshot_immutable;');
    f.db.prepare('UPDATE hiring_wire_editions SET snapshot_json=?,snapshot_sha256=?').run(JSON.stringify(value),digest(value));
    const report=f.reports.report('company-1');
    assert.equal(report.hiringHistory.state,'unavailable');assert.equal(report.provenance.history,null);
    assert.deepEqual(report.sourceChecks,{state:'unavailable',items:[]});
    assert.equal(report.monitoringSince,null);assert.equal(report.hiringRoles.sampleSize,1);
    assert.equal(JSON.stringify(report).includes('private.internal'),false);
  }
});

test('multi-board public links stay with their frozen scope checks and null never substitutes another URL',async t=>{
  const f=fixture(t),value=snapshotV2();
  value.scopes.push({...structuredClone(value.scopes[0]),id:'second-private-scope',revision:'new-private-revision',
    publicLink:null,trackedSince:'2026-10-20T00:00:00.000Z',lastVerifiedAt:null,
    coverage:[{start:'2026-10-12T00:00:00.000Z',end:END,state:'unknown'}]});
  await publish(f,value);
  const report=f.reports.report('company-1');
  assert.deepEqual(report.sourceChecks,{state:'partial',items:[
    {publicLink:value.scopes[0].publicLink,trackedSince:'2026-09-01T00:00:00.000Z',lastVerifiedAt:END},
    {publicLink:null,trackedSince:'2026-10-20T00:00:00.000Z',lastVerifiedAt:null}
  ]});
  assert.equal(report.hiringHistory.state,'partial');
  assert.deepEqual(report.hiringHistory.points.map(point=>point.newListings),[null,null]);
  assert.equal(report.hiringHistory.points[0].reasons.includes('new_scope'),true);
  assert.equal(JSON.stringify(report.sourceChecks).includes('employer.example'),false);
  assert.equal(JSON.stringify(report).includes('second-private-scope'),false);
  assert.equal(JSON.stringify(report).includes('new-private-revision'),false);
  // Later in-memory source edits cannot relabel or repair a published snapshot.
  value.scopes[0].publicLink.url='https://careers.example.com/reassigned/jobs';
  assert.equal(f.reports.report('company-1').sourceChecks.items[0].publicLink.url,'https://careers.example.com/team/jobs');
  f.setNow(Date.parse(END)+8*DAY_MS);
  assert.equal(f.reports.report('company-1').freshness.history,'stale');
  assert.deepEqual(f.reports.report('company-1').sourceChecks,report.sourceChecks);
});

test('available approved links do not assert a successful check or complete history',async t=>{
  const f=fixture(t),value=snapshotV2();
  value.scopes.push({...structuredClone(value.scopes[0]),id:'unverified-scope',lastVerifiedAt:null,
    publicLink:{...value.scopes[0].publicLink,url:'https://ats.example.org/openings',provenance:'ats-careers',approvedAt:value.generatedAt},
    coverage:[{start:'2026-10-12T00:00:00.000Z',end:END,state:'unknown'}]});
  await publish(f,value);
  const report=f.reports.report('company-1');
  assert.equal(report.sourceChecks.state,'available');assert.equal(report.sourceChecks.items[1].lastVerifiedAt,null);
  assert.equal(report.sourceChecks.items[1].publicLink.approvedAt,value.generatedAt);
  assert.equal(report.hiringHistory.state,'partial');
});

test('v2 with no approved links keeps attributable counts and explicit unavailable link evidence',async t=>{
  const f=fixture(t),value=snapshotV2();value.scopes[0].publicLink=null;await publish(f,value);
  const report=f.reports.report('company-1');
  assert.equal(report.sourceChecks.state,'unavailable');assert.equal(report.sourceChecks.items[0].publicLink,null);
  assert.equal(report.hiringHistory.state,'available');assert.equal(report.provenance.history.sha256,digest(value));
});

test('zero newly observed listings is reported only for an explicitly complete historical period', async t => {
  const f = fixture(t), value = snapshot(); value.postings.shift(); await publish(f, value);
  const points = f.reports.report('company-1').hiringHistory.points;
  assert.deepEqual(points.map(value => value.newListings), [0, 2]);
  assert.equal(points[0].state, 'complete');
});

test('interrupted and new scopes retain observed activity with unknown full counts instead of zero', async t => {
  const f = fixture(t), value = snapshot();
  value.scopes.push({ ...structuredClone(value.scopes[0]), id: 'new-scope', trackedSince: '2026-10-20T00:00:00.000Z', coverage: [{ start: '2026-10-20T00:00:00.000Z', end: END, state: 'interrupted' }] });
  await publish(f, value);
  const report = f.reports.report('company-1');
  assert.equal(report.hiringHistory.state, 'partial');
  assert.deepEqual(report.hiringHistory.points.map(value => [value.newListings, value.observedListings, value.completeScopeCount, value.scopeCount]), [[null, 1, 1, 2], [null, 2, 1, 2]]);
  assert(report.hiringHistory.points[0].reasons.includes('new_scope'));
  assert(report.hiringHistory.points[1].reasons.includes('interrupted_scope'));
});

test('source hash, publication order, pending state and future observations fail closed without losing current facts', async t => {
  for (const column of ['hash', 'period', 'publication', 'pending', 'future']) await t.test(column, async t => {
    const f = fixture(t); await publish(f);
    f.db.exec('DROP TRIGGER hiring_wire_published_immutable; DROP TRIGGER hiring_wire_period_immutable; DROP TRIGGER hiring_wire_snapshot_immutable;');
    if (column === 'hash') f.db.prepare("UPDATE hiring_wire_editions SET snapshot_sha256=?").run('0'.repeat(64));
    if (column === 'period') f.db.exec("UPDATE hiring_wire_editions SET period_id='2026-10-19'");
    if (column === 'publication') f.db.prepare('UPDATE hiring_wire_editions SET published_at=?').run(Date.parse(END));
    if (column === 'pending') f.db.exec("UPDATE hiring_wire_editions SET status='pending'");
    if (column === 'future') f.setNow(Date.parse(END) + 30 * 60_000);
    const report = f.reports.report('company-1');
    assert.equal(report.hiringHistory.state, 'unavailable'); assert.equal(report.monitoringSince, null);
    assert.equal(report.provenance.history, null);
    if (column !== 'future') assert.equal(report.hiringRoles.sampleSize, 1);
  });
});

test('public company publication and actual offline importer preserve canonical follows, raw identity and reports', async t => {
  const f = fixture(t, []), id = f.feed.publishCompany({ name: 'Example', domain: 'employer.example', websiteUrl: 'https://employer.example/', evidenceUrls: ['https://employer.example/about'] });
  const reading = createReadingPreferencesService({ db: f.db, feed: f.feed, now: f.now, ownerAuthority: owner => ({ account: { id: owner }, access: { fullAccess: true } }) });
  reading.followAcceptedCompany('synthetic-owner', id);
  const process = spawnSync('python3', ['-c', `import importlib.util,json
spec=importlib.util.spec_from_file_location('fixture','scripts/test_import_jobs.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
source=module.FakeSource([module.posting()],companies=[{'id':'company-1','website':'https://employer.example/'}])
print(json.dumps(module.IMPORT.import_snapshot(source,'2026-11-01T12:00:00.000Z',max_jobs=1,now=module.NOW+module.timedelta(hours=20))))`], { encoding: 'utf8', maxBuffer: 65_536 });
  assert.equal(process.status, 0); f.store.importSnapshot(JSON.parse(process.stdout));
  assert.equal(f.feed.company('company-1').id, id); assert.equal(f.feed.companies().items.length, 1);
  assert.equal(reading.follows('synthetic-owner').items[0].companyId, id);
  assert.equal(f.db.prepare('SELECT company_id FROM job_source_identities').get().company_id, 'company-1');
  await publish(f);
  assert.equal(f.reports.report('company-1').companyId, id); assert.equal(f.reports.report(id).hiringHistory.state, 'available');
});

test('report HTTP reads are public and cookie-independent while private scopes and writes are denied', async t => {
  const f = fixture(t), server = createServer(createHandler({ auth: { session: () => null }, feed: f.feed, services: [f.reports], now: f.now, config: { allowedOrigin: 'https://preview.example' } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/api/v1/companies/company-1/report`;
  const response = await fetch(url); assert.equal(response.status, 200); assert.equal(response.headers.get('set-cookie'), null);
  assert.equal((await response.json()).companyId, 'company-1');
  assert.equal((await fetch(url + '?scope=followed')).status, 400);
  assert.equal((await fetch(url.replace('company-1', 'absent'))).status, 404);
  assert.notEqual((await fetch(url, { method: 'POST' })).status, 200);
  assert.equal(f.db.prepare('SELECT count(*) n FROM justup_requested_companies').get().n, 0);
});
