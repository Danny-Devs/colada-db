import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  sourcemap: true,
  // Private package, never auto-published (ADR-008 §4: React ships only once
  // the boundary is frozen by two real consumers, and that is Danny's call).
  // Type declarations are deferred to that decision — same reasoning as
  // packages/mcp.
  dts: false,
  target: "esnext",
  clean: true,
});
