#!/usr/bin/env node
/**
 * Publish-surface gate for ADR-019: colada-db owns its public read type.
 *
 * The emitted `dist/index.d.mts` is the first thing a consumer's IDE reads and
 * the artifact a reviewer checks the "framework-agnostic" claim against. A
 * single barrel-exported type that references the signal engine puts an
 * `import { ... } from "@vue/reactivity"` back on line 1 — silently, from a
 * file nobody edited in the change that caused it. So the assertion lives in
 * the build, not in a reviewer's habits.
 *
 * This is a TYPE-surface gate only. `dist/index.mjs` importing the signal
 * engine at runtime is correct and expected (ADR-008 §3): the engine is the
 * runtime core, just not the contract.
 *
 * Runs as part of `pnpm build`. Exit 1 on leak.
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every declaration artifact that makes up the published type surface — keep in
 * sync with the `exports` map in package.json. The gate only covers what it is
 * told about, so a new entry point without a line here is an unguarded surface.
 */
const DECLARATION_FILES = ["dist/index.d.mts", "dist/sqlite-worker.d.mts"];

/**
 * Packages that must never appear in the published declarations. Substring
 * match, so it catches deep specifiers (`@vue/reactivity/dist/...`) and prose
 * alike — the claim is that the name does not appear, full stop.
 */
const FORBIDDEN = ["@vue/reactivity", "@vue/shared"];

let failed = false;

for (const relPath of DECLARATION_FILES) {
  const absPath = join(root, relPath);
  let source;
  try {
    source = readFileSync(absPath, "utf8");
  } catch {
    console.error(
      `✗ ${relPath} is missing — the type-surface gate cannot run.\n` +
        `  This script is meant to run AFTER tsdown emits declarations.`,
    );
    failed = true;
    continue;
  }

  const lines = source.split("\n");
  for (const forbidden of FORBIDDEN) {
    const hits = lines
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => line.includes(forbidden));

    if (hits.length > 0) {
      failed = true;
      console.error(
        `✗ ADR-019 violation: "${forbidden}" appears in ${relative(root, absPath)} ` +
          `(${hits.length} occurrence${hits.length === 1 ? "" : "s"}).\n` +
          `  The published type surface must name no framework at all.\n` +
          `  If the hit is an IMPORT: some barrel-exported type in src/index.ts ` +
          `pulled the signal engine's types back in — retype it against a type ` +
          `colada-db owns (e.g. ColadaRef).\n` +
          `  If the hit is inside a JSDOC COMMENT: that is also a fail, by ` +
          `design — a reader (or a reviewer grepping this file) cannot tell ` +
          `prose from a dependency. Describe the engine without naming the ` +
          `package, e.g. "Vue's standalone reactivity core".`,
      );
      for (const { line, n } of hits.slice(0, 10)) {
        console.error(`    ${relative(root, absPath)}:${n}: ${line.trim()}`);
      }
    }
  }
}

if (failed) process.exit(1);

console.log(`✔ public type surface is framework-free (${DECLARATION_FILES.join(", ")})`);
