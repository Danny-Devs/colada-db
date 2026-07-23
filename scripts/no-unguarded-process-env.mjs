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
 * nor in any runtime without a bundler shim. (Deno is NOT affected — it exposes
 * `process` through Node compatibility; verified 2026-07-23.) Bundler users never see the
 * problem: Vite/webpack/esbuild statically replace `process.env.NODE_ENV` at
 * build time (when the guard is written in the strippable literal form — see
 * the `?.` warning below), so the identifier is gone before the code ever
 * runs. That is
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
 *     typeof process !== "undefined" && process.env && process.env.NODE_ENV !== "production"
 *
 * The `typeof` operand is safe on an undeclared identifier (it is the one
 * operator that does not throw on an unresolvable binding), and the plain
 * `process.env &&` conjunct covers runtimes that expose a `process` object with
 * no `env` — it evaluates falsy instead of throwing.
 *
 * **Do NOT write `process.env?.NODE_ENV`.** Optional chaining looks like the
 * tidier way to spell the same tolerance, but it silently defeats dead-code
 * elimination. `@rollup/plugin-replace` performs LITERAL substitution on the
 * exact member expression `process.env.NODE_ENV` (AST-aware definers — esbuild,
 * Vite 8, webpack 5 — were measured folding the `?.` form fine; the literal
 * substituters break, and we do not control which definer a consumer uses).
 * Insert a `?.` and there is no longer any
 * literal for the definer to find, so the branch never folds to `false`, the
 * dev-only warning strings survive into every downstream production bundle,
 * and constant-folded reads become live runtime reads. Measured on the
 * canonical Rollup production chain: +1,106 bytes minified / +400 gzipped, all
 * five internal warning strings leaked. (esbuild is the exception — its
 * `define` is AST-aware and folds the `?.` form too. Write to the strictest
 * definer; that shape is the only one correct for all of them.)
 * `src/process-guard.spec.ts` pins the literal form for exactly this reason —
 * no SEMANTIC test can catch a strippability regression, because both shapes
 * behave identically at runtime.
 *
 * ## Guard shapes this rule accepts
 *
 *   - inline dominance: `typeof process !== "undefined" && process.env…`
 *     (and the `||` / ternary / `if` duals)
 *   - early-exit dominance: `if (typeof process === "undefined") return;` then
 *     free use of `process` in the rest of the block — the repo's own house
 *     idiom for ambient globals (`src/persist.ts` guards `navigator` this way)
 *   - a hoisted `const`: `const HAS_PROCESS = typeof process !== "undefined"`
 *     then `HAS_PROCESS && process.env…` — the other house idiom
 *     (`src/engines/idb.ts` hoists its `indexedDB` check)
 *   - an auditable escape hatch:
 *     `// lint-ok: no-unguarded-process-env — <reason>` on the offending line
 *     or the line above. The reason is REQUIRED; an empty one is itself a
 *     violation. A rule with no pressure valve gets deleted from
 *     `package.json` the first time it is wrong, which is how a required gate
 *     dies — so the valve is a reviewable comment instead.
 *
 * ## Dominance, not containment
 *
 * A guard licenses a read only when reaching that read PROVES the guard held.
 * `(typeof window !== "undefined" || typeof process !== "undefined") && process.env…`
 * CONTAINS a `typeof process` check but is not DOMINATED by one: the `window`
 * disjunct alone satisfies the `&&`, and the read still throws in a real
 * browser realm. The rule therefore recurses through `&&` only for positive
 * guards and `||` only for negative ones — never through the opposite
 * connective, a ternary, a call, or a parenthesized disjunction. Containment
 * manufactures false confidence, which is worse than no rule at all.
 *
 * ## `globalThis.process` is covered too
 *
 * The rule's own message names `process` as a Node global, which invites the
 * "portable" workaround `globalThis.process.env.NODE_ENV`. That does not throw
 * `ReferenceError` — it throws `TypeError: Cannot read properties of
 * undefined`, in exactly the same place, for exactly the same audience. Member
 * reads of `process` off `globalThis` / `self` / `window` / `global` are
 * reported unless optional-chained through the global
 * (`globalThis.process?.env?.NODE_ENV`) or dominated by a `typeof` / `in`
 * check.
 *
 * ## Scope
 *
 * Only shipped source is linted (`src/`, `packages/&#42;/src/`), extensions
 * `.ts` / `.tsx` / `.mts` / `.cts`. Spec files are exempt: they run exclusively
 * under Node/vitest, are never published, and legitimately read things like
 * `process.cwd()`. This script itself is a Node build script, not shipped
 * source — no allowlisted extension matches `.mjs`, so it never scans itself.
 *
 * Encoding rank: this is the LINT rung of the house strongest-encoding rule
 * (lint > test > skill > LESSONS.md) — it fires on every future site, not just
 * the five that existed when it was written. See LESSONS.md for the narrative.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, relative, resolve } from "node:path";
