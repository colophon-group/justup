# Product design: Justup — fresh jobs, one search workspace

Status: first draft for discussion

Date: 30 October 2026

Brand: **Justup**. Intended domain: `justup.work`. The repository retains its working name `fresh-jobs-ui`.

## 1. Product intent

Help people find relevant opportunities recently discovered by the backend on company career pages and get to the original application quickly.

The current service has no conversions. That establishes the need to revisit the offer, but does not establish which parts of acquisition, relevance, trust, or payment are failing. This design defines a new experience and the evidence needed to assess it.

The starting asset is the job collection. The new service has a new brand, repository, interface, and product contract. Existing page structure, technology choices, account flows, and ranking behavior impose no requirements on it.

The central promise is: **Fresh jobs. No paid placement.** Listings come directly from company career pages, matching results stay newest first, and users can inspect exactly which companies and career pages are monitored. Describe the work you want to narrow that collection.

**Transparency is a core brand value.** Justup makes its actual company coverage visible and lets users request companies they need. We do not claim to cover the entire job market. A user should be able to tell whether a company is monitored, which career pages or regions are covered, whether collection is working, and what is happening with their request.

The brand promise includes: **See what we cover. Ask for what you need.** Explain limits in ordinary language: publication time means first observed by our backend, missing information remains unknown, and catalogue presence is distinct from working job monitoring. A requested company appears in the catalogue as soon as the requester accepts its discovered identity; monitoring follows a separate crawler-configuration step. Premium users receive priority handling for company requests; this benefit is stated openly.

The initial audience hypothesis is people actively searching now, who return frequently enough to value new results. The first occupation and geography to target remain open; launch scope should follow the collection's actual fresh coverage.

## 2. Requirements and proposals

The following are the product requirements from the brief:

- Listings come directly from employers’ own career pages. Exclude recruitment agency listings and reposts sourced from job aggregators or social media.
- Publication time is when the backend first observed the posting.
- Listings older than two weeks disappear from the website, while remaining in the backend.
- One search workspace contains tabs for separate searches.
- One search bar is the input for creating and refining searches; there is no filter editor.
- The search bar retains the user's search text. Users edit that text and resubmit it to change the search.
- The model generates the active-criteria description and search tab title.
- Results are always ordered by recency, newest first. Employers cannot buy promoted placement or sponsored listings.
- Live results use Server-Sent Events (SSE) to deliver newly available matching postings while the workspace is open.
- On submission, an inexpensive model translates the request into filters using user metadata as context.
- The existing JEV narrowing capability is retained in the backend. The interpretation model can configure it when structured filters cannot fully express the user's requirements.
- Later submissions use the current configuration, previous search text, and edited search text to generate a configuration diff.
- Anonymous access is limited, with the latest results hidden.
- New users receive one free week, followed by a small recurring fee. $3/week and $10/month are pricing hypotheses for a later financial model.
- Existing Jobseek users receive their first month free.
- Results show extracted structured values, without full posting text. Summaries may come later if their cost is justified.
- Result cards do not expand. Users open the original company posting for further details.
- Opening a position's company posting marks that position as viewed for the user. Viewed state persists across searches, tabs, and sessions.
- Users can follow companies and limit each search tab to followed companies.
- A compact company catalogue shows discovered companies and their monitoring status, including those whose crawler setup is still pending.
- Users can request a new company and track its progress. Premium users receive priority on their company requests.
- Company setup has two steps: discover the company with brand assets, description, and other metadata, then configure its crawler. The backend runs discovery through a Codex-powered Luna agent at low reasoning, returning the found company for the user to accept or reject. On acceptance, publish the catalogue entry promptly without waiting for crawler configuration.
- Company lookup surfaces matching companies already being configured before offering new discovery. Users can request higher priority for an existing setup task.
- Coverage, request status, and known collection limitations are communicated transparently.

Everything below that resolves an unspecified detail is a proposal, not a settled requirement. The final section gathers decisions to review before implementation.

## 3. The main experience

The main screen is the search workspace. A new visitor can search immediately. A short explanation of freshness, direct employer sources, and free access sits alongside that experience; a long onboarding sequence is unnecessary.

The screen has four main elements:

1. A tab strip for searches and an action to create a new search.
2. One natural-language search field in the active tab, holding the user's current search text.
3. A compact, readable description of the active criteria, generated by the model, with an “Only followed companies” toggle.
4. A list of compact job results, always ordered by recency, newest first.

Account and billing controls remain secondary. The account icon opens Settings as an overlay, preserving the underlying route and reading position. Keep the large Justup masthead but omit a secondary JUSTUP.WORK header link. Settings includes account identity, sign-in/logout, access status, language and reduced-motion preferences. In the prototype, a clearly labelled temporary account selector switches among signed-out, free-week, Plus, expired and legacy welcome-month profiles. Each profile has its own searches, follows, requests and viewed positions. A small “Companies” entry opens the company browser and request workflow. The model translates job-search intent; the results list remains the center of the experience.

Tell users next to the field: “Be as specific as you need. Every nuance shapes your search.” Unsupported requirements must still be identified honestly; this copy is not permission to pretend unavailable criteria were applied.

Use the same search-field component for position search, company search and company discovery: cream background, square black border, consistent typography and insets, a coral submit button inside the field, and the shared focus shadow. Single-line company inputs and the multiline job query keep their appropriate input behavior. Labels and action wording reflect the task. Company search filters as the user types and also supports Enter or the Search button. Use the same hover and keyboard-focus feedback across all three surfaces.

### First search

