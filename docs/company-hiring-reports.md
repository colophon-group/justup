---
summary: Read attributable public company hiring activity, sampled roles and reported salaries without inventing coverage.
read_when: Integrating company reports, reviewing source gaps or verifying the public reporting boundary.
---

# Company hiring reports

`GET /api/v1/companies/:id/report` is a public, keyless, read-only projection.
It requires an existing public catalogue identity and returns its canonical
`companyId`. Unknown identities return 404. The route accepts no query parameters;
private scope selectors return `400 invalid_query`. It creates no visitor session,
task or source read. The standard API no-store/noindex headers still apply.

The report has `companyId`, `asOf`, `provenance`, `scope`, `freshness`,
`monitoringSince`, `sourceChecks`, `hiringHistory`, `hiringRoles`, `reportedSalaries` and
`methodology`. `asOf` is when the report was computed. Listing verification,
historical observation, source generation and publication have their own explicit
timestamps; none are replaced with the request time.

`provenance.importVerifiedAt` and `importGeneration` identify the imported
snapshot. `sampleObservedFrom`/`sampleObservedThrough` are the actual minimum and
maximum per-record verification times among eligible sample rows (null for an
empty sample); the final export time cannot refresh older record evidence.

## Read current structured samples

`scope.kind` is `eligible_public_listing_sample`. Its `firstObservedFrom` and
`firstObservedThrough` describe the rolling 14-day to 48-hour source discovery
window. This is the same fresh, active, unreserved public eligibility boundary
used by the guest feed. It is independent of cookies, paid access, follows,
private requests and saved search criteria. `completeCompanyCoverage:false`
always applies: the bounded import is a sample, not the company's overall
positions total. Missing or stale import evidence produces unavailable sample
sections, not a zero-hiring claim.

`hiringRoles` contains `state`, `sampleSize`, `labelledSampleSize`,
`unknownSampleSize` and `items:[{id,name,count}]`. The labels are Jobseek's
structured leaf occupation ID/name, not a classifier run by this report or a
guess from titles. Older imports without occupation labels remain unlabelled.

`reportedSalaries` contains `state`, `sampleSize`, `reportedSampleSize`,
`groupedSampleSize`, `incompleteSampleSize`, `unknownSampleSize` and
`groups:[{currency,period,sampleSize,min,max}]`. A group retains the lowest reported
lower bound and highest reported upper bound within that exact currency/period;
either bound can be null. If these aggregate endpoints cross, both are null:
the group's numeric bounds are unavailable, while its currency, period and
sample count remain attributable. For example, separate USD/year statements
`{min:100,max:null}` and `{min:null,max:50}` produce a group with `sampleSize:2`
and `min:null,max:null`, never a reversed or swapped band or zero pay.

`reportedSampleSize` counts listings with at least one numeric endpoint.
`groupedSampleSize` counts those with currency, period and individually ordered
or one-sided bounds, including observations in a group whose aggregate bounds
are unavailable. Missing currency/period and individually reversed ranges are
omitted from groups and counted in `incompleteSampleSize` (reported minus
grouped). `unknownSampleSize` counts listings with no numeric salary endpoint
(sample minus reported). Values are not converted, annualized, averaged or
presented as employee pay. A salary or role that belongs only to a withheld
recent listing never enters these samples.

The browser and public HTML share one validated report read for source links and
structured samples. Fresh, nonempty role and salary sections show the public
listing sample size and its first-observed window, never an overall openings
total. Role counts use the whole sample as their denominator and retain
unlabelled counts. Salary groups keep their exact currency, pay period and group
sample size; reported, unreported and incomplete counts stay explicit. Ordered
and one-sided bounds are displayed without conversion. Unknown aggregate bounds
retain their unit and sample count with no invented numeric range. Stale, empty
or unsupported numerical sections are omitted while company identity and
independent approved career-page links remain usable. Historical activity and
monitoring-start presentation remain separate report work.

## Read attributable historical activity

`server/company-reports.mjs` reads the latest **published** frozen
`hiring_wire_editions` snapshot from the existing SQLite store. It accepts explicit
`jobseek-coverage-v1` and `jobseek-coverage-v2`, verifies the canonical stored hash, the edition period,
publication ordering and the shared fact compiler's schema. Source generation
must precede publication and publication must not be in the future. Revalidation
uses the frozen generation time: a valid historical edition does not disappear
merely because its ingestion was more than 24 hours ago. The API receives no
source directory, provider configuration, broker or queue constructor.

