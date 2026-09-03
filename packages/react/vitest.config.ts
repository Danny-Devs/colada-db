import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const core = (rel: string): string => fileURLToPath(new URL(`../../src/${rel}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // Test against core SOURCE (mirrors tsconfig paths) so the suite is
      // green on a clean tree, before core's dist exists.
      { find: /^colada-db$/, replacement: core("index.ts") },
      // Unpublished internals (`enableSync`, sync types) — spec files only.
      { find: /^@core\/(.*)$/, replacement: core("$1") },
    ],
  },
  test: {
    include: ["src/**/*.spec.{ts,tsx}"],
    environment: "happy-dom",
  },
});
