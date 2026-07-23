/**
 * DAN-649 / A1 — `process` must never crash a bundler-less runtime.
 *
 * `process` is a Node global. A consumer loading `dist/index.mjs` from a CDN or
 * from a plain `<script type="module">` has no `process` binding at all. Every
 * dev-warning guard in this library sits on a DEGRADATION path (IndexedDB open
 * failure, writeBatch failure, OPFS unavailable, foreign StoreBoundary) — so an
 * unguarded `process.env.NODE_ENV` read turns graceful degradation into
 * `ReferenceError: process is not defined`, precisely when the fallback was
 * supposed to rescue the user.
 *
 * Audience, stated precisely (2026-07-23 gauntlet): NOT Deno. Deno 2.7.9 exposes
 * `process` through Node compatibility (`typeof process === "object"`), so it
 * never threw, before or after. The verified beneficiaries are browsers / CDN /
 * `<script type=module>`, which WERE observed crashing pre-fix and degrading
 * cleanly post-fix in real Chrome 149.
 *
 * These tests do NOT assert "the warning fires" — that would pass against the
 * broken code, because the whole failure only exists where `process` is absent
 * and the test runner always has one. Instead they EXTRACT the real guard
 * expressions from source and EVALUATE them in a scope where `process` is
 * genuinely undefined, asserting no throw. A positive control proves the
 * harness can actually detect the crash it is looking for.
 *
 * The second contract these tests hold is STRIPPABILITY, and it is the one no
 * semantic test could ever reach: `process.env?.NODE_ENV` and
 * `process.env && process.env.NODE_ENV` behave IDENTICALLY at runtime, so every
 * evaluation assertion below passes against both. They differ only in what a
 * bundler can do with them. `@rollup/plugin-replace` substitutes the LITERAL
 * member expression `process.env.NODE_ENV` (AST-aware definers — esbuild, Vite
 * 8, webpack 5 — were measured coping with the `?.` form; the literal
 * substituters are the ones that break, so write to the strictest, not the
 * smartest); put a `?.` between `env` and `NODE_ENV`
 * and there is no literal left to find, so the comparison never folds, the
 * branch never dies, and the dev-warning string ships. The measured cost on the
 * canonical Rollup production chain: +1,106 bytes minified / +400 gzipped, all
 * five internal warning strings leaked. (esbuild is the exception — verified
 * 2026-07-23: its `define` is AST-aware and folds the `?.` form too. Writing to
 * the strictest definer is the only shape that is correct for all of them.)
 * Hence the literal-form pin below — it is the whole reason this file and the
 * lint both exist.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

import { checkSource, resolveTargets } from "../scripts/no-unguarded-process-env.mjs";

const SRC_ROOT = resolve(__dirname);
const REPO_ROOT = resolve(__dirname, "..");

/** Every shipped (non-spec) `.ts` file under `src/`. */
function shippedSourceFiles(dir = SRC_ROOT, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      shippedSourceFiles(full, out);
    } else if (full.endsWith(".ts") && !full.endsWith(".spec.ts") && !full.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

interface Guard {
  file: string;
  line: number;
  /** The `process`-dependent slice of the condition, verbatim from source. */
  expression: string;
}

/**
 * Pull the real guard expressions out of the source tree.
 *
 * For each `if` whose condition mentions `process`, flatten the top-level `&&`
 * chain and keep the contiguous tail starting at the first operand that
 * mentions `process`. That tail is exactly the guard shape, with no unrelated
 * free variables (`store`, `info`, …) that would confuse evaluation.
 */
function extractProcessGuards(): Guard[] {
  const guards: Guard[] = [];

  for (const file of shippedSourceFiles()) {
    const text = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);

    const mentionsProcess = (node: ts.Node): boolean => {
      let found = false;
      const walk = (n: ts.Node): void => {
        if (found) return;
        if (ts.isIdentifier(n) && n.text === "process") found = true;
        else ts.forEachChild(n, walk);
      };
      walk(node);
      return found;
    };

    /** Flatten `a && b && c` (left-associative) into [a, b, c]. */
    const flattenAnd = (node: ts.Expression): ts.Expression[] => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        return [...flattenAnd(node.left), node.right];
      }
      return [node];
    };

    const visit = (node: ts.Node): void => {
      if (ts.isIfStatement(node) && mentionsProcess(node.expression)) {
        const operands = flattenAnd(node.expression);
        const firstProcessIdx = operands.findIndex(mentionsProcess);
        const tail = operands.slice(firstProcessIdx);
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        guards.push({
          file: relative(REPO_ROOT, file),
          line: line + 1,
          expression: tail.map((op) => op.getText(sf)).join(" && "),
        });
      }
      ts.forEachChild(node, visit);
    };

    visit(sf);
  }

  return guards;
}

