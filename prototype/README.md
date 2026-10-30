# Justup interactive prototype

A buildless, browser-local mockup of the Extra Orange edition. It uses 252 fictional jobs and 20 fictional companies. No API keys, dependencies, backend or real requests are required.

From this repository:

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory prototype
```

Open http://127.0.0.1:4173.

- Scroll the positions feed. Each additional job starts only when its slot reaches the visible viewport, at least 450 ms after the preceding reveal starts. Background candidate pages are buffered independently. Leaving the tail or backgrounding the tab stops consumption.
- Edit the complete search text and press Enter. Try the existing Backend, Robotics or Everything searches, or create a new tab. This prototype uses a small local interpreter; it does not call a model or implement JEV.
- Click anywhere on a job row to open a clearly labelled sample company page in a new tab. The company name independently opens its catalogue profile. Viewed state is shared by all searches.
- Browse and search the company catalogue. It uses the same viewport-gated, 450 ms row reveal as the positions feed. Whole company rows open their profiles; the compact priority action stays independent. Inspect monitored, configuring and attention states, then request priority on an existing setup. Both lists share one row component for link hit areas, hover/pressed/focus feedback, arrow targets and responsive edge insets (16 px desktop, 12 px mobile). The company section bar follows its search, matching Positions. The prominent request-company panel follows the final row; the jobs Open Coverage panel is hidden while more results remain.
- Request a missing company, reject or accept the sample identity, and see its immediate catalogue entry and tracked setup request. Company metadata generated here is explicitly illustrative, not verified discovery.
- Open Demo controls to compare Ink, Dock and Glide at 450 ms, simulate a fresh arrival, a matching gap or the actual end, and enable reduced motion. The account control switches Plus priority for new requests.

Searches, viewed IDs, requests and confirmed company profiles are saved in localStorage in this browser. Demo controls can reset them. There is no authentication, subscription billing, SSE connection, actual company discovery, real crawler setup or cross-device persistence. The intended application framework remains undecided.
