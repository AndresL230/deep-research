import { defineConfig } from "vitest/config";

// Dev: Vite on 5173 proxies /api to the Python server (uvicorn deep_research.api:app on 8000; docs/api-contract.md).
// Build: web/dist, which the server serves at / (SPA fallback to index.html).
export default defineConfig({
  server: {
    port: 5173,
    // ws: true so the batch websocket (/api/batches/{id}/ws) works in dev too.
    proxy: { "/api": { target: "http://localhost:8000", changeOrigin: true, ws: true } },
  },
  // The landing page's 3D scenes (src/landing/scene.ts and devices.ts) are loaded on demand, and both need three.js:
  // about 550 kB before gzip. It gets a chunk of its own, named for what it is, and the limit only keeps the build
  // from warning about that one chunk.
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 700,
    rollupOptions: { output: { manualChunks: (id) => (id.includes("/node_modules/three/") ? "three" : undefined) } },
  },
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
