/**
 * FIXTURE — a SPEC file that would violate if it were ever scanned.
 *
 * Specs are exempt by documented policy: they run only under Node/vitest, are
 * never published, and legitimately read `process.cwd()` / `process.env`. The
 * directory walk honoured that exemption, but naming a file DIRECTLY bypassed
 * it (`collectFiles` checked only the extension on a file target), so
 * `node scripts/no-unguarded-process-env.mjs src/foo.spec.ts` linted it —
 * exactly what a lint-staged or changed-files wiring would do. FIX 7 routes
 * file targets through the same `isLintable` gate.
 *
 * Not collected by vitest: the config includes only `src/**\/*.spec.ts`.
 */
export function looksLikeAViolation(): string {
  return String(process.env.NODE_ENV);
}
