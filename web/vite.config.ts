import { defineConfig } from "vitest/config";

// Dev: Vite on 5173 proxies /api to the Python server (uvicorn deep_research.api:app on 8000; docs/api-contract.md).
// Build: web/dist, which the server serves at / (SPA fallback to index.html).
export default defineConfig({
  server: {
    port: 5173,
    // ws: true so the batch websocket (/api/batches/{id}/ws) works in dev too.
    proxy: { "/api": { target: "http://localhost:8000", changeOrigin: true, ws: true } },
  },
  build: { outDir: "dist", emptyOutDir: true },
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
