---
summary: Persist company follows, posting-language options and interface-language choices.
read_when: Connecting account settings or search options, reviewing private-state retention, or testing language and follow changes.
---

# Reading state and language preferences

The composed API stores follows and interface preferences under the authenticated account. Search options belong to each saved search. Viewed positions continue to use the existing [visitor and account workspace](visitor-search.md); there is no second viewed-history store. The implementation uses the application SQLite database, built-in Node APIs and the existing compiler and matching queue.

These backend contracts are implemented and tested with isolated SQLite and local HTTP. Browser journeys, real multilingual interpretation quality and the full deployed release gate still require qualification. No provider, mail, billing or crawler setup is activated by these routes.

## Follow companies

All routes below are relative to `/api/v1`. Authentication, Origin, CSRF, body and rate checks use the existing HTTP boundary. Ownership comes from the current session; bodies cannot supply an account ID.

| Route | Request and response |
| --- | --- |
| `GET /follows` | Current account's follow snapshot. |
| `PATCH /follows/:companyId` | `{followed:boolean,expectedRevision:number}` → updated follow snapshot. |

A snapshot is `{accountId,revision,items:[{companyId,followedAt}],invalidatedSearchIds:[]}`. IDs must resolve through the public company catalogue. A repeated request for the same state has one effect and retains the first timestamp for that follow interval. A stale revision cannot replace a different, newer choice. Unfollowing stores a private negative choice, so automatic request following cannot recreate it. Followed-only searches affected by an actual change increment their revisions; `invalidatedSearchIds` tells the client which saved searches to reload.

Accepting an exact company preview publishes or reuses its canonical public catalogue identity and follows it in the same SQLite transaction. The preview `candidate.id` remains the acceptance proof; `candidate.companyId` is the separate catalogue ID, null until discovery is accepted unless it already refers to a known company. The request DTO also exposes nullable `companyId`. Imported catalogue IDs remain unchanged. New accepted companies share an identity by validated official domain and expose `coverage.state:"requested"`; no jobs, collection history or working monitoring are invented. Replaying acceptance or requesting another scope preserves an explicit unfollow.

Published company identity and source evidence are public catalogue data without a requester identifier. Deleting the private request or account removes its private state and leaves the published company available to other users. Following alone does not request setup priority. Setup progression and priority integration remain owned by the company-request workflow.

## Select posting languages per search

| Route | Request and response |
| --- | --- |
| `GET /search-options` | `{postingLanguages:[{id,name}],emptySelection:"any",selectionOperator:"or",queryCombination:"intersection"}`. |
| `POST /searches` | Existing `{query,requestKey}` plus optional `options:{followedOnly,postingLanguages}` and `presentationLocale`. |
| `PATCH /searches/:id/options` | `{expectedRevision,followedOnly,postingLanguages}` → `200 {search}`. |

Every Search DTO includes `options:{followedOnly:false,postingLanguages:[]}` by default. Visitor equivalents are `GET /visitor/search-options` and `PATCH /visitor/searches/:id/options`; visitor creation accepts the same options. Visitors may select languages, while `followedOnly:true` requires an account. Sign-in transfers options with the existing saved search, alongside its workspace and viewed observations.

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

Search creation and text refinement may pass an allowlisted `presentationLocale`. It takes precedence for that request; otherwise the saved override or English fallback supplies the context. The browser should pass its resolved current locale when following browser preferences. Only generated titles and reason messages use that presentation language. Query text, exact requirement terms, canonical filter values and employer source content retain their original form. The interface does not translate or rewrite searches.

## Private retention and recovery

Follows, explicit unfollows, preferences and search options survive sign-out, new sessions and database reopen. The account's deletion hook removes all of them synchronously in the existing account transaction, including options owned by its searches. Rollback retains the state. Search deletion removes its options; account deletion does not affect another owner's data. Restore continues to require the existing private-generation checks and restored-session invalidation; a retained snapshot cannot bypass deletion policy.

Clients must bind pending requests to the captured account and search revision, ignore responses after account transitions, and reload affected searches after a follow change. The follow/preferences snapshots include the account ID for this fence. The server separately rechecks current persisted authority and revision before private writes, task commits and result delivery.

The adjacent `server/reading-preferences.test.mjs` suite owns these SQLite and local HTTP boundaries, including canonical-company publication, stale compare-and-set, large/unknown language sets, conflicts, filtering before classification, delayed work, active-search snapshots, deletion and reopen. `server/evals/reading-preferences-v1.json` records versioned multilingual qualification cases with quality, latency and cost explicitly unmeasured. Existing visitor, intent, matching, auth and recovery suites retain their respective contracts. The deterministic tests do not establish real Luna multilingual quality, browser accessibility or deployed readiness; those remain explicit release gates.
