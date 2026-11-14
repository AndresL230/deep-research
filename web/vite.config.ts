import { defineConfig } from "vitest/config";

// Dev: Vite on 5173 proxies /api to the Python server (uvicorn on 8000; docs/api-contract.md).
// Build: web/dist, which the server serves at / (SPA fallback to index.html).
export default defineConfig({
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://localhost:8000", changeOrigin: true } },
  },
  build: { outDir: "dist", emptyOutDir: true },
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
