# Justup — product design

A new job discovery service built around fresh listings from company career pages, natural-language search, and compact structured results.

The brand is **Justup**, with intended domain `justup.work`. Visual identity and the application stack remain undecided; the repository retains its working name `fresh-jobs-ui`. This repository starts from a new product design; the existing job collection is the starting data asset.

Transparency is a core value: show which companies are monitored, make coverage limits clear, and let users request companies with visible progress. Premium users receive priority on their company requests.

Company setup has two steps: the backend runs fast discovery through a Codex-powered Luna agent at low reasoning, then the user accepts or rejects the found company. Acceptance publishes it in the catalogue with its brand assets and metadata; crawler configuration follows separately. Companies already being configured appear in company search with an action to request higher priority.

Start with the [product design document](docs/product-design.md). It distinguishes agreed requirements from proposed behavior and decisions still to validate.

This repository currently contains product documentation. UI implementation follows design review.
