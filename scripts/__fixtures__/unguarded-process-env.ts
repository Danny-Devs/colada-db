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
