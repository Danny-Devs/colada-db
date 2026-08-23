/**
 * Scaling report — deterministic COUNTS, not timings.
 *
 * Prints the work volume behind the two findings in bench/README.md. Counts do
 * not vary by machine, so this table is reproducible exactly rather than
 * approximately:
 *
 *     pnpm bench:scaling
 *
 * A "visit" is one entity element read while the `getByType()` projection
 * rebuilds its array.
 */
import { it } from "vitest";
import { effect } from "@vue/reactivity";
import { createEntityStore } from "../src/store";

function watch(view: { value: readonly unknown[] }) {
  const c = { recomputes: 0, visits: 0 };
  effect(() => {
    c.recomputes++;
    c.visits += view.value.length;
  });
  return c;
}

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    entityType: "User",
    id: `u${i}`,
    data: { id: `u${i}`, name: `Author ${i}` },
  }));

it("scaling report", () => {
  console.log("\nFINDING 1 — ingest under a live getByType subscriber");
  console.log("     N | one-at-a-time visits | setMany visits | ratio");
  console.log("  -----|----------------------|----------------|-------");
  for (const n of [100, 200, 400, 800, 1600]) {
    const a = createEntityStore();
    const ca = watch(a.getByType("User"));
    for (const r of rows(n)) a.set(r.entityType, r.id, r.data);

    const b = createEntityStore();
    const cb = watch(b.getByType("User"));
    b.setMany(rows(n));

    console.log(
      `  ${String(n).padStart(4)} | ${String(ca.visits).padStart(20)} | ${String(cb.visits).padStart(14)} | ${(ca.visits / cb.visits).toFixed(1)}x`,
    );
  }

  console.log("\nFINDING 2 — cost of ONE field update on a live projection");
  console.log("  graph size N | visits per single-field update");
  console.log("  -------------|-------------------------------");
  for (const n of [100, 200, 400, 800, 1600]) {
    const s = createEntityStore();
    s.setMany(rows(n));
    const c = watch(s.getByType("User"));
    const v0 = c.visits;
    const updates = 50;
    for (let k = 0; k < updates; k++) s.set("User", "u0", { id: "u0", name: `x${k}` });
    console.log(
      `  ${String(n).padStart(12)} | ${((c.visits - v0) / updates).toFixed(0).padStart(30)}`,
    );
  }
  console.log("");
});
