---
summary: Motion and reading-position rules for the Justup interface.
read_when: Changing result arrivals, scrolling, reduced motion or the news ribbon.
status: Proposed design values for review.
---

# Justup motion language

The live-dot pulse is part of the orange-and-ink visual direction. Exact timing values are starting values for review.

## Visual baseline

Use orange coral `#F28A60`, black and white ink, a condensed masthead, headlines in the same condensed face as the wordmark and readable typewriter copy, square controls, and small company marks at text size. Keep “Fresh work. Clear sources.” and “Live edition” visible. Keep “Last 14 days” explicit. The search is a pale, visibly editable field with a Search action. Search tabs include “+ New search.”

Result lists have no footer or appended coverage panel, so reaching an end does not introduce a new layout block. Keep **Request a company** available in the catalogue header. Do not show an idle “Up to date” label.

## Marking new positions

Use a small white **New** label beside the company name and a narrow white leading edge on the position. The label supplies the meaning; the edge helps scanning. The timestamp continues to mean when the server first observed the posting.

Newness is relative to the current search, while Viewed belongs to the user and posting across searches. A newly created search starts with its initial result set; live arrivals are marked New. Proposed return-visit behavior is to mark positions delivered since the previous visit, retaining that cohort throughout the current visit. Define and persist the search visit boundary before implementation so reloads and tab changes cannot accidentally clear the cohort or mark all old matches New.

The entrance ends; the marker remains. Do not remove New merely because the animation completed or the position entered the viewport. Opening the company posting changes the position to Viewed and removes its New treatment. Existing positions that receive metadata updates do not replay an arrival animation. Reconnecting or receiving the same event twice does not replay it either.

## Timing and movement

| Interaction | Starting motion | Persistent result |
| --- | --- | --- |
| A visible new position | Content settles downward by 4 px over 220 ms, with opacity resolving to 1. Use `cubic-bezier(.2,.7,.3,1)`. The leading edge reveals over 180 ms. | New label and edge stay visible. |
| An older match during infinite scroll | Use a proposed 450 ms cycle per job. Motion treatment is under review: Dock, Glide, or Ink. Complete the cycle before beginning the next job, including when the next match is already buffered. | Continuous job-by-job disclosure without visible server page boundaries. |
| Arrival above the reader | Insert automatically above the viewport and compensate scroll position in the same rendering transaction. Animate no existing row. Update the small “N new ↑” navigation cue without rolling digits or pulsing. | The same position, text selection, and keyboard target remain in place. |
| Opening a company posting | Change text to the muted brand color over 160 ms; reveal the eye indicator over 120 ms. | Viewed remains muted at the same font weight, size, line wrapping, and row height. |
| Live connection | Only the small live dot breathes between 0.6 and 1 opacity on a 2.8 s cycle. An optional faint halo expands from the dot. | “Live edition” text stays steady. |
| Buttons, focus, and tabs | Fill, border, or underline feedback within 120 ms. | No card scaling or result-list displacement. |

Reserve a small indicator slot for the eye and New label so changing their visibility does not reflow company names or headings. Muting must preserve readable contrast; do not lower the opacity of the entire row. Company-mark opacity can soften while text uses an explicit muted color.

Motion is local and functional. Use no springs, bounce, confetti, full-page fades, flashing rows, or repeated entrance effects on already shown positions. Fresh live arrivals are one update; any visible entrances share a short time window. Infinite scrolling uses its own deliberately paced, job-by-job reveal, described below. Keep the live-dot pulse subtle. The weekly company-news ribbon (Hiring Wire) is the additional continuous motion: a fixed-height text tape moving at roughly 27 px/s, carrying selected week-over-week changes in listed jobs. A functional looking indicator runs only while matching work is active.

## Infinite scroll: the reveal is the pacing mechanism

The interface reveals individual jobs as the user scrolls down to them. Start a reveal only when the new row’s slot reaches the visible viewport; never consume or animate queued jobs below the screen. Background fetching may prepare matches without revealing them. Server collection pages, candidate scan batches and matching batches never appear as pages in the interface. A matched page arriving does not dump all its jobs onto the screen. A small ordered queue smooths irregular background loading.

