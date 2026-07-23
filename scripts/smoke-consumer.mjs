#!/usr/bin/env node
/**
 * Consumer smoke test for the `engines.node` floor (DAN-658, ADR-021).
 *
 * ## 🚨 THIS FILE MUST BE COPIED INTO THE CONSUMER DIRECTORY BEFORE IT IS RUN
 *
 * It lives in `scripts/` so it is version-controlled with the package, but it
 * is *invalid* to execute it from there. The workflow does:
 *
 *     cp "$GITHUB_WORKSPACE/scripts/smoke-consumer.mjs" ./smoke-consumer.mjs
 *     node ./smoke-consumer.mjs
 *
 * Why that copy is load-bearing, and not a stylistic preference:
 *
 * Node's **package self-reference** rule (`exports` + the nearest enclosing
 * `package.json`) resolves a bare specifier for a package's OWN name against
 * that package's own `exports` map whenever the importing file lives inside the
 * package — regardless of the process's working directory, and without ever
 * consulting any `node_modules`. So running this file from `$WORKSPACE/scripts/`
 * makes `import("colada-db")` load `$WORKSPACE/dist/index.mjs`, i.e. the local
 * build, and the tarball under test is never opened. Measured 2026-07-23: a
 * consumer directory containing nothing but a bare `package.json` — no install,
 * no `node_modules`, no tarball — passed every assertion in this file. So did a
 * tarball built with `files: ["LICENSE","README.md"]`, which ships no `dist` at
 * all. See LESSONS.md 2026-07-23.
 *
 * The `resolvedFrom` assertion below is the fail-closed guard against that trap
 * returning: it refuses to report on anything that did not come out of a
 * `node_modules` directory.
 *
 * ## What this asserts, narrowly
 *
 * That the SHIPPED ARTIFACT parses and runs on the oldest Node the package
 * claims to support. It is not a functional suite — that is `pnpm -r test`,
 * which runs against source on the toolchain Node versions. What is unique here
 * is the runtime floor, which no other gate touches, because the toolchain
 * itself cannot run there (tsdown needs >=20.19).
 *
 * `target: "esnext"` in tsdown.config.ts is what makes this a live risk rather
 * than a formality: the build emits whatever syntax the bundler feels like, and
 * nothing pins that to the engines floor. If this job goes red after a
 * toolchain bump, the honest fixes are to lower the build target or to raise
 * `engines` — NOT to delete the assertion.
 */
import { createRequire } from "node:module";

/** Fails loudly with context rather than an assertion library. */
function check(label, condition, detail) {
  if (!condition) {
    console.error(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
    process.exit(1);
  }
  console.log(`✔ ${label}`);
}

// ── Fail-closed: prove we are about to test an INSTALLED package ────────────
// `require.resolve` honours the `exports` map (`"./package.json"` is exported)
// and is available on every Node this job runs on, unlike `import.meta.resolve`
// which needs a flag before Node 20.6. If this file were moved back inside the
// package, self-reference would resolve to the workspace root and this path
// would contain no `node_modules` segment — so the check fires before any
// assertion below can manufacture a green tick over the wrong artifact.
let resolvedFrom;
try {
  resolvedFrom = createRequire(import.meta.url).resolve("colada-db/package.json");
} catch (err) {
  console.error(
    `✗ could not resolve colada-db from ${import.meta.url}\n` +
      `  ${err?.message ?? err}\n` +
      `  Run this file from the CONSUMER directory (copy it there first).`,
  );
  process.exit(1);
}
check(
  "package resolved from node_modules (not a package self-reference)",
  resolvedFrom.includes("/node_modules/") || resolvedFrom.includes("\\node_modules\\"),
  `resolved to ${resolvedFrom} — this script is running INSIDE the package, so ` +
    `the tarball under test was never opened. Copy it into the consumer dir.`,
);

const mod = await import("colada-db");

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

// ── The second published entry point ────────────────────────────────────────
// `exports["./sqlite-worker"]` ships `dist/sqlite-worker.mjs`, which is built by
// the same `target: "esnext"` bundler and therefore carries the same syntax risk
// this whole job exists to measure — yet nothing exercised it until 2026-07-23.
// A published entry point with no gate is an untested promise, and this is the
// cheapest place to make it a tested one. Importing is side-effect-free: the
// module only declares `runSqliteWorker`; the worker `onmessage` handler is
// installed when it is CALLED, so there is nothing to clean up here.
const worker = await import("colada-db/sqlite-worker");
check(
  "./sqlite-worker subpath resolves and parses on this Node",
  typeof worker === "object",
);
check(
  "runSqliteWorker is callable",
  typeof worker.runSqliteWorker === "function",
  `got ${typeof worker.runSqliteWorker}`,
);

console.log(`\n✔ colada-db runs on the claimed engines floor (${process.version})`);
