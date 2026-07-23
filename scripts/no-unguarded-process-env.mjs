#!/usr/bin/env node
/**
 * Lint rule: `no-unguarded-process-env` (DAN-649 / A1)
 *
 * Bans any reference to the global `process` binding in SHIPPED source unless
 * it is dominated by a `typeof process !== "undefined"` guard.
 *
 * ## Why this rule exists
 *
 * `process` is a Node global. It does not exist in a browser loading
 * `dist/index.mjs` straight from a CDN, nor in a plain `<script type=module>`,
 * nor in any runtime without a bundler shim. Bundler users never see the
 * problem: Vite/webpack/esbuild statically replace `process.env.NODE_ENV` at
 * build time, so the identifier is gone before the code ever runs. That is
 * exactly what makes this class of bug so easy to reintroduce — it is
 * invisible to the entire toolchain the library is developed with.
 *
 * Every site this rule has ever caught sat on a DEGRADATION path (IndexedDB
 * open failure, writeBatch failure, OPFS-unavailable, foreign-boundary
 * fallback) inside a dev-only `console.warn`. That placement is the trap: the
 * happy path never touches `process`, so a bundler-less consumer works
 * perfectly right up until persistence degrades — at which point the graceful
 * fallback that was supposed to save them throws `ReferenceError: process is
 * not defined` instead. The crash lands precisely where the recovery code was
 * meant to run, and only for the framework-free audience (ADR-008 §4/§5) that
 * has no bundler to shield them.
 *
 * ## The fix this rule asks for
 *
 *     typeof process !== "undefined" && process.env?.NODE_ENV !== "production"
 *
 * The `typeof` operand is safe on an undeclared identifier (it is the one
 * operator that does not throw on an unresolvable binding), and `?.` covers
 * runtimes that expose a `process` object with no `env`. This shape still
 * folds to `false` under a bundler's static `process.env.NODE_ENV`
 * replacement, so dead-code elimination of the dev warning is preserved.
 *
 * ## Scope
 *
 * Only shipped source is linted (`src/`, `packages/&#42;/src/`). Spec files are
 * exempt: they run exclusively under Node/vitest, are never published, and
 * legitimately read things like `process.cwd()`.
 *
 * Encoding rank: this is the LINT rung of the house strongest-encoding rule
 * (lint > test > skill > LESSONS.md) — it fires on every future site, not just
 * the five that existed when it was written. See LESSONS.md for the narrative.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, relative, resolve } from "node:path";
import ts from "typescript";

const RULE = "no-unguarded-process-env";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Directories whose `.ts` files are published to consumers. */
const DEFAULT_ROOTS = ["src", "packages"];

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "__fixtures__"]);

const MESSAGE =
  `\`process\` is a Node global and does not exist in a bundler-less runtime ` +
  `(CDN <script type=module>, Deno, plain browser ESM). Reading it there throws ` +
  `ReferenceError. Bundlers hide this by statically replacing process.env.NODE_ENV, ` +
  `so it is invisible in development — and these guards sit on DEGRADATION paths, ` +
  `so the crash replaces the graceful fallback exactly when it is needed.\n` +
  `    Fix: typeof process !== "undefined" && process.env?.NODE_ENV !== "production"`;

/**
 * Is `node` the expression `typeof process !== "undefined"` (either operand
 * order)? This is the form that PROVES `process` is safe to read.
 */
function isProcessDefinedCheck(node) {
  return isTypeofProcessComparison(node, ts.SyntaxKind.ExclamationEqualsEqualsToken)
    || isTypeofProcessComparison(node, ts.SyntaxKind.ExclamationEqualsToken);
}

/**
 * Is `node` the expression `typeof process === "undefined"`? This is the form
 * that proves `process` is safe in the *negated* branch (`||` right operand,
 * `else` branch, ternary false-arm).
 */
function isProcessUndefinedCheck(node) {
  return isTypeofProcessComparison(node, ts.SyntaxKind.EqualsEqualsEqualsToken)
    || isTypeofProcessComparison(node, ts.SyntaxKind.EqualsEqualsToken);
}

function isTypeofProcessComparison(node, operator) {
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== operator) return false;
  const { left, right } = node;
  return (
    (isTypeofProcess(left) && isUndefinedLiteral(right))
    || (isTypeofProcess(right) && isUndefinedLiteral(left))
  );
}

function isTypeofProcess(node) {
  return (
    ts.isTypeOfExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === "process"
  );
}

function isUndefinedLiteral(node) {
  return ts.isStringLiteral(node) && node.text === "undefined";
}

