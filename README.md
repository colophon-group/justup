# Justup

A new job discovery service built around fresh listings from company career pages, natural-language search, and compact structured results.

The brand is **Justup**, with intended domain `justup.work`. **Extra Orange** is the accepted visual baseline; the application stack remains undecided. The existing job collection supplies the starting data asset.

Transparency is a core value: show which companies are monitored, make coverage limits clear, and let users request companies with visible progress. Premium users receive priority on their company requests.

Company setup has two steps: the backend runs fast discovery through a Codex-powered Luna agent at low reasoning, then the user accepts or rejects the found company. Acceptance publishes it in the catalogue with its brand assets and metadata; crawler configuration follows separately. Companies already being configured appear in company search with an action to request higher priority.

Start with the [product design document](docs/product-design.md). It distinguishes agreed requirements from proposed behavior and decisions still to validate.

The proposed [motion language](docs/motion-design.md) covers New markers, automatic arrivals, reading-position protection, Viewed transitions, and the live-dot pulse.

The [current browser interface](prototype/README.md) includes the scrollable job feed, company catalogue and two-step company requests. It runs as static HTML/CSS/JavaScript with fictional data and is the starting point for ongoing Justup application work.
