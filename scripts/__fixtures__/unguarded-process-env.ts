/**
 * FIXTURE — deliberately violating. Not shipped, not typechecked
 * (`tsconfig.json` includes only `src/**\/*`), not linted by the rule's own
 * default roots (`__fixtures__` is in SKIP_DIRS). It exists so the
 * `no-unguarded-process-env` rule can be proven to FIRE, end-to-end through
 * the real CLI, rather than merely proven not to crash.
 *
 * Each numbered case below is a shape the rule must reject.
 */

// 1. the bare original shape — the exact bug DAN-649/A1 fixed
export function warnOnDegradation(): void {
  if (process.env.NODE_ENV !== "production") {
    console.warn("degraded");
  }
}

// 2. optional chaining alone is NOT enough — `process` itself is still
//    unresolvable, so this throws ReferenceError before `?.` ever applies
export function optionalChainIsNotAGuard(): void {
  if (process.env?.NODE_ENV !== "production") {
    console.warn("still crashes");
  }
}

// 3. a guard for the WRONG binding does not license reading `process`
export function wrongGuard(): void {
  if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
    console.warn("window is not process");
  }
}

// 4. non-`env` members crash identically — the hazard is the binding, not `.env`
export function otherMember(): string {
  return process.platform;
}

// 5. guard polarity inverted: the true-arm of `typeof process === "undefined"`
//    is precisely where `process` is NOT available
export function invertedPolarity(): void {
  if (typeof process === "undefined") {
    console.warn(process.env.NODE_ENV);
  }
}

// ── FIX 4 — CONTAINMENT is not DOMINANCE ──
// Both of the next two CONTAIN a `typeof process` check and both passed the
// pre-FIX-4 rule. Both still throw `ReferenceError` in a real browser realm
// (verified under `node:vm` with `window` present and `process` genuinely
// undeclared), because the check never controlled the read.

// 6. a disjunction: the `window` arm alone satisfies the `&&`
export function disjunctionIsNotDominance(): void {
  if ((typeof window !== "undefined" || typeof process !== "undefined") && process.env.NODE_ENV !== "production") {
    console.warn("throws in a browser");
  }
}

// 7. a ternary: whether the check ran at all depends on `flag`
export function ternaryConditionIsNotDominance(flag: boolean): void {
  if ((flag ? typeof process !== "undefined" : true) && process.env.NODE_ENV !== "production") {
    console.warn("throws when flag is false");
  }
}

// 8. an early exit whose body does NOT exit dominates nothing
export function nonTerminalEarlyGuard(): string {
  if (typeof process === "undefined") console.warn("no process");
  return String(process.env.NODE_ENV);
}

// 9. an early exit of the WRONG polarity: reaching the tail proves `process` is
//    absent, which is the opposite of a licence to read it
export function earlyExitWrongPolarity(): string {
  if (typeof process !== "undefined") return "node";
  return String(process.env.NODE_ENV);
}

// ── FIX 5 — `globalThis.process` is the same hazard in a portable-looking hat ──
// In a browser `globalThis.process` is `undefined`, so `.env` throws
// `TypeError: Cannot read properties of undefined` — same place, same
// degradation path, same bundler-less audience. The rule's own message names
// `process` as "a Node global", which is precisely what invites this rewrite.

// 10. the invited workaround
export function viaGlobalThis(): void {
  if (globalThis.process.env.NODE_ENV !== "production") {
    console.warn("TypeError in a browser");
  }
}

// 11. `self` is the same object in a worker — the engines' own realm
export function viaSelf(): string {
  // @ts-expect-error fixture: `self.process` is exactly the unsound access being pinned
  return String(self.process.env.NODE_ENV);
}

// 12. `?.` AFTER the process member does not protect the member read itself
export function optionalAfterIsTooLate(): string | undefined {
  return globalThis.process.env?.NODE_ENV;
}

// ── FIX 3c — the escape hatch must stay AUDITABLE ──

// 13. a reasonless suppression is itself a violation: without this, the hatch
//     is just a mute button and the rule is one comment away from dead
export function reasonlessSuppression(): string {
  return String(process.env.NODE_ENV); // lint-ok: no-unguarded-process-env
}