The animation itself imposes a deliberate consumption interval, including when data is already ready. The current proposed cycle is **450 ms per job**, with 350 ms and 550 ms comparisons available. The next job cannot begin until the current cycle completes and another ordered match is ready. This is purposeful browsing cadence, rather than an animation applied after a whole page was already disclosed.

Three whole-row treatments are under review:

- **Dock:** open only the newly appended slot during the first 44% of the cycle. After that space is open, introduce the complete job block with a 6 px settle, reaching its final appearance by 88%. Existing rows above stay still.
- **Glide:** introduce the complete row from 14 px to the left, resolving position and opacity by 85% of the cycle.
- **Ink:** keep text immediately readable and stationary. Draw its separator while a soft coral tint settles to the page color over the cycle.

Dock and Glide use `cubic-bezier(.18,.8,.25,1)` for their settling movement. None scans a mask through individual lines of text. Each treatment has the same consumption deadline, ordering, matching states, and reduced-motion pacing.

Fetching and the optional extra AI-based matching step run alongside the reveal. They can take longer than a cycle: the interface waits for the next real match rather than inventing a position or resetting its animation. Older matches disclosed through scrolling do not receive the live-arrival New label.

### Three continuation states

| State | Meaning | Visible behavior |
| --- | --- | --- |
| Revealing | At least one match is ready in chronological order. | Reveal one row per cycle. Existing rows keep their position, identity, and focus. |
| Looking | The matched queue is empty, but candidates remain, a continuation is active, or extra AI-based matching decisions are pending. | Hold a stable continuation area with **Looking for more matches…** and a quiet indeterminate ink rule. Show no percentage or made-up remaining count. |
| End | No candidates remain in the eligible range, every pending evaluation has resolved, the matched queue is drained, and the last reveal has completed. | Stop the looking indicator and show **You’ve reached the back page.** Follow it with **No more matches in the last 14 days. Live updates stay on.** Coverage remains limited to the companies we monitor. Keep the company-request action available through the catalogue header. |

An empty filtered server page is a Looking state, not an End state. A timeout, failed AI-based matching decision, scan pause or disconnection does not prove there are no more matches. If work has stopped, show a truthful paused or retry state with a next action, rather than animating “Looking” indefinitely. A real account access limit requires its explicit access message.

### Buffering, work limits, and ordering

Proposed initial limits are a small queue of up to six ready matches, a refill trigger around two remaining matches, and at most one continuation request in flight for the current search revision. Final values require latency and cost measurement. Do not preload the whole search. A bounded candidate scan can yield its cursor when matching is expensive; resuming does not restart the scan or re-evaluate completed candidates.

Work refills the buffer according to actual consumption and proximity to the loaded end. Stop consuming new rows and refilling when the user leaves that area, changes the search, or backgrounds the tab. Finish the current visible row so no half-revealed text remains. Do not turn the loader's animation loop into repeated requests. Each continuation has a server work limit as well as the deliberate browser reveal cadence.

Extra AI-based matching decisions may finish out of order. Emit matches only when all more-recent candidates have been resolved, keeping a stable first-observed timestamp and posting-identity ordering. Buffer later accepted candidates behind that decision boundary. This preserves newest-first order without inserting a late decision into the middle of rows someone is reading.

Retain existing rows as new rows are appended below them. Do not animate the height of the existing list, apply scroll resistance, or hijack wheel and touch input. If a user focuses a partly revealed row, complete its visual reveal immediately so the target is visible; the cadence deadline for disclosing the next job remains in force. Do not let the pagination loader become a scroll anchor that pulls the reader downward.

### Reduced motion keeps the same cadence

With reduced motion, a ready job appears without a wipe, translation, or fade, and the next job still waits for the same per-job cycle deadline. The looking indicator is static with the same status text. Reduced motion changes the visual treatment, while preserving the designed consumption pacing and server work limits.

The infinite-scroll study simulates continued proximity to the loaded end. Its three scenarios show buffered matching jobs, a candidate batch with no matches followed by more AI-matched jobs, and confirmed exhaustion. It does not make real requests.

## Protecting reading and interaction

New matching positions are added automatically in first-observed order. The count is a navigation shortcut to positions already inserted; it is never an “apply updates” gate.

