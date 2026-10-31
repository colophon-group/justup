---
summary: Small repository-owned checks used by Justup pull-request CI.
read_when: Changing test selection or the pull-request quality gate.
---

# CI scripts

`ci.py` reads the pull-request event and changed paths, checks the work-based branch name, verifies the quality checklist and local guide links, then runs the full runtime lane when application, test, deployment or CI tooling files change. Checklist explanations may link an issue. The script also has a `selftest` command for its naming, selection and checklist rules.

The full runtime lane uses `npm run test:full`: strict TypeScript checking, a Vite production build, pure web contracts (`test:web`), frontend deployment contracts (`test:deployment`), all available server contracts (`test:server`), offline Python contracts (`test:python`), and every Playwright browser journey (`test:browser`, including public policy pages when integrated). CI pins Node 24.22.2 and the runtime baseline requires Node 24 for the backend built-in SQLite module. `test-server.mjs` reports absence only when the candidate has no `server/` directory; any present server tree must contain discoverable `.test.mjs` contracts, which run recursively. Backend changes select this full lane and remain blocked from main until release verification. Frontend hosting owns the edge/packaging suite, expected under five seconds; the interface owner maintains browser journeys. Application, dependency, deployment and CI-tooling changes run this broad lane. Documentation-only changes keep the fast policy/link lane. `python3 scripts/ci.py selftest` covers representative selection and main-release-blocking rules.

`frontend-prepare.mjs` builds an exact committed package/config/web snapshot in a credential-free temporary build context and retains compiled assets and edge bytes; `frontend-configure.mjs` verifies that retained artifact and writes approved runtime routing config; `frontend-smoke.mjs` performs bounded read-only deployed checks. See [preview hosting](../docs/demo-preview-hosting.md) before using them. They have no provider writes or credential access.

The required GitHub check is `CI / decision`. It reports which suites ran and why. A path it does not recognize requires a registered `test:full` suite or an update to the reviewed impact rules. Runtime changes to `main` fail until the release preview gate exists; application changes target `dev`.

`test-deployment.mjs` recursively discovers `deploy/**/*.test.mjs` plus `scripts/preview-*.test.mjs`. `test-python.py` discovers `scripts/test_*.py`, reports an absent offline suite explicitly, and rejects an importer implementation without its `test_import_demo_jobs.py` contracts. CI logs each runner duration and its exact selected files or unavailable reason. This first small application runs every available suite for broad changes rather than maintaining speculative dependency groups; unknown paths use that same full lane. A backend preview implementation without its own registered Node/Python contracts fails instead of passing on frontend tests alone. Backend owners must provide and execute any nonstandard preview checks before calling them registered.

`test-web.mjs` recursively runs pure `web/src/**/*.test.ts` contracts with Node 24 type stripping, paired with the required strict TypeScript check. Playwright serves `web/dist` through Vite preview with existing-server reuse disabled, so source or a stale server cannot satisfy built-application verification. No source files or test fixtures are deployed.
