// Emit public, no-JavaScript notices from the same source served during development.
import type { Plugin } from "vite";
import { policyDocuments } from "./render.ts";

export function policyDocumentsPlugin(): Plugin {
  let publicBuild = true;
  return {
    name: "justup-policy-documents",
    configResolved(config) { publicBuild = !config.build.ssr; },
    configureServer(server) {
      const documents = policyDocuments();
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split("?")[0];
        const document = path && documents.get(path);
        if (!document || (request.method !== "GET" && request.method !== "HEAD")) return next();
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader("Cache-Control", "no-cache");
        response.end(request.method === "HEAD" ? undefined : document);
      });
    },
    generateBundle() {
      // Server bundles are private; notices belong only to the public client artifact.
      if (!publicBuild) return;
      for (const [path, source] of policyDocuments()) this.emitFile({ type: "asset", fileName: path.slice(1), source });
    },
  };
}