When results are the reader’s current context, retain the visible position’s offset from the viewport. Preserve the same browser page elements (DOM nodes), focus, text selection and pointer targets. While someone edits the search or reads the header, keep that field or header stable instead of scrolling the document to maintain a result below it. Do not auto-scroll to the newest position.

Avoid changing the list during an active drag, touch scroll, or text selection. Coalesce events during the gesture and apply them once it settles, with the same reading anchor. Do not wait for a button click. Events for a superseded search revision cannot appear in the edited search.

Clicking “N new ↑” is explicit navigation. It may bring the newest row into view; do not replay its entrance. Returning to a tab or the browser window does not replay animations. A focused row that becomes Viewed retains the same link node and keyboard focus.

Search submission keeps the user’s complete text in place. Do not fade away the workspace or animate individual letters of the generated title or criteria description. Update ready content atomically and protect the reader from any resulting layout change.

## Reduced motion and announcements

Honor the operating system’s reduced-motion preference. Remove translations, edge animation, color transitions, and the repeating live pulse. State changes are immediate, with the same New labels, eye indicator, counts, newest-first order, and reading-position protection. Infinite scrolling retains its per-job cadence deadline as specified above.

Announce incoming batches through one polite status region, such as “2 new matching positions added.” Do not make the entire feed a live region or announce every frame. Eye and outbound-link icons have accessible labels. Neither color nor motion is the only way to identify a new or viewed position.

## Review and implementation checks

- Reading: delivering one or several positions preserves the currently read row’s viewport offset and its DOM identity.
- Editing: arrival preserves the active input, caret, selected text, and page position.
- Viewed: opening a position preserves its row dimensions and link focus while the color changes.
- Recovery: duplicate events, reconnects, tab returns, and stale search revisions do not duplicate positions or replay entrances.
- Motion preference: reduced motion produces no translations or ambient animation and loses no information.
- Accessibility and layout: verify keyboard operation, announcements, contrast, long titles, and small screens in the real application viewport.

The inline motion study demonstrates the arrival treatment, a cropped reading viewport, and the viewed transition. Its hidden “above viewport” region is illustrative; production insertion and scroll anchoring require end-to-end verification in the application.

The company catalogue uses the same individual-row cadence and viewport gate as the job feed. Company rows open their profiles, with priority requests as an independent button. Clickable rows have a coral hover wash, a keyboard focus outline, and pressed feedback. Do not append footer panels at the end of either list. Reserve enough space for looking and end statuses to change without shifting the document. A fixed back-to-top button appears after scrolling and respects reduced motion; it restores focus to the top navigation. The Requested filter in Companies reuses the company-row component, including logos, source identity, details, status, single row separators and the shared arrow.

For clickable rows, the surface highlight, arrow motion and focus outline provide interaction feedback. Do not additionally underline row logos, titles or arrows on hover. Keep ordinary standalone text links identifiable.

## Company globe

The globe responds directly to wheel, drag and keyboard input, without a reveal sequence, automatic spin or inertial tail. Scrolling over the sphere rotates longitude; its scale remains fixed. Wheel input outside the sphere scrolls the page normally. Horizontal touch dragging rotates while vertical touch gestures scroll the page. Arrow keys rotate and Home restores the initial view. Rendering uses a single animation-frame update per frame, with no movement while idle.

The first-search screen has no result reveal or live insertion until submission. Deleting the last search invalidates queued or pending results before showing that screen; a late response must not repopulate it. Example buttons prefill the input without starting a search.

## Hiring Wire

Keep a fixed-height strip under the masthead, with continuously moving company links, short headlines, percentages and small trend charts. Each change compares the current seven days with the previous seven days, with no visible title, comparison label or contextual panel. A visual duplicate enables seamless looping; it is hidden from assistive technology and excluded from keyboard order. Use no pause controls. Keep motion running through pointer hover and clicks. Hold it while a dialog is open or the document is hidden. Keyboard navigation switches to a static, horizontally scrollable view so every focused link stays visible. Reduced motion freezes the tape and permits manual horizontal scrolling, without losing any stories. Avoid aria-live announcements of the repeating text.
