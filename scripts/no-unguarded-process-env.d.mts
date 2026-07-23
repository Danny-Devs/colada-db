/**
 * Type surface for the `no-unguarded-process-env` lint rule (DAN-649 / A1).
 *
 * The rule itself is plain ESM (`.mjs`) so it can run as a standalone node
 * script from `pnpm lint` with no build step. This declaration exists so the
 * rule's own regression spec (`src/process-guard.spec.ts`) can import it under
 * `strict` typechecking.
 */

export interface ProcessEnvViolation {
  /** Path of the offending file, relative to the repo root. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  column: number;
  /** The trimmed source line, for reporting. */
  text: string;
  /** The teaching message explaining why the rule exists and how to fix it. */
  message: string;
}

/** Report every unguarded reference to the global `process` binding. */
export function checkSource(sourceText: string, fileName?: string): ProcessEnvViolation[];

/** Report violations across every shipped `.ts` file under the given paths. */
export function checkPaths(paths: string[]): ProcessEnvViolation[];
