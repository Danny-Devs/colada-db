import { defineConfig } from "vite";

export default defineConfig({
  // sqlite-wasm must not be pre-bundled: its worker + wasm asset resolution
  // breaks under optimizeDeps (upstream guidance).
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  server: { port: 5178, strictPort: true },
});