import ts from "typescript";

const RULE = "no-unguarded-process-env";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Directories whose source files are published to consumers. */
const DEFAULT_ROOTS = ["src", "packages"];

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "__fixtures__"]);

/** Extensions that reach a consumer's bundle. `.mjs`/`.js` build scripts do not. */
const LINTABLE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

/** Global objects off which `X.process` is the same hazard as bare `process`. */
const GLOBAL_OBJECTS = new Set(["globalThis", "self", "window", "global"]);

const FIX_HINT =
  `    Fix: typeof process !== "undefined" && process.env && process.env.NODE_ENV !== "production"\n`
  + `    NOT process.env?.NODE_ENV — optional chaining defeats the literal define/replace\n`
  + `    substitution every bundler keys on, so the dev warning survives into production bundles.\n`
  + `    Escape hatch, if the read is genuinely safe here:\n`
  + `      // lint-ok: ${RULE} — <reason>`;

const MESSAGE =
  `\`process\` is a Node global and does not exist in a bundler-less runtime `
  + `(CDN <script type=module>, plain browser ESM). Reading it there throws `
  + `ReferenceError. Bundlers hide this by statically replacing process.env.NODE_ENV, `
  + `so it is invisible in development — and these guards sit on DEGRADATION paths, `
  + `so the crash replaces the graceful fallback exactly when it is needed.\n`
  + FIX_HINT;

const GLOBAL_MESSAGE =
  `Reading \`process\` off a global object does not make it portable: in a browser `
  + `\`globalThis.process\` is \`undefined\`, so \`.env\` throws TypeError in the same place, `
  + `on the same degradation path, for the same bundler-less audience.\n`
  + `    Fix: optional-chain through the global (globalThis.process?.env?.NODE_ENV), or guard it\n`
  + `    (typeof globalThis.process !== "undefined" && …).\n`
  + FIX_HINT;

const SUPPRESSION_REASON_MESSAGE =
  `A \`// lint-ok: ${RULE}\` suppression must carry a reason — the escape hatch exists to be `
  + `AUDITABLE, and a bare suppression is indistinguishable from deleting the rule.\n`
  + `    Fix: // lint-ok: ${RULE} — <why this read is safe here>`;

// ─────────────────────────────────────────────
// Guard recognition
// ─────────────────────────────────────────────

function unparen(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function isNot(node) {
  return ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken;
}

/** `globalThis.process` / `self.process` / `window.process` / `global.process`. */
function isGlobalProcessAccess(node) {
  return (
    ts.isPropertyAccessExpression(node)
    && ts.isIdentifier(node.name)
    && node.name.text === "process"
    && ts.isIdentifier(node.expression)
    && GLOBAL_OBJECTS.has(node.expression.text)
  );
}

/** `typeof process` or `typeof globalThis.process` — the only safe probes. */
function isTypeofProcess(node) {
  if (!ts.isTypeOfExpression(node)) return false;
  const operand = unparen(node.expression);
  if (ts.isIdentifier(operand) && operand.text === "process") return true;
  return isGlobalProcessAccess(operand);
}

function isUndefinedLiteral(node) {
  return ts.isStringLiteral(node) && node.text === "undefined";
}

function isTypeofProcessComparison(node, operator) {
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== operator) return false;
  const left = unparen(node.left);
  const right = unparen(node.right);
  return (
    (isTypeofProcess(left) && isUndefinedLiteral(right))
    || (isTypeofProcess(right) && isUndefinedLiteral(left))
  );
}

