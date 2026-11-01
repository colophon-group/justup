import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { policyDocumentsPlugin } from "./web/policies/vite.ts";

export default defineConfig(({ isSsrBuild }) => ({
  root: "web",
  plugins: [react(), policyDocumentsPlugin()],
  build: {
    outDir: isSsrBuild ? "worker-dist" : "dist",
    ...(isSsrBuild ? { ssr: "src/public/worker.ts", rolldownOptions: { output: { entryFileNames: "worker.mjs" } } } : {}),
    emptyOutDir: true,
    copyPublicDir: !isSsrBuild,
    sourcemap: false,
    target: "es2022",
  },
  ssr: { target: "webworker", noExternal: true, resolve: { conditions: ["workerd", "module", "production"] } },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
}));
