/**
 * FIXTURE — deliberately COMPLIANT. The negative control for
 * `no-unguarded-process-env`: a rule that only ever fires is as useless as one
 * that never does, so every guard shape the rule claims to accept is pinned
 * here. If any case below starts reporting, the rule has become a false-positive
 * generator and would push authors toward pointless ceremony.
 */

// 1. the canonical shape the rule teaches (and the one A1 shipped)
export function canonical(): void {
  if (typeof process !== "undefined" && process.env?.NODE_ENV !== "production") {
    console.warn("dev only");
  }
}

// 2. same, with an unrelated condition ahead of the guard
export function guardAfterOtherCondition(store: unknown): void {
  if (!store && typeof process !== "undefined" && process.env?.NODE_ENV !== "production") {
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
