#!/usr/bin/env node
/**
 * Publish-surface gate (DAN-658).
 *
 * `check-public-types.mjs` guards ONE invariant (ADR-019: no framework in the
 * declarations). This script is the broader sweep: every textual invariant the
 * 2026-07-22/23 publish-readiness audit established about the *built artifact*,
 * asserted against `dist/` rather than against a reviewer's memory.
 *
 * ── Why a script and not three `grep` lines in the workflow ──────────────────
 *
 * 1. A CI-only assertion is the disease this ticket treats, not the cure. The
 *    whole finding behind DAN-658 is that encodings which only fire when a
 *    human types the command silently stop existing. An assertion that only
 *    fires on GitHub is the same bug with a different host. This runs locally
 *    (`pnpm check:publish-surface`), in the pre-push hook, and in CI — one
 *    implementation, three trigger points.
 * 2. `grep -c "x" file` exits 1 when the count is zero, so the intuitive
 *    "assert this is absent" spelling reads a PASS as a FAIL inside a `&&`
 *    chain (DAN-657). Exit codes here are explicit and never inferred from a
 *    match count.
 * 3. Windows. This repo is going public; a `.sh` gate is unrunnable for a
 *    chunk of contributors, and a gate you cannot run locally is a gate you
 *    learn about from a red PR.
 *
 * ── Why the positive controls ────────────────────────────────────────────────
 *
 * LESSONS.md 2026-07-23: "a lint that tests CONTAINMENT instead of DOMINANCE is
 * worse than no lint" — a gate that cannot fail manufactures confidence it has
 * not earned, and the next author trusts the tick. Every assertion below is
 * therefore run twice: once against the real artifact, and once against a
 * synthetic string engineered to violate it. If a detector does not fire on its
 * own counter-example, THAT is a failure — the gate has gone vacuous and is
 * reported as broken rather than green.
 *
 * Exit 0 = every invariant holds AND every detector proved it can fire.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The invariants, as data.
 *
 * `mustContain` / `mustNotContain` are plain substrings, never regexes — the
 * claim in every case is about literal text a bundler, a reviewer, or a
 * consumer's IDE would see, and a regex only adds escaping bugs between us and
 * that claim.
 *
 * `control` is a string that MUST trip the assertion. It is the anti-vacuity
 * proof described in the header.
 */
const INVARIANTS = [
  {
    id: "no-plugin-branding",
    files: ["dist/index.d.mts", "dist/index.mjs"],
    mustNotContain: "pinia-colada-plugin-normalizer",
    control: "from 'pinia-colada-plugin-normalizer';",
    why:
      "colada-db is the standalone engine; the plugin is one adapter of many " +
      "(AGENTS.md, ADR-018). The originating plugin's name must not appear in " +
      "the shipped artifact — it misrepresents the dependency direction to " +
      "anyone reading the bundle, and it is exactly the leak an extraction " +
      "re-introduces without anyone editing the file it appears in.",
  },
  {
    id: "strippable-node-env",
    files: ["dist/index.mjs"],
    mustContain: "process.env.NODE_ENV",
    control: "if (typeof process !== 'undefined' && process.env) {}",
    why:
      "DAN-649 / LESSONS.md 2026-07-23. Dev warnings are stripped from " +
      "consumers' production bundles by a definer substituting the LITERAL " +
      "member expression `process.env.NODE_ENV`. If that literal is absent " +
      "from the shipped ESM, either the guards were rewritten into a " +
      "non-strippable shape or the warnings themselves were dropped — the " +
      "first leaks 5 dev strings into production bundles, the second silently " +
      "removes the diagnostics. Both want a human to look.",
  },
  {
    id: "no-optional-chained-node-env",
    files: ["dist/index.mjs"],
    mustNotContain: "process.env?.NODE_ENV",
    control: "typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production'",
    why:
      "DAN-649 / LESSONS.md 2026-07-23. The exact regression. `?.` between " +
      "`process.env` and `NODE_ENV` is runtime-identical and therefore " +
      "invisible to every semantic test, but it leaves a literal definer " +
      "(`@rollup/plugin-replace`) nothing to replace: measured at +1,106 bytes " +
      "minified / +400 gzipped with all five dev-warning strings leaked. " +
      "`src/process-guard.spec.ts` pins the SOURCE; this pins the ARTIFACT.",
  },
  {
    id: "framework-free-types",
    files: ["dist/index.d.mts"],
    mustNotContain: "@vue/reactivity",
    control: "import type { Ref } from '@vue/reactivity';",
    why:
      "ADR-019. The published declarations are where the " +
      "'framework-agnostic' claim is checked. `check-public-types.mjs` already " +
      "asserts this during `pnpm build`; it is repeated here so the " +
      "publish-surface job is a complete statement of the artifact contract " +
      "rather than a partial one that silently depends on another script " +
      "having run first.",
  },
];

/** Applies one invariant to one blob of text. Returns null on pass. */
function violation(inv, text) {
  if (inv.mustNotContain !== undefined && text.includes(inv.mustNotContain)) {
    return `found forbidden substring ${JSON.stringify(inv.mustNotContain)}`;
  }
  if (inv.mustContain !== undefined && !text.includes(inv.mustContain)) {
    return `required substring ${JSON.stringify(inv.mustContain)} is missing`;
  }
  return null;
}

let failed = false;

// ── Pass 1: the detectors must be able to fail ──────────────────────────────
// Runs BEFORE the real assertions. A vacuous gate reporting green on a broken
// artifact is worse than no gate, so we refuse to report on the artifact at all
// until every detector has demonstrated it fires on its own counter-example.
for (const inv of INVARIANTS) {
  if (violation(inv, inv.control) === null) {
    failed = true;
    console.error(
      `✗ VACUOUS GATE: the "${inv.id}" detector did NOT fire on its own ` +
        `counter-example.\n` +
        `  Control string: ${JSON.stringify(inv.control)}\n` +
        `  This assertion cannot fail, so its green tick means nothing. Fix ` +
        `the detector before trusting any result below.`,
    );
  }
}

if (failed) {
  console.error("\nRefusing to assert against dist/ with a broken detector.");
  process.exit(1);
}

// ── Pass 2: the real artifact ───────────────────────────────────────────────
const cache = new Map();
function read(relPath) {
  if (!cache.has(relPath)) cache.set(relPath, readFileSync(join(root, relPath), "utf8"));
  return cache.get(relPath);
}

let checks = 0;
for (const inv of INVARIANTS) {
  for (const relPath of inv.files) {
    let text;
    try {
      text = read(relPath);
    } catch {
      failed = true;
      console.error(
        `✗ ${relPath} is missing — the publish-surface gate cannot run.\n` +
          `  This script asserts against BUILT output; run \`pnpm build\` first.`,
      );
      continue;
    }

    const problem = violation(inv, text);
    checks += 1;
    if (problem !== null) {
      failed = true;
      console.error(`✗ ${inv.id} — ${relPath}: ${problem}\n  ${inv.why}\n`);
    }
  }
}

if (failed) process.exit(1);

console.log(
  `✔ publish surface holds — ${checks} assertions across ` +
    `${cache.size} artifacts, ${INVARIANTS.length} detectors self-tested`,
);
