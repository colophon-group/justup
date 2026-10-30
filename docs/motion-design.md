# Justup motion language

Status: proposed motion specification for the accepted **Extra Orange** visual direction. The live-dot pulse is requested; exact timing values are starting values for review.

## Visual baseline

Use orange coral `#F28A60`, black and white ink, a condensed masthead, readable sans-serif job text, square controls, and small company marks at text size. Keep “Fresh work. Clear sources.” and “Live edition” visible. Keep “Last 14 days” explicit. The search is a pale, visibly editable field with a Search action. Search tabs include “+ New search.”

The coverage footer says “See who we monitor. Tell us who’s missing.” Its primary action is **Request a company**, with **Company catalogue** as the secondary action. Do not show an idle “Up to date” label.

## Marking new positions

Use a small white **New** label beside the company name and a narrow white leading edge on the position. The label supplies the meaning; the edge helps scanning. The timestamp continues to mean when the backend first observed the posting.

Newness is relative to the current search, while Viewed belongs to the user and posting across searches. A newly created search starts with its initial result set; live arrivals are marked New. Proposed return-visit behavior is to mark positions delivered since the previous visit, retaining that cohort throughout the current visit. Define and persist the search visit boundary before implementation so reloads and tab changes cannot accidentally clear the cohort or mark all old matches New.

The entrance ends; the marker remains. Do not remove New merely because the animation completed or the position entered the viewport. Opening the company posting changes the position to Viewed and removes its New treatment. Existing positions that receive metadata updates do not replay an arrival animation. Reconnecting or receiving the same event twice does not replay it either.

## Timing and movement

| Interaction | Starting motion | Persistent result |
| --- | --- | --- |
| A visible new position | Content settles downward by 4 px over 220 ms, with opacity resolving to 1. Use `cubic-bezier(.2,.7,.3,1)`. The leading edge reveals over 180 ms. | New label and edge stay visible. |
| Arrival above the reader | Insert automatically above the viewport and compensate scroll position in the same rendering transaction. Animate no existing row. Update the small “N new ↑” navigation cue without rolling digits or pulsing. | The same position, text selection, and keyboard target remain in place. |
| Opening a company posting | Change text to the muted brand color over 160 ms; reveal the eye indicator over 120 ms. | Viewed remains muted at the same font weight, size, line wrapping, and row height. |
| Live connection | Only the small live dot breathes between 0.6 and 1 opacity on a 2.8 s cycle. An optional faint halo expands from the dot. | “Live edition” text stays steady. |
| Buttons, focus, and tabs | Fill, border, or underline feedback within 120 ms. | No card scaling or result-list displacement. |

Reserve a small indicator slot for the eye and New label so changing their visibility does not reflow company names or headings. Muting must preserve readable contrast; do not lower the opacity of the entire row. Company-mark opacity can soften while text uses an explicit muted color.

Motion is local and functional. Use no springs, bounce, confetti, full-page fades, flashing rows, repeated entrance effects, or staggered cascades across a batch. A batch is one update; any visible entrances share a short time window. The live dot is the sole repeating ambient motion and must remain subtle.

## Protecting reading and interaction

New matching positions are added automatically in first-observed order. The count is a navigation shortcut to positions already inserted; it is never an “apply updates” gate.

When results are the reader’s current context, retain the visible position’s offset from the viewport. Preserve existing DOM nodes, focus, text selection, and pointer targets. While someone edits the search or reads the header, keep that field or header stable instead of scrolling the document to maintain a result below it. Do not auto-scroll to the newest position.

Avoid changing the list during an active drag, touch scroll, or text selection. Coalesce events during the gesture and apply them once it settles, with the same reading anchor. Do not wait for a button click. Events for a superseded search revision cannot appear in the edited search.

Clicking “N new ↑” is explicit navigation. It may bring the newest row into view; do not replay its entrance. Returning to a tab or the browser window does not replay animations. A focused row that becomes Viewed retains the same link node and keyboard focus.

Search submission keeps the user’s complete text in place. Do not fade away the workspace or animate individual letters of the generated title or criteria description. Update ready content atomically and protect the reader from any resulting layout change.

## Reduced motion and announcements

Honor the operating system’s reduced-motion preference. Remove translations, edge animation, color transitions, and the repeating live pulse. All updates are immediate, with the same New labels, eye indicator, counts, newest-first order, and reading-position protection.

Announce incoming batches through one polite status region, such as “2 new matching positions added.” Do not make the entire feed a live region or announce every frame. Eye and outbound-link icons have accessible labels. Neither color nor motion is the only way to identify a new or viewed position.

## Review and implementation checks

- Reading: delivering one or several positions preserves the currently read row’s viewport offset and its DOM identity.
- Editing: arrival preserves the active input, caret, selected text, and page position.
- Viewed: opening a position preserves its row dimensions and link focus while the color changes.
- Recovery: duplicate events, reconnects, tab returns, and stale search revisions do not duplicate positions or replay entrances.
- Motion preference: reduced motion produces no translations or ambient animation and loses no information.
- Accessibility and layout: verify keyboard operation, announcements, contrast, long titles, and small screens in the real application viewport.

The inline motion study demonstrates the arrival treatment, a cropped reading viewport, and the viewed transition. Its hidden “above viewport” region is illustrative; production insertion and scroll anchoring require end-to-end verification in the application.