/** `"process" in globalThis` — proves the global object carries the binding. */
function isProcessInGlobalCheck(node) {
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.InKeyword) {
    return false;
  }
  const left = unparen(node.left);
  const right = unparen(node.right);
  return (
    ts.isStringLiteral(left)
    && left.text === "process"
    && ts.isIdentifier(right)
    && GLOBAL_OBJECTS.has(right.text)
  );
}

/** Is `node` `typeof process !== "undefined"` (either operand order)? */
function isProcessDefinedCheck(node) {
  const expr = unparen(node);
  return (
    isTypeofProcessComparison(expr, ts.SyntaxKind.ExclamationEqualsEqualsToken)
    || isTypeofProcessComparison(expr, ts.SyntaxKind.ExclamationEqualsToken)
    || isProcessInGlobalCheck(expr)
  );
}

/** Is `node` `typeof process === "undefined"`? */
function isProcessUndefinedCheck(node) {
  const expr = unparen(node);
  return (
    isTypeofProcessComparison(expr, ts.SyntaxKind.EqualsEqualsEqualsToken)
    || isTypeofProcessComparison(expr, ts.SyntaxKind.EqualsEqualsToken)
  );
}

/**
 * FIX 3b — simple same-file constant propagation.
 *
 * `const HAS_PROCESS = typeof process !== "undefined"` makes `HAS_PROCESS` a
 * valid guard token, so the repo's hoisted-boolean house style (see
 * `src/engines/idb.ts`) is expressible for `process` too.
 *
 * Deliberately unscoped and non-transitive: a name qualifies only when it is
 * declared EXACTLY ONCE in the whole file and that single declaration is a
 * `const` initialised to a directly-recognised check. Any redeclaration,
 * parameter, import, or function of the same name disqualifies it. Aliases do
 * not chain (`const B = A` is not a guard) — proving that needs real
 * scope+flow analysis, and this rule fails loud rather than open.
 */
function collectGuardAliases(sourceFile) {
  const declarationCount = new Map();
  const candidates = new Map();

  const bump = (name) => declarationCount.set(name, (declarationCount.get(name) ?? 0) + 1);

  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      bump(node.name.text);
      const list = node.parent;
      const isConst = list
        && ts.isVariableDeclarationList(list)
        && (list.flags & ts.NodeFlags.Const) !== 0;
      if (isConst && node.initializer) {
        if (isProcessDefinedCheck(node.initializer)) {
          candidates.set(node.name.text, "defined");
        } else if (isProcessUndefinedCheck(node.initializer)) {
          candidates.set(node.name.text, "undefined");
        }
      }
    } else if (
      (ts.isParameter(node)
        || ts.isBindingElement(node)
        || ts.isFunctionDeclaration(node)
        || ts.isClassDeclaration(node)
        || ts.isImportSpecifier(node)
        || ts.isImportClause(node)
        || ts.isNamespaceImport(node))
      && node.name
      && ts.isIdentifier(node.name)
    ) {
      bump(node.name.text);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  const aliases = new Map();
  for (const [name, polarity] of candidates) {
    if (declarationCount.get(name) === 1) aliases.set(name, polarity);
  }
  return aliases;
}

/**
 * Build the two polarity provers for one source file.
 *
 * `provesDefined(e)` — "`e` evaluating TRUTHY implies `process` is safe to read"
 * `provesUndefined(e)` — "`e` evaluating TRUTHY implies `process` is absent"
 */
