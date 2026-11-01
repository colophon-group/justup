// Public report protocol fixture shared by local HTML and browser contracts, never product assets.
export function companyReportSample(companyId) {
  return { companyId, asOf: '2026-11-01T12:00:00.000Z', sourceChecks: { state: 'unavailable', items: [] },
    provenance: { source: 'jobseek_public', importVerifiedAt: '2026-11-01T12:00:00.000Z', importGeneration: 'synthetic-report-generation',
      sampleObservedFrom: '2026-11-01T11:00:00.000Z', sampleObservedThrough: '2026-11-01T12:00:00.000Z' },
    scope: { kind: 'eligible_public_listing_sample', firstObservedFrom: '2026-10-18T12:00:00.000Z', firstObservedThrough: '2026-10-30T12:00:00.000Z', completeCompanyCoverage: false },
    freshness: { listings: 'fresh' },
    hiringRoles: { state: 'available', sampleSize: 6, labelledSampleSize: 3, unknownSampleSize: 3, items: [
      { id: 'developer', name: 'Software developers', count: 2 }, { id: 'archivist', name: 'Archivists & curators', count: 1 },
    ] },
    reportedSalaries: { state: 'available', sampleSize: 6, reportedSampleSize: 5, groupedSampleSize: 4, incompleteSampleSize: 1, unknownSampleSize: 1, groups: [
      { currency: 'EUR', period: 'hour', sampleSize: 1, min: null, max: 45 },
      { currency: 'USD', period: 'month', sampleSize: 1, min: 7000, max: null },
      { currency: 'USD', period: 'year', sampleSize: 2, min: 90000, max: 150000 },
    ] } };
}
