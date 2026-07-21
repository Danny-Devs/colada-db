import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Test against core SOURCE (mirrors tsconfig paths) so the suite is
      // green on a clean tree, before core's dist exists. The observe
      // script is the counterpart that drives the BUILT artifacts.
      "colada-db": fileURLToPath(new URL("../../src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.spec.ts"],
    environment: "node",
  },
});
