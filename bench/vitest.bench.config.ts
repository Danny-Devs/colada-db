import { defineConfig } from "vitest/config";

// Benchmarks are DELIBERATELY excluded from the CI gate: wall-clock numbers are
// machine-dependent, and a flaky gate gets weakened until it asserts nothing.
// The deterministic half of this work lives in `src/perf-pins.spec.ts` and runs
// on every push. See bench/README.md.
export default defineConfig({
  test: {
    include: ["bench/**/*.spec.ts"],
    environment: "happy-dom",
    benchmark: {
      include: ["bench/**/*.bench.ts"],
    },
  },
});
