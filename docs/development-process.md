# Justup development and release process

This policy applies to Justup contributions now. The repository is in design and prototype work; the application test runner, `dev` branch, selected CI and release automation described below are not implemented yet. Activate their gates before the first live release, and update this document when the repository state changes.

## 1. Branch and release requirements

| Branch or ref | Purpose | Entry rule |
| --- | --- | --- |
| Short-lived feature branch | One coherent change, based on `dev`. | PR into `dev`. |
| `dev` | Integrated next version; never a production deployment source. | Selected PR checks and reviewed quality checklist pass. |
| `release/vX.Y.Z` | Frozen candidate cut from an exact `dev` commit. | PR into `main`; full release gate passes on the candidate and current base. |
| `main` | Source of released versions only. | Release PR or urgent hotfix PR; no direct pushes. |
| `vX.Y.Z` tag | Immutable production release identity. | Tag the tested `main` commit and record artifact digests. |

An urgent hotfix starts from `main`, runs the release gate for the affected candidate, and is merged back into `dev` immediately. After each release, merge `main` back into `dev`. If `main` or the release candidate changes while verification is running, repeat the affected gate against the new exact commit. Do not promote a moving branch alias or rebuild different production bytes after preview verification.

Release PRs use a merge commit, with current `main` an ancestor of the candidate. Record the candidate's Git tree hash. Before production promotion, compare the merged `main` tree hash with the verified candidate's tree hash; a mismatch blocks promotion and requires a new candidate and gate. The merge commit SHA may differ while its source tree is identical. This rule keeps previewed artifacts tied to the released source.

For Justup's planned Cloudflare frontend and Hetzner API/runner, the release candidate preview must include compatible versions of **all three**, an isolated database and non-production credentials. Verify the immutable preview deployment and its API/runner artifact identities. After promotion, smoke-test production and retain the prior deployable artifacts and a database recovery path. A frontend-only preview cannot establish that the service works.

## 2. Issues, commits and resource approval

Open one issue for each meaningful work item. Title it `<Area>: <desired outcome>` with a short area name and an outcome, for example `Search: preserve results after invalid interpretation` or `CI: select affected test suites`. Do not put type, priority, status or an issue number in the title; labels and GitHub state carry those. A pure typo or metadata correction may omit an issue if it has no enduring context to preserve.

The issue holds the motivation, current context, desired outcome, constraints, acceptance evidence and relevant links. Record material decisions and alternatives in its discussion. Keep implementation chronology out of code comments and product documentation; those files describe current behavior and contracts. A PR links its primary issue and documents the resulting changes and verification, without repeating the issue's rationale.

Use an imperative commit subject with the issue reference visible in one-line file history: `Preserve valid search after model failure (refs #42)`. Every commit for that work item uses its issue number, including the final squash subject if squashing. Put secondary issue links in the commit body when necessary. `refs` links context without claiming automatic closure; close the issue when its desired outcome is accepted and link the merged PR. Do not rewrite older commits solely to adopt this convention.

Use one type label and, only when needed, `blocked`:

| Label | Use |
| --- | --- |
| `bug` | Current behavior violates an expected contract. |
| `enhancement` | A user-facing capability or behavior change. |
| `maintenance` | Refactoring, tests, CI, process or internal upkeep. |
| `documentation` | Documentation-only work. |
| `resource-request` | A separate request for a new external service or infrastructure spend. |
| `blocked` | An issue is waiting on a decision or dependency; remove it when that condition clears. |

When proposed work needs a new external service or infrastructure spend, create a separate `resource-request` issue and mark it `blocked`. State the purpose, existing alternatives, owner, environment, data/access scope, one-time and recurring cost estimate, spending ceiling and cleanup plan. Planning and code preparation may proceed. An authorized human must explicitly approve the resource and ceiling in that issue before provisioning, even if usable credentials already exist. A label, available account, or agent-authored comment is not approval. Reapproval is needed if scope or cost increases. Link the resource issue and its approval status from the implementation issue and PR.

## 3. Contribution quality

