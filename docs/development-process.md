# JustUp development and release process

Status: proposed starting policy, 31 October 2026

This process applies to JustUp. Keep the policy small enough that every check has a clear purpose and owner. Add guidelines when a real review failure or recurring defect justifies one.

## 1. Branch and release contract

| Branch or ref | Purpose | Entry rule |
| --- | --- | --- |
| Short-lived feature branch | One coherent change, based on `dev`. | PR into `dev`. |
| `dev` | Integrated next version; never a production deployment source. | Selected PR checks and reviewed quality checklist pass. |
| `release/vX.Y.Z` | Frozen candidate cut from an exact `dev` commit. | PR into `main`; full release gate passes on the candidate and current base. |
| `main` | Source of released versions only. | Release PR or urgent hotfix PR; no direct pushes. |
| `vX.Y.Z` tag | Immutable production release identity. | Tag the tested `main` commit and record artifact digests. |

An urgent hotfix starts from `main`, runs the release gate for the affected candidate, and is merged back into `dev` immediately. After each release, merge `main` back into `dev`. If `main` or the release candidate changes while verification is running, repeat the affected gate against the new exact commit. Do not promote a moving branch alias or rebuild different production bytes after preview verification.

Release PRs use a merge commit, with current `main` an ancestor of the candidate. Record the candidate's Git tree hash. Before production promotion, compare the merged `main` tree hash with the verified candidate's tree hash; a mismatch blocks promotion and requires a new candidate and gate. The merge commit SHA may differ while its source tree is identical. This rule keeps previewed artifacts tied to the released source.

For JustUp's planned Cloudflare frontend and Hetzner API/runner, the release candidate preview must include compatible versions of **all three**, an isolated database and non-production credentials. Verify the immutable preview deployment and its API/runner artifact identities. After promotion, smoke-test production and retain the prior deployable artifacts and a database recovery path. A frontend-only preview cannot establish that the service works.

## 2. Contribution quality

Every PR completes the [PR template](../.github/PULL_REQUEST_TEMPLATE.md). For each guideline, check the box and write one short **Applied: evidence** or **N/A: reason** line. A script may enforce completion and valid format; a reviewer judges whether the explanation is true. A checked box alone is not evidence.

| ID | Guideline | Review question |
| --- | --- | --- |
| Q1 | Focus and maintainability | Is the change cohesive, readable, and placed at a clear ownership boundary without avoidable duplication? |
| Q2 | Contracts and failure behavior | Are inputs, outputs, errors, retries, concurrency and idempotency handled where relevant? |
| Q3 | Verification | Does the PR name the tests and checks that prove the change, including a relevant failure or edge path, and explain any gap? |
| Q4 | Security and privacy | Are authorization, secrets, dependency trust, personal data and data retention handled where touched? |
| Q5 | Data and deployment safety | Are schema/data changes compatible with deployed versions, observable, and recoverable? |
| Q6 | User experience | Are accessibility, language, loading, empty and error states handled where users see a change? |
| Q7 | Documentation and decisions | Are contracts, runbooks or design decisions updated where future contributors will need them? |

Keep this checklist stable and version its IDs. A PR may mark a guideline N/A only with a specific reason; for example, “N/A: this changes only the search evaluation fixture, with no user-facing UI.” Claims such as “N/A: not needed” are incomplete. Reviewers request evidence when the explanation is doubtful. Mechanical rules belong in formatters, linters, type checks and CI rather than prose.

## 3. Test creation, structure and maintenance

Each PR also completes the four testing guidelines below. For a change with no affected behavior or tests, give a specific N/A reason; a behavior change without an automated test needs an explicit exception, manual evidence and reviewer acceptance. A passing test command alone does not explain whether the right behavior was tested.

| ID | Guideline | Required practice |
| --- | --- | --- |
| T1 | Create meaningful tests | New behavior gets an assertion of an observable contract; a bug fix gets a reproducer that fails before the fix. Cover a relevant failure, boundary or state transition. Avoid duplicate cases, tests that only restate implementation, and test counts as a goal. |
| T2 | Put tests at the right level | Use the cheapest level that proves the contract. Keep pure logic tests beside their module; put API/provider contracts, database/runner integration, migrations and browser journeys in named suites. Choose one primary suite for each behavior and register its shared dependencies in the CI impact manifest. |
| T3 | Keep tests trustworthy | Use deterministic factories, fixed clocks/seeds and isolated state. Fake network calls by default; run real providers only in explicit integration or preview suites. Keep production secrets and personal data out of fixtures; preview tests use non-production credentials. Update tests when a reviewed contract changes, remove obsolete tests with an explanation, and never weaken assertions just to make CI green. |
| T4 | Evaluate AI behavior | Version reviewed cases and a held-out set for search interpretation, matching, company identity and Hiring Wire facts. Run the relevant evaluations when prompts, models, tool schemas or routing change; report quality, latency and cost against defined thresholds. Keep stochastic variance visible rather than treating one lucky run as proof. |

Use table-driven cases when several inputs exercise the same invariant. Prefer small fixtures with only the facts a test needs; avoid broad snapshots of rendered pages or provider responses unless the snapshot itself is the contract. Name tests by input condition and expected outcome so failures identify the broken behavior.

