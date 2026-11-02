---
summary: Persist company follows, posting-language options and interface-language choices.
read_when: Connecting account settings or search options, reviewing private-state retention, or testing language and follow changes.
---

# Reading state and language preferences

The composed API stores follows and interface preferences under the authenticated account. Search options belong to each saved search. Viewed positions continue to use the existing [visitor and account workspace](visitor-search.md); there is no second viewed-history store. The implementation uses the application SQLite database, built-in Node APIs and the existing compiler and matching queue.

These backend contracts are implemented and tested with isolated SQLite and local HTTP. The browser wires posting-language selection to these routes. Real multilingual interpretation quality and the full deployed release gate still require qualification. No provider, mail, billing or crawler setup is activated by these routes.

## Follow companies

All routes below are relative to `/api/v1`. Authentication, Origin, CSRF, body and rate checks use the existing HTTP boundary. Ownership comes from the current session; bodies cannot supply an account ID.

| Route | Request and response |
| --- | --- |
| `GET /follows` | Current account's follow snapshot. |
| `GET /account/companies?view=followed\|requested&q=…&limit=20&cursor=…` | Bounded canonical company rows for current follows or accepted requests; see the [catalogue contract](api.md#companies-and-identity-requests). |
| `PATCH /follows/:companyId` | `{followed:boolean,expectedRevision:number}` → updated follow snapshot. |

A snapshot is `{accountId,revision,items:[{companyId,followedAt}],invalidatedSearchIds:[]}`. IDs must resolve through the public company catalogue. A repeated request for the same state has one effect and retains the first timestamp for that follow interval. A stale revision cannot replace a different, newer choice. Unfollowing stores a private negative choice, so automatic request following cannot recreate it. Followed-only searches affected by an actual change increment their revisions; `invalidatedSearchIds` tells the client which saved searches to reload.

Accepting an exact company preview publishes or reuses its canonical public catalogue identity and follows it in the same SQLite transaction. The preview `candidate.id` remains the acceptance proof; `candidate.companyId` is the separate catalogue ID, null until discovery is accepted unless it already refers to a known company. The request DTO also exposes nullable `companyId`. Imported catalogue IDs remain unchanged. A confirmed known catalogue ID is reused directly. A newly researched company receives a separate requested ID and exposes `coverage.state:"requested"`; its official host or name cannot bind it to an imported company. Duplicate requested candidates reuse an occupied domain only when normalized name and exact website URL also agree; otherwise acceptance returns `409 preview_conflict` without merging entities. The current schema admits one requested identity per domain. No jobs, collection history or working monitoring are invented. Replaying acceptance or requesting another scope preserves an explicit unfollow.

Published company identity and source evidence are public catalogue data without a requester identifier. Deleting the private request or account removes its private state and leaves the published company available to other users. Following alone does not request setup priority. Setup progression and priority integration remain owned by the company-request workflow.

A reviewed import can include optional `companyIdentities:[{companyId,officialDomain}]` metadata, where `companyId` is the immutable source-system company ID. Hosts stay bound to that exact source ID and never establish a cross-ID alias. Requested and source identities remain separate, even on the same domain, until a separately reviewed identity link exists. Their follows, filters, setup priority and reports do not transfer automatically. Existing stored alias mappings stay stable; older cross-ID rows require explicit review before activation rather than a destructive automatic reassignment. Conflicting source-domain changes reject the import transaction. The public importer obtains optional host metadata through bounded exact-ID reads of Jobseek's explicit public `company.website` field; missing or failed lookups omit it. Stored source posting/company IDs and discovery timestamps remain unchanged. See [job data](job-data.md).

## Select posting languages per search

| Route | Request and response |
| --- | --- |
| `GET /search-options` | `{postingLanguages:[{id,name}],emptySelection:"any",selectionOperator:"or",queryCombination:"intersection"}`. |
| `POST /searches` | Existing `{query,requestKey}` plus optional `options:{followedOnly,postingLanguages}` and `presentationLocale`. |
| `PATCH /searches/:id/options` | `{expectedRevision,followedOnly,postingLanguages}` → `200 {search}`. |

Every Search DTO includes `options:{followedOnly:false,postingLanguages:[]}` by default. Visitor equivalents are `GET /visitor/search-options` and `PATCH /visitor/searches/:id/options`; visitor creation accepts the same options. Visitors may select languages, while `followedOnly:true` requires an account. Sign-in transfers options with the existing saved search, alongside its workspace and viewed observations.

The browser offers a compact posting-language button next to the search editor, opening a searchable list of native checkboxes with explicit Apply and Cancel actions. The catalogue's English names and exact identifiers remain searchable in every interface locale. No language count limit is added. Empty selection means any; previously saved identifiers absent from a newer catalogue remain removable. The selector only enables after a valid catalogue response and, for saved searches, a Search DTO containing options. Missing service routes or malformed responses keep it unavailable; the browser does not manufacture a catalogue or a capability flag.

Saved-search Apply preserves `followedOnly` and unsent query text, sends the captured search revision, and replaces only the acknowledged canonical search. It cancels local polling of an older interpretation; the server cancels incompatible queued work. A failed or lost mutation response triggers a canonical read and an explicit unconfirmed-change notice, without automatically retrying a write. Apply stays disabled until the reader explicitly reviews the last canonical saved choices or closes the dialog; review discards the staged selection and captures the shown revision before another explicit edit. Switching searches or accounts cannot apply a delayed response to a different search. The revised search drives the existing results and SSE revision boundary.

For a new search, Apply stages choices in the mounted page until explicit Search creation sends them through the API. Choices are saved only when that search is actually created. The current workspace API persists text drafts, not options on unsubmitted searches: reloading, signing in or changing owners clears those unsaved choices. The dialog states this limitation. Ordinary navigation retains the mounted new-search choice. Existing saved-search options transfer with the actual visitor search on sign-in. Interface-language detection, overrides and policy metadata remain separate.

Language IDs are validated BCP 47 identifiers from imported `locales` metadata. The options response gives the actual available identifiers and English display names. There is no selected-language count cap: the existing bounded JSON body and the finite validated catalogue bound the request. Previously selected identifiers can remain selected if they disappear from the latest import; new values must be present in the current catalogue. De-duplicate and sort selections for stable storage. Unsupported or malformed additions return 400.

An empty set accepts any posting language, including unknown evidence. A selected set uses OR: a posting with any selected ID qualifies. Unknown or absent posting language cannot satisfy a nonempty set. The option intersects the query's independently compiled requirements. For example, a text requirement for English and a selected set containing only French produce zero matches. Neither side is dropped or silently relaxed. Following scope also intersects text company requirements and exclusions. All these primary filters run before residual AI matching, including the hidden-match cohort, without changing source recency order.

An option change is a local transaction and spends no interpretation call. It increments the search revision, cancels incompatible pending interpretation and matching tasks, and invalidates proposals, scans and cursors. The accepted query and any unsent workspace text remain intact. A pending submitted draft stays available with `taskId:null,status:"interrupted"`; a later explicit text submission can retry it. Repeating an unchanged option value with the current revision has no effect. Stale revisions return 409. Late model replies or awaited result pages cannot commit or return the superseded search.

The model receives explicit options as independent server-applied context and must still account for every text requirement. A large selected set has a bounded context projection with its full count and hash; omitting examples from model context never removes a server constraint. Settings are separate from the query-derived `configuration` DTO. The same compiler filter operators and matching configuration fingerprint enforce their intersection.

The live-delivery integration uses `intent.snapshot({ownerId,viewer,activeSearchId,activeRevision})` for one active accepted search. It returns `{searches,generation,revisionKey,databaseKey}`, with at most 96 deliverable prefix items and full removal-only `reconciliation:{complete,retainedItemIds}` metadata across the bounded canonical scope. Complete means the retained-ID enumeration is authoritative, including older accepted evidence behind newer pending work; it does not mean AI is exhausted. Continuation state carries that separate fact. A partial or unavailable enumeration cannot withdraw unknown rows by absence. Snapshot reads mint no cursors, never mark viewed or advance ordinary scroll delivery, and do not refill existing scans just because a stream polls. Only an initial or changed canonical scan may enqueue through the existing scheduler. Current authority, active revision, generation and eligible evidence membership are checked after asynchronous waits. The final SQLite `data_version:total_changes()` stamp lets the transport reject a change between snapshot return and its public write. Inactive searches cause no scan or count work.

## Choose the interface language

| Route | Request and response |
| --- | --- |
| `GET /preferences?languages=de-CH,fr-CH,en` | Account preferences plus resolution against the ordered browser language list. The list is not stored. |
| `PATCH /preferences` | `{expectedRevision,interfaceLocale:null|supportedLocale}` → current preferences. |

The response is `{accountId,revision,interfaceLocale,supportedInterfaceLocales:["en","de","fr","it","es"],defaultInterfaceLocale:"en",resolvedInterfaceLocale}`. These five locales are the explicit first-release interface set. The backend can be constructed with a supported subset containing English if a deployment's actual frontend catalogue is narrower; it never advertises an unknown translation.

`interfaceLocale:null` uses browser preferences in their supplied order, matching regional tags to a supported base language and falling back to English. A saved explicit locale wins browser preferences. Unsupported saved choices are rejected; malformed browser language tags are rejected. Clearing an override returns to browser matching. Posting-language selections remain unchanged.

Search creation and text refinement may pass an allowlisted `presentationLocale`. It must match the resolved request locale: explicit `X-Justup-Locale`, then the account override or browser/default selection; guests can use their device cookie. The browser should pass its resolved current locale when following browser preferences. Only generated titles and reason messages use that presentation language. Query text, exact requirement terms, canonical filter values and employer source content retain their original form. The interface does not translate or rewrite searches.

## Private retention and recovery

Follows, explicit unfollows, preferences and search options survive sign-out, new sessions and database reopen. The account's deletion hook removes all of them synchronously in the existing account transaction, including options owned by its searches. Rollback retains the state. Search deletion removes its options; account deletion does not affect another owner's data. Restore continues to require the existing private-generation checks and restored-session invalidation; a retained snapshot cannot bypass deletion policy.

Clients must bind pending requests to the captured account and search revision, ignore responses after account transitions, and reload affected searches after a follow change. The follow/preferences snapshots include the account ID for this fence. The server separately rechecks current persisted authority and revision before private writes, task commits and result delivery. Preference and follow mutations, including a company acceptance's automatic follow, use the resolved request locale for those authority checks; approval of that locale grants no approval to another language.

The adjacent `server/reading-preferences.test.mjs` suite owns these SQLite and local HTTP boundaries, including canonical-company publication, stale compare-and-set, large/unknown language sets, conflicts, filtering before classification, delayed work, active-search snapshots, deletion and reopen. `server/evals/reading-preferences-v1.json` records versioned multilingual qualification cases with quality, latency and cost explicitly unmeasured. Existing visitor, intent, matching, auth and recovery suites retain their respective contracts. The deterministic tests do not establish real Luna multilingual quality, browser accessibility or deployed readiness; those remain explicit release gates.
