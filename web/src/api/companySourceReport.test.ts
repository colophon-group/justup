import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeCompanySourceReport } from './decode.ts';
const report = () => ({ companyId: 'company', asOf: '2026-11-01T12:00:00Z', sourceChecks: { state: 'partial', items: [
  { publicLink: { url: 'https://careers.example.com/jobs', status: 'approved', provenance: 'employer-careers', approvedAt: '2026-10-01T00:00:00Z' }, trackedSince: '2026-10-01T00:00:00Z', lastVerifiedAt: '2026-10-26T00:00:00Z' },
  { publicLink: null, trackedSince: '2026-10-01T00:00:00Z', lastVerifiedAt: null },
] }, privateScopeId: 'PRIVATE_CANARY' });
test('approved report links retain attributable dates without unknown private report fields', () => {
  const value = decodeCompanySourceReport(report(), 'company');
  assert.equal(value.sourceChecks.items[0]?.publicLink?.url, 'https://careers.example.com/jobs');
  assert.equal(value.sourceChecks.items[1]?.lastVerifiedAt, null);
  assert.equal(Object.hasOwn(value, 'privateScopeId'), false);
  assert.deepEqual(decodeCompanySourceReport({ companyId: 'company', asOf: report().asOf, sourceChecks: { state: 'unavailable', items: [] } }, 'company').sourceChecks.items, []);
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
  ]) { const value = report(); mutate(value); assert.throws(() => decodeCompanySourceReport(value, 'company')); }
});
