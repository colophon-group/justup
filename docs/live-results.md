---
summary: Consume bounded workspace event streams and reconcile accepted results safely.
read_when: Connecting live results, checking stream authorization or verifying reconnect and reader stability.
---

# Live result delivery

The API supplies one same-origin Server-Sent Events (SSE) connection for an open workspace's active search. Accounts use `GET /api/v1/workspace/events?searchId=…&revision=1`; cookie-owned visitors use `GET /api/v1/visitor/workspace/events?searchId=…&revision=1`. Both parameters are required and validated against an owned accepted search. Use the existing host-only session or visitor cookie. The endpoints never accept an owner or access flag. Close and reopen the connection on an active-tab change. Cross-origin `Origin` and Fetch Metadata requests are rejected. The session capability `sse` reports whether the composed transport and policy/deletion gates are available; model outages remain truthful per-search states.

Native `EventSource` cannot set `X-Justup-Locale`, so these two endpoints also accept one optional `locale=en|de|fr|it|es` query parameter with the same request-only precedence. No other query fields are admitted. Duplicate, unsupported or conflicting header/query locale values return 400. An explicit locale still requires its current reviewed policy and asset binding; it never saves a preference or changes the query.

The canonical search snapshot uses the same primary filters, search options, current follows, language restrictions and exact residual decisions as ordinary result pages. It computes only the active search; inactive tabs cannot initialize scans, hidden-count work or classification tasks through this stream. It never advances the ordinary delivered offset, creates pagination cursors or refills the classifier merely because a connection polls. Initial or changed active canonical scans may enqueue the existing bounded, idempotent matching work. Newly pending rows are not results. A late accepted row waits behind every newer unresolved row before entering `items`.

## Events and reconciliation

The browser opens a stream only when the session advertises `capabilities.sse`, a search revision is accepted and selected, and the document is visible with no open dialog. It uses same-origin fetch streaming with an explicit `Last-Event-ID` header, a 1 MiB frame bound, a 20-second header deadline and a 45-second idle deadline. Closing a dialog or resuming the document reuses the last accepted identity for the same owner, revision and locale. Session quarantine immediately cancels the stream; old chunks cannot cross the authority barrier. HTTP 401, 403 and 409 opening failures also reload current session or search authority instead of treating an unavailable stream as an empty search. Transient failures retry up to eight times, at one to eight seconds, before requiring the explicit check action. No public preview flag is enabled by this consumer.

An event has `event: snapshot`, an opaque 43-character `id`, and JSON data:

```json
{
  "schemaVersion": 1,
  "scope": "active_search",
  "searchId": "saved-search",
  "revision": 1,
  "asOf": "2026-11-01T12:00:00.000Z",
  "reason": "initial",
  "searches": [{
    "searchId": "saved-search",
    "revision": 1,
    "items": [],
    "continuation": {"cursor": null, "state": "pending", "retryAfterMs": 1000},
    "ai": {"status": "matching"},
    "coverage": {"kind": "imported_snapshot", "verifiedAt": "2026-11-01T12:00:00.000Z", "stale": false},
    "hiddenMatches": {"status": "pending", "count": null},
    "reconciliation": {"complete": true, "retainedItemIds": []}
  }]
}
```

Opening snapshots use `initial`, `resumed` or `recovery`; normal subsequent changes use `changed`. Frame order and the current transport scope govern reconciliation; `asOf` is a server timestamp and is not a monotonic sequence across reconnects or clock corrections.

`searches` covers only the explicitly selected search. Its absence says nothing about inactive tabs. `items` contains the currently deliverable newest-first resolved prefix, limited to 96 public postings. Reconcile these by stable posting identity, preserving existing row nodes, reading anchor, selection and focus. An item's first-observed timestamp and ID determine its order. Duplicate events or reconnects do not create duplicate rows or mark existing rows as new arrivals.

The prefix is not a replacement for every previously loaded row. `reconciliation.retainedItemIds` is a removal-only enumeration of currently accepted, eligible, exact-evidence identities throughout the canonical search scope, including older accepted rows behind a newer unresolved candidate. It cannot create arrivals. When `complete:true`, remove previously displayed IDs absent from this enumeration. `complete` describes enumeration coverage, independently of whether AI work remains pending. When `complete:false`, absence cannot remove an unknown previously displayed row. Never infer removal from the limited `items` prefix. A deleted or revised active search closes the connection with `search_changed`; reload accepted search state before opening a new revision.