Every PR completes the [PR template](../.github/PULL_REQUEST_TEMPLATE.md). For each guideline, check the box and write one short **Applied: evidence** or **N/A: reason** line. A script may enforce completion and valid format; a reviewer judges whether the explanation is true. A checked box alone is not evidence.

| ID | Guideline | Review question |
| --- | --- | --- |
| Q1 | Focus and maintainability | Is the change cohesive, readable, and placed at a clear ownership boundary without avoidable duplication? |
| Q2 | Contracts and failure behavior | Are inputs, outputs, errors, retries, concurrency and idempotency handled where relevant? |
| Q3 | Verification | Does the PR name the tests and checks that prove the change, including a relevant failure or edge path, and explain any gap? |
| Q4 | Security and privacy | Are authorization, secrets, dependency trust, personal data and data retention handled where touched? |
| Q5 | Data and deployment safety | Are schema/data changes compatible with deployed versions, observable, and recoverable? |
| Q6 | User experience | Are accessibility, language, loading, empty and error states handled where users see a change? |
| Q7 | Current-state code and docs | Do code, comments, tests, examples and docs describe what exists now, with obsolete paths and historical narrative removed? |
| Q8 | Transform before adding | Does the change reshape or replace the existing path where possible, removing superseded code, tests and docs instead of accumulating parallel versions? If temporary compatibility is needed, is its owner and removal condition clear? |
| Q9 | Dependency budget | Are new direct and transitive dependencies avoided where a small existing solution suffices? If added, does the issue record alternatives and why the dependency reduces the total maintenance surface enough to justify upkeep, security and upgrade cost, while the PR names the actual dependency change? |
| Q10 | Resource authorization | Does work needing a new external service or infrastructure spend link to a separate `resource-request` issue, with no provisioning before explicit human approval? |

Keep this checklist stable and version its IDs. A PR may mark a guideline N/A only with a specific reason; for example, “N/A: this changes only the search evaluation fixture, with no user-facing UI.” Claims such as “N/A: not needed” are incomplete. Reviewers request evidence when the explanation is doubtful. Mechanical rules belong in formatters, linters, type checks and CI rather than prose.

## 4. Test creation, structure and maintenance

Each PR also completes the four testing guidelines below. For a change with no affected behavior or tests, give a specific N/A reason; a behavior change without an automated test needs an explicit exception, manual evidence and reviewer acceptance. A passing test command alone does not explain whether the right behavior was tested.

| ID | Guideline | Required practice |
| --- | --- | --- |
| T1 | Create meaningful tests | New behavior gets an assertion of an observable contract; a bug fix gets a reproducer that fails before the fix. Cover a relevant failure, boundary or state transition. Avoid duplicate cases, tests that only restate implementation, and test counts as a goal. |
| T2 | Put tests at the right level | Use the cheapest level that proves the contract. Keep pure logic tests beside their module; put API/provider contracts, database/runner integration, migrations and browser journeys in named suites. Choose one primary suite for each behavior and register its shared dependencies in the CI impact manifest. |
| T3 | Keep tests trustworthy | Use deterministic factories, fixed clocks/seeds and isolated state. Fake network calls by default; run real providers only in explicit integration or preview suites. Keep production secrets and personal data out of fixtures; preview tests use non-production credentials. Update tests when a reviewed contract changes, remove obsolete tests with an explanation, and never weaken assertions just to make CI green. |
| T4 | Evaluate AI behavior | Version reviewed cases and a held-out set for search interpretation, matching, company identity and Hiring Wire facts. Run the relevant evaluations when prompts, models, tool schemas or routing change; report quality, latency and cost against defined thresholds. Keep stochastic variance visible rather than treating one lucky run as proof. |

Use table-driven cases when several inputs exercise the same invariant. Prefer small fixtures with only the facts a test needs; avoid broad snapshots of rendered pages or provider responses unless the snapshot itself is the contract. Name tests by input condition and expected outcome so failures identify the broken behavior.

