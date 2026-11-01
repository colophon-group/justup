import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { policyDocumentsPlugin } from "./web/policies/vite.ts";

export default defineConfig({
  root: "web",
  plugins: [react(), policyDocumentsPlugin()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
  },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
});