function makeProvers(aliases) {
  const provesDefined = (node) => {
    const expr = unparen(node);
    if (isNot(expr)) return provesUndefined(expr.operand);
    if (ts.isIdentifier(expr) && aliases.get(expr.text) === "defined") return true;
    return isProcessDefinedCheck(expr);
  };
  const provesUndefined = (node) => {
    const expr = unparen(node);
    if (isNot(expr)) return provesDefined(expr.operand);
    if (ts.isIdentifier(expr) && aliases.get(expr.text) === "undefined") return true;
    return isProcessUndefinedCheck(expr);
  };
  return { provesDefined, provesUndefined };
}

/**
 * FIX 4 — DOMINANCE, not containment.
 *
 * Does `cond` evaluating TRUTHY prove `predicate`? `a && b` truthy proves
 * whatever either conjunct proves, so we recurse through `&&` (and through
 * parentheses) and nothing else. Never through `||`, `?:`, or a call — in
 * those shapes the check may not have controlled the read at all.
 */
function truthyProves(cond, predicate) {
  const expr = unparen(cond);
  if (predicate(expr)) return true;
  if (
    ts.isBinaryExpression(expr)
    && expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    return truthyProves(expr.left, predicate) || truthyProves(expr.right, predicate);
  }
  return false;
}

/**
 * The dual: does `cond` evaluating FALSY prove `predicate`? `a || b` falsy
 * means BOTH disjuncts are falsy, so we recurse through `||` only.
 */
function falsyProves(cond, predicate) {
  const expr = unparen(cond);
  if (predicate(expr)) return true;
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return falsyProves(expr.left, predicate) || falsyProves(expr.right, predicate);
  }
  return false;
}

/** Does this statement unconditionally leave the enclosing block? */
function isTerminalStatement(stmt) {
  if (!stmt) return false;
  if (
    ts.isReturnStatement(stmt)
    || ts.isThrowStatement(stmt)
    || ts.isContinueStatement(stmt)
    || ts.isBreakStatement(stmt)
  ) {
    return true;
  }
  if (ts.isBlock(stmt)) return isTerminalStatement(stmt.statements[stmt.statements.length - 1]);
  return false;
}

function hasStatementList(node) {
  return (
    ts.isBlock(node)
    || ts.isSourceFile(node)
    || ts.isModuleBlock(node)
    || ts.isCaseClause(node)
    || ts.isDefaultClause(node)
  );
}

/**
 * FIX 3a — early-exit dominance.
 *
 * `if (typeof process === "undefined") return;` guards every statement after
 * it: control only reaches them when the condition was falsy. This is the
 * repo's own house idiom for ambient globals (`src/persist.ts` guards
 * `navigator` exactly this way), and the previous rule rejected it — pushing
 * the next author toward deleting the rule rather than satisfying it.
 */
function precededByEarlyExitGuard(container, child, provesUndefined) {
  const statements = container.statements;
  if (!statements) return false;
  const index = statements.indexOf(child);
  if (index < 0) return false;
  for (let i = 0; i < index; i++) {
    const stmt = statements[i];
    if (!ts.isIfStatement(stmt) || stmt.elseStatement) continue;
    if (!isTerminalStatement(stmt.thenStatement)) continue;
    // Execution reaches `child` only when this condition was FALSY.
    if (falsyProves(stmt.expression, provesUndefined)) return true;
  }
  return false;
}

/**
 * Walk up from a `process` reference looking for a DOMINATING guard.
 *
 * Recognised guard positions (deliberately conservative — an unrecognised
 * shape reports rather than stays silent, so the rule fails loud, never open):
 *   - right operand of `&&` whose left proves defined
 *   - right operand of `||` whose left proves undefined
 *   - ternary true-arm (condition proves defined) / false-arm (proves undefined)
 *   - `if` then-branch (condition proves defined) / else-branch (proves undefined)
 *   - any statement preceded in its block by an early-exit undefined guard
 */
