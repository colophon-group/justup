import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeCompany, decodeCompanyReport } from './decode.ts';
import { ApiClient } from './client.ts';
// @ts-expect-error Real producer/store boundary is exercised without a browser or provider.
import { openStore } from '../../../server/store.mjs';
// @ts-expect-error Real public feed supplies the actual retained sample.
import { createFeed } from '../../../server/feed.mjs';
// @ts-expect-error Real report compiler proves the projection matches current structured evidence.
import { createCompanyReports } from '../../../server/company-reports.mjs';
const report = () => ({ companyId: 'company', asOf: '2026-11-01T12:00:00Z', sourceChecks: { state: 'partial', items: [
  { publicLink: { url: 'https://careers.example.com/jobs', status: 'approved', provenance: 'employer-careers', approvedAt: '2026-10-01T00:00:00Z' }, trackedSince: '2026-10-01T00:00:00Z', lastVerifiedAt: '2026-10-26T00:00:00Z' },
  { publicLink: null, trackedSince: '2026-10-01T00:00:00Z', lastVerifiedAt: null },
] }, privateScopeId: 'PRIVATE_CANARY' });
test('approved report links retain attributable dates without unknown private report fields', () => {
  const value = decodeCompanyReport(report(), 'company');
  assert.equal(value.sourceChecks.items[0]?.publicLink?.url, 'https://careers.example.com/jobs');
  assert.equal(value.sourceChecks.items[1]?.lastVerifiedAt, null);
  assert.equal(Object.hasOwn(value, 'privateScopeId'), false);
  assert.deepEqual(decodeCompanyReport({ companyId: 'company', asOf: report().asOf, sourceChecks: { state: 'unavailable', items: [] } }, 'company').sourceChecks.items, []);
});
test('unapproved, unsafe or inconsistent report evidence cannot supply a career link', () => {
  for (const mutate of [
    (v: ReturnType<typeof report>) => { v.companyId = 'another'; },
    (v: ReturnType<typeof report>) => { v.sourceChecks.items[0]!.publicLink!.status = 'pending'; },
    (v: ReturnType<typeof report>) => { v.sourceChecks.items[0]!.publicLink!.provenance = 'inferred'; },
    (v: ReturnType<typeof report>) => { v.sourceChecks.items[0]!.publicLink!.url = 'https://127.0.0.1/private'; },
    (v: ReturnType<typeof report>) => { v.sourceChecks.items[0]!.publicLink!.url = 'https://careers.example.com/jobs?secret=x'; },
    (v: ReturnType<typeof report>) => { v.sourceChecks.items[0]!.publicLink!.approvedAt = '2026-11-02T00:00:00Z'; },
    (v: ReturnType<typeof report>) => { v.sourceChecks.items[0]!.lastVerifiedAt = '2026-02-30T00:00:00Z'; },
    (v: ReturnType<typeof report>) => { v.sourceChecks.state = 'available'; },
  ]) { const value = report(); mutate(value); assert.throws(() => decodeCompanyReport(value, 'company')); }
});

test('valid producer scope counts remain supported through the 2000-scope contract limit', () => {
  const item = report().sourceChecks.items[0]!;
  for (const size of [1001, 2000]) {
    const value = { ...report(), sourceChecks: { state: 'available', items: Array.from({ length: size }, () => item) } };
    assert.equal(decodeCompanyReport(value, 'company').sourceChecks.items.length, size);
  }
  const oversized = { ...report(), sourceChecks: { state: 'available', items: Array.from({ length: 2001 }, () => item) } };
  assert.throws(() => decodeCompanyReport(oversized, 'company'));
});


