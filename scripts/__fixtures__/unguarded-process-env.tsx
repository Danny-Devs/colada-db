/**
 * FIXTURE — deliberately violating, in a `.tsx` file. Companion to the `.mts`
 * fixture: both extensions were invisible to the pre-FIX-7 allowlist.
 * Deliberately contains no JSX — the point is the EXTENSION, and the rule
 * parses `.tsx` under `ScriptKind.TSX`.
 */
export function unscannedBefore(): void {
  if (process.env.NODE_ENV !== "production") {
    console.warn("a .tsx file is shipped source too");
  }
}
