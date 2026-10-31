---
summary: Cloudflare edge delivery and isolated contract tests for the retained Justup frontend artifact.
read_when: Changing same-origin API routing, frontend security headers or exact-candidate verification.
---

# Frontend hosting boundary

`worker.mjs` serves existing static assets and streams `/api/v1` to an approved HTTPS backend. It has no credentials, application data, model calls or entitlement logic. `worker.test.mjs` covers routing/privacy/streaming; `artifact.test.mjs` covers committed-byte packaging and deployed drift detection. Both run with `node --test deploy/frontend/*.test.mjs` using platform primitives and isolated fixtures.

See [preview hosting](../../docs/demo-preview-hosting.md) for approval prerequisites, runtime configuration, official CLI use, smoke checks, limits and rollback. The `scripts/frontend-*` tools prepare a retained artifact, create runtime-only config and check a deployed candidate. They do not provision or deploy services.