/** Does `node`'s subtree contain a guard of the given polarity anywhere? */
function subtreeHasCheck(node, predicate) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (predicate(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/**
 * Walk up from a `process` reference looking for a dominating guard.
 *
 * Recognised guard positions (deliberately conservative — an unrecognised
 * shape reports rather than stays silent, so the rule fails loud, never open):
 *   - right operand of `&&` whose left proves defined
 *   - right operand of `||` whose left proves undefined
 *   - ternary true-arm (condition proves defined) / false-arm (proves undefined)
 *   - `if` then-branch (condition proves defined) / else-branch (proves undefined)
 */
function isGuarded(node) {
  let child = node;
  let parent = node.parent;

  while (parent) {
    if (ts.isBinaryExpression(parent) && parent.right === child) {
      const kind = parent.operatorToken.kind;
      if (
        kind === ts.SyntaxKind.AmpersandAmpersandToken
        && subtreeHasCheck(parent.left, isProcessDefinedCheck)
      ) {
        return true;
      }
      if (
        kind === ts.SyntaxKind.BarBarToken
        && subtreeHasCheck(parent.left, isProcessUndefinedCheck)
      ) {
        return true;
      }
    }

    if (ts.isConditionalExpression(parent)) {
      if (parent.whenTrue === child && subtreeHasCheck(parent.condition, isProcessDefinedCheck)) {
        return true;
      }
      if (parent.whenFalse === child && subtreeHasCheck(parent.condition, isProcessUndefinedCheck)) {
        return true;
      }
    }

    if (ts.isIfStatement(parent)) {
      if (parent.thenStatement === child && subtreeHasCheck(parent.expression, isProcessDefinedCheck)) {
        return true;
      }
      if (parent.elseStatement === child && subtreeHasCheck(parent.expression, isProcessUndefinedCheck)) {
        return true;
      }
    }

    child = parent;
    parent = parent.parent;
  }

  return false;
}

/**
 * Does this node introduce a LOCAL binding named `process`, shadowing the
 * global? A shadowed `process` is an ordinary variable and always safe — the
 * rule must not force ceremony around it.
 */
function declaresProcess(node) {
  if (ts.isFunctionLike(node) && node.parameters) {
    if (node.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === "process")) {
      return true;
    }
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "process") {
    return true;
  }
  if (ts.isCatchClause(node) && node.variableDeclaration) {
    const name = node.variableDeclaration.name;
    if (ts.isIdentifier(name) && name.text === "process") return true;
  }
  if (
    (ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node))
    && node.name
    && ts.isIdentifier(node.name)
    && node.name.text === "process"
  ) {
    return true;
  }
  return false;
}

/**
 * Is this identifier in a NAME position rather than a value position? Covers
 * `foo.process`, `{ process: 1 }`, `interface X { process: string }`, and
 * every declaration name — none of which read the global binding.
 */
function isNamePosition(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.name === node) return true;
  if (parent.propertyName === node) return true;
  return false;
}

/** Is this identifier inside a type annotation (never emitted, never runs)? */
function isInTypePosition(node) {
  let current = node.parent;
  while (current) {
    if (ts.isTypeNode(current) || ts.isTypeAliasDeclaration(current) || ts.isInterfaceDeclaration(current)) {
      return true;
    }
    if (ts.isSourceFile(current) || ts.isFunctionLike(current) || ts.isBlock(current)) return false;
    current = current.parent;
  }
  return false;
}

/**
 * Report every unguarded reference to the global `process` binding.
 *
 * @param {string} sourceText
 * @param {string} fileName
 * @returns {Array<{ file: string, line: number, column: number, text: string, message: string }>}
 */
export function checkSource(sourceText, fileName = "input.ts") {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  const violations = [];

  // `shadowed` is carried DOWN the walk: once an enclosing scope declares a
  // local `process`, every reference beneath it resolves to that local.
  const visit = (node, shadowed) => {
    const shadowedHere = shadowed || declaresProcess(node);

    if (
      !shadowedHere
      && ts.isIdentifier(node)
      && node.text === "process"
      // `typeof process` IS the guard — and the only safe way to touch an
      // undeclared binding. Never a violation.
      && !(node.parent && ts.isTypeOfExpression(node.parent))
      && !isNamePosition(node)
      && !isInTypePosition(node)
      && !isGuarded(node)
    ) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const lineText = sourceText.split(/\r?\n/)[line] ?? "";
      violations.push({
        file: fileName,
        line: line + 1,
        column: character + 1,
        text: lineText.trim(),
        message: MESSAGE,
      });
    }

    ts.forEachChild(node, (child) => visit(child, shadowedHere));
  };

  visit(sourceFile, false);
  return violations;
}

function isLintable(file) {
  if (extname(file) !== ".ts") return false;
  // Specs run only under Node/vitest and are never published.
  if (/\.(spec|test)\.[cm]?ts$/.test(file)) return false;
  if (file.endsWith(".d.ts")) return false;
  return true;
}

function collectFiles(target, out = []) {
  let stats;
  try {
    stats = statSync(target);
  } catch {
    return out;
  }
  if (stats.isFile()) {
    if (extname(target) === ".ts") out.push(target);
    return out;
  }
  for (const entry of readdirSync(target)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(target, entry);
    const entryStats = statSync(full);
    if (entryStats.isDirectory()) collectFiles(full, out);
    else if (isLintable(full)) out.push(full);
  }
  return out;
}

/** @returns {Array} violations across every file under the given paths */
export function checkPaths(paths) {
  const files = paths.flatMap((p) => collectFiles(resolve(REPO_ROOT, p)));
  return files.flatMap((file) =>
    checkSource(readFileSync(file, "utf8"), relative(REPO_ROOT, file)),
  );
}

function main() {
  const args = process.argv.slice(2);
  const paths = args.length > 0 ? args : DEFAULT_ROOTS;
  const violations = checkPaths(paths);

  if (violations.length === 0) {
    console.log(`✓ ${RULE}: no unguarded \`process\` references in shipped source`);
    return 0;
  }

  console.error(`\n✗ ${RULE}: ${violations.length} unguarded \`process\` reference(s)\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}:${v.column}`);
    console.error(`    ${v.text}`);
  }
  console.error(`\n  ${MESSAGE}\n`);
  return 1;
}

// Only run the CLI when executed directly, so tests can import the checkers.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
