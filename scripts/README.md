---
summary: Small repository-owned checks used by Justup pull-request CI.
read_when: Changing test selection or the pull-request quality gate.
---

# CI scripts

`ci.py` reads the pull-request event and changed paths, checks the work-based branch name, verifies the quality checklist and local guide links, then runs the full runtime lane when application, test, deployment or CI tooling files change. Checklist explanations may link an issue. The script also has a `selftest` command for its naming, selection and checklist rules.

The full runtime lane uses `npm run test:full`: browser-source syntax, dependency-free frontend deployment contracts (`test:deployment`), and every Playwright browser journey (`test:browser`, including public policy pages when integrated). Frontend hosting owns the edge/packaging suite, expected under five seconds; the interface owner maintains browser journeys. Application, dependency, deployment and CI-tooling changes run this broad lane. Documentation-only changes keep the fast policy/link lane. `python3 scripts/ci.py selftest` covers representative selection and main-release-blocking rules.

`frontend-prepare.mjs` snapshots exact committed public assets and edge bytes; `frontend-configure.mjs` verifies that retained artifact and writes approved runtime routing config; `frontend-smoke.mjs` performs bounded read-only deployed checks. See [preview hosting](../docs/demo-preview-hosting.md) before using them. They have no provider writes or credential access.

The required GitHub check is `CI / decision`. It reports which suites ran and why. A path it does not recognize requires a registered `test:full` suite or an update to the reviewed impact rules. Runtime changes to `main` fail until the release preview gate exists; application changes target `dev`.
