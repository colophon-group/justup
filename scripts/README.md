---
summary: Repository-owned CI, immutable deployment and offline ingestion tools.
read_when: Changing verification, packaging, runtime startup or recovery.
---

# Repository scripts

`ci.py` reads the pull-request event and changed paths, checks the work-based branch name and quality checklist, and verifies local guide links and each root guide's summary and guidebook entry. It then runs the suites selected by its reviewed `IMPACT` map. Checklist explanations may link an issue. Its `selftest` command checks naming, selection, checklist and guidebook rules.

The full runtime lane covers strict TypeScript checking, a Vite production build, pure web contracts (`test:web`), deployment contracts (`test:deployment`), server contracts (`test:server`), offline Python contracts (`test:python`), and Playwright browser journeys (`test:browser`). CI pins Node 24.22.2 for the backend built-in SQLite module. Web changes select typecheck, build, web, deployment and browser; server changes select build, deployment, server and Python; offline Python changes select build, deployment and Python; deployment changes select build, deployment, server, Python and browser. The deployment suite imports compiled web assets, so CI builds them first for every change that selects that suite. Shared configuration, dependency and CI-tooling changes run all suites. Unknown paths also run all suites. Guide-only changes run policy and local-link checks. Each selected suite must be registered and pass; missing results fail the check. `python3 scripts/ci.py selftest` covers representative selection, build prerequisites and main-release-blocking rules.

`frontend-prepare.mjs` builds an exact committed package/config/web snapshot in a credential-free temporary build context and retains compiled assets and edge bytes; `frontend-configure.mjs` verifies that retained artifact and writes approved runtime routing config; `frontend-smoke.mjs` performs bounded read-only deployed checks. See [frontend delivery](../docs/frontend-delivery.md) before using them. They have no provider writes or credential access.

The required GitHub check is `CI / decision`. It reports selected suites, the reason and each duration. An unfamiliar path runs all suites. Release PRs into `main` run all suites, then remain blocked until the release preview gate exists; application changes target `dev`. `CI / full suite` runs against `dev` on a weekly schedule and by manual dispatch after the workflow is installed on the default branch. GitHub schedules only workflow files on the default branch, so a change to the schedule in `dev` starts after that workflow change reaches `main`.

The private [company setup handoff](company-requests/README.md) provides one bounded pending read and a revision-checked progress update against existing protected application storage. It aggregates stored acceptance-time priority grants and runs no configuration, crawler, model or provider. The exact command bytes ship with the application artifact.

`test-deployment.mjs` recursively discovers `deploy/**/*.test.mjs` plus `scripts/preview-*.test.mjs`. `test-python.py` discovers `scripts/test_*.py`, reports an absent offline suite explicitly, and rejects an importer implementation without its `test_import_jobs.py` contracts. CI logs each runner duration and its exact selected files or unavailable reason. A backend preview implementation without its own registered Node/Python contracts fails instead of passing on frontend tests alone. Backend owners must provide and execute any nonstandard preview checks before calling them registered.

`test-web.mjs` recursively runs pure `web/src/**/*.test.ts` contracts with Node 24 type stripping, paired with the required strict TypeScript check. Playwright serves `web/dist` through Vite preview with existing-server reuse disabled, so source or a stale server cannot satisfy built-application verification. No source files or test fixtures are deployed.

The backend deployment tools retain their `preview-*` filenames because they operate the reviewed temporary host. They launch the same product runtime with `JUSTUP_*` configuration; no legacy environment aliases are accepted. `preview-artifact.py` packages canonical runtime adapters and `import-jobs.py`, immutable task schemas/catalogues and the pinned native runtimes. See [operations](../docs/operations.md) before host changes or recovery. The offline deployment wrapper checks inventory, scoped configuration, task-specific model proof, preview identity, resource boundaries and deletion-safe restore using fake/local inputs.

Application artifacts declare database epoch 2. Current protected API/queue launchers and host switching compare that epoch with actual SQLite before executing/selecting a release. `preview-recovery.py migrate` binds the exact staged target, closes launches, proves all dedicated identities idle, takes a deletion-safe online backup and invokes the fixed atomic migration as the API UID. An incomplete operation retains its maintenance lock. Epoch-1 snapshots require explicit forward migration before auth-owned session invalidation; no downgrade exists. See the [schema guide](../docs/schema.md) and keep these protected tools current independently of retained application artifacts.

`import-jobs.py --company-ids-file` optionally pins the operator QA export to 1–100 exact source company UUIDs without changing the default global sample. The private schema-1 selector, bounded selection receipt, missing-company/language review and known-ID refresh behavior are described in [job data](../docs/job-data.md#refresh-a-fixed-qa-company-cohort). It does not select an approved launch segment or remove existing store evidence.

`preview-feed.py` prepares a private, bounded intake on the existing Justup preview mount. Its `send` command streams a reviewed manifest and parts; the restricted SSH `relay` passes bytes to a socket-activated receiver inside the preview slice. The receiver verifies and stages bytes but cannot acknowledge a batch. A separate root operator `import` uses the exact active artifact's importer, then acknowledges a partial page only after durable staging or a complete batch only after the application database confirms the import. `receipt` returns just the producer's digest proof. The socket, SSH command and host unit upgrade are not installed or enabled by this repository change; [operations](../docs/operations.md#private-job-feed-handoff) explains the current gate.

The feed's Python contracts also run the actual feed adapter and pinned Node SQLite importer against synthetic private batches, including partial catch-up and recovery after database commit. They substitute the local identity, Python interpreter and host configuration; they do not establish target-host confinement or real-source coverage.

Every accepted receipt read syncs the validated file and its parent directory before returning proof. A synchronization failure blocks acknowledgement on both publication and replay; a durable historical receipt remains replayable after a later build switch.


`account-test-journey.mjs` is an explicit protected operator mailbox-proof command
and an importable synthetic-test helper. It creates one disposable account,
queues one authorized email through the existing adapter, requires mailbox code
input, activates the ordinary week separately and verifies account deletion in
`finally`. It uses no provider credentials, activates no runtime configuration
and never runs Stripe. Failed cleanup retains a protected recovery file and
fails the receipt. Review the exact recipient packet and limits in
[account verification](../docs/account-verification.md#run-one-bounded-operator-mailbox-proof)
before an operator runs it. Its automatic contract suite lives at
`server/account-test-journey.test.mjs`; CI uses synthetic transport only.
