import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  plugins: [react()],
  // Relative asset paths: the static bundle works from any sub-path (GitHub
  // Pages serves under /<repo>/). Deploying is a human decision — see README.
  base: "./",
  resolve: {
    alias: [
      // Same three seams as tsconfig `paths` — keep them in lockstep.
      { find: /^colada-db$/, replacement: here("../../src/index.ts") },
      { find: /^@core\/(.*)$/, replacement: here("../../src/$1") },
      { find: /^@colada-db\/react$/, replacement: here("../react/src/index.ts") },
    ],
  },
  // sqlite-wasm must not be pre-bundled: its worker + wasm asset resolution
  // breaks under optimizeDeps (upstream guidance; same as playground/).
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  worker: { format: "es" },
  build: { target: "esnext" },
  // opfs-sahpool needs no COOP/COEP headers (it is not SharedArrayBuffer-based),
  // so none are set — mirrors playground/vite.config.ts.
  server: { port: 5179, strictPort: true },
});