Prioritize integration cases where boundaries create risk: search revisions and stale responses, entitlement changes, SSE reconnect, idempotent billing and company requests, AI-decision invalidation, and stored-state migrations across old and new API/runner versions. Keep a small browser set for the critical user journeys; do not duplicate every unit scenario in a browser. Start that suite with Playwright for the new web application; Selenium is also viable if a concrete browser or team need warrants it. Use semantic selectors and observable outcomes rather than sleeps or broad page snapshots. Test data and fixtures are owned alongside their suites, with changes to shared fixtures widening CI selection.

Every suite has an owner, purpose, expected runtime and CI lane. Track failures and duration. Quarantine a flaky test only with an owner, issue, expiry and replacement signal during quarantine; fix or delete it before expiry. A removed test must follow removed behavior or be replaced by evidence at a better level. Review test additions that materially increase suite time or repeat an existing invariant.

## 5. CI that selects relevant tests

One required, always-running `CI / decision` check owns the result of each PR. It reports the changed paths, selected suites, reasons for selection and reasons for any skip. It fails if a required suite fails, a selected suite does not report a result, or the selection script fails. An unknown path triggers the full suite and is reported as a fallback; a passing full run may clear the check. Do not path-filter the required workflow itself: GitHub can leave a required check pending when the whole workflow is skipped.

Keep suite ownership and impact rules in one reviewed manifest next to the CI selector. Start with explicit groups for frontend, API, runner, database/migrations, search and AI evaluations, billing/access, and deployment/infrastructure. Selection uses the diff against the actual PR base, includes dependents of changed shared contracts, and can be expanded with a `full-ci` override. Changes to the selector, workflows, lockfiles, shared types, authentication/access, billing, database schema, deployment contracts, model prompts, tool schemas or model versions receive broad or full coverage. Unknown paths fail closed to the full suite. Test the selector with representative change sets.

Ordinary PRs run a fast baseline (format, lint/type checks for touched code, PR-template validation, and relevant build checks) plus selected behavioral suites against the proposed merge result with current `dev`, not only the feature head. Run the full suite on every release candidate and on a scheduled `dev` run so selection mistakes are detected before release. Keep the full run observable: record duration, failure rate and flaky tests. Set time budgets for each suite and review additions that make CI materially slower.

Define AI evaluation pass/fail thresholds from representative baselines before the first live release; running an evaluation without an acceptance threshold does not make the release gate green.

## 6. Release gate

The release PR from the frozen candidate to `main` must record a named release owner, changelog, migration and rollback steps, feature flags, known limitations and candidate SHA. Its gate is:

1. Full static, build, unit, contract, integration, migration and AI evaluation suites pass on the exact candidate with the current `main` base. The browser suite runs once against the deployed preview in step 3.
2. Build the frontend, API and runner once; deploy those versioned artifacts to an isolated preview. Record the exact candidate SHA, current `main` base OID, tree hash, immutable frontend deployment URL and artifact digests.
3. Run the automated preview gate described below. Verify both ordinary and failure paths, then attach its report to the release PR.
4. Confirm backups, forward-compatible migrations, rollback steps, monitoring and alert readiness. Rehearse a restore/rollback before the first live release and after material data-contract changes.
5. Immediately before merging, compare the candidate SHA and `main` base OID with the preview report; rerun the gate if either changed. Verify the merged `main` tree hash matches the candidate, tag the exact `main` commit, deploy the retained identical artifacts, and run production smoke checks. Watch error rate, latency, queue lag and business-critical results for a defined observation window. Define observation thresholds before launch; roll back or disable a feature if the release fails them.

### Automated prerelease preview gate

The release PR gets one `Preview / verified` result tied to its exact candidate SHA and `main` base OID. Unprivileged jobs build and test the candidate; a trusted deploy job uploads their recorded artifacts without running candidate-supplied scripts. It deploys a release-specific preview of the Cloudflare frontend, Hetzner API and runner, with an isolated database/queue, seeded test data and preview-only credentials. Run one candidate at a time if preview infrastructure is shared; never let a later deployment change the backend behind an earlier tested URL. Keep deployment credentials out of ordinary PR jobs and never execute unreviewed PR workflow code with production secrets.