function isGuarded(node, provesDefined, provesUndefined) {
  let child = node;
  let parent = node.parent;

  while (parent) {
    if (ts.isBinaryExpression(parent) && unparen(parent.right) === unparen(child)) {
      const kind = parent.operatorToken.kind;
      if (kind === ts.SyntaxKind.AmpersandAmpersandToken && truthyProves(parent.left, provesDefined)) {
        return true;
      }
      if (kind === ts.SyntaxKind.BarBarToken && falsyProves(parent.left, provesUndefined)) {
        return true;
      }
    }

    if (ts.isConditionalExpression(parent)) {
      if (parent.whenTrue === child && truthyProves(parent.condition, provesDefined)) return true;
      if (parent.whenFalse === child && falsyProves(parent.condition, provesUndefined)) return true;
    }

    if (ts.isIfStatement(parent)) {
      if (parent.thenStatement === child && truthyProves(parent.expression, provesDefined)) {
        return true;
      }
      if (parent.elseStatement === child && falsyProves(parent.expression, provesUndefined)) {
        return true;
      }
    }

    if (
      hasStatementList(parent)
      && ts.isStatement(child)
      && precededByEarlyExitGuard(parent, child, provesUndefined)
    ) {
      return true;
    }

    child = parent;
    parent = parent.parent;
  }

  return false;
}

// ─────────────────────────────────────────────
// Position / shadowing filters
// ─────────────────────────────────────────────

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
 * every declaration name — none of which read the global BINDING.
 *
 * Note: the `process` in `globalThis.process` lands here too and stays exempt
 * AS AN IDENTIFIER — that hazard is reported once, on the member-access node,
 * by `isGlobalProcessAccess`. Reporting both would double-count one defect.
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
    if (
      ts.isTypeNode(current)
      || ts.isTypeAliasDeclaration(current)
      || ts.isInterfaceDeclaration(current)
    ) {
      return true;
    }
    if (ts.isSourceFile(current) || ts.isFunctionLike(current) || ts.isBlock(current)) return false;
    current = current.parent;
  }
  return false;
}

/**
 * Is `node` the `expression` of a parent access/call that carries a `?.`?
 * `globalThis.process?.env` is safe: the optional link short-circuits on the
 * `undefined` a browser hands back.
 */
function isOptionalChainedThrough(node) {
  const parent = node.parent;
  if (!parent) return false;
  return (
    (ts.isPropertyAccessExpression(parent)
      || ts.isElementAccessExpression(parent)
      || ts.isCallExpression(parent))
    && parent.expression === node
    && Boolean(parent.questionDotToken)
  );
}

// ─────────────────────────────────────────────
// Suppression comments (FIX 3c)
// ─────────────────────────────────────────────

const SUPPRESSION_RE = new RegExp(`//\\s*lint-ok:\\s*${RULE}\\b(.*)$`);

/**
 * @returns `null` when the line carries no suppression, otherwise
 *   `{ reason }` — an empty reason meaning the suppression is malformed.
 */
function parseSuppression(line) {
  const match = SUPPRESSION_RE.exec(line ?? "");
  if (!match) return null;
  // Strip the separator (em dash, en dash, hyphen, colon), then the reason.
  const reason = match[1].replace(/^[\s–—:-]+/, "").trim();
  return { reason };
}

// ─────────────────────────────────────────────
// Checker
// ─────────────────────────────────────────────

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
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const lines = sourceText.split(/\r?\n/);
  const aliases = collectGuardAliases(sourceFile);
  const { provesDefined, provesUndefined } = makeProvers(aliases);

  const violations = [];
  const report = (node, message) => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({
      file: fileName,
      line: line + 1,
      column: character + 1,
      text: (lines[line] ?? "").trim(),
      message,
    });
  };

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
      && !isGuarded(node, provesDefined, provesUndefined)
    ) {
      report(node, MESSAGE);
    }

    // FIX 5 — `globalThis.process` and friends are the same hazard wearing a
    // portable-looking hat, and this rule's own message invites them.
    if (
      !shadowedHere
      && isGlobalProcessAccess(node)
      && !(node.parent && ts.isTypeOfExpression(node.parent))
      && !isOptionalChainedThrough(node)
      && !isInTypePosition(node)
      && !isGuarded(node, provesDefined, provesUndefined)
    ) {
      report(node, GLOBAL_MESSAGE);
    }

    ts.forEachChild(node, (child) => visit(child, shadowedHere));
  };

  visit(sourceFile, false);

  // Apply the escape hatch: a suppression on the offending line, or the line
  // directly above it, clears the violation — provided it carries a reason.
  const kept = violations.filter((v) => {
    const own = parseSuppression(lines[v.line - 1]);
    const above = parseSuppression(lines[v.line - 2]);
    return !((own && own.reason) || (above && above.reason));
  });

  // A reasonless suppression is itself a violation — otherwise the "auditable"
  // escape hatch is just a mute button.
  lines.forEach((line, index) => {
    const suppression = parseSuppression(line);
    if (suppression && !suppression.reason) {
      kept.push({
        file: fileName,
        line: index + 1,
        column: line.indexOf("//") + 1,
        text: line.trim(),
        message: SUPPRESSION_REASON_MESSAGE,
      });
    }
  });

  kept.sort((a, b) => a.line - b.line || a.column - b.column);
  return kept;
}

