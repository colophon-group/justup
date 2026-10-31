## Issue

Primary issue: #123 (replace with the actual number, or write `N/A: trivial correction`)

## Changes

State what changed, including removed or replaced paths. Keep motivation, alternatives and decisions in the issue.

## Quality checklist

Check every item. After the dash, replace `Applied` with `N/A` where appropriate and replace the placeholder with one short explanation or evidence. See the [quality and testing guidelines](https://github.com/colophon-group/justup/blob/main/docs/development-process.md).

- [ ] Q1 Focus and maintainability — Applied: [explanation or evidence]
- [ ] Q2 Contracts and failure behavior — Applied: [explanation or evidence]
- [ ] Q3 Verification — Applied: [explanation or evidence]
- [ ] Q4 Security and privacy — Applied: [explanation or evidence]
- [ ] Q5 Data and deployment safety — Applied: [explanation or evidence]
- [ ] Q6 User experience — Applied: [explanation or evidence]
- [ ] Q7 Current-state code and docs — Applied: [current behavior documented or specific N/A reason]
- [ ] Q8 Transform before adding — Applied: [what was replaced or removed, or specific N/A reason]
- [ ] Q9 Dependency budget — Applied: [package/version and affected surface; link issue decision, or N/A: no dependency change]
- [ ] Q10 Resource authorization — Applied: [resource issue and approval/pending status; confirm no allocation while pending, or N/A: no new service or spend]
- [ ] T1 Create meaningful tests — Applied: [behavior covered or specific N/A reason]
- [ ] T2 Put tests at the right level — Applied: [suite and reason or specific N/A reason]
- [ ] T3 Keep tests trustworthy — Applied: [fixtures and maintenance evidence or specific N/A reason]
- [ ] T4 Evaluate AI behavior — Applied: [evaluation result or specific N/A reason]

## Tests and verification

Name added or changed tests, their suites and the failure or edge case they cover. List commands, CI checks, preview URL or manual steps used. State any verification that remains for the release gate.

## Prerelease preview (release PRs only)

Record the candidate SHA, `main` base OID and tree hash, immutable preview URL and deployment IDs, frontend/API/runner artifact digests, `Preview / verified` report, and release-owner review. Ordinary PRs may remove this section.

## Release impact

Note migrations, flags, deployment order, rollback steps or monitoring changes. Write `None` with a reason if none apply.
