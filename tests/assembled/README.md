---
summary: Run the local built browser/Worker against real API, auth, SQLite and measured deterministic queue work.
read_when: Verifying approved company source links, visitor bootstrap, lost responses, handoff, reclamation or locale propagation across the assembled boundary.
---

The default assembled browser suite loads the checked-out `server/` source. It never substitutes a pinned older producer or skips an incompatible source. The compatible backend is composed in the same source tree. CI must verify this default path before the integration can be accepted; an explicit archived API is diagnostic component evidence, never a replacement for the current-source check.

Run the current-source journey after building:

```sh
JUSTUP_TEST_PORT=4202 JUSTUP_PUBLIC_TEST_PORT=4203 JUSTUP_ASSEMBLED_TEST_PORT=4204 \
 npm run test:browser -- tests/browser/assembled-visitor-bootstrap.spec.mjs
```

For a separate component comparison, explicitly select an immutable API input:

```sh
JUSTUP_ASSEMBLED_API_REF=253caa98777b7f29454157628fd2a6ec6e39dfad \
JUSTUP_TEST_PORT=4202 JUSTUP_PUBLIC_TEST_PORT=4203 JUSTUP_ASSEMBLED_TEST_PORT=4204 \
npm run test:browser -- tests/browser/assembled-visitor-bootstrap.spec.mjs
```

Run `npm run build` first under Node 24.22.2. An explicit ref is archived from local Git objects into a temporary directory; no fetch, credential loading or backend edit occurs. Without that variable, tests use the current source. Git, tar and OpenSSL must be available. Temporary TLS material, a local synthetic account, SQLite files, deletion generation and backup directory are isolated and removed afterward.

These journeys do not intercept or fabricate API responses. They run the built frontend and Worker over local HTTPS, the real HTTP API, authentication, cookie/CSRF rules, SQLite, private-deletion barrier and fixed feature composition. A deterministic local interpreter supplies structured output to real leased tasks, wrapped in the candidate's model-execution and journey hooks. Transport fault injection drops or holds actual committed HTTP responses. It does not replace their bodies or bypass authorization.

`assembled-company-sources.spec.mjs` publishes a frozen synthetic v2 coverage snapshot through the real Wire service and SQLite, then checks approved links and missing check dates in public HTML and client navigation. Deleting that published evidence removes the source list while preserving company identity. It does not intercept API responses or qualify real source coverage.

Local synthetic admission configuration enables the test languages and binds the built draft notice bytes. It neither approves real notices nor activates a deployment. This proves the application boundary with deterministic model output; it does not qualify a provider's language quality, matching quality, latency or cost. The Wire and import schemas remain version 1; the application database contract is version 2.