`provenance.history` is null when evidence is missing, malformed, unsupported,
unpublished, future, mismatched or tampered. Otherwise it contains
`{source,sourceVersion,snapshotId,asOf,generatedAt,publishedAt,sha256}`.
`freshness.history` is fresh before the next seven-day boundary and stale
afterward; an old attributable period remains explicitly historical. No failed
source refresh can replace it with a fabricated newer observation.

`monitoringSince` is null without source coverage evidence. When supplied, it is
the earliest `trackedSince` among the current recorded scopes for that canonical
company. It does not mean all company career pages were tracked from that date,
or that coverage was continuous. It is never derived from a current listing,
account request, import timestamp or catalogue publication.

`sourceChecks` is `{state,items:[{publicLink,trackedSince,lastVerifiedAt}]}` from
those same frozen scopes. The [v2 source contract](source-coverage.md) supplies
`publicLink:null|{url,status:"approved",provenance,approvedAt}`; v1 scopes retain
null links. State describes link evidence only: `available` for all linked scopes,
`partial` for some, `unavailable` for none or no history. It makes no live-health or
coverage-completeness claim. Missing verification remains null, unsafe metadata
closes historical evidence, and no scope identity/revision is public.

`hiringHistory` has `{state,scopeCount,points}`. Without usable historical evidence
it is `{state:"unavailable",scopeCount:0,points:[]}`. A recorded snapshot covers
the two half-open UTC weeks ending at its actual `asOf`; it does not establish
any older history. Every point is:

```text
{start,end,state,newListings,observedListings,completeScopeCount,scopeCount,reasons}
```

`newListings` is a distinct source listing count only when every recorded scope
was tracked before that week's start, verified through its end, and continuously
complete during the week. Then `state:"complete"` can truthfully include zero.
Otherwise `newListings:null` and the point is partial or unknown.
`observedListings` retains the distinct observations actually in the source
snapshot, with no assertion that the incomplete period contained only those
observations. `reasons` uses `new_scope`, `unverified_scope`, `stale_scope`,
`missing_history` and `interrupted_scope`. Duplicate observations on overlapping
career pages count once. Closing a current listing cannot rewrite historical
discovery activity. These measures describe listing activity, not hires or
headcount. No raw source scope IDs/revisions or posting IDs/bodies are public.

## Display approved career pages

Public company HTML and client navigation read the report’s `sourceChecks` through a bounded, validated projection. Only approved public HTTPS career links appear. Each link retains its supplied last-check date; an absent date produces no invented check status. A missing report leaves company identity readable, and a failed browser report read offers a separate retry. Legacy identity-source URLs never substitute for approved report links.

The browser integration currently consumes this source-link projection only. Report history, sampled roles and salary units still need the complete report presentation and deployed source qualification described below.

## Verify source identity and release readiness

The existing public importer reads Jobseek's `company` collection in at most
four exact-ID batches of 250 distinct companies already in the selected jobs.
It requests only `id,website` using the same approved public Typesense host and
transient scoped search key. The source repository defines `company.website`
explicitly in `apps/crawler/src/typesense_schema.py`; the public company-detail
reader uses the same field. Successful lookups emit only
`companyIdentities:[{companyId,officialDomain}]`, using the validated HTTPS website
hostname. No name, applicant-tracking-system URL, parent-domain guess or `www`
rewrite supplies identity proof. A shared host never merges distinct source IDs
or binds an imported company to an accepted request. Until a separately reviewed
identity link exists, requested and imported companies can remain separate on
the same domain; their reports, follows and priority stay separate too. Missing,
invalid, duplicate or failed lookups omit host metadata. A changed host for an
already recorded source ID rejects the import. No new credential, network host,
source write or crawler setup is involved. Raw source posting IDs/company IDs
remain unchanged. Existing stored aliases are preserved, so older cross-ID rows
must be reviewed before activation; these imports neither approve nor repair
them.

Before activation against any existing application database, inspect
`justup_company_aliases` rows where `source_company_id <> company_id`. Those
stored links need an explicit identity review; a matching `official_domain`
does not establish that review. This fix preserves their state and does not
silently remap existing public URLs or private follows.

`server/company-reports.test.mjs` owns real SQLite/publication/import/HTTP
contracts with synthetic source facts and fake editorial transport. It also
executes the actual offline Python importer against a fake public source and
imports that result through the real store. The Python importer suite owns
allowlisted occupation/domain evidence, deduplicated batches and missing or
failed lookup behavior. Run the pinned Node 24 server suite and Python suite.

These deterministic checks do not qualify a real historical export, establish
complete source history or prove a deployed report. The source producer and
published snapshot must be verified through the approved read-only transfer
path, then representative company reports and their unknown/partial states must
be checked in the retained deployed browser before release. No host, native
model, provider, scheduler or user activation is performed by this work.
