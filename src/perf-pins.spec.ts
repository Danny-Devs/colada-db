import { describe, expect, it } from "vitest";
import { effect } from "@vue/reactivity";
import { createEntityStore } from "./store";

/**
 * PERF-REGRESSION PINS — TESTING-STRATEGY.md item 4.
 *
 * These assert *recompute counts and work volume*, never wall-clock time.
 * That split is deliberate and load-bearing:
 *
 *   - Counts are DETERMINISTIC. The same store operations visit the same number
 *     of entities on any machine, under any load, in any CI runner. They can be
 *     asserted exactly, so a regression fails the PR that caused it.
 *   - Timings are NOT. A wall-clock assertion in CI is flaky, and a flaky gate
 *     gets weakened until it asserts nothing. Timings live in `bench/` behind
 *     `pnpm bench`, are reported with median and spread, and gate nothing.
 *
 * The quantity under test is INVALIDATION COST of the reactive projection from
 * `getByType()`: how many times it rebuilds, times how many entities each
 * rebuild produces. That is the P1 scaling class: `getByType()` rebuilds its
 * array by walking the whole type map, so anything that invalidates it more
 * often than necessary is O(n) work per invalidation.
 *
 * A "visit" below = one entity in the projection's OUTPUT for one rebuild
 * (`recomputes × output length`). It is observed from outside the store, so it
 * catches the failure this file exists for — invalidating too often, the
 * O(n^2) shape — and it does NOT see work hidden inside one rebuild: a
 * redundant second traversal of the type map that produces the same output
 * leaves `visits` unchanged. Counting reads at the source would require
 * test-only instrumentation in shipped code, which this repo does not do; the
 * inner cost of a single rebuild is what `bench/` measures in time.
 *
 * @see bench/README.md for the measured figures and how to reproduce them.
 */

/** Attach a live subscriber; count rebuilds, and output entities per rebuild (see the header for what this can and cannot see). */
function watchProjection(view: { value: readonly unknown[] }) {
  const counts = { recomputes: 0, visits: 0 };
  effect(() => {
    counts.recomputes++;
    counts.visits += view.value.length;
  });
  return counts;
}

function rows(n: number, prefix = "u") {
  return Array.from({ length: n }, (_, i) => ({
    entityType: "user",
    id: `${prefix}${i}`,
    data: { id: `${prefix}${i}`, name: `name-${i}` },
  }));
}

describe("perf pins — getByType projection invalidation", () => {
  /**
   * The headline scaling guarantee. `setMany` bumps the type version ONCE per
   * type (store.ts, "Bump type versions once per type, not per entity"), so a
   * bulk write costs one rebuild regardless of batch size.
   *
   * If someone makes `setMany` bump per entity, this batch becomes O(n^2) and
   * this pin fails. That is the entire point of the pin.
   */
  it("a batched write of N entities rebuilds the projection a constant number of times", () => {
    for (const n of [100, 400, 1600]) {
      const store = createEntityStore();
      const counts = watchProjection(store.getByType("user"));
      store.setMany(rows(n));

      // One rebuild for the initial (empty) read, one for the single version bump.
      expect(counts.recomputes, `n=${n} rebuilds`).toBeLessThanOrEqual(2);
      // Work stays linear: the projection is built once over n entities.
      expect(counts.visits, `n=${n} visits`).toBeLessThanOrEqual(2 * n);
    }
  });

  /**
   * The O(n^2) canary, stated as a shape rather than a constant so it survives
   * legitimate implementation changes. Doubling the batch must not much more
   * than double the work. A quadratic regression drives this ratio toward 2n.
   */
  it("batched write work grows linearly, not quadratically, in batch size", () => {
    const measure = (n: number) => {
      const store = createEntityStore();
      const counts = watchProjection(store.getByType("user"));
      store.setMany(rows(n));
      return counts.visits;
    };

    const small = measure(500);
    const large = measure(1000);

    // Linear would be ~2.0x. Quadratic would be ~4.0x. 2.5x leaves room for the
    // constant-cost initial read without admitting a scaling change.
    expect(large / small, `visit growth 500 -> 1000`).toBeLessThan(2.5);
  });

  /**
   * Guards `hasChangedFields`. A write whose fields all match the stored entity
   * must not touch reactivity at all — this is what lets a list query and a
   * detail query overlap without cascading invalidation through every view.
   */
  it("a no-op write does not rebuild the projection", () => {
    const store = createEntityStore();
    store.setMany(rows(200));
    const counts = watchProjection(store.getByType("user"));
    const baseline = counts.recomputes;

    for (let i = 0; i < 50; i++) {
      store.set("user", "u7", { id: "u7", name: "name-7" }); // identical payload
    }

    expect(counts.recomputes - baseline, "rebuilds after 50 no-op writes").toBe(0);
  });

  /**
   * The other side of the boundary. A pin that only ever asserts "did not fire"
   * cannot tell a working guard from a broken subscriber, so this asserts the
   * projection DOES react to a structural change. Without it the no-op pin
   * above could pass for the wrong reason.
   */
  it("CONTROL — adding an entity does rebuild the projection", () => {
    const store = createEntityStore();
    store.setMany(rows(200));
    const counts = watchProjection(store.getByType("user"));
    const baseline = counts.recomputes;

    store.set("user", "brand-new", { id: "brand-new", name: "new" });

    expect(counts.recomputes - baseline, "rebuilds after one add").toBe(1);
  });

  /**
   * Pins the CURRENT cost of a field update, which is O(n) per update: the
   * projection reads every entity ref while building its array, so it depends
   * on all of them, and one changed field rebuilds the whole array.
   *
   * This pin is written as an upper bound on the number of REBUILDS (one per
   * update, never more). It deliberately does NOT bless the O(n) visit cost as
   * correct — see bench/README.md "Finding 2", which measures that cost and
   * proposes an ids-only projection. This pin exists so that if the invalidation
   * gets *worse* than one rebuild per update, CI says so.
   */
  it("a field update rebuilds the projection exactly once, never more", () => {
    const store = createEntityStore();
    store.setMany(rows(300));
    const counts = watchProjection(store.getByType("user"));
    const baseline = counts.recomputes;

    const updates = 40;
    for (let i = 0; i < updates; i++) {
      store.set("user", "u0", { id: "u0", name: `renamed-${i}` });
    }

    expect(counts.recomputes - baseline, "rebuilds per field update").toBe(updates);
  });

  /**
   * Per-entity subscribers must stay isolated: changing entity A must not wake
   * a subscriber holding only entity B. This is the normalized-store promise
   * ("one copy, every view holding it sees the change") stated as its contra-
   * positive, which is the half that is easy to regress.
   */
  it("a per-entity subscriber does not wake for an unrelated entity", () => {
    const store = createEntityStore();
    store.setMany(rows(200));

    const target = store.get("user", "u5");
    let wakes = 0;
    effect(() => {
      wakes++;
      void target.value;
    });
    const baseline = wakes;

    for (let i = 10; i < 60; i++) {
      store.set("user", `u${i}`, { id: `u${i}`, name: `changed-${i}` });
    }
    expect(wakes - baseline, "wakes from 50 unrelated writes").toBe(0);

    store.set("user", "u5", { id: "u5", name: "changed" });
    expect(wakes - baseline, "wakes after its own entity changed").toBe(1);
  });
});
