---
summary: Small repository-owned checks used by Justup pull-request CI.
read_when: Changing test selection or the pull-request quality gate.
---

# CI scripts

`ci.py` reads the pull-request event and changed paths, checks the work-based branch name, verifies the quality checklist and local guide links, then runs the browser suite when application, test or CI tooling files change. Checklist explanations may link an issue. The script also has a `selftest` command for its naming, selection and checklist rules.

The required GitHub check is `CI / decision`. It reports which suites ran and why. A path it does not recognize requires a registered `test:full` suite or an update to the reviewed impact rules. Runtime changes to `main` fail until the release preview gate exists; application changes target `dev`.
