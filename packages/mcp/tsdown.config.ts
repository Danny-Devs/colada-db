import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  sourcemap: true,
  // Private package, never auto-published (npm gate is Danny's). Type
  // declarations are deferred to the publish decision — emitting them here
  // would require core's built dist at build time and buys nothing for the
  // two consumers that exist today (vitest suite + observe script).
  dts: false,
  target: "esnext",
  clean: true,
});
