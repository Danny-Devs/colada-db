import { defineConfig } from "vite";

// Fixture server for the L4 real-browser durability lane (DAN-652).
// Deliberately serves the library from SOURCE rather than `dist` — the lane
// tests the engines' behaviour against real storage, and a stale `dist` would
// make a green run prove the last build instead of the current tree.
export default defineConfig({
  // sqlite-wasm must not be pre-bundled: its worker + wasm asset resolution
  // breaks under optimizeDeps (upstream guidance). Same exclusion the
  // playground uses.
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  // strictPort is load-bearing: if this port is taken, FAIL rather than
  // sliding to the next one. A silently-moved server means the browser lane
  // would be pointed at whatever is on 5187 — see the note in
  // playwright.config.ts.
  server: { port: 5187, strictPort: true },
});