/**
 * Evaluate an expression with `process` bound to `undefined`.
 *
 * The parameter SHADOWS the real Node global, so `typeof process` genuinely
 * evaluates to `"undefined"` — the same thing the expression sees in a browser.
 */
function evaluateWithoutProcess(expression: string): unknown {
  return new Function("process", `return (${expression});`)(undefined);
}

/** Evaluate with a supplied stand-in for `process`. */
function evaluateWithProcess(expression: string, processStub: unknown): unknown {
  return new Function("process", `return (${expression});`)(processStub);
}

describe("A1: process guards survive a runtime with no `process` (DAN-649)", () => {
  const guards = extractProcessGuards();

  it("finds every dev-warning guard in shipped source", () => {
    // Five known sites at the time of writing: matcher-view, engines/sqlite,
    // and three in persist. New ones are welcome — the count may only grow,
    // and each is held to the same contract by the tests below.
    expect(guards.length).toBeGreaterThanOrEqual(5);
  });

  it("harness sanity: the PRE-FIX shape really does throw when `process` is absent", () => {
    // Positive control. Without this, "no throw" below could be vacuously true
    // because the harness never actually removed `process`.
    expect(() => evaluateWithoutProcess(`process.env.NODE_ENV !== "production"`)).toThrow();
    // Optional chaining alone is NOT a fix — the binding itself is unresolvable.
    expect(() => evaluateWithoutProcess(`process.env?.NODE_ENV !== "production"`)).toThrow();
  });

  it.each(extractProcessGuards().map((g) => [`${g.file}:${g.line}`, g] as const))(
    "%s does not throw with `process` undefined",
    (_label, guard) => {
      expect(() => evaluateWithoutProcess(guard.expression)).not.toThrow();
    },
  );

  it.each(extractProcessGuards().map((g) => [`${g.file}:${g.line}`, g] as const))(
    "%s suppresses the warning (returns false) when `process` is undefined",
    (_label, guard) => {
      // Chosen policy: an unknown runtime is not assumed to be development.
      expect(evaluateWithoutProcess(guard.expression)).toBe(false);
    },
  );

  it.each(extractProcessGuards().map((g) => [`${g.file}:${g.line}`, g] as const))(
    "%s still warns in a Node/bundler dev environment",
    (_label, guard) => {
      // The guard must not have been "fixed" by simply disabling the warning
      // everywhere — bundler and Node users must keep their diagnostics.
      expect(evaluateWithProcess(guard.expression, { env: { NODE_ENV: "development" } })).toBe(true);
    },
  );

  it.each(extractProcessGuards().map((g) => [`${g.file}:${g.line}`, g] as const))(
    "%s stays silent in production",
    (_label, guard) => {
      expect(evaluateWithProcess(guard.expression, { env: { NODE_ENV: "production" } })).toBe(false);
    },
  );

  it.each(extractProcessGuards().map((g) => [`${g.file}:${g.line}`, g] as const))(
    "%s tolerates a `process` object with no `env` (exotic shims)",
    (_label, guard) => {
      expect(() => evaluateWithProcess(guard.expression, {})).not.toThrow();
    },
  );
});

