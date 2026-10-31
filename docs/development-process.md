---
summary: How to record work, review changes, test and release Justup.
read_when: Filing an issue, committing, opening a pull request or preparing a release.
---

# Contributing and releasing Justup

This guide applies to Justup contributions now. All application work, including browser-only code, uses the same review and test path. The live service and the full prerelease preview gate are not implemented yet; no live release may proceed until that gate exists and passes. Update this guide when the repository state changes.

A pull request (PR) is a proposed change reviewed before it joins a branch. The tables below use that short form.

| I need to... | Go to |
| --- | --- |
| Record a bug, simplification or other discovery | [Issues and discoveries](#2-issues-discoveries-and-resource-approval) |
| Prepare a change or review | [Contribution quality](#3-contribution-quality) and [test guidance](#4-test-creation-structure-and-maintenance) |
| Understand what automated checks will run | [Pull request checks](#5-automated-checks-for-pull-requests) |
| Prepare a release | [Branch requirements](#1-branch-and-release-requirements) and [release verification](#6-verify-a-release-before-it-goes-live) |

## 1. Branch and release requirements

Application feature branches target `dev`, including work that began as a browser demonstration. A change cannot bypass tests or merge into `main` because its first version runs only in the browser. `main` receives release and urgent hotfix PRs; its full preview deployment gate must be implemented before a live release. Repository setup and policy changes may enter `main` through a reviewed PR with current checks while the first release is being prepared.

| Branch or ref | Purpose | Entry rule |
| --- | --- | --- |
| Short-lived feature branch | One coherent change, based on `dev`. | PR into `dev`. |
| `dev` | Integrated next version; never a production deployment source. | Selected PR checks and reviewed quality checklist pass. |
| `release/vX.Y.Z` | Frozen candidate cut from an exact `dev` commit. | PR into `main`; full release gate passes on the candidate and current base. |
| `main` | Stable baseline and source of released versions. | Release or urgent hotfix PR; before launch, reviewed repository-setup or policy PR. No direct pushes. |
| `vX.Y.Z` tag | Immutable production release identity. | Tag the tested `main` commit and record artifact digests. |

An urgent hotfix starts from `main`, runs the release gate for the affected candidate, and is merged back into `dev` immediately. After each release, merge `main` back into `dev`. If `main` or the release candidate changes while verification is running, repeat the affected gate against the new exact commit. Do not promote a moving branch alias or rebuild different production bytes after preview verification.

Release PRs use a merge commit, with current `main` an ancestor of the candidate. Record the candidate's Git tree hash. Before production promotion, compare the merged `main` tree hash with the verified candidate's tree hash; a mismatch blocks promotion and requires a new candidate and gate. The merge commit SHA may differ while its source tree is identical. This rule keeps previewed artifacts tied to the released source.

For Justup's planned Cloudflare-hosted website, Hetzner-hosted server interface (API) and background worker (runner), the prerelease preview must include compatible versions of **all three**, an isolated database and non-production credentials. Verify the fixed preview URL and the exact server and worker builds. After release, check the live service and retain the previous deployable builds and a database recovery path. A website-only preview cannot establish that the service works.

## 2. Issues, discoveries and resource approval

Open one issue for each meaningful work item. Give it a plain-language title in the form `<Area>: <desired outcome>`, such as `Search: keep results after a failed interpretation`. Choose a unique, stable slug of short lowercase words separated by hyphens, such as `search-keep-valid-results`. Put `Slug: search-keep-valid-results` at the top of the issue body. Search for a matching slug before creating an issue; if it exists, choose more specific words. The title may improve as the work becomes clearer, but keep the slug unchanged. A pure typo or metadata correction may omit an issue if it has no enduring context to preserve.

If you notice a separate bug, possible simplification, maintenance task, documentation gap or other concern while working on code:

1. Note the observable behavior, affected file or area and why it matters. Do not include credentials or personal data.
2. Search open and closed issues by behavior, file path and slug. If one already covers the same outcome, add the new evidence there.
3. Otherwise open an issue with the [work-item template](../.github/ISSUE_TEMPLATE/work.md). Explain the motivation, current context, desired outcome and how to tell when it is addressed. Choose one type label from the table below; use `blocked` only while a decision or dependency is pending.
4. Keep the current change focused. Address a finding in the current pull request only when it is needed for that request; otherwise leave the new issue for separate work.

Write each issue so a reader understands it without opening another document: use ordinary words, define necessary project terms the first time they appear, and link files or evidence for detail. Record material decisions and rejected alternatives in the issue discussion. Code comments and product docs describe current behavior, without a timeline of earlier approaches.

Use an imperative commit subject with the slug visible in one-line file history: `Keep valid search results after model failure (search-keep-valid-results)`. Every commit for the work uses that slug, including the final subject if commits are squashed. To find context for a file, inspect its Git history, take the slug from the relevant commit and search issue bodies for that exact `Slug:` line. Published older commits are kept intact.

A pull request description links its primary issue and states the changes, verification and release impact in plain language. It should make sense on its own, without repeating the issue's motivation. Close the issue when its desired outcome is accepted.

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
| Q2 | Contracts and failure behavior | Are inputs, outputs, errors, retries, concurrent work and safe repeated requests handled where relevant? |
| Q3 | Verification | Does the PR name the tests and checks that prove the change, including a relevant failure or edge path, and explain any gap? |
| Q4 | Security and privacy | Are authorization, secrets, dependency trust, personal data and data retention handled where touched? |
| Q5 | Data and deployment safety | Are schema/data changes compatible with deployed versions, observable, and recoverable? |
| Q6 | User experience | Are accessibility, language, loading, empty and error states handled where users see a change? |
| Q7 | Current-state code and docs | Do code, comments, tests, examples and docs describe what exists now, with obsolete paths and historical narrative removed? |
| Q8 | Transform before adding | Does the change reshape or replace the existing path where possible, removing superseded code, tests and docs instead of accumulating parallel versions? If temporary compatibility is needed, is its owner and removal condition clear? |
| Q9 | Dependency budget | Are new packages and their indirect dependencies avoided where a small existing solution suffices? If added, does the issue record alternatives and why the package reduces the total code and systems to maintain enough to justify upgrades and security review, while the pull request names the actual package change? |
| Q10 | Resource authorization | Does work needing a new external service or infrastructure spend link to a separate `resource-request` issue, with no provisioning before explicit human approval? |
| Q11 | Clear navigation | Can a new reader understand the change without unexplained project terms, and do touched files or directories have short purpose and read-when summaries where useful? |

Keep this checklist stable and version its IDs. A PR may mark a guideline N/A only with a specific reason; for example, “N/A: this changes only the search evaluation fixture, with no user-facing UI.” Claims such as “N/A: not needed” are incomplete. Reviewers request evidence when the explanation is doubtful. Mechanical rules belong in formatters, linters, type checks and CI rather than prose.

Write guides around the task a reader is trying to complete, with steps before detailed reference. Start substantive Markdown guides with two short metadata fields: `summary` says what the guide covers, and `read_when` says when to open it. A directory README gives the same orientation for a group of files. A source file with a non-obvious purpose gets a brief top-of-file comment explaining its role and when to read it. Skip headers on tiny self-explanatory files, generated code, vendored libraries and data snapshots; their directory guide can cover them. Keep the root `AGENTS.md` short and use it to route agents to the appropriate guide rather than repeating the guides there. Update these summaries when file responsibilities change.

## 4. Test creation, structure and maintenance

Each PR also completes the four testing guidelines below. For a change with no affected behavior or tests, give a specific N/A reason; a behavior change without an automated test needs an explicit exception, manual evidence and reviewer acceptance. Browser-only application work does not qualify for an exception merely because it started as a demonstration. A passing test command alone does not explain whether the right behavior was tested.

| ID | Guideline | Required practice |
| --- | --- | --- |
| T1 | Create meaningful tests | New behavior gets an assertion of an observable contract; a bug fix gets a reproducer that fails before the fix. Cover a relevant failure, boundary or state transition. Avoid duplicate cases, tests that only restate implementation, and test counts as a goal. |
| T2 | Put tests at the right level | Use the cheapest level that proves the contract. Keep pure logic tests beside their module; put API/provider contracts, database/runner integration, migrations and browser journeys in named suites. Choose one primary suite for each behavior and register its shared dependencies in the CI impact manifest. |
| T3 | Keep tests trustworthy | Use deterministic factories, fixed clocks/seeds and isolated state. Fake network calls by default; run real providers only in explicit integration or preview suites. Keep production secrets and personal data out of fixtures; preview tests use non-production credentials. Update tests when a reviewed contract changes, remove obsolete tests with an explanation, and never weaken assertions just to make CI green. |
| T4 | Evaluate AI behavior | Version reviewed cases and a held-out set for search interpretation, matching, company identity and weekly company-activity facts. Run the relevant evaluations when prompts, models, tool schemas or routing change; report quality, latency and cost against defined thresholds. Keep stochastic variance visible rather than treating one lucky run as proof. |

Use table-driven cases when several inputs exercise the same invariant. Prefer small fixtures with only the facts a test needs; avoid broad snapshots of rendered pages or provider responses unless the snapshot itself is the contract. Name tests by input condition and expected outcome so failures identify the broken behavior.

Prioritize integration cases where boundaries create risk: search revisions and stale responses, access changes, reconnecting the live result stream (Server-Sent Events), billing and company requests that must take effect only once, invalidating old AI decisions, and moving stored state between old and new server/background-worker versions. Keep a small browser set for the critical user journeys; do not duplicate every unit scenario in a browser. Start that suite with Playwright for the new web application; Selenium is also viable if a concrete browser or team need warrants it. Use selectors based on visible labels and roles, and check observable outcomes rather than sleeps or broad page snapshots. Test data and fixtures are owned alongside their suites, with changes to shared fixtures widening the automated checks selected for a change.

Every suite has an owner, purpose, expected runtime and CI lane. Track failures and duration. Quarantine a flaky test only with an owner, issue, expiry and replacement signal during quarantine; fix or delete it before expiry. A removed test must follow removed behavior or be replaced by evidence at a better level. Review test additions that materially increase suite time or repeat an existing invariant.

## 5. Automated checks for pull requests

Each pull request gets one always-running `CI / decision` result. It reports which changed paths selected which test groups and why anything was skipped. It fails if a required group fails, does not report a result, or the selection script fails. An unfamiliar path runs the full available suite and reports that fallback. Do not skip the entire required workflow based on paths: GitHub can leave a required result pending when its workflow never starts.

Keep test ownership and impact rules in one reviewed map next to the selection script. The first application checks cover browser source syntax and the small browser journey suite. Add groups for server, background worker, database, search and AI checks, billing/access, and deployment as those parts are built. Selection compares changed files with the pull request's actual base and includes tests that depend on shared contracts. As suites grow, add an explicit override to run them all. Changes to the selector, workflows, dependency lockfiles, shared types, access control, billing, database schema, deployment contracts, model instructions, tool definitions or model versions need broad or full coverage. Unfamiliar paths run the full available suite. Test the selection script with representative change sets.

Ordinary PRs run a fast baseline plus selected behavioral suites against the proposed merge result with current `dev`, not only the feature head. The first application lane checks browser-source syntax and critical browser journeys; add format, lint, type and build checks as their tools become part of the application. Run the full suite on every release candidate; add a scheduled full `dev` run before release so selection mistakes are detected. Keep the full run observable: record duration, failure rate and flaky tests. Set time budgets for each suite and review additions that make CI materially slower.

Define AI evaluation pass/fail thresholds from representative baselines before the first live release; running an evaluation without an acceptance threshold does not make the release gate green.

## 6. Verify a release before it goes live

The release pull request from the frozen version proposed for release (the candidate) to `main` must record a named release owner, changelog, data-migration and rollback steps, feature flags, known limitations and candidate Git commit ID. A commit ID (often called a SHA or OID) identifies exact source code; an artifact digest is a hash identifying a built file or image. In this section, the frontend is the website, the API is its server interface, and the runner is the background worker. The release gate is:

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
| AI narrowing (extra model-based filtering) | Browser + API | One successful and one honest failure journey render correctly; server checks distinguish rejected, insufficient-evidence and provider-failure states. |
| Live results | Browser + API | New results and reconnection work through Cloudflare; server checks prevent duplicates and updates to an old search revision. |
| Background work | Worker/API + browser result | A test worker task completes once; repeated company requests have one effect, and the weekly company-activity summary called Hiring Wire is visible. |
| Billing and data | API/migration + browser result | A signed sandbox callback and replay produce one entitlement change; the browser reflects it and migration of representative prior state succeeds. |

Use deterministic provider fixtures for broad journeys and a bounded real-provider contract check where that provider is required for release. Run the browser smoke set in desktop Chromium and one mobile browser profile on release; add more browsers only for a supported compatibility promise or a demonstrated defect. Assertions check behavior and state, with screenshots or traces retained for diagnosis. Set test and readiness timeouts. The gate fails on a missing deployment, identity mismatch, failed journey, unavailable required provider, or missing result. Publish a concise report with the candidate SHA, base OID, deployment IDs, digests, test counts and sanitized failure traces. Keep a successful preview available for release-owner review, then destroy it after the release decision. On failed or cancelled runs, an always-run finalizer captures diagnostics and cleans up. Enforce an independent expiry for abandoned previews; alert the release owner and block another candidate if cleanup fails.

The production deploy is an explicit release action, not an automatic build on every `main` push. Same-byte frontend deployment requires runtime configuration or stable relative routes for API/auth origins and environment-specific public keys. This is a launch prerequisite: preview-specific values embedded at build time invalidate the tested artifact and block promotion until the deployment contract is fixed and reverified. If Cloudflare Pages is chosen, CI can use Wrangler Direct Upload to publish the retained prebuilt frontend bytes as a **new** production deployment; disable automatic production builds in a Git-integrated Pages project. A Pages preview cannot itself be promoted or used as a production rollback target. Verify the production asset hash and backend digests before smoke testing. If another hosting path rebuilds artifacts, prove source and output identity and repeat verification after any mismatch.

## 7. Ownership and enforcement

Before the first live release, decide who may merge into `dev` and `main`, who owns each suite, and who can approve production promotion. Require PRs, current green checks and resolved review comments. Code owners or a second reviewer should inspect security, billing, migration and deploy changes. Restrict CI credentials to the minimum scope and keep preview and production secrets separate.

Keep `dev` and `main` protected against direct pushes and require current `CI / decision` results before merging. If a branch rule or required check is missing, stop the application merge and restore the gate. The full preview deployment and `Preview / verified` release check are not implemented yet; they must pass before a live release. Do not create an always-green placeholder check.

## References

- [GitHub required-check troubleshooting](https://docs.github.com/en/enterprise-cloud@latest/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks) and [protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).
- [Cloudflare Pages preview deployments](https://developers.cloudflare.com/pages/configuration/preview-deployments/), [CI Direct Upload](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/) and [rollback limits](https://developers.cloudflare.com/pages/configuration/rollbacks/).
- [GitHub deployment environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).
- [Playwright CI](https://playwright.dev/docs/ci) and [trace viewer](https://playwright.dev/docs/trace-viewer/).