After deployment, CI waits for readiness and confirms the frontend deployment ID, API version, runner version, schema version and artifact digests match the candidate manifest. Test the immutable deployment URL, not a branch alias. Preview routes are protected from public access and indexing; fixtures and callbacks cannot send real email, charge real payment methods or modify production data.

Run a small Playwright suite through that URL for user-visible, cross-service behavior. Use API/worker checks for the deeper state and failure permutations that a browser would make slow or obscure. Start with these release-blocking checks:

| Check | Primary level | Observable proof |
| --- | --- | --- |
| Account and access | Browser + API | Visitor and paid journeys show the right data; trial and expired states and protected API responses enforce entitlement. |
| Search | Browser + API | A query becomes the expected criteria and fresh results; an invalid normalization leaves the prior search intact. |
| AI narrowing | Browser + API | One successful and one honest failure journey render correctly; API checks distinguish rejected, insufficient-evidence and provider-failure states. |
| Live results | Browser + API | SSE arrival and reconnect work through Cloudflare; API checks reject duplicates and stale revisions. |
| Background work | Worker/API + browser result | A synthetic runner task completes once; company request deduplication and a published Hiring Wire edition are visible. |
| Billing and data | API/migration + browser result | A signed sandbox callback and replay produce one entitlement change; the browser reflects it and migration of representative prior state succeeds. |

Use deterministic provider fixtures for broad journeys and a bounded real-provider contract check where that provider is required for release. Run the browser smoke set in desktop Chromium and one mobile browser profile on release; add more browsers only for a supported compatibility promise or a demonstrated defect. Assertions check behavior and state, with screenshots or traces retained for diagnosis. Set test and readiness timeouts. The gate fails on a missing deployment, identity mismatch, failed journey, unavailable required provider, or missing result. Publish a concise report with the candidate SHA, base OID, deployment IDs, digests, test counts and sanitized failure traces. Keep a successful preview available for release-owner review, then destroy it after the release decision. On failed or cancelled runs, an always-run finalizer captures diagnostics and cleans up. Enforce an independent expiry for abandoned previews; alert the release owner and block another candidate if cleanup fails.

The production deploy is an explicit release action, not an automatic build on every `main` push. Same-byte frontend deployment requires runtime configuration or stable relative routes for API/auth origins and environment-specific public keys. This is a launch prerequisite: preview-specific values embedded at build time invalidate the tested artifact and block promotion until the deployment contract is fixed and reverified. If Cloudflare Pages is chosen, CI can use Wrangler Direct Upload to publish the retained prebuilt frontend bytes as a **new** production deployment; disable automatic production builds in a Git-integrated Pages project. A Pages preview cannot itself be promoted or used as a production rollback target. Verify the production asset hash and backend digests before smoke testing. If another hosting path rebuilds artifacts, prove source and output identity and repeat verification after any mismatch.

## 7. Ownership and enforcement

Before the first live release, decide who may merge into `dev` and `main`, who owns each suite, and who can approve production promotion. Require PRs, current green checks and resolved review comments. Code owners or a second reviewer should inspect security, billing, migration and deploy changes. Restrict CI credentials to the minimum scope and keep preview and production secrets separate.

The public GitHub repository has no branch protection or required checks configured yet. Until they are implemented, the release owner records the exact candidate SHA, check links and approval in the release PR and performs the merge manually. Treat protection and required checks as launch prerequisites, not as already enforced safeguards. Do not create an always-green placeholder CI check.

## References

- [GitHub required-check troubleshooting](https://docs.github.com/en/enterprise-cloud@latest/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks) and [protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).
- [Cloudflare Pages preview deployments](https://developers.cloudflare.com/pages/configuration/preview-deployments/), [CI Direct Upload](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/) and [rollback limits](https://developers.cloudflare.com/pages/configuration/rollbacks/).
- [GitHub deployment environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).
- [Playwright CI](https://playwright.dev/docs/ci) and [trace viewer](https://playwright.dev/docs/trace-viewer/).
