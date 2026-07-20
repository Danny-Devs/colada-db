import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/sqlite-worker.ts"],
  format: ["esm"],
  sourcemap: true,
  dts: {
    build: true,
  },
  deps: {
    onlyBundle: [],
    neverBundle: [
      "@vue/reactivity",
      "@vue/shared",
      // Optional peer — resolved by the APP's bundler inside its worker;
      // bundling it here would break its .wasm asset resolution.
      "@sqlite.org/sqlite-wasm",
    ],
  },
  target: "esnext",
  clean: true,
});
