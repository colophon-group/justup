---
summary: Find the owning guide for product, implementation, operations or contribution work.
read_when: You need to understand or change Justup and want the right starting point.
---

# Justup guidebook

Choose the task you are doing. The [product guide](product-design.md) defines accepted first-release behavior; implementation guides distinguish working behavior from release requirements. A guide is the home for its current facts. Change history and open decisions belong in issues and commits.

## Understand and change the product

| Task | Owning guide |
| --- | --- |
| See the service components and follow a job or search through them | [Service overview](service-overview.md) |
| Understand the accepted user experience and release scope | [Product design](product-design.md) |
| Check the accepted interface against remaining release gaps | [Interface readiness](interface-readiness.md) |
| Understand the server's main boundaries before changing a feature | [Backend design](backend-design.md) and [server directory](../server/README.md) |
| Change result arrival, scrolling or reduced motion | [Motion design](motion-design.md) |
| Review approved Privacy and Usage notices and exact admission evidence | [Policy release record](policies.md) and [provider evidence](policy-review-package.md) |

## Build a user journey

| Task | Owning guide |
| --- | --- |
| Run or change the browser application | [Web application](../web/README.md) |
| Connect a browser or another client to the server | [API](api.md) |
| Change accounts, sessions, access or deletion | [Authentication and accounts](auth.md) |
| Integrate subscription transitions and billing | [Account billing](account-billing.md) |
| Verify an account email before a free period | [Account verification](account-verification.md) |
| Let a visitor search and carry work into an account | [Visitor search](visitor-search.md) |
| Save followed companies, posting languages or interface language | [Reading preferences](reading-preferences.md) |
| Deliver live matches and reconnect without losing accepted results | [Live results](live-results.md) |
| Interpret and filter search results | [Matching](matching.md) and [model work](models.md) |
| Import current jobs from the approved source | [Job data](job-data.md) |
| Show career-page source links and coverage history | [Source coverage](source-coverage.md) |
| Show company hiring activity with honest unknowns | [Company hiring reports](company-hiring-reports.md) |
| Publish weekly company-activity news | [Hiring Wire](hiring-wire.md) |

## Operate and release

| Task | Owning guide |
| --- | --- |
| Choose placement, isolation and recovery for a release | [Deployment plan](deployment-plan.md) |
| Build and verify the exact website assets | [Frontend delivery](frontend-delivery.md) and [frontend deployment directory](../deploy/frontend/README.md) |
| Configure, start, observe or recover the API and worker | [Operations](operations.md), [preview deployment directory](../deploy/justup-preview/README.md) and [repository scripts](../scripts/README.md) |
| Migrate or restore the application database | [Database schema](schema.md) |
| Approve which language and policy assets may process private work | [Processing admission](processing-admission.md) |
| Run weekly news through the API and shared worker | [Hiring Wire integration](hiring-wire-integration.md) |
| Review the bounded model transport used for weekly news | [Hiring Wire runtime](hiring-wire-runtime.md) |
| Inspect bounded product measurements and reviewed model cases | [Product evidence](product-evidence.md) |
| Set up local access or change credential ownership | [Secrets](secrets.md) |

## Contribute

| Task | Owning guide |
| --- | --- |
| File a discovery, make a change, test a pull request or prepare a release | [Development and release process](development-process.md) |