A first visit opens a compact editorial landing page with the same working search field used afterward. Pair “Fresh jobs. No paid placement.” with the search form, then explain four product principles: no sponsored listings, the last 14 days, inspectable company coverage, and excluding recruitment agencies and aggregator/social-media reposts. Link the coverage explanation directly to the company catalogue. Plain-language search is demonstrated by the field and editable examples. The feature overview is headed “The Justup Way” and “Beat the endless scroll.” Keep the Extra Orange masthead, motto and Live edition indicator. On mobile, stack the introduction and form, followed by the feature overview. Do not create starter tabs or load a broad default job feed. Show three concrete role-and-location examples that prefill the field for editing; selecting an example does not submit it. The search remains the primary action; feature explanations do not start a feed or add extra onboarding steps. Preserve an unsubmitted first-search draft across navigation and reloads.

Submission creates the first tab, its generated title and criteria description, and matching results. Until a search is submitted, do not fetch result continuations or display live arrivals. Returning users restore their last active search. A broad all-jobs search remains available through an explicit user request.

A visitor enters: “Senior backend roles in Zurich, or remote from Switzerland. Go preferred.”

On Enter:

1. Keep the submitted text in the search bar and show a brief interpretation state. The field is not cleared or replaced with generated text.
2. Translate it into a validated search configuration, including optional backend JEV narrowing when structured filters are insufficient.
3. Display the model-generated criteria description: senior backend; Zurich **or** remote eligible from Switzerland; Go preferred. Generate a concise search tab title, such as “Senior backend · Switzerland,” in the same response.
4. Fetch matching results and show the appropriate access state.

The description should explain what the system searched for. “Preferred” records a nonbinding preference; it does not exclude roles missing Go or change their order. The description must make that distinction clear. The user can refine the search to require Go. “Remote from Switzerland” must retain geographic eligibility, not become worldwide remote.

Result order is fixed: newest eligible listing first, ordered by publication time—the backend's first observation of the posting. This is the same timestamp used for the freshness rule. Relevance, preferences, personalization, and model output cannot override recency. There is no alternative sort mode.

The interpretation must support alternatives such as “Zurich on-site OR Switzerland-eligible remote.” A flat set of unrelated fields must not accidentally turn this into “Zurich AND remote.”

#### Landing positioning and search discoverability

Lead with concrete product policies rather than a generic convenience or AI claim. The visible promise is fresh jobs without paid placement. Explain that freshness means when Justup first found the role, with removal after 14 days; it does not change the employer’s original publication date. Let visitors verify coverage through the catalogue, company check information and tracked career pages. Requesting a company and premium setup priority never buy job-result rank.

Use these topic phrases naturally in useful copy: fresh jobs, company career pages, no sponsored listings, newest-first job search, and monitored companies. These are language and intent candidates, without measured search-volume claims. Keep role/location examples concrete rather than adding keyword lists. The proposed landing title is “Justup — Fresh Jobs, No Sponsored Listings”; its description summarizes direct sources, visible coverage and newest-first order.

