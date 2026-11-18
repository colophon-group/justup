---
summary: Fixed model fixtures and the protected one-use Luna qualification path.
read_when: Changing model cases, scoring, numeric broker metrics or preparing a protected live qualification.
---

# Model evaluation

Read [the model guide](../../docs/models.md) before changing a task profile or preparing a live check. `intent-heldout.json` and `company-heldout.json` record broader provider-free contracts. `luna-qualification-v1.json` fixes the case order, expectations and repeats. `luna-qualification.mjs` scores redacted outcomes and uses a digest-bound independent reviewer decision for ambiguous company cases. The [protected host procedure](../../docs/operations.md#run-a-protected-luna-qualification) binds the exact artifact, installed plan and approved one-use grant to a fixed transient sandbox. A direct invocation outside that service is rejected. Actual host execution and protected clarification review remain release evidence. Local tests use fake model responses and make no provider or host calls.
