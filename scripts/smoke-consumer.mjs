#!/usr/bin/env node
/**
 * Consumer smoke test for the `engines.node` floor (DAN-658, ADR-021).
 *
 * Run from a throwaway directory that has installed the PACKED TARBALL — not
 * from the workspace. The import below is a bare specifier on purpose: it
 * resolves through the published `exports` map, so this exercises the same path
 * a real consumer takes, and fails if `exports`, `files`, or `main` are wrong.
 *
 * The point is narrow and worth stating so nobody widens it by accident: this
 * asserts that the SHIPPED ARTIFACT parses and runs on the oldest Node the
 * package claims to support. It is not a functional suite — that is `pnpm -r
 * test`, which runs against source on the toolchain Node versions. What is
 * unique here is the runtime floor, which no other gate touches, because the
 * toolchain itself cannot run there (tsdown needs >=20.19).
 *
 * `target: "esnext"` in tsdown.config.ts is what makes this a live risk rather
 * than a formality: the build emits whatever syntax the bundler feels like, and
 * nothing pins that to the engines floor. If this job goes red after a
 * toolchain bump, the honest fixes are to lower the build target or to raise
 * `engines` — NOT to delete the assertion.
 */
const mod = await import("colada-db");

/** Fails loudly with context rather than an assertion library. */
function check(label, condition, detail) {
  if (!condition) {
    console.error(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
    process.exit(1);
  }
  console.log(`✔ ${label}`);
}

// A bare `import` that resolves is already most of the value: it proves the
// exports map, the file list, and — critically — that Node could PARSE the
// emitted syntax at this version.
check("module resolves via the published exports map", typeof mod === "object");

// Guard against a build that emits an empty or tree-shaken-to-nothing barrel.
// An artifact that imports cleanly and exports nothing would otherwise pass.
const exportCount = Object.keys(mod).length;
check(
  `barrel exports a plausible surface (${exportCount})`,
  exportCount >= 20,
  `expected >= 20 named exports, got ${exportCount}`,
);

for (const name of ["createEntityStore", "normalize", "denormalize", "defineEntity"]) {
  check(`${name} is callable`, typeof mod[name] === "function", `got ${typeof mod[name]}`);
}

// Exercise the core write/read path. Parsing is not running: a top-level
// construct that only breaks on execution (a class field, a private method, a
// modern builtin) would survive import and die here.
const store = mod.createEntityStore();
store.set("user", "1", { id: "1", name: "ada" });
const ref = store.get("user", "1");
check(
  "store round-trips an entity through a reactive ref",
  ref?.value?.name === "ada",
  `got ${JSON.stringify(ref?.value)}`,
);

// Merge-on-write is the documented `set()` semantic (vs `replace()`); it also
// happens to be the cheapest proof that reactivity is genuinely wired up rather
// than the ref being a plain object that happened to have `.value`.
store.set("user", "1", { email: "ada@example.com" });
check(
  "set() shallow-merges rather than overwriting",
  ref.value.name === "ada" && ref.value.email === "ada@example.com",
  `got ${JSON.stringify(ref.value)}`,
);

console.log(`\n✔ colada-db runs on the claimed engines floor (${process.version})`);
