/**
 * DAN-649 / A1 — `process` must never crash a bundler-less runtime.
 *
 * `process` is a Node global. A consumer loading `dist/index.mjs` from a CDN,
 * from Deno, or from a plain `<script type="module">` has no `process` binding
 * at all. Every dev-warning guard in this library sits on a DEGRADATION path
 * (IndexedDB open failure, writeBatch failure, OPFS unavailable, foreign
 * StoreBoundary) — so an unguarded `process.env.NODE_ENV` read turns graceful
 * degradation into `ReferenceError: process is not defined`, precisely when
 * the fallback was supposed to rescue the user.
 *
 * These tests do NOT assert "the warning fires" — that would pass against the
 * broken code, because the whole failure only exists where `process` is absent
 * and the test runner always has one. Instead they EXTRACT the real guard
 * expressions from source and EVALUATE them in a scope where `process` is
 * genuinely undefined, asserting no throw. A positive control proves the
 * harness can actually detect the crash it is looking for.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

import { checkSource } from "../scripts/no-unguarded-process-env.mjs";

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

describe("A1: the no-unguarded-process-env lint rule (DAN-649)", () => {
  const fixture = (name: string): string =>
    readFileSync(resolve(REPO_ROOT, "scripts/__fixtures__", name), "utf8");

  it("fires on a deliberately-unguarded fixture", () => {
    const violations = checkSource(
      fixture("unguarded-process-env.ts"),
      "unguarded-process-env.ts",
    );
    // One per numbered case in the fixture: bare read, optional-chain-only,
    // wrong-binding guard, non-`env` member, inverted polarity.
    expect(violations).toHaveLength(5);
    expect(violations[0].message).toMatch(/bundler-less runtime/);
    expect(violations[0].message).toMatch(/typeof process !== "undefined"/);
  });

  it("does not fire on any legitimate guard shape", () => {
    // Negative control: a rule that only ever fires is as useless as one that
    // never does. This caught two real false positives while being written
    // (a shadowing parameter, and `process` as a property name in a type).
    expect(checkSource(fixture("guarded-process-env.ts"), "guarded-process-env.ts")).toEqual([]);
  });

  it("reports zero violations across the real shipped source tree", () => {
    const violations = shippedSourceFiles().flatMap((file) =>
      checkSource(readFileSync(file, "utf8"), relative(REPO_ROOT, file)),
    );
    expect(violations).toEqual([]);
  });
});