Google recommends [descriptive, concise titles](https://developers.google.com/search/docs/appearance/title-link), [relevant page descriptions](https://developers.google.com/search/docs/appearance/snippet), and [helpful content for people](https://developers.google.com/search/docs/fundamentals/creating-helpful-content). Before production, give the public landing page and catalogue stable, crawlable URLs and render their public content independently of saved search state. The current private, hash-routed mockup validates copy and interaction rather than production indexing. See [Google’s JavaScript guidance](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics).

The paid-placement distinction is supported by competitors’ own descriptions: [LinkedIn says promoted jobs may appear higher](https://www.linkedin.com/help/linkedin/answer/a512429/promoted-jobs-in-your-job-search-results), and [Indeed describes prominent placement for Sponsored Jobs](https://www.indeed.com/hire/resources/howtohub/faq?co=US). The landing page states Justup’s policies directly, without broad claims about competitors’ job quality or completeness.

### Refinement

The search bar still contains “Senior backend roles in Zurich, or remote from Switzerland. Go preferred.” The user edits it to “Senior permanent backend roles in Zurich, or remote from Switzerland. Go preferred. Exclude agencies.” and presses Enter.

The system sends the active configuration, relevant user context, previous submitted search text, and edited search text to the model. It applies a validated diff that adds the two constraints while preserving location, role, seniority, and Go preference. The edited text describes the complete desired search; it is not a separate command appended to a conversation.

Show a short change receipt, such as “Added permanent employment · Excluded agencies,” with Undo. The model returns an updated criteria description and search title alongside the diff. Update them with the accepted configuration so they describe the same search revision. Keep the user's edited search text in the field; the generated description and title are separate display text.

Editing the field does not change the applied search until submission. Each submission creates or updates the search in the active tab. Removing a requirement from the text removes its corresponding constraint; the current configuration is context for computing the diff, not a reason to retain deleted requirements. Unrelated searches can start in a new tab.

### Search tabs

Each tab owns its user-authored search text, any unsubmitted text edits, model-generated title and criteria description, criteria, result position, and undo history. Users can create, duplicate, reorder, and close tabs. Switching tabs restores that tab's field text and results without invoking the model again. Paging also requires no interpretation call. Undo restores the submitted search text, configuration, description, and title together.

Every tab can be deleted, including the last one, after confirmation. Deleting the last search returns to the mini landing page, clears the old results and continuation state, and focuses the field. Persist the empty search list so reload does not recreate starter searches. Keep followed companies, viewed positions and company requests. Cancel or Escape leaves the search and its unsent draft intact.

Tabs persist across reloads locally for visitors and across sessions for accounts. Preserve a visitor's search when they sign in. No search should overwrite another tab's state.

On smaller screens, use a scrollable tab strip or a compact tab switcher while preserving the same interaction. A proposed initial limit on stored tabs may be introduced for usability and cost, but the number is undecided.

### Live results over SSE

While the workspace is open, deliver matching postings through a persistent SSE connection as soon as they are ready for that user. The flow is: backend discovers a posting → required extraction completes → structured filters match → JEV accepts it if narrowing is configured → access rules permit it → browser receives the update. This reduces delivery delay after processing; it does not make the crawler discover postings immediately after companies publish them.

Use one connection per open workspace to carry updates for its search tabs, rather than one connection per search. New postings use the stored search configuration without another interpretation request. Events belong to a particular search revision; updates for a previous revision cannot enter the newly edited search.

Keep cards ordered by first-observed publication time, even if JEV decisions arrive out of order. Insert new results automatically. When the user is further down, add them above the viewport, preserve the currently read row's position, and show a small “N new ↑” navigation cue. This cue takes the user to results already inserted; it does not gate their insertion. Preserve focus, selection, and existing row nodes. Do not auto-scroll or show an idle “Up to date” label. New postings begin unviewed; receiving an update does not mark them as viewed. See the proposed [motion language](motion-design.md) for persistent New markers and arrival behavior.

Scrolling into older matches is a continuous job-by-job stream. Background pages refill a small ordered matching buffer; they are not shown as UI pages. Each job's reveal deliberately paces consumption, including when the next match is already ready. The current proposed cycle is 450 ms, with the motion treatment still under review. When the buffer is empty and candidates or JEV decisions remain, show “Looking for more matches…”; an empty filtered page does not establish that the search has ended. Show “No more matches in the last 14 days” only after all remaining evaluations and buffered reveals have completed, then prompt for company requests. See the [infinite-scroll specification](motion-design.md#infinite-scroll-the-reveal-is-the-pacing-mechanism).

The connection must enforce the same account access rules as ordinary result retrieval. It cannot reveal latest postings to visitors who are not entitled to see them. When a posting becomes eligible for a visitor's preview after the latest-results cutoff, it can then appear. Expired or closed postings must disappear, and changes to access must take effect during the connection.

On disconnection, show that live updates are interrupted and reconnect. Resume missed events or refresh the authoritative result state, deduplicate by posting identity, and reconcile closures and expirations. Streaming is a delivery mechanism; it does not replace durable search and viewed-position state. Updates while the website is closed would require a separate notification feature.

**Server-Sent Events (SSE) is the selected transport** for live result delivery. Search edits and viewed actions use ordinary requests. The [HTML standard](https://html.spec.whatwg.org/dev/server-sent-events.html) defines EventSource streams, automatic reconnection, and last-event identifiers. Choose hosting that supports persistent SSE connections, and validate reconnect recovery, delivery latency, and connection costs before launch.

## 4. Filters and user context

### Generated description and title

The model generates a concise description of the active criteria and a short title for the search tab. The description communicates requirements, exclusions, alternatives, and nonbinding preferences; the title helps distinguish searches. Both must reflect the validated configuration without adding claims or criteria.

Users correct or change criteria by editing the search text already in the bar and submitting it again. For example, changing “Backend roles in Zurich paying at least CHF 140,000” to “Backend roles in Zurich” generates a diff removing the salary constraint, followed by an updated description and title. A removed constraint must not silently return from the previous configuration or profile defaults on the next refinement. The structured filter fields remain internal; there is no expandable editor or manual filter panel.

Candidate criteria include role, seniority, location, remote eligibility, employment type, compensation, skills, language, and company inclusion or exclusion. Each criterion should distinguish a requirement from a preference where relevant. Supported filters depend on trustworthy extracted data; the UI must not offer capabilities that the data cannot support.

### Backend JEV narrowing

Retain the existing JEV filter as an additional backend narrowing stage. The inexpensive interpretation model configures the structured filters first and can add a JEV request for requirements those filters cannot adequately express. For example, “backend roles working on software for industrial robots” may use role and location filters to select candidates, then JEV to evaluate the requested work context against posting evidence.

JEV decides which candidates satisfy the additional request. It can only narrow the eligible candidate set; it cannot relax structured requirements, bypass freshness or access restrictions, or change the newest-first order. This is part of the same search experience, without a separate JEV control or filter editor. The generated criteria description explains the additional requirement in ordinary language.

The search configuration includes the optional JEV request. Edits to the user's search text can add, change, or remove it while preserving unaffected structured filters. Each submission receives the complete current configuration, including JEV criteria, and the previous and edited search text. Removing a requirement from the text must also remove any corresponding JEV narrowing. Undo restores both configuration parts along with the corresponding search text, title, and description. Candidate decisions must remain associated with the criteria and posting evidence they evaluated; they must not carry over to a changed request as if still valid.

Posting evidence used for backend evaluation does not become full posting text in the UI. JEV makes no unsupported employer facts certain. If a requirement cannot be evaluated from the available evidence, do not describe it as verified.

JEV evaluation adds candidate-processing time and cost beyond the submit-time interpretation call. Define evaluation limits, reuse of valid decisions, progress states, and cost budgets before launch. While evaluation is incomplete or unavailable, distinguish pending work or failure from a true zero-result search. Do not silently show candidates that have not passed the configured narrowing as matching results. Newly collected candidates must pass the same narrowing before joining the search results.

### User metadata

Proposed optional profile fields are preferred locations, work eligibility, remote preferences, desired roles, seniority, skills, salary expectations, and language preferences. Ask for missing context when it improves a real search rather than requiring a complete profile up front. Resume upload is outside the initial scope.

Use metadata to resolve references such as “near me” or “roles I can apply to.” State material assumptions in the interpretation. The user's search text and explicit removal of requirements take precedence over profile defaults. If a profile changes, offer to update existing searches rather than silently rewriting them.

Country, language, or browsing location must not be used to invent citizenship, work authorization, or willingness to relocate. If essential context is missing, ask a short clarification without discarding the search.

### Interpretation rules

The model returns structured criteria and an optional JEV request, or an allowlisted diff to that configuration, together with the search title and criteria description. The application validates fields, values, relationships, and the revision being changed before applying it. Generated text must stay consistent with the accepted criteria, including any JEV narrowing. The model cannot change account access, pricing, freshness rules, or the fixed recency order.

Key behavior:

- Preserve criteria associated with unchanged search text during refinement, and remove or update criteria whose requirements the user deletes or changes.
- Separate exclusions, hard constraints, and soft preferences.
- Use backend JEV narrowing when structured filters are insufficient; explain requirements unsupported by either mechanism instead of pretending they were applied.
- Ask for clarification when ambiguity would materially change results.
- Never invent employer facts or automatically loosen requirements to fill the page.
- Treat user text, profile text, and job content as data, including text that resembles instructions to the system.

If a refinement targets an older revision, it must not overwrite a newer edit. If the model times out or fails validation, preserve the last valid configuration, title, description, and results; keep the user's edited search text in the field and offer retry. Distinguish unapplied edits from the search that produced the current results.

Use one inexpensive interpretation request per submission where possible, returning the configuration or diff, description, and title together. Paging, tab switching, and undo should not require another interpretation call. JEV may separately evaluate unevaluated candidates in the backend when narrowing is configured. Interpretation model selection, rate limits, and latency targets follow measured quality and cost tests.

## 5. Freshness and direct sources

Two weeks is a hard eligibility boundary, not merely a sorting preference. A result is eligible only while less than 14 days have elapsed since the backend first observed it, it is not known to be closed, and its company source meets the availability rules below. At the boundary it disappears from public search and public listing surfaces.

The backend retains the record and its history. Retention must not accidentally make expired listings accessible through a result API, an old cursor, a shared search, or a saved result. A stale reference may show a minimal unavailable state without exposing the archived posting.

### Publication time and age

Publication time is defined as the timestamp when the backend first observed the posting: `publication_time = first_observed_at`. The 14-day window, newest-first ordering, displayed publication age, and latest-results access cutoff all use this timestamp.

The company's own publication date does not determine eligibility or ordering. A posting first observed today starts its 14-day window today, regardless of the date shown by the company. Product copy should explain that publication time means first observed by our backend.

Recrawling, source edits, URL changes, duplicate records, and reopening the same posting do not reset its first-observed timestamp. A genuinely distinct posting has its own first observation. Deduplication must preserve the earliest backend observation for the same posting.

Imported records retain when the collection backend originally first observed them. Moving a record into the new product does not restart the clock. If that timestamp is unavailable, resolve it from observation history before publishing the record; do not substitute the import time or company publication date.

### Company provenance and availability

Every result links to the original company posting or an applicant-tracking system linked from the company's careers site. Display the company, source link, publication age based on first observation, and a source-check timestamp. Aggregator copies do not qualify as direct sources.

Deduplicate the same opportunity across URLs and locations when appropriate. Merge duplicates without resetting age, and preserve distinct roles when the source identifies them separately.

Remove a listing as soon as the source is known to be closed, even within the 14-day window. A failed check is not proof of closure. Define a maximum verification age; when a source cannot be verified within it, temporarily withhold affected results. The threshold and source coverage are launch decisions.

Say when a listing was checked. Do not promise that an external vacancy is guaranteed to remain open at the instant someone applies.

### Company browser and visible coverage

Provide a small, searchable catalogue of discovered companies. Omit company locations from profiles, catalogue rows and discovery confirmations: this metadata is unavailable. Job locations remain visible, and globe highlights describe hiring locations rather than company headquarters. Show company name, brand assets, a concise description, website, and relevant available metadata. Keep coverage visible alongside that identity: monitored career-page links and regions, monitoring status, last successful check when available, without position totals. JEV may still be evaluating candidates, so a total would imply knowledge we do not have. Publish a requested company as soon as the requester accepts the discovery result; crawler setup must not hold up that publication. A company remains in the catalogue when it has no fresh positions; the catalogue does not expose archived postings.

Use clear statuses such as “Monitoring setup pending,” “Setting up monitoring,” “Monitoring,” and “Collection interrupted.” When only some regions or career pages are covered, show that scope. Until collection has been verified, show that positions are not available yet rather than claiming zero vacancies. A successful check with no fresh positions is different from an interrupted collection or a company we do not yet monitor. The catalogue overview shows the actively monitored count, without totals for companies being added or needing attention. Report catalogued and actively monitored company counts separately; pending requests without discovered identities do not inflate either count.

Users can open a company's eligible positions in the existing search workspace. Listing freshness, access limits, newest-first ordering, and viewed state remain unchanged. The browser is a compact coverage reference, without a separate full employer-profile experience.

Company search and job-search empty states should provide a “Request a company” action when coverage is missing. A search yielding no matches must not imply the company has no vacancies when we do not monitor it or collection is interrupted. The directory and coverage status are public, including for visitors whose latest job results are hidden.

### Followed companies

Users can follow or unfollow any company from catalogue search results and company profiles. Keep this action independent of opening the whole row. Show a compact Follow / Following control with a plus or check mark, using the same component wherever a company appears. In company rows, place Follow beside the profile arrow in a dedicated action area on the right. Omit website subtitles from catalogue and request rows; career-page addresses remain available in company profiles. The catalogue has exactly three filters: All companies, Followed and Requested. Keep coverage status on individual rows, without separate Monitoring, Being added or Needs attention filters. Requested replaces the standalone Requests navigation tab and uses the shared company rows to show request date, priority and setup status. Combine it with the company search text, update the list immediately on unfollow, and offer a route back to all companies when the followed view is empty.

Each search tab has an “Only followed companies” toggle beneath its query and generated description. It intersects the followed-company set with that tab’s search criteria, freshness window and access rules. It never changes recency ordering. Save this scope per search; following a company is shared across the user’s searches. Editing the query preserves the toggle, and toggling preserves any unsent query draft. Subsequent results and live arrivals obey the same company scope.

When no companies are followed, show a link to browse the catalogue. When followed companies yield no matching positions, explain that the user can change the query or turn off the limit. Companies still being added can be followed before jobs become available. Submitting a new company request automatically follows that company. The user can unfollow it while its request remains visible under Requested. Reloading or revisiting an existing request must preserve an explicit unfollow choice. A manual follow does not itself request setup priority.

Persist follows with the account in the service. The interactive prototype saves them locally in the browser alongside searches and viewed positions.

### Request a company

Use “WANTED” as the company-request headline, with restrained editorial language such as “Send us a lead,” “Help grow the edition,” and “Every edition needs its sources.” Keep action and status labels explicit. The user searches by company name or website, with an optional careers-page link and any requested region or subsidiary. First show matching catalogue entries, including companies whose crawler configuration is pending or in progress. These are real company search results with an explicit setup status, not missing companies or placeholder job listings. If monitoring already covers the requested scope, link to its positions. If setup is pending or in progress, offer “Request higher priority” on the existing entry. If the request concerns a missing region or career page of an existing company, reuse its discovered identity and keep the additional scope explicit.

When the intended company is not found, send a discovery request to the backend. Return a candidate showing its name, brand assets, description, and available supporting metadata. The confirmation surface omits the website URL and duplicate top/bottom rules; the main page divider provides structure. Do not fill unknown fields with repeated “not confirmed” placeholders. Actual tracked career-page links remain on company profiles. The user chooses “Accept company” or “Not this company.” Acceptance confirms the intended identity, publishes or reuses its catalogue entry, and queues crawler configuration. Rejection keeps the original request available for correction and another discovery attempt; it does not queue configuration for that candidate or remove a company already accepted by another user.

Proposed account behavior: anyone can browse coverage and prepare a request; sign-in is required to submit and track it, preserving the entered details through sign-in. Both free and premium accounts can submit requests. Show confirmation and a persistent request status after submission under Companies → Requested. Link the request confirmation directly to that filtered catalogue view.

The workflow has two independently completed steps:

| Step | Work | Completion and visible result |
| --- | --- | --- |
| 1. Company discovery | The backend runs a Codex-powered Luna agent at low reasoning to resolve identity and official website and gather brand assets, a factual description, and other supported metadata. Return the candidate promptly for user acceptance or rejection. | After acceptance, persist or reuse the company record and publish it in the catalogue immediately, with “Monitoring setup pending.” |
| 2. Crawler configuration | Use that company record to identify the requested career-page scope, configure collection, and verify that it works. | Mark the verified scope as “Monitoring”; eligible collected positions can enter search. |

Step 1 is an interactive backend request optimized for a fast response, independent of the slower crawler-configuration queue. Use Codex subscription execution with the selected Luna agent at low reasoning. The browser calls our backend, which owns agent execution and returns the candidate; model/runtime configuration stays in the backend. No crawler setup is required to return the discovery result. Missing optional assets or metadata can be filled in later with appropriate placeholders; they must not delay confirmation of a valid company identity. Unknown values remain unknown.

Acceptance must be tied to the exact candidate shown to the user. If another request has already created that company, reuse the existing record and setup task. The accepted catalogue record and discovery work are durable even if step 2 is queued, blocked, or fails. Retrying crawler configuration reuses the company record instead of restarting discovery or creating another entry.

The requester sees: discovering company → confirm found company → listed in catalogue / monitoring setup pending → setting up monitoring → monitoring. Rejection returns to company lookup with the user's text preserved. Show the catalogue link immediately after acceptance. If either step needs more information or is blocked, show which step, the reason, and any available next action. Catalogue publication is the first completion milestone; the full request is complete once the requested scope is successfully monitored. That does not require the company to have a fresh vacancy at that moment. Once monitoring is active, normal collection and matching rules apply, including live SSE delivery.

**Premium users receive priority handling for their company requests in both steps.** Show the priority on the request and describe it in the subscription offer. Keep discovery quick for all users while prioritizing premium work within each step's queue. Priority affects processing order; it does not mean guaranteed immediate completion. Publish a turnaround estimate only when operational evidence supports it. Free requests remain accepted and visible in the queue.

Duplicate requests share the same company record and setup work while each requester can follow progress. When a premium user requests a company already in the queue, give its pending setup work premium priority. The catalogue entry is public after acceptance of the discovered company, and working monitoring later joins the service's common coverage; ordinary job-access rules apply to every user. Priority never changes job-result ordering or freshness.

“Request higher priority” attaches the user to the existing setup request and records their demand for that company. Both free and premium users can request a priority increase; premium requests receive preferential handling. Show that the priority request was recorded and the current setup status. Repeated clicks by the same user must not create additional tasks or repeatedly increase priority. If configuration is already running, retain that work and record the user's interest without restarting it. Exact ordering among requests remains an operational decision.

Let requesters see progress in the product and provide separate in-product updates when the company is catalogued and when monitoring becomes active. The first links to the catalogue entry; the second also links to its job search. Proposed request limits, queue ordering within each priority, and handling of subscription expiry while a request is pending must be defined before launch.

## 6. Compact structured results

A result should let someone make a quick decision about opening the original posting.

Each compact row or card shows title, company, location/remote eligibility, publication age based on the backend's first observation, and a small set of available decision fields. Salary, seniority, employment type, and key skills are candidates. Cards have a single compact presentation, with no expansion or internal posting detail view. Further extracted values can support search matching without needing to appear on the card.

The primary action is “View on company site,” linking directly to the original posting for further details and application. Keep enough search context and scroll position for the user to return and continue.

### Viewed positions

When a user activates the link to a position's full description on the company site, mark the position as viewed, mute its text color, and show an eye indicator with the accessible label “Viewed.” Preserve readable contrast, font weight, row dimensions, and focus. This includes keyboard activation and opening the link in a new tab. Merely displaying a result does not mark it as viewed. The state records that the user opened the link; it does not claim they read the description or applied.

Viewed state belongs to the user and the position, not to an individual search or tab. Store it against the stable posting identity with a first-viewed timestamp. The same position remains viewed when it appears in another search, after a search edit, or after a reload. Duplicate URLs for the same posting share the state; genuinely distinct postings have separate states. Repeated clicks do not create duplicate viewed records.

For signed-in users, persist viewed state in the backend so it follows the account across sessions and devices. For visitors, the proposed behavior is to persist it locally in that browser and merge those observations into the account on sign-in. Account-specific state must not remain visible to another user on a shared browser.

Viewed positions remain in their normal newest-first location; viewing does not reorder or automatically hide them. Preserve viewed state if a posting expires or closes, while still removing the posting from the website under the freshness rules. Keeping that state does not create a browsable archive of expired positions.

Record the viewed action without delaying navigation to the company site. If persistence fails, retain the local viewed state and retry synchronization; returning to the search should still show the clicked position as viewed.

### Presentation and matching rules

- No full description, copied paragraphs, or generated summary in the initial product.
- Show extracted facts only when supported by the posting. Unknown is distinct from “No.”
- Preserve salary currency, pay period, and scope. Do not present an annual estimate as a source-provided value.
- Preserve restrictions on remote work; “remote” alone is often insufficient.
- Match explanations refer to observable fields, such as “Go listed” or “Zurich location.” Avoid invented fit scores.
- A hard constraint requires supporting data. If sponsorship is unknown, it cannot satisfy “must sponsor.” The user may explicitly choose to include unknown values.

Allow lightweight saving and hiding as proposed convenience features. Saved listings obey the same expiry rule; after expiry, show only an unavailable marker and optional private user note. Do not retain a browsable archive of expired posting content in the website.

When a result expires while the user is viewing it, remove its active content and explain why. Do not replace it with an older job to keep a page full.

## 7. Access, free periods, and payment

### Proposed access states

| State | Experience |
| --- | --- |
| Visitor, not signed in | Can search and see a limited sample of eligible older results; latest matches are withheld. |
| Signed in, first free week | Full access to eligible results and persisted searches. |
| Verified existing Jobseek user, first free month | Same full access during the longer welcome period. |
| Active paid subscriber | Full access while the entitlement is active. |
| Signed in, free period ended without subscription | Searches remain saved; return to limited preview access with an upgrade action. |
| Cancelled subscription with time remaining | Full access until the paid-through time. |

Premium subscribers also receive priority handling for company requests. The request workflow remains available to free users. Whether the free week and legacy welcome month include premium request priority is a decision to settle before launch.

Public preview must still contain only jobs first observed by the backend less than 14 days ago. The proposed latest-results cutoff hides postings first observed within the most recent 48 hours; it is an experiment to validate, not a decided requirement. Sparse markets may have no unlocked matches. Show that honestly rather than weakening the freshness promise.

Show one aggregate notice with the number of recent matching postings withheld by access, for example “12 recent matches hidden,” and the sign-in or subscription action. It respects the active search, followed-company limit, freshness and JEV acceptance. Do not show overall position totals on the feed, catalogue or company profiles. While evaluation remains open, count only confirmed hidden matches and present the number as a lower bound (“At least 12 recent matches hidden”); do not invent an exact final total from unevaluated candidates. Update it as accepted matches become known, without revealing their identities. A preview end message describes the end of the preview rather than claiming that no other matches exist. The static prototype has a finite, fully evaluated sample collection, so its hidden-match count is exact. Do not return hidden listing data to the browser and merely blur it. Apply access rules to result queries and any individual listing retrieval alike.

### Language and display

Use the browser’s ordered language preferences to choose a supported interface language, falling back to English. Provide a saved override in the Settings overlay. The prototype supports English, German, French and Spanish; it sets the document language and formats dates for the selected locale. Employer job titles, company descriptions, URLs and user-entered searches retain their source language. Localizing the interface does not translate or rewrite a user’s query. The mock interpreter understands the translated example searches; production interpretation remains a model/backend responsibility.

Use the same bold condensed display face as the Justup wordmark for large headlines and section/dialog headings. Keep the original typewriter face for body copy, inputs, job titles, company names, controls, steps, filters and metadata. The existing masthead and company logos remain brand marks. Use a shared size, weight and spacing scale within those roles. Use the same scale across search, company pages, request confirmations, dialogs, Settings and membership. Preserve readable weight in viewed rows; mute color instead.

Use restrained newspaper references in suitable moments: “Every company we monitor. On the record.” in the catalogue, “Your edition awaits.” at sign-in, and “Keep your edition coming.” for membership. At true search exhaustion, “You’ve reached the back page.” is followed by the explicit 14-day limit and live-update status. Never show that ending while candidates or evaluations remain. Keep search instructions, access counts, coverage status and billing actions literal. Translate these editorial touches with the rest of the interface.

### Hiring Wire

A cream running strip beneath the masthead carries selected company news, with ink-black percentage badges. There is no visible title, sample label, WoW label, explanatory panel or control block on the strip. Every item is a week-over-week signal about newly observed listings, with the company link, short headline, direction, signed percentage and a small sparkline. The comparison remains WoW even though the abbreviation is omitted from the strip. Examples include listing activity picking up, a quieter week at the source, more roles on the board and steady activity. Keep the news company-wide rather than implying it is matched to the user’s search. Public aggregates must not expose hidden posting identities or content.

Define WoW as a rolling seven-day window compared with the immediately preceding seven days at one backend snapshot time. Count distinct postings by first observation, retaining earlier records and known closures for the historical count. These are changes in listing activity, not completed hires or company headcount. Compare the same continuously tracked career-page scope across both windows; suppress signals when new sources, interruptions or missing history would make the comparison misleading. When the previous window is zero, report the before/after counts instead of an infinite percentage. Apply minimum evidence and material-change criteria before selecting real stories; the prototype does not implement this analysis or curation service.

The prototype uses fictional weekly snapshots, independent of the sample search fixtures. The global prototype banner identifies the fictional content; the strip itself runs without explanatory context. Real signals should update when new observations materially change the WoW comparison, using verified history rather than arbitrary rotating announcements. No external news service or live analytics is connected.

The strip moves continuously at a calm, constant speed in a fixed-height area. No pause controls. Pointer hover and clicks keep it running. Open dialogs hold it for reading; keyboard access reveals each company link without moving focus unexpectedly. Reduced motion freezes the strip and leaves manual horizontal scrolling available. Hide the visual duplicate from assistive technology and keyboard navigation. The strip scrolls away with the header and does not become a sticky obstacle or a jittering footer.

### Free period

Proposed default: the free period begins when a verified account activates full search access, with no payment card required. Show the end date clearly. Full access ending does not delete tabs or force the user through onboarding again.

Existing Jobseek users receive one calendar month free instead of the ordinary week. Verify eligibility through account ownership, such as the same verified email; do not copy old preferences into the new profile without a choice. Offer an account-recovery path when identities differ. Define eligibility cutoff and prior-redemption handling before launch. Do not start a person's welcome month before they activate the new service.

### Paid access

The working offers are **$3 per week** or **$10 per month**. These are hypotheses, pending a financial model and willingness-to-pay validation. Currency, tax presentation, payment provider, and trial mechanics are undecided.

Proposed payment behavior is an explicit subscription purchase after or during the free period, with no automatic charge from the cardless free period. The purchase screen states billing interval, renewal terms, and next charge. Cancellation is self-service; access continues through the paid period. Define failed-payment and refund behavior before taking payments.

No financial viability claim is made here. The later model should account for collection and extraction costs, interpretation requests and retries, JEV candidate evaluations and reevaluations, hosting/search, payment fees, free and anonymous usage, abuse, support, taxes, acquisition, retention, and plan mix. Weekly and monthly billing must be assessed separately. Summary generation would be an additional budget line.

## 8. Empty, loading, and failure states

| Situation | Expected behavior |
| --- | --- |
| First visit | Show example searches and the input; allow immediate search. |
| Search interpretation in progress | Keep the submitted text visible and indicate progress. |
| Search text edited but not submitted | Keep current results and criteria unchanged; indicate that the field has unapplied edits. |
| Refinement in progress | Keep the edited search text visible and preserve the previous result state while preparing the change; distinguish it from new results. |
| No matches | Say which requirements were applied. Offer specific relaxations that require a user action. |
| Matches exist but access hides them | Explain the access boundary separately from a true zero-result search. |
| Unsupported request | State what could not be applied and let the user revise. |
| Model unavailable | Preserve the applied configuration, title, description, and results; retain the user's edited search text and offer retry. |
| JEV narrowing pending or unavailable | Show evaluation progress or an error separately from zero matches; do not substitute unfiltered candidates for narrowed results. |
| Search service unavailable | Show an error and retry; do not report zero jobs. |
| Live connection interrupted | Preserve the loaded results while still enforcing expiry and access rules; show connection status and reconcile missed changes after reconnecting. |
| Viewed-state synchronization fails | Open the company posting normally, preserve the viewed state locally, and retry synchronization. |
| Company absent from coverage | Explain that it is not monitored and offer the company request flow. |
| Company discovered, crawler setup pending or blocked | Show the catalogue entry with its assets and metadata, the monitoring status, and the request's next step. Do not present unavailable collection as zero vacancies. |
| Company request blocked or needs information | Show the actual status, reason, and available next action. |
| Company discovery returns the wrong company | Let the user reject it, preserve their lookup text, and retry with corrected details; do not start crawler configuration. |
| Source outage | Explain coverage limitations where material and withhold listings beyond the verification threshold. |
| Free period expires during use | Preserve searches and apply the new access state consistently. |

All core actions must work with a keyboard. Loading updates, errors, tab selection, and result changes need accessible announcements. The search input, generated description, tabs, and payment experience must work on small screens.

## 9. Privacy and product boundaries

Send only the metadata needed for interpretation to the model. Do not send account identifiers or billing information as search context. Explain which profile information is used and provide ways to edit or delete it.

Raw searches may contain personal information. Analytics should prefer outcome events and coarse dimensions over unrestricted prompt logs. Separate necessary debugging retention from long-term product measurement and decide retention before launch.

Viewed-position history is private account state. It is not public activity or a required input to the interpretation model. Include it in account data deletion and define its retention policy before launch.

The UI repository owns the new experience and its access presentation. The product requires a service boundary supplying eligible structured listings, structured search and optional backend JEV narrowing, fixed recency ordering, and authoritative entitlements. Retaining JEV's narrowing capability does not require carrying over the old UI, plan structure, or application architecture. Backend retention is separate from website availability.

This draft intentionally leaves application framework, authentication provider, interpretation model vendor, deployment platform, and payment provider undecided. JEV is retained for backend narrowing; its integration contract needs to be defined for the new service. Select the remaining technologies after the product behaviors and data contract are agreed.

## 10. Scope of the first release

The first release must cover the complete value path: visitor search → understandable criteria → useful preview → sign-in → full fresh results → original company posting → return to saved searches → explicit paid continuation.

Include the search workspace and tabs, persistent editable user search text, model-generated search titles and criteria descriptions, optional metadata, natural-language interpretation and diffs from text edits, model-configured backend JEV narrowing, undo, structured results always ordered newest first, persistent viewed-position and followed-company state, per-search followed-company scope, strict freshness rules, source links, access gating, free-period eligibility, subscription lifecycle, and measurement of the journey.

The first release includes live result delivery over SSE, the compact company catalogue, and two-step company requests with premium priority and visible progress. Interactive Luna discovery at low reasoning returns a company for user acceptance; acceptance publishes the catalogue entry before crawler configuration completes. In-progress companies appear in company search with an action to request higher priority. Hosting, reconnect recovery, and the delivery budget still need to be defined and validated.

Proposed additions to defer include email alerts, CV ingestion, automatic applications, recommendations unrelated to an active search, employer advertising, generated posting summaries, and an internal application tracker. Saving and hiding can be removed from the first release if they delay validating the search-to-source path.

The chosen brand is Justup, with intended domain `justup.work`. The whole job row opens the company posting; the company identity remains a separate link into the catalogue. The accepted visual baseline is **Extra Orange**: orange coral `#F28A60`, a condensed black-and-white masthead, readable typewriter interface text, square controls, and company marks at text size. Keep “Fresh work. Clear sources.” and “Live edition” visible, with a subtle pulse on the live dot. The search field is pale and visibly editable; tabs include “+ New search.” Keep “Last 14 days” explicit. Remove footers and bottom coverage panels to keep scrolling stable. Keep Request a company prominent in the catalogue header. Search deletion requires a dialog naming the search, with explicit delete and keep actions. A floating back-to-top button appears after scrolling. The Requested filter uses the same clickable company-row component as the catalogue: logos, names, details, status, single separators and consistent arrows, with Follow beside the arrow and no website subtitle. The proposed [motion language](motion-design.md) defines arrivals and Viewed transitions for review. Transparency must appear in product behavior as well as messaging: visible company coverage, clear publication-age meaning, readable search interpretation, and honest request progress.

## 11. Validation and success measures

The first hypothesis is that a visitor can find a relevant fresh job and understand why it matches. The second is that access to recent opportunities is valuable enough to return for and eventually pay for. A redesign alone does not establish either.

Instrument the journey with distinct definitions:

- **Search success:** submitted searches that produce eligible matches, segmented by occupation and geography.
- **Interpretation quality:** how often intent is preserved, descriptions and titles reflect the configuration, required clarifications, corrective refinements, failed diffs, and unsupported criteria.
- **Activation:** an account views full search results and opens at least one company posting during the free period.
- **Conversion:** measure preview-to-sign-in, sign-in-to-activation, and free-period-to-paid separately.
- **Retention:** return use during the free period, weekly return use, paid renewal, and cancellation.
- **Trust and operations:** expired listings exposed, known-closed results, duplicate exposure, source-check lag, latency, and cost per submitted search and active user.
- **Coverage and requests:** catalogued companies separately from monitored company scopes, discovery response time, candidate acceptance and rejection rates, time from acceptance to catalogue publication and to monitoring by priority, priority-increase requests, blocked requests by setup step, and time pending for free requests as well as premium requests.

A company-link click records an outbound visit and marks the position as viewed for that user. It is not a completed application or hire. Repeated clicks may be separate analytics events but must not inflate the count of distinct viewed positions.

Before building the whole experience, validate the fresh inventory available in candidate launch segments and test interpretation on representative searches, including exclusions, alternatives, currencies, and refinements. Then test whether people understand the hidden latest results and free-period offer. Set numerical success thresholds before running the launch experiment, using baseline evidence rather than invented targets.

## 12. Decisions to resolve next

| Decision | Proposed starting point |
| --- | --- |
| Visual identity and copy | Extra Orange is the accepted visual baseline. Review the proposed motion language, remaining states, and final copy. |
| Initial audience | Select occupation/geography using actual fresh inventory and user research. |
| Closure verification and posting identity | Set a maximum verification age and define how to distinguish genuinely new postings from duplicates or reopened records. The first-observed timestamp of the same posting never resets. |
| Latest-results gate | Start by evaluating a 48-hour cutoff; validate preview usefulness in sparse searches. |
| Free-period start and card requirement | Activation of verified full access; cardless free period. |
| Legacy eligibility | Verify ownership; one calendar month from activation, replacing the standard week. Define cutoff and redemption rules. |
| Price and billing | Model $3/week and $10/month before selecting final prices and payment mechanics. |
| Filters and missing data | Expose only supported fields; make inclusion of unknown values an explicit choice. |
| JEV evaluation contract | Define candidate evidence, evaluation limits, reuse of valid decisions, progress behavior, quality targets, and a cost budget. |
| SSE operations | Define persistent-connection hosting, reconnect recovery, delivery latency targets, and connection cost budgets. The transport choice is settled. |
| Company-request operations | Define request limits, ordering within each step's priority queues, the effect of distinct users' priority-increase requests, discovery response and crawler-configuration turnaround targets, and priority handling after subscription expiry. Luna discovery at low reasoning, user acceptance, two-step setup, and premium request priority are settled; priority during free periods remains open. |
| Tab limits and saving/hiding | Set limits from usability and cost; keep convenience features secondary to the core flow. |
| Launch targets | Define minimum coverage, relevance, latency, cost, and funnel thresholds before launch. |

Review these product decisions first. The next artifacts are the main-screen wireframe, the search-configuration contract, and the financial model; implementation should follow their agreement.

Company profiles link to the main search for their positions; do not repeat a “Latest from…” job list inside the profile. A stylized interactive globe provides visual character with the brand palette, without a legend or explanatory note. Use plain product language such as “Being added” and “First seen on Justup”; implementation terms such as backend, crawler and configuration belong in technical documentation. This does not change technical terms in actual job titles or the user’s own search text.

Keep company-profile source information compact beneath the company name: last check and a link to each tracked career page. Do not show a status table, scope table, or repeated position counts in that area. Companies with no career pages added yet show “Not checked yet” without invented links.

Keep the globe circular, using an orthographic projection in a square rendering area. Do not separate the description with a horizontal rule. Display tracked career-page addresses as the link text; the design must not depend on human-readable board labels being available.

Company globes must support worldwide hiring. Start over each company’s hiring countries, with a neutral orientation for unknown footprints. Scrolling over the sphere rotates it; there is no zoom or automatic spin. Dragging and keyboard arrows offer additional control, with Home restoring the initial orientation. Preserve normal page scrolling outside the sphere and vertical touch scrolling. The prototype uses distinct sample footprints across the Americas, Africa, Asia, Oceania and Europe.