/**
 * THE STRIPPABILITY PIN (DAN-649 gauntlet, FIX 1).
 *
 * Everything above tests SEMANTICS, and semantics cannot see this defect:
 * `process.env?.NODE_ENV` passes every single assertion in the block above,
 * because at runtime it behaves exactly like `process.env && process.env.NODE_ENV`.
 * What it does NOT do is survive contact with a bundler.
 *
 * LITERAL-substitution toolchains — `@rollup/plugin-replace` is the canonical
 * one, and the only one measured leaking here — replace the exact member
 * expression `process.env.NODE_ENV` as text. (esbuild, Vite 8 and webpack 5
 * were built and grepped during review and stripped correctly: their `define`
 * is AST-aware. The pin below targets the strictest definer, not the smartest,
 * because we do not control which one a consumer uses.)
 * Put a `?.` between `env` and
 * `NODE_ENV` and the literal is gone: nothing gets replaced, the comparison
 * never folds to a constant, dead-code elimination cannot remove the branch,
 * and every internal dev-warning string ships to production. Measured on the
 * canonical Rollup production chain when the guards used `?.`: +1,106 bytes
 * minified, +400 gzipped, all five warning strings leaked, five constant-folded
 * reads turned into live runtime reads.
 *
 * Without this pin the next agent "tidies" the guard back to optional chaining,
 * every test stays green, and every downstream production bundle silently
 * regresses. This is the durable half of the lesson.
 */
