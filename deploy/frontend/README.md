---
summary: Cloudflare edge delivery and isolated contract tests for the retained Justup frontend artifact.
read_when: Changing same-origin API routing, frontend security headers or exact-candidate verification.
---

# Frontend hosting boundary

`worker.mjs` is the reviewed HTTP boundary, imported into the self-contained `web/src/public/worker.ts` build. The retained compiled Worker renders the shared React public views, serves compiled Vite assets and streams `/api/v1` to an approved HTTPS backend. It has no credentials, application data, model calls or entitlement logic. `worker.test.mjs` covers routing/privacy/streaming; `artifact.test.mjs` covers exact committed-source builds, secret/symlink/legacy rejection, retained compiled-byte packaging and deployed drift detection. The public-document suite imports the actual built Worker, so run `npm run build` first. These suites run with `node --test deploy/frontend/*.test.mjs` using platform primitives and isolated fixtures.

See [frontend delivery](../../docs/frontend-delivery.md) for approval prerequisites, runtime configuration, official CLI use, smoke checks, limits and rollback. The `scripts/frontend-*` tools prepare a retained artifact, create runtime-only config and check a deployed candidate. They do not provision or deploy services.

## Select a retained build

The [Frontend artifact workflow](../../.github/workflows/frontend-artifact.yml) cold-builds the exact event commit on a GitHub-hosted Ubuntu runner with Node 24.22.2. It provides no deployment secrets, environment or identity-token access, disables persisted checkout credentials and package-manager caching, then verifies the retained bytes. Its source-named immutable upload contains only `assets/`, `worker.mjs` and `release.json`; it has no backend origin or runtime configuration. Artifacts expire after seven days.

Pull-request runs verify the actual proposed merge commit. Those uploads are test evidence, not the final candidate. For an isolated preview, select only a successful **push to protected `dev`** for the frozen exact commit, with the required CI and compatible backend checks passing. This workflow is build evidence only; it neither deploys nor supplies `Preview / verified`, and it does not change the runtime release block into `main`.

1. Find and inspect the exact push run. Confirm its event, branch, full source commit, successful conclusion and current candidate evidence; never select the latest branch run implicitly.

   ```sh
   gh run list --repo colophon-group/justup --workflow frontend-artifact.yml --event push --branch dev --commit <candidate-sha>
   gh run view <run-id> --repo colophon-group/justup --json event,headBranch,headSha,conclusion,url
   gh api repos/colophon-group/justup/actions/runs/<run-id>/artifacts --jq '.artifacts[] | {id,name,digest,expired}'
   ```

2. Record the source/tree and frontend artifact digest from the run summary, plus the separate GitHub artifact ID and archive digest. Download that exact ID into a new private directory, check the ZIP's SHA-256 against GitHub's `digest`, then extract it without replacing an existing retained build.

   ```sh
   gh api repos/colophon-group/justup/actions/artifacts/<artifact-id>/zip > /private/new-candidate.zip
   shasum -a 256 /private/new-candidate.zip
   unzip /private/new-candidate.zip -d /private/new-candidate
   ```

3. Before loading deployment credentials, use separately reviewed release tooling to call `verifyArtifact` from `scripts/frontend-prepare.mjs` on the extracted directory. Compare `release.json`'s source and tree with the frozen candidate and its frontend digest with the recorded run summary. The GitHub ZIP digest and the frontend artifact digest cover different byte sets; retain both. Missing, expired or mismatched evidence blocks selection.

4. The trusted deployment phase uses the approved runtime origins and pinned official Wrangler to configure and upload those retained bytes. It must not rebuild the candidate, run its package scripts or install its application dependencies with deployment credentials. Keep the selected artifact, upload identity and compatible backend/runner evidence for rollback beyond GitHub's seven-day expiry when needed. Follow the hosting guide's route, policy, resource, deployed-byte and browser acceptance gates before sharing the deployment.

The runtime configurator defaults to preview and binds its explicit deployment mode into the configuration digest. Production mode changes public-document and policy indexing rules while retaining private API/release/error protection; it does not authorize promotion. Use the same retained asset and Worker bytes after the main/candidate tree check in the release guide. The mutating acceptance harness only accepts preview mode.

The workflow pins official [checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1), [setup-node v7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0) and [upload-artifact v7.0.2](https://github.com/actions/upload-artifact/releases/tag/v7.0.2) commits. Their action metadata uses Node 24; no application package is added.