const iso = (at: number) => new Date(at).toISOString();
const at = Date.parse('2026-11-01T12:00:00Z');
const currentReport = () => ({ ...report(),
  provenance: { source: 'jobseek_public', importVerifiedAt: iso(at - 600_000) as string | null, importGeneration: 'public-import-one' as string | null,
    sampleObservedFrom: iso(at - 3_600_000) as string | null, sampleObservedThrough: iso(at - 1_200_000) as string | null,
    history: { privateSourceId: 'PRIVATE_HISTORY_CANARY' } },
  scope: { kind: 'eligible_public_listing_sample', firstObservedFrom: iso(at - 14 * 86_400_000), firstObservedThrough: iso(at - 2 * 86_400_000), completeCompanyCoverage: false },
  freshness: { listings: 'fresh', history: 'unavailable' },
  hiringRoles: { state: 'available', sampleSize: 5, labelledSampleSize: 2, unknownSampleSize: 3, items: [{ id: '23', name: 'Developer', count: 2 }] },
  reportedSalaries: { state: 'available', sampleSize: 5, reportedSampleSize: 4, groupedSampleSize: 3, incompleteSampleSize: 1, unknownSampleSize: 1,
    groups: [{ currency: 'EUR', period: 'hour', sampleSize: 1, min: 10, max: null },
      { currency: 'USD', period: 'month', sampleSize: 1, min: null, max: 8 },
      { currency: 'USD', period: 'year', sampleSize: 1, min: 100, max: 200 }] },
});
test('current report keeps exact role/sample denominators and separate currency-period bounds without private history', () => {
  const raw = currentReport(), value = decodeCompanyReport(raw, 'company');
  assert.deepEqual(value.hiringRoles, raw.hiringRoles);
  assert.deepEqual(value.reportedSalaries, raw.reportedSalaries);
  assert.equal(value.provenance?.sampleObservedFrom, raw.provenance.sampleObservedFrom);
  assert.equal(value.scope?.completeCompanyCoverage, false);
  assert.deepEqual(value.freshness, { listings: 'fresh' });
  assert.equal(Object.hasOwn(value.provenance!, 'history'), false);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_HISTORY_CANARY|PRIVATE_CANARY/);
  assert.deepEqual(decodeCompanyReport(value, 'company'), value, 'Public hydration revalidation preserves the same projection');
});
test('an explicit empty current sample stays a sample and missing analytics do not become default zeroes', () => {
  const raw = currentReport(); raw.provenance.sampleObservedFrom = null; raw.provenance.sampleObservedThrough = null;
  raw.hiringRoles = { state: 'available', sampleSize: 0, labelledSampleSize: 0, unknownSampleSize: 0, items: [] };
  raw.reportedSalaries = { state: 'available', sampleSize: 0, reportedSampleSize: 0, groupedSampleSize: 0, incompleteSampleSize: 0, unknownSampleSize: 0, groups: [] };
  const value = decodeCompanyReport(raw, 'company');
  assert.equal(value.hiringRoles?.state, 'available');
  if (value.hiringRoles?.state === 'available') assert.equal(value.hiringRoles.sampleSize, 0);
  const sourceOnly = decodeCompanyReport(report(), 'company');
  for (const field of ['provenance', 'scope', 'freshness', 'hiringRoles', 'reportedSalaries']) assert.equal(Object.hasOwn(sourceOnly, field), false);
});
test('unavailable current evidence discards stale numeric claims while preserving approved career links', () => {
  const raw = currentReport(); raw.freshness.listings = 'unavailable'; raw.hiringRoles.state = 'unavailable'; raw.reportedSalaries.state = 'unavailable';
  const value = decodeCompanyReport(raw, 'company');
  assert.deepEqual(value.hiringRoles, { state: 'unavailable' }); assert.deepEqual(value.reportedSalaries, { state: 'unavailable' });
  assert.equal(value.sourceChecks.items[0]?.publicLink?.url, report().sourceChecks.items[0]?.publicLink?.url);
  assert.deepEqual(decodeCompanyReport(value, 'company'), value);
});
test('partial, inconsistent, unbounded or misleading current sample evidence is rejected', () => {
  const cases: [string, (v: ReturnType<typeof currentReport>) => void][] = [
    ['partial analytics', v => { Reflect.deleteProperty(v, 'scope'); }],
    ['missing provenance', v => { v.provenance.importGeneration = null; }],
    ['other source', v => { v.provenance.source = 'title_guess'; }],
    ['complete coverage', v => { v.scope.completeCompanyCoverage = true; }],
    ['wrong source window', v => { v.scope.firstObservedThrough = iso(at - 86_400_000); }],
    ['future import', v => { v.provenance.importVerifiedAt = iso(at + 1); }],
    ['future observation', v => { v.provenance.sampleObservedThrough = iso(at + 1); }],
    ['reversed observations', v => { v.provenance.sampleObservedFrom = iso(at); }],
    ['missing positive-sample observations', v => { v.provenance.sampleObservedFrom = null; v.provenance.sampleObservedThrough = null; }],
    ['invalid date', v => { v.scope.firstObservedFrom = '2026-02-30T00:00:00Z'; }],
    ['stale enum', v => { v.freshness.listings = 'stale'; }],
    ['contradictory freshness', v => { v.hiringRoles.state = 'unavailable'; }],
    ['unavailable numeric section', v => { v.freshness.listings = 'unavailable'; }],
    ['fractional denominator', v => { v.hiringRoles.sampleSize = 5.5; }],
    ['negative count', v => { v.hiringRoles.unknownSampleSize = -1; }],
    ['count over retained bound', v => { v.hiringRoles.sampleSize = 1001; }],
    ['role denominator', v => { v.hiringRoles.labelledSampleSize = 3; }],
    ['role count sum', v => { v.hiringRoles.items[0]!.count = 1; }],
    ['zero role group', v => { v.hiringRoles.items[0]!.count = 0; }],
    ['duplicate role identity', v => { v.hiringRoles.items.push({ ...v.hiringRoles.items[0]! }); v.hiringRoles.labelledSampleSize = 4; v.hiringRoles.unknownSampleSize = 1; }],
    ['salary denominator differs', v => { v.reportedSalaries.sampleSize = 4; }],
    ['reported/unknown sum', v => { v.reportedSalaries.unknownSampleSize = 2; }],
    ['grouped/incomplete sum', v => { v.reportedSalaries.incompleteSampleSize = 2; }],
    ['salary group count sum', v => { v.reportedSalaries.groups[0]!.sampleSize = 2; }],
    ['duplicate salary units', v => { v.reportedSalaries.groups.push({ ...v.reportedSalaries.groups[0]! }); v.reportedSalaries.groupedSampleSize = 4; v.reportedSalaries.incompleteSampleSize = 0; }],
    ['missing currency', v => { v.reportedSalaries.groups[0]!.currency = ''; }],
    ['missing period', v => { v.reportedSalaries.groups[0]!.period = ''; }],
    ['non-finite amount', v => { v.reportedSalaries.groups[0]!.min = Infinity; }],
    ['negative amount', v => { v.reportedSalaries.groups[0]!.min = -1; }],
    ['reversed amount', v => { v.reportedSalaries.groups[2]!.min = 300; }],
    ['empty amount group', v => { v.reportedSalaries.groups[0]!.min = null; v.reportedSalaries.groups[0]!.max = null; }],
    ['missing bound', v => { Reflect.deleteProperty(v.reportedSalaries.groups[0]!, 'max'); }],
  ];
  for (const [label, change] of cases) { const raw = currentReport(); change(raw); assert.throws(() => decodeCompanyReport(raw, 'company'), label); }
});
test('sample bounds match real retained imports rather than a single import request', () => {
  const store = openStore(); let now = at;
  const job = (id: string) => ({ id, companyId: 'company', companyName: 'Sample company', companySlug: 'sample', title: 'Sample role', sourceUrl: 'https://example.org/jobs/' + id,
    firstObserved: iso(at - 3 * 86_400_000), lastObserved: null, active: true, reserved: false, hasContent: true, locales: [], locations: [], employmentTypes: [], seniority: null,
    salary: null, bodyText: null, evidence: { source: 'jobseek_public', metadataFetchedAt: iso(now), bodyFetchedAt: null, bodyUrl: null, bodySha256: null, textSha256: null, bodyBytes: 0, normalizationVersion: 1, truncated: false } });
  const load = (jobs: ReturnType<typeof job>[]) => store.importSnapshot({ schemaVersion: 1, snapshotAt: iso(now), verifiedAt: iso(now), observations: [], unknownIds: [], jobs });
  try {
    load(Array.from({ length: 1000 }, (_, index) => job('retained-' + index)));
    now += 1000; load([job('next-import')]);
    assert.equal(store.db.prepare('SELECT count(*) n FROM justup_jobs').get().n, 1000);
    const feed = createFeed({ db: store.db, now: () => now });
    const raw = createCompanyReports({ db: store.db, feed, now: () => now }).report('company');
    const decoded = decodeCompanyReport(raw, 'company');
    assert.equal(decoded.hiringRoles?.state, 'available');
    if (decoded.hiringRoles?.state === 'available') assert.equal(decoded.hiringRoles.sampleSize, 1000);
    assert.equal(decoded.reportedSalaries?.state, 'available');
    if (decoded.reportedSalaries?.state === 'available') assert.equal(decoded.reportedSalaries.unknownSampleSize, 1000);
    raw.hiringRoles.sampleSize = 1001;
    assert.throws(() => decodeCompanyReport(raw, 'company'));
  } finally { store.close(); }
});
test('report client makes one public request for approved sources and structured samples', async () => {
  const calls: string[] = [];
  const client = new ApiClient({ fetch: async url => { calls.push(String(url)); return new Response(JSON.stringify(currentReport()), { headers: { 'Content-Type': 'application/json' } }); } });
  const value = await client.getCompanyReport('company');
  assert.deepEqual(calls, ['/api/v1/companies/company/report']); assert.equal(value.hiringRoles?.state, 'available');
});
test('legacy company role and salary arrays do not bypass report evidence', () => {
  const value = decodeCompany({ id: 'company', name: 'Sample company', hiringRoles: [{ name: 'Guessed', count: 500 }], reportedSalaries: [{ text: 'Guaranteed pay' }] });
  assert.equal(Object.hasOwn(value, 'hiringRoles'), false); assert.equal(Object.hasOwn(value, 'reportedSalaries'), false);
});
