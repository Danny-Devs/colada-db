/**
 * FIXTURE — deliberately COMPLIANT. The negative control for
 * `no-unguarded-process-env`: a rule that only ever fires is as useless as one
 * that never does, so every guard shape the rule claims to accept is pinned
 * here. If any case below starts reporting, the rule has become a false-positive
 * generator and would push authors toward pointless ceremony — or, worse, toward
 * deleting the rule from `package.json`.
 */

// 1. the canonical shape the rule teaches (and the one A1 ships in `src/`).
//    NOTE the plain `process.env &&` conjunct rather than `process.env?.` — the
//    optional-chained spelling is equally SAFE but not STRIPPABLE, and
//    `src/process-guard.spec.ts` pins the literal `process.env.NODE_ENV` that
//    every bundler's define/replace pass keys on.
export function canonical(): void {
  if (typeof process !== "undefined" && process.env && process.env.NODE_ENV !== "production") {
    console.warn("dev only");
  }
}

// 2. same, with an unrelated condition ahead of the guard
export function guardAfterOtherCondition(store: unknown): void {
  if (!store && typeof process !== "undefined" && process.env && process.env.NODE_ENV !== "production") {
    console.warn("dev only");
  }
}

// 3. the `||`-with-inverted-check form
export function inverted(): boolean {
  return typeof process === "undefined" || process.env?.NODE_ENV !== "production";
}

// 4. ternary true-arm under a positive check
export function ternary(): string {
  return typeof process !== "undefined" ? String(process.env?.NODE_ENV) : "unknown";
}

// 5. `if`-statement then-branch — the guard need not be in the same expression
export function ifStatement(): void {
  if (typeof process !== "undefined") {
    console.warn(process.env?.NODE_ENV);
  }
}

// 6. `typeof process` on its own is always safe — it is the ONE operator that
//    tolerates an undeclared binding, and banning it would ban the guard itself
export function typeofAlone(): boolean {
  return typeof process !== "undefined";
}

// 7. a LOCAL binding named `process` shadows the global and is always safe
export function shadowed(process: { env: Record<string, string> }): string {
  return process.env.NODE_ENV ?? "";
}

// 8. `process` as a PROPERTY name is an unrelated identifier
export function asPropertyName(config: { process: string }): string {
  return config.process;
}

// ── FIX 3a — early-exit dominance (the repo's own house idiom) ──
// `src/persist.ts` guards `navigator` with exactly this inverted early return.
// Rejecting it for `process` would make the rule reject house style, and an
// author who cannot satisfy a rule deletes it.

// 9. inverted early return dominates the rest of the function body
export function earlyReturn(): string {
  if (typeof process === "undefined") return "unknown";
  return String(process.env.NODE_ENV);
}

// 10. same, with the guard folded into a wider disjunction — reaching the
//     remainder proves EVERY disjunct was falsy, so `process` is defined
export function earlyReturnDisjunction(force: boolean): string {
  if (force || typeof process === "undefined") return "unknown";
  return String(process.env.NODE_ENV);
}

// 11. `throw` is an exit too, and a braced body is still terminal
export function earlyThrow(): string {
  if (typeof process === "undefined") {
    throw new Error("node only");
  }
  return String(process.env.NODE_ENV);
}

// 12. `continue` inside a loop dominates the rest of that iteration
export function earlyContinue(names: string[]): string[] {
  const out: string[] = [];
  for (const _name of names) {
    if (typeof process === "undefined") continue;
    out.push(String(process.env.NODE_ENV));
  }
  return out;
}

// ── FIX 3b — hoisted-const guards (the OTHER house idiom) ──
// `src/engines/idb.ts` and `src/engines/sqlite.ts` both hoist their ambient
// checks into a returned boolean rather than inlining them.

// 13. a `const` holding the positive check is a valid guard token
const HAS_PROCESS = typeof process !== "undefined";
export function viaHoistedConst(): boolean {
  return HAS_PROCESS && process.env.NODE_ENV !== "production";
}

// 14. and the negative polarity, used as an early exit
const NO_PROCESS = typeof process === "undefined";
export function viaHoistedNegativeConst(): string {
  if (NO_PROCESS) return "unknown";
  return String(process.env.NODE_ENV);
}

// 15. a negated hoisted const flips polarity correctly
export function viaNegatedConst(): boolean {
  return !NO_PROCESS && process.env.NODE_ENV !== "production";
}

// ── FIX 3c — the auditable escape hatch ──

// 16. a suppression WITH a reason clears the read on the same line
export function suppressedInline(): string {
  return String(process.env.NODE_ENV); // lint-ok: no-unguarded-process-env — fixture: proves the hatch opens
}

// 17. …and on the line directly above it
export function suppressedAbove(): string {
  // lint-ok: no-unguarded-process-env — fixture: proves the above-line form works
  return String(process.env.NODE_ENV);
}

// ── FIX 5 — `globalThis.process` done safely ──

// 18. optional-chained THROUGH the global: `globalThis.process` is `undefined`
//     in a browser, and `?.` short-circuits on it instead of throwing
export function globalOptionalChained(): string | undefined {
  return globalThis.process?.env?.NODE_ENV;
}

// 19. a `typeof` check on the member expression is a real guard
export function globalTypeofGuarded(): boolean {
  return typeof globalThis.process !== "undefined" && globalThis.process.env.NODE_ENV !== "production";
}

// 20. `in` against the global object proves the same thing
export function globalInGuarded(): boolean {
  return "process" in globalThis && globalThis.process.env.NODE_ENV !== "production";
}
