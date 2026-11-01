# Justup

Justup is a job discovery product in development. It brings together fresh jobs from company career pages, natural-language search and transparent coverage. A preview deployment is a temporary way to release and verify the product; the [product guide](docs/product-design.md) defines the first-release experience.

The [web application](web/README.md) uses React and strict TypeScript to connect search, company browsing and company requests to a same-origin API. Vite produces the assets. The current interface uses real API responses and shows unavailable states when a service is missing. Search delivery, persistent account features, access and billing, and company monitoring still need end-to-end implementation and verification before release.

The [backend design](docs/backend-design.md) defines search interpretation, company discovery, AI matching and Hiring Wire. The [deployment plan](docs/deployment-plan.md) places frontend delivery on Cloudflare and the application on existing Hetzner capacity. The complete product has not yet been deployed and verified.

Start with the [guidebook](docs/README.md) to find the current run guide, product design, contribution workflow, release requirements and credential setup.
