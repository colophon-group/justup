---
summary: Fixed provider-free fixtures and the blocked Luna qualification path.
read_when: Changing model cases, scoring, numeric broker metrics or preparing a protected live qualification.
---

# Model evaluation

Read [the model guide](../../docs/models.md) before changing a task profile or preparing a live check. `intent-heldout.json` and `company-heldout.json` record broader provider-free contracts. `luna-qualification-v1.json` fixes the case order, expectations and repeats; `luna-qualification.mjs` scores only redacted outcomes. The ambiguous-company cases require a clarification naming the requested company and asking for identifying detail. The CLI and queue launcher have a prepared one-use path, but the CLI rejects live execution because no fixed protected qualification service is installed or in the host plan. A later host change must review and install that sandbox before removing the source gate or creating a root grant. Local tests use fake model responses and make no provider or host calls.
