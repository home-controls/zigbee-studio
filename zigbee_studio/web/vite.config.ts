import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// Relative asset paths: the page lives under Home Assistant's ingress path.
// `npm run dev` proxies the WebSocket to a local backend (dev/run_local.py on :8098).
export default defineConfig({
  base: "./",
  plugins: [preact()],
  build: {
    outDir: "../app/static",
    emptyOutDir: true,
    target: "es2022",
    assetsInlineLimit: 0,
    reportCompressedSize: true,
  },
  server: {
    port: 5173,
    proxy: { "/ws": { target: "ws://127.0.0.1:8098", ws: true } },
  },
});