describe("A1: guards must stay STRIPPABLE by literal define/replace (DAN-649)", () => {
  const guards = extractProcessGuards();

  it.each(guards.map((g) => [`${g.file}:${g.line}`, g] as const))(
    "%s contains the literal `process.env.NODE_ENV` a definer can substitute",
    (_label, guard) => {
      expect(guard.expression).toContain("process.env.NODE_ENV");
    },
  );

  it("no shipped source optional-chains between `process.env` and `NODE_ENV`", () => {
    // Tree-wide, not just inside `if` conditions — a `?.` anywhere in the
    // member expression breaks substitution wherever it appears.
    const offenders = shippedSourceFiles()
      .map((file) => [relative(REPO_ROOT, file), readFileSync(file, "utf8")] as const)
      .filter(([, text]) => /process\s*\.\s*env\s*\?\./.test(text))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  it("harness sanity: the pin would actually FIRE on the optional-chained shape", () => {
    // Positive control for the pin itself — otherwise "no offenders" could be
    // vacuously true because the detector never matched anything.
    const brokenShape = `typeof process !== "undefined" && process.env?.NODE_ENV !== "production"`;
    expect(brokenShape).not.toContain("process.env.NODE_ENV");
    expect(/process\s*\.\s*env\s*\?\./.test(brokenShape)).toBe(true);
  });
});

describe("A1: the no-unguarded-process-env lint rule (DAN-649)", () => {
  const fixture = (name: string): string =>
    readFileSync(resolve(REPO_ROOT, "scripts/__fixtures__", name), "utf8");

  it("fires on a deliberately-unguarded fixture", () => {
    const violations = checkSource(
      fixture("unguarded-process-env.ts"),
      "unguarded-process-env.ts",
    );
    // 13 numbered cases → 14 violations (the reasonless-suppression case yields
    // two: the unguarded read AND the malformed hatch above it).
    expect(violations).toHaveLength(14);
    expect(violations[0].message).toMatch(/bundler-less runtime/);
    expect(violations[0].message).toMatch(/typeof process !== "undefined"/);
  });

  it("teaches the STRIPPABLE fix, never the optional-chained one", () => {
    // The rule's advice is the highest-leverage string in the repo: it is what
    // the next author copies. Before the DAN-649 gauntlet it prescribed
    // `process.env?.NODE_ENV` — steering every future fix straight into the
    // dead-code-elimination defect the rule exists to prevent.
    const [first] = checkSource(fixture("unguarded-process-env.ts"), "f.ts");
    expect(first.message).toContain(
      `typeof process !== "undefined" && process.env && process.env.NODE_ENV !== "production"`,
    );
    expect(first.message).not.toMatch(/Fix:.*process\.env\?\./);
    expect(first.message).toMatch(/optional chaining defeats/i);
  });

  it("does not fire on any legitimate guard shape", () => {
    // Negative control: a rule that only ever fires is as useless as one that
    // never does. This caught two real false positives while being written
    // (a shadowing parameter, and `process` as a property name in a type), and
    // the FIX 3 gauntlet added the two house idioms below.
    expect(checkSource(fixture("guarded-process-env.ts"), "guarded-process-env.ts")).toEqual([]);
  });

  it("reports zero violations across the real shipped source tree", () => {
    const violations = shippedSourceFiles().flatMap((file) =>
      checkSource(readFileSync(file, "utf8"), relative(REPO_ROOT, file)),
    );
    expect(violations).toEqual([]);
  });

  // ── FIX 4 — dominance, not containment ──
  // The pre-gauntlet rule asked "does a `typeof process` check appear ANYWHERE
  // in the left subtree", which both of these satisfy while still throwing in a
  // real browser realm. A lint that tests containment manufactures false
  // confidence, which is worse than having no lint at all.

  it("rejects a `typeof` check that is merely CONTAINED, not dominating (disjunction)", () => {
    const src = `
      export function f(): void {
        if ((typeof window !== "undefined" || typeof process !== "undefined")
            && process.env.NODE_ENV !== "production") {
          console.warn("x");
        }
      }
    `;
    expect(checkSource(src, "d.ts")).toHaveLength(1);
  });

  it("rejects a `typeof` check buried in a ternary condition", () => {
    const src = `
      export function f(flag: boolean): void {
        if ((flag ? typeof process !== "undefined" : true)
            && process.env.NODE_ENV !== "production") {
          console.warn("x");
        }
      }
    `;
    expect(checkSource(src, "t.ts")).toHaveLength(1);
  });

  it("still accepts a genuine conjunct in a nested `&&` chain", () => {
    // The dominance rule must not become a false-positive machine: `&&` is the
    // one connective it may recurse through.
    const src = `
      export function f(a: boolean, b: boolean): void {
        if (a && b && typeof process !== "undefined" && process.env.NODE_ENV !== "production") {
          console.warn("x");
        }
      }
    `;
    expect(checkSource(src, "c.ts")).toEqual([]);
  });

  // ── FIX 3a — early-exit dominance (the repo's own house idiom) ──

  it("accepts an inverted early return, the way `src/persist.ts` guards `navigator`", () => {
    const src = `
      export function f(): string {
        if (typeof process === "undefined") return "unknown";
        return String(process.env.NODE_ENV);
      }
    `;
    expect(checkSource(src, "e.ts")).toEqual([]);
  });

  it("rejects an early guard whose body does not actually exit", () => {
    const src = `
      export function f(): string {
        if (typeof process === "undefined") console.warn("none");
        return String(process.env.NODE_ENV);
      }
    `;
    expect(checkSource(src, "e2.ts")).toHaveLength(1);
  });

  it("rejects an early exit of the WRONG polarity", () => {
    const src = `
      export function f(): string {
        if (typeof process !== "undefined") return "node";
        return String(process.env.NODE_ENV);
      }
    `;
    expect(checkSource(src, "e3.ts")).toHaveLength(1);
  });

  // ── FIX 3b — hoisted-const guards (the OTHER house idiom) ──

  it("accepts a hoisted `const` holding the typeof check", () => {
    const src = `
      const HAS_PROCESS = typeof process !== "undefined";
      export function f(): boolean {
        return HAS_PROCESS && process.env.NODE_ENV !== "production";
      }
    `;
    expect(checkSource(src, "h.ts")).toEqual([]);
  });

  it("refuses to trust an alias that is redeclared elsewhere in the file", () => {
    // The propagation is deliberately unscoped, so it must fail LOUD the
    // moment the name is ambiguous rather than silently license a read.
    const src = `
      const HAS_PROCESS = typeof process !== "undefined";
      export function g(HAS_PROCESS: boolean): boolean {
        return HAS_PROCESS && process.env.NODE_ENV !== "production";
      }
    `;
    expect(checkSource(src, "h2.ts")).toHaveLength(1);
  });

  it("does not chain aliases (`const B = A` proves nothing)", () => {
    const src = `
      const A = typeof process !== "undefined";
      const B = A;
      export function f(): boolean {
        return B && process.env.NODE_ENV !== "production";
      }
    `;
    expect(checkSource(src, "h3.ts")).toHaveLength(1);
  });

  // ── FIX 3c — the auditable escape hatch ──
  // A rule with no pressure valve gets deleted from `package.json` the first
  // time it is wrong. The valve is a reviewable comment instead — and the
  // reason is mandatory, or the "auditable" hatch is just a mute button.

  it("honours a suppression comment that carries a reason", () => {
    const src = `
      export function f(): string {
        return String(process.env.NODE_ENV); // lint-ok: no-unguarded-process-env — node-only build script
      }
    `;
    expect(checkSource(src, "s.ts")).toEqual([]);
  });

  it("honours a suppression on the line directly above", () => {
    const src = `
      export function f(): string {
        // lint-ok: no-unguarded-process-env — node-only build script
        return String(process.env.NODE_ENV);
      }
    `;
    expect(checkSource(src, "s2.ts")).toEqual([]);
  });

  it("rejects a reasonless suppression — and still reports the read underneath", () => {
    const src = `
      export function f(): string {
        return String(process.env.NODE_ENV); // lint-ok: no-unguarded-process-env
      }
    `;
    const violations = checkSource(src, "s3.ts");
    expect(violations).toHaveLength(2);
    expect(violations.some((v) => /must carry a reason/.test(v.message))).toBe(true);
  });

  // ── FIX 5 — `globalThis.process` ──
  // The most plausible false negative of all, because the rule's OWN message
  // ("`process` is a Node global") is what invites the rewrite. It swaps a
  // ReferenceError for a TypeError in the same place, for the same audience.

  it("reports `globalThis.process` member reads", () => {
    const src = `
      export function f(): void {
        if (globalThis.process.env.NODE_ENV !== "production") console.warn("x");
      }
    `;
    const violations = checkSource(src, "g.ts");
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toMatch(/does not make it portable/);
  });

  it.each(["self", "window", "global"])("reports `%s.process` too", (globalName) => {
    const src = `export const v = ${globalName}.process.env.NODE_ENV;`;
    expect(checkSource(src, "g2.ts")).toHaveLength(1);
  });

  it("accepts `globalThis.process` optional-chained THROUGH the global", () => {
    const src = `export const v = globalThis.process?.env?.NODE_ENV;`;
    expect(checkSource(src, "g3.ts")).toEqual([]);
  });

  it("rejects a `?.` placed AFTER the process member (too late to help)", () => {
    const src = `export const v = globalThis.process.env?.NODE_ENV;`;
    expect(checkSource(src, "g4.ts")).toHaveLength(1);
  });

  it("accepts a `typeof` or `in` guard on the global member expression", () => {
    const viaTypeof = `
      export const a = typeof globalThis.process !== "undefined"
        && globalThis.process.env.NODE_ENV !== "production";
    `;
    const viaIn = `
      export const b = "process" in globalThis
        && globalThis.process.env.NODE_ENV !== "production";
    `;
    expect(checkSource(viaTypeof, "g5.ts")).toEqual([]);
    expect(checkSource(viaIn, "g6.ts")).toEqual([]);
  });

  // ── FIX 6 / FIX 7 — target resolution ──

  it("reports a non-existent target instead of silently scanning nothing", () => {
    // The old `collectFiles` swallowed ENOENT, so a typo'd path printed ✓ and
    // exited 0 — harmless for the bare `pnpm lint` call, fatal the moment the
    // rule is wired into lint-staged or a changed-files CI step.
    const { files, missing } = resolveTargets(["definitely-not-a-real-path"], REPO_ROOT);
    expect(files).toEqual([]);
    expect(missing).toEqual(["definitely-not-a-real-path"]);
  });

  it("resolves targets against a caller-supplied base directory", () => {
    const { files, missing } = resolveTargets(["persist.ts"], SRC_ROOT);
    expect(missing).toEqual([]);
    expect(files.map((f) => relative(REPO_ROOT, f))).toEqual(["src/persist.ts"]);
  });

  it("scans `.mts` and `.tsx` shipped source, not just `.ts`", () => {
    // The allowlist was `extname === ".ts"` exactly, so these extensions were
    // reported ✓ over files the rule had never opened.
    for (const name of ["unguarded-process-env.mts", "unguarded-process-env.tsx"]) {
      const { files, missing } = resolveTargets([`scripts/__fixtures__/${name}`], REPO_ROOT);
      expect(missing).toEqual([]);
      expect(files).toHaveLength(1);
      expect(checkSource(fixture(name), name)).toHaveLength(1);
    }
  });

  it("honours the spec exemption even when a spec file is named DIRECTLY", () => {
    // Directory discovery always honoured it; an explicit file target used to
    // bypass it by checking only the extension.
    const { files, missing } = resolveTargets(
      ["scripts/__fixtures__/exempt-target.spec.ts"],
      REPO_ROOT,
    );
    expect(missing).toEqual([]);
    expect(files).toEqual([]);
    // …and the file really would violate if it were ever scanned.
    expect(checkSource(fixture("exempt-target.spec.ts"), "x.spec.ts")).toHaveLength(1);
  });
});
