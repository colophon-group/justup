// Synthetic fixtures only; never imported by application composition or shipped
// as published news. The fixed clock makes comparison and retry tests repeatable.
export const END='2026-11-02T00:00:00.000Z';
export const AT=Date.parse(END)+3_600_000;
export function wireFixture() {
  return {schemaVersion:1,sourceVersion:'wire-history-v1',snapshotId:'fixture-snapshot',asOf:END,generatedAt:new Date(AT).toISOString(),
    companies:[{id:'fixture-company',name:'Fixture Engineering',url:'https://example.com/'}],
    scopes:[{id:'internal-board',companyId:'fixture-company',revision:'rev-1',trackedSince:'2026-10-01T00:00:00.000Z',lastVerifiedAt:END,coverage:[{start:'2026-10-19T00:00:00.000Z',end:END,state:'complete'}]}],
    postings:[{id:'restricted-old-1',scopeId:'internal-board',firstObserved:'2026-10-20T00:00:00.000Z'},{id:'restricted-old-2',scopeId:'internal-board',firstObserved:'2026-10-25T00:00:00.000Z'},
      {id:'restricted-new-1',scopeId:'internal-board',firstObserved:'2026-10-26T00:00:00.000Z'},{id:'restricted-new-2',scopeId:'internal-board',firstObserved:'2026-10-28T00:00:00.000Z'},{id:'restricted-new-3',scopeId:'internal-board',firstObserved:'2026-11-01T00:00:00.000Z'}]};
}