No withheld posting identity, URL, title or body enters either collection. Closed, reserved, expired, access-excluded and changed-evidence rows cannot be retained. Fresh exhausted zero, pending classification and paused import/provider states stay distinct. Missing or stale coverage cannot claim that zero matches is authoritative.

The browser keeps its ordinary HTTP pagination cursor separate from the snapshot prefix. A stale cursor restarts canonical pagination without removing existing rows or interpreting the query. The first complete accepted-ID enumeration establishes an in-memory visit baseline; only a later prefix identity absent from a complete preceding baseline becomes New. Initial snapshots, prefix expansion, buffered pagination and repeated identities do not establish New. An incomplete preceding enumeration conservatively creates no new cohort. The baseline is scoped to the current mounted owner/search/revision; persistent return-visit newness is not implemented. Viewed removes the marker. The navigation cue targets already inserted arrivals.

Existing row keys, focus and selection survive reconciliation. The browser captures a visible row before changing results and compensates its offset before paint; editor/header contexts retain their document position. Active pointer/touch gestures and scrolling coalesce updates until settling. Live arrivals enter immediately; older buffered rows remain gated by their actual visible slot and the 450 ms reveal cadence, including reduced motion.

## Reconnect and authorization

Browsers reconnect with `Last-Event-ID`. The server binds remembered identities to the cookie authority, owner, current access, exact locale policy and asset binding, accepted search revisions and import generation. Every reconnect receives a fresh canonical snapshot: `reason` is `initial`, `resumed` for a remembered matching scope, or `recovery` when the identity expired, became stale, belongs elsewhere or was lost on restart. Events are not a durable journal. The fresh snapshot and reconciliation metadata are authoritative recovery, including after missed imports or accepted decisions. A malformed identity receives HTTP 400; an unknown well-formed identity never grants authority or replays another owner's data.

The HTTP boundary reloads the actual session or visitor cookie before each poll and immediately before each result write. Current policy, private-deletion and auth-maintenance gates remain required. A changed locale or exact policy/asset binding closes an existing stream; its old resume identity recovers under the newly admitted context. Access changes force canonical reconciliation; logout, deletion, visitor expiry/handoff, restore-invalidated sessions and unavailable protections stop delivery. An `unavailable` event has `{schemaVersion:1,reason,retryAfterMs:1000}` and closes the connection. `authority_lost` requires dropping private workspace results and reloading session state. `search_changed` invalidates the selected revision and requires reloading searches. `dependency_unavailable` pauses delivery without presenting a fabricated zero. `reconnect` requests a fresh connection after the lifetime bound.

## Bounds, shutdown and verification

The process shares a one-second SQLite change poll and one current snapshot per connected owner/search/revision. Time/access/provider transitions force reconciliation within five seconds even without a database write. Heartbeat comments run every 15 seconds. Defaults allow 16 connections globally, two per owner, five minutes per connection and at most 1 MiB per event. Oversize projections fail closed with `dependency_unavailable`. A blocked response queues no additional frame and is destroyed if it has not drained within five seconds. Disconnects release state; resume metadata is limited to 1,024 opaque identities for ten minutes and contains no posting payload. Application shutdown closes services and their timers before closing HTTP and SQLite. No private deletion transaction or barrier is held for the duration of a connection.

`node --test server/live-results.test.mjs` checks incremental localhost HTTP chunks, reconnect identities, current SQLite imports, late accepted decisions, access and revision changes, closure/expiry, visitor protection, bounded connections and slow-reader cleanup. Browser contracts in `tests/browser/live-results.spec.mjs` exercise real incremental local HTTP frames, reconnect headers, reader anchors, node identity, selection, focus, duplicate/revision rejection, removal evidence and document/dialog pause. These local tests do not establish deployed Cloudflare delivery or production latency. The release gate must verify first event and reconnect through the actual approved streaming route using exact frontend/API/runner artifacts. An accountless Cloudflare Quick Tunnel cannot provide SSE; use the separately reviewed streaming-capable route.
