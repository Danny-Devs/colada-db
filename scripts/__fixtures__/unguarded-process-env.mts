/**
 * FIXTURE — deliberately violating, in a `.mts` file.
 *
 * The extension allowlist used to be `extname(file) === ".ts"` exactly, so
 * `.tsx` / `.mts` / `.cts` shipped source was silently UNSCANNED — the rule
 * reported ✓ over files it had never opened. This fixture pins the widened
 * allowlist (DAN-649 / FIX 7).
 */
export function unscannedBefore(): void {
  if (process.env.NODE_ENV !== "production") {
    console.warn("a .mts file is shipped source too");
  }
}
