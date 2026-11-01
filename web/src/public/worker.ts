// Bundled private entry: one retained Worker contains the shared React renderer and edge boundary.
// @ts-expect-error The dependency-free JS boundary is covered by deployment contracts.
import { createHandler } from '../../../deploy/frontend/worker.mjs';
import { renderPublicDocument } from './document.tsx';
export function createPublicHandler(fetchUpstream: typeof fetch = globalThis.fetch) {
  return createHandler(fetchUpstream, renderPublicDocument);
}
export default { fetch: createPublicHandler() };
