import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // Same three seams as vite.config.ts / tsconfig paths.
      { find: /^colada-db$/, replacement: here("../../src/index.ts") },
      { find: /^@core\/(.*)$/, replacement: here("../../src/$1") },
      { find: /^@colada-db\/react$/, replacement: here("../react/src/index.ts") },
    ],
  },
  test: {
    include: ["src/**/*.spec.ts"],
    // The hub is pure — no DOM. The React panes are not unit-tested here; the
    // hooks they use are tested in packages/react.
    environment: "node",
  },
});