Prioritize integration cases where boundaries create risk: search revisions and stale responses, entitlement changes, SSE reconnect, idempotent billing and company requests, AI-decision invalidation, and stored-state migrations across old and new API/runner versions. Keep a small browser set for the critical user journeys; do not duplicate every unit scenario in a browser. Test data and fixtures are owned alongside their suites, with changes to shared fixtures widening CI selection.

Every suite has an owner, purpose, expected runtime and CI lane. Track failures and duration. Quarantine a flaky test only with an owner, issue, expiry and replacement signal during quarantine; fix or delete it before expiry. A removed test must follow removed behavior or be replaced by evidence at a better level. Review test additions that materially increase suite time or repeat an existing invariant.

## 4. CI that selects relevant tests

One required, always-running `CI / decision` check owns the result of each PR. It reports the changed paths, selected suites, reasons for selection and reasons for any skip. It fails if a required suite fails, a selected suite does not report a result, or the selection script fails. An unknown path triggers the full suite and is reported as a fallback; a passing full run may clear the check. Do not path-filter the required workflow itself: GitHub can leave a required check pending when the whole workflow is skipped.

Keep suite ownership and impact rules in one reviewed manifest next to the CI selector. Start with explicit groups for frontend, API, runner, database/migrations, search and AI evaluations, billing/access, and deployment/infrastructure. Selection uses the diff against the actual PR base, includes dependents of changed shared contracts, and can be expanded with a `full-ci` override. Changes to the selector, workflows, lockfiles, shared types, authentication/access, billing, database schema, deployment contracts, model prompts, tool schemas or model versions receive broad or full coverage. Unknown paths fail closed to the full suite. Test the selector with representative change sets.

Ordinary PRs run a fast baseline (format, lint/type checks for touched code, PR-template validation, and relevant build checks) plus selected behavioral suites against the proposed merge result with current `dev`, not only the feature head. Run the full suite on every release candidate and on a scheduled `dev` run so selection mistakes are detected before release. Keep the full run observable: record duration, failure rate and flaky tests. Set time budgets for each suite and review additions that make CI materially slower.

Define AI evaluation pass/fail thresholds from representative baselines before the first live release; running an evaluation without an acceptance threshold does not make the release gate green.

## 5. Release gate

The release PR from the frozen candidate to `main` must record a named release owner, changelog, migration and rollback steps, feature flags, known limitations and candidate SHA. Its gate is:

1. Full static, build, unit, integration, browser, migration and AI evaluation suites pass on the exact candidate with the current `main` base.
2. Deploy the candidate's versioned frontend, API and runner artifacts to an isolated preview. Record immutable deployment URLs and artifact digests.
3. Run scripted critical journeys against that preview: sign-in and entitlement, search planning and result correctness, AI narrowing and honest failure states, SSE reconnect, company request, Hiring Wire, billing callback, and data handoff where relevant. Verify both an ordinary and a failure path. Keep the journey set small and expand it only when a release escapes with an uncovered failure.
4. Confirm backups, forward-compatible migrations, rollback steps, monitoring and alert readiness. Rehearse a restore/rollback before the first live release and after material data-contract changes.
5. Merge only the verified candidate. Verify the merged `main` tree hash matches the candidate, tag the exact `main` commit, promote the same artifacts, and run production smoke checks. Watch error rate, latency, queue lag and business-critical results for a defined observation window. Define observation thresholds before launch; roll back or disable a feature if the release fails them.

The production deploy should be triggered by an explicit promotion of the tested release, not an automatic deploy of every `main` push. If the hosting integration cannot preserve artifact identity, the release workflow must prove source and build identity and rerun verification after any rebuild.

## 6. Ownership and enforcement

Before the first live release, decide who may merge into `dev` and `main`, who owns each suite, and who can approve production promotion. Require PRs, current green checks and resolved review comments. Code owners or a second reviewer should inspect security, billing, migration and deploy changes. Restrict CI credentials to the minimum scope and keep preview and production secrets separate.

The current private GitHub repository does not expose branch-rule enforcement under the account's present plan (the rules API returns a plan restriction). Until enforcement is available, the release owner records the exact candidate SHA, check links and approval in the release PR and performs the merge manually. Treat this as a launch prerequisite to resolve, not as an already enforced safeguard. Do not create an always-green placeholder CI check.

## 7. Adoption

1. **Now:** agree on this policy, use the PR checklist, define the initial suite manifest and critical journeys when the application code is scaffolded.
2. **Before JustUp launch:** implement the CI selector and always-running decision check, release preview, immutable artifact promotion, recovery test and available branch protections. Set AI and production-health pass thresholds. Measure and publish baseline CI duration and release verification time.

## References

- [GitHub required-check troubleshooting](https://docs.github.com/en/enterprise-cloud@latest/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks) and [protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).
- [Cloudflare Pages preview deployments](https://developers.cloudflare.com/pages/configuration/preview-deployments/) and [deployment controls](https://developers.cloudflare.com/api/resources/pages/index.html).
- [GitHub deployment environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).
