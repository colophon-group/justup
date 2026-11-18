---
summary: Fixed model fixtures and protected Luna and JEV qualification paths.
read_when: Changing model cases, scoring, numeric broker metrics or preparing a protected live qualification.
---

# Model evaluation

Read [the model guide](../../docs/models.md) before changing a task profile or preparing a live check. `intent-heldout.json` and `company-heldout.json` record broader provider-free contracts. `luna-qualification-v1.json` fixes the case order, expectations and repeats. `luna-qualification.mjs` scores redacted outcomes. `luna-qualification-review.mjs` seals ambiguous replies to the independent reviewer's key and validates the exact operator-recorded report. The [protected host procedure](../../docs/operations.md#run-a-protected-luna-qualification) binds the artifact, installed plan and one-use grant to a fixed transient sandbox and explains the offline reviewer command. Actual host execution and an independent human verdict remain release evidence. Local tests use fake model responses and make no provider or host calls.

`matching-cases-v1.json` defines the synthetic held-out JEV labels. The
[JEV procedure](../../docs/operations.md#run-the-protected-jev-held-out-check)
uses `jev-qualification-cli.mjs` to run them through the protected queue's
ordinary transport and spend guard. It emits a fixed verdict and redacted
measurements. The real job-slice evaluation remains a separate release check.
