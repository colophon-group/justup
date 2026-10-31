## Change

What changes, and why? Link the issue or decision when one exists.

## Quality checklist

Check every item. After the dash, replace `Applied` with `N/A` where appropriate and replace the placeholder with one short explanation or evidence. See the [quality and testing guidelines](https://github.com/colophon-group/fresh-jobs-ui/blob/main/docs/development-process.md).

- [ ] Q1 Focus and maintainability — Applied: <explanation or evidence>
- [ ] Q2 Contracts and failure behavior — Applied: <explanation or evidence>
- [ ] Q3 Verification — Applied: <explanation or evidence>
- [ ] Q4 Security and privacy — Applied: <explanation or evidence>
- [ ] Q5 Data and deployment safety — Applied: <explanation or evidence>
- [ ] Q6 User experience — Applied: <explanation or evidence>
- [ ] Q7 Documentation and decisions — Applied: <explanation or evidence>
- [ ] T1 Create meaningful tests — Applied: <behavior covered or specific N/A reason>
- [ ] T2 Put tests at the right level — Applied: <suite and reason or specific N/A reason>
- [ ] T3 Keep tests trustworthy — Applied: <fixtures and maintenance evidence or specific N/A reason>
- [ ] T4 Evaluate AI behavior — Applied: <evaluation result or specific N/A reason>

## Tests and verification

Name added or changed tests, their suites and the failure or edge case they cover. List commands, CI checks, preview URL or manual steps used. State any verification that remains for the release gate.

## Prerelease preview (release PRs only)

Record the candidate SHA, `main` base OID and tree hash, immutable preview URL and deployment IDs, frontend/API/runner artifact digests, `Preview / verified` report, and release-owner review. Ordinary PRs may remove this section.

## Release impact

Note migrations, flags, deployment order, rollback steps or monitoring changes. Write `None` with a reason if none apply.
