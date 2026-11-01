---
summary: Where Justup runs and which deployment settings can change without changing the product.
read_when: Choosing runtime placement, reviewing isolation or preparing an environment transition.
---

# Justup deployment

Justup uses one product API, durable SQLite store, shared background runner and private model broker. Cloudflare delivers the compiled frontend and forwards same-origin API requests to the application on existing Hetzner capacity. A restricted preview runs the same product with its own data, credentials and temporary routing. Invitation, noindex, schedule, provider and resource settings may change through reviewed configuration; account identity and product state remain durable.

This guide owns placement and environment boundaries. Use [operations](operations.md) for host commands, exact resource controls, configuration delivery and recovery; [frontend delivery](frontend-delivery.md) for retained assets, routing and deployed byte checks; and the [development and release guide](development-process.md) for release candidates, required evidence and promotion.

## Placement and isolation

| Component | Boundary |
| --- | --- |
| Frontend | Build React/TypeScript/Vite assets off-host from an exact commit. Retain the compiled assets and Cloudflare Worker bytes. Do not install frontend source or build tools on the application host. |
| API | A dedicated unprivileged Node HTTP process owns sessions, access-filtered reads and SSE. It receives no model or residual-matching credentials. |
| Product state | API and runner share only their explicit SQLite state group. Accounts, searches, company requests, tasks, editions and their deletion boundaries persist across audience changes. |
| Runner | One leased queue handles interactive and scheduled work. Interactive requests have priority; editorial work does not start a second permanent agent service. |
| Models | A separate unprivileged identity uses a root-created private socket. Only the runner can request model work; native execution requires independent profile and host qualification. |
| Job transfer | The importer accepts an approved public-field projection from Jobseek. Source IDs, first observation, revision and coverage evidence must survive refresh and recovery. |
| Recovery and accounting | The deletion generation is outside restorable snapshots. Restore invalidates sessions; the cumulative provider ledger and crash locks remain outside database backups and are never reset by restore. |

The backend artifact contains the exact runtime modules, importer, schemas/catalogues and pinned native bytes. Frontend and backend artifacts must identify the same frozen source tree. A changed source, configuration or artifact requires renewed evidence; process readiness alone cannot establish product readiness.

## Restricted preview boundary

The reviewed preview uses a bounded slice on a former Murmur host and the existing Cloudflare Free allowance. Keep the production Jobseek renderer, services, data and deployment gates independent. The API, runner, model, tunnel and maintenance work share one aggregate resource ceiling. The [operations guide](operations.md#apply-the-resource-boundary) owns its exact kernel limits and proof procedure; current host identity, allocation receipts and deployment status belong in protected operator notes.

An existing installation must follow its reviewed upgrade path. Do not reinstall over durable state, replace authentication, reset a ledger, raise a cap or assume that a test fixture proves live isolation. Verify the actual host, installation record, resource controls and remaining capacity before any change.

## Environment configuration

The API uses explicit `JUSTUP_*` settings for invitation admission, account capacity, optional new-account deadlines, session lifetime, reviewed policies and service enablement. Accounts are durable by default. Changing an account deadline setting never rewrites an existing account; session expiry is separate. The [operations guide](operations.md#deliver-scoped-api-configuration) owns the current allowlist and safe delivery procedure.

Frontend configuration binds a `preview` or `production` deployment mode and approved routing without rebuilding assets. Preview is noindex; production indexing is an explicit publication step. API responses remain private and uncached in either mode. A mode flag never grants policy, provider or release approval.

Keep payment capture, production mail and production schedules off until their actual providers, disclosures and failure paths qualify. A source snapshot alone does not establish continuous monitoring; historical comparisons require uninterrupted, attributable coverage. Missing accepted product paths block first invited activation rather than becoming preview exceptions.

## Release handoff and resources

The [release guide](development-process.md#6-verify-a-release-before-it-goes-live) owns the complete candidate checklist, exact tree/hash comparison, deployed browser gate and production promotion. [Operations](operations.md) supplies backup/restore, host/resource and runner evidence; [frontend delivery](frontend-delivery.md) supplies immutable asset and routing evidence. Retain a compatible prior artifact and deletion-safe recovery path for rollback.

Existing credentials or a passing test do not authorize a new service, paid tier or infrastructure spend. File a resource issue with purpose, alternatives, owner, environment, data scope, estimate, ceiling and cleanup, then obtain explicit approval before allocation. Keep live prices, capacity readings, host identifiers and one-off approvals in issues or protected operator notes rather than this guide.
