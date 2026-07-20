/**
 * Event-ordering + consistency suite (arch review H5 + H3; roadmap 0.5/0.6).
 *
 * The invariants the history store, sync outbox, and cross-tab bus will
 * all silently depend on:
 * 1. No reentrant delivery — a listener that writes causes queued, not
 *    nested, delivery (causal order preserved).
 * 2. State visible at event time is uniform: maps AND type versions are
 *    settled before delivery, for set() and setMany() alike.
 * 3. The emitted event stream is REPLAYABLE: applying it to a fresh store
 *    reproduces identical state.
 * 4. One optimistic handle per store, structurally.
 */
import { describe, expect, it } from "vitest";
import type { EntityEvent, EntityRecord } from "./types";
import { createEntityStore } from "./store";
import { createOptimisticUpdates } from "./transactions";

describe("H5 — event ordering", () => {
  it("a listener that writes causes queued delivery, never nested (causal order)", () => {
    const store = createEntityStore();
    const seen: string[] = [];
    store.subscribe((e) => {
      seen.push(`${e.entityType}:${e.id}`);
      // Reactive listener: writing from inside delivery (the tx-replay shape)
      if (e.entityType === "contact" && e.id === "1" && e.type === "set") {
        store.set("audit", "log-1", { id: "log-1", about: "contact:1" });
      }
    });

    store.set("contact", "1", { id: "1", name: "Alice" });

    // The outer event is FULLY delivered before the nested one starts:
    // contact:1 first, audit:log-1 second — never interleaved/inverted.
    expect(seen).toEqual(["contact:1", "audit:log-1"]);
  });

  it("all listeners receive the outer event before any receives the nested event", () => {
    const store = createEntityStore();
    const order: string[] = [];
    store.subscribe((e) => {
      order.push(`L1:${e.key}`);
      if (e.key === "contact:1") store.set("audit", "x", { id: "x" });
    });
    store.subscribe((e) => order.push(`L2:${e.key}`));

    store.set("contact", "1", { id: "1" });
    expect(order).toEqual(["L1:contact:1", "L2:contact:1", "L1:audit:x", "L2:audit:x"]);
  });

  it("setMany: getByType() read inside a listener sees the settled batch (uniform consistency)", () => {
    const store = createEntityStore();
    const countsAtEventTime: number[] = [];
    store.subscribe((e) => {
      if (e.entityType === "contact") {
        countsAtEventTime.push(store.getByType("contact").value.length);
      }
    });

    store.setMany([
      { entityType: "contact", id: "1", data: { id: "1" } },
      { entityType: "contact", id: "2", data: { id: "2" } },
    ]);

    // Both events observe the FULLY settled batch — versions bumped before
    // delivery, exactly as a lone set() behaves.
    expect(countsAtEventTime).toEqual([2, 2]);
  });

  it("the event stream is replayable: applying it to a fresh store reproduces identical state", () => {
    const source = createEntityStore();
    const stream: EntityEvent[] = [];
    source.subscribe((e) => stream.push(e));

    // A representative history incl. merges, removes, evicts, transactions
    source.set("contact", "1", { id: "1", name: "Alice" });
    source.setMany([
      { entityType: "contact", id: "2", data: { id: "2", name: "Bob" } },
      { entityType: "order", id: "5", data: { id: "5", total: 10 } },
    ]);
    source.set("contact", "1", { id: "1", email: "a@x.com" }); // merge
    const tx = createOptimisticUpdates(source).transaction();
    tx.set("contact", "2", { id: "2", name: "Bobby" });
    tx.rollback();
    source.remove("order", "5");
    source.evict("contact", "1"); // memory-only — replay must respect the distinction

    // Replay: set/remove/evict applied in order (replace semantics — event
    // .data is the full post-write value, so replace, not merge)
    const replica = createEntityStore();
    for (const e of stream) {
      if (e.type === "set" && e.data) replica.replace(e.entityType, e.id, e.data as EntityRecord);
      else if (e.type === "remove") replica.remove(e.entityType, e.id);
      else if (e.type === "evict") replica.evict(e.entityType, e.id);
    }

    expect(replica.toJSON()).toEqual(source.toJSON());
  });
});

describe("H3 — one optimistic handle per store, structurally", () => {
  it("createOptimisticUpdates returns the SAME handle for the same store", () => {
    const store = createEntityStore();
    const a = createOptimisticUpdates(store);
    const b = createOptimisticUpdates(store);
    expect(b).toBe(a);
  });

  it("the old two-handle corruption is now impossible: interleaved rollbacks stay correct", () => {
    const store = createEntityStore();
    store.set("contact", "1", { id: "1", name: "Server" });

    // Previously: two handles → B snapshots A's optimistic state as truth.
    // Now both calls share bookkeeping.
    const txA = createOptimisticUpdates(store).transaction();
    txA.set("contact", "1", { id: "1", name: "A-optimistic" });
    const txB = createOptimisticUpdates(store).transaction();
    txB.set("contact", "1", { id: "1", name: "B-optimistic" });

    txB.rollback();
    expect(store.get("contact", "1").value?.name).toBe("A-optimistic"); // A replayed
    txA.rollback();
    expect(store.get("contact", "1").value?.name).toBe("Server"); // true server truth
  });

  it("distinct stores get distinct handles", () => {
    const a = createOptimisticUpdates(createEntityStore());
    const b = createOptimisticUpdates(createEntityStore());
    expect(a).not.toBe(b);
  });
});