function isLintable(file) {
  if (!LINTABLE_EXTENSIONS.has(extname(file))) return false;
  // Specs run only under Node/vitest and are never published.
  if (/\.(spec|test)\.[cm]?tsx?$/.test(file)) return false;
  if (/\.d\.[cm]?ts$/.test(file)) return false;
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
    // FIX 7 — an explicit FILE target goes through the SAME gate as a
    // discovered one, so naming a spec file directly can no longer bypass the
    // documented spec exemption.
    if (isLintable(target)) out.push(target);
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

/**
 * Resolve CLI/API targets to a concrete file list, reporting any that do not
 * exist.
 *
 * FIX 6 — a target that resolved to nothing used to be swallowed, so a typo'd
 * path printed ✓ and exited 0. Harmless for the bare `pnpm lint` invocation,
 * fatal the moment the rule is wired into lint-staged, a pre-commit hook, or a
 * changed-files CI step: a green tick over an empty scan.
 *
 * @param {string[]} paths
 * @param {string} [baseDir] directory the paths resolve against
 * @returns {{ files: string[], missing: string[] }}
 */
export function resolveTargets(paths, baseDir = REPO_ROOT) {
  const files = [];
  const missing = [];
  for (const p of paths) {
    const target = resolve(baseDir, p);
    if (!existsSync(target)) {
      missing.push(p);
      continue;
    }
    collectFiles(target, files);
  }
  return { files, missing };
}

/** @returns {Array} violations across every file under the given paths */
export function checkPaths(paths, baseDir = REPO_ROOT) {
  const { files } = resolveTargets(paths, baseDir);
  return files.flatMap((file) => checkSource(readFileSync(file, "utf8"), relative(REPO_ROOT, file)));
}

function main() {
  const args = process.argv.slice(2);
  const usingArgs = args.length > 0;
  // Explicit arguments are the CALLER's paths — resolve them the way every
  // other CLI does, against the working directory. The no-arg defaults are the
  // repo's own roots and stay anchored to the repo.
  const baseDir = usingArgs ? process.cwd() : REPO_ROOT;
  const paths = usingArgs ? args : DEFAULT_ROOTS;

  const { files, missing } = resolveTargets(paths, baseDir);
  if (missing.length > 0) {
    console.error(`\n✗ ${RULE}: ${missing.length} path(s) do not exist\n`);
    for (const m of missing) console.error(`  ${m}  (resolved against ${baseDir})`);
    console.error("");
    return 2;
  }

  const violations = files.flatMap((file) =>
    checkSource(readFileSync(file, "utf8"), relative(REPO_ROOT, file)),
  );

  if (violations.length === 0) {
    console.log(`✓ ${RULE}: no unguarded \`process\` references in shipped source`);
    return 0;
  }

  console.error(`\n✗ ${RULE}: ${violations.length} unguarded \`process\` reference(s)\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}:${v.column}`);
    console.error(`    ${v.text}`);
  }
  console.error(`\n  ${violations[0].message}\n`);
  return 1;
}

// Only run the CLI when executed directly, so tests can import the checkers.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
