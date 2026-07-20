/**
 * Optimistic-transaction suite (chip 2.5) + scar-tissue legs:
 * - A1(b): untouched refs stay === across a rolled-back transaction
 *   (Dexie #2034 class, the rollback leg).
 * - A2: optimistic-op cleanup after failures (Dexie #2058 class — the
 *   bookkeeping must be consistent after rollbacks/failed settles).
 */
import { describe, expect, it } from "vitest";
import { createEntityStore } from "./store";
import { createOptimisticUpdates } from "./transactions";

describe("createOptimisticUpdates", () => {
  it("apply → commit keeps the optimistic value", () => {
    const store = createEntityStore();
    store.set("contact", "1", { id: "1", name: "Alice" });
    const optimistic = createOptimisticUpdates(store);

    const tx = optimistic.apply("contact", "1", { id: "1", name: "Alicia" });
    expect(store.get("contact", "1").value?.name).toBe("Alicia");
    tx.commit();
    expect(store.get("contact", "1").value?.name).toBe("Alicia");
  });

  it("apply → rollback restores server truth (existing entity)", () => {
    const store = createEntityStore();
    store.set("contact", "1", { id: "1", name: "Alice", email: "a@x.com" });
    const optimistic = createOptimisticUpdates(store);

    const tx = optimistic.apply("contact", "1", { id: "1", name: "Alicia" });
    tx.rollback();
    expect(store.get("contact", "1").value).toEqual({ id: "1", name: "Alice", email: "a@x.com" });
  });

  it("rollback of an optimistic CREATE removes the entity", () => {
    const store = createEntityStore();
    const optimistic = createOptimisticUpdates(store);

    const tx = optimistic.apply("contact", "new", { id: "new", name: "Ghost" });
    expect(store.has("contact", "new")).toBe(true);
    tx.rollback();
    expect(store.has("contact", "new")).toBe(false);
  });

  it("multi-mutation transaction rolls back atomically", () => {
    const store = createEntityStore();
    store.set("contact", "1", { id: "1", name: "Alice" });
    const optimistic = createOptimisticUpdates(store);

    const tx = optimistic.transaction();
    tx.set("contact", "1", { id: "1", name: "Alicia" });
    tx.set("order", "5", { id: "5", status: "confirmed" });
    tx.remove("contact", "1"); // even removes
    tx.rollback();

    expect(store.get("contact", "1").value?.name).toBe("Alice");
    expect(store.has("order", "5")).toBe(false);
  });

  it("concurrent transactions: rolling back A replays B on top of server truth", () => {
    const store = createEntityStore();
    store.set("contact", "1", { id: "1", name: "Alice", email: "a@x.com" });
    const optimistic = createOptimisticUpdates(store);

    const a = optimistic.transaction();
    a.set("contact", "1", { id: "1", name: "A-name" });
    const b = optimistic.transaction();
    b.set("contact", "1", { id: "1", email: "b@x.com" });

    a.rollback();
    const v = store.get("contact", "1").value;
    expect(v?.name).toBe("Alice"); // A's change gone
    expect(v?.email).toBe("b@x.com"); // B's change survives (replayed)
  });

  it("REGRESSION: rolling back B after A commits does NOT revert A's confirmed change", () => {
    const store = createEntityStore();
    store.set("contact", "1", { id: "1", name: "Alice", email: "a@x.com" });
    const optimistic = createOptimisticUpdates(store);

    const a = optimistic.transaction();
    a.set("contact", "1", { id: "1", name: "A-confirmed" });
    const b = optimistic.transaction();
    b.set("contact", "1", { id: "1", email: "b@x.com" });

    a.commit(); // A's write is now confirmed truth
    b.rollback(); // must NOT resurrect pre-A state

    const v = store.get("contact", "1").value;
    expect(v?.name).toBe("A-confirmed");
    expect(v?.email).toBe("a@x.com");
  });

  it("double-settle is a no-op (commit then rollback, rollback then commit)", () => {
    const store = createEntityStore();
    store.set("contact", "1", { id: "1", name: "Alice" });
    const optimistic = createOptimisticUpdates(store);

    const tx = optimistic.apply("contact", "1", { id: "1", name: "Alicia" });
    tx.commit();
    tx.rollback(); // no-op — must not revert the committed value
    expect(store.get("contact", "1").value?.name).toBe("Alicia");

    const tx2 = optimistic.apply("contact", "1", { id: "1", name: "Third" });
    tx2.rollback();
    tx2.commit(); // no-op
    expect(store.get("contact", "1").value?.name).toBe("Alicia");
  });

  // A1(b) — the rollback leg of referential stability (Dexie #2034 class)
  it("A1b: entities untouched by a rolled-back transaction keep === identity", () => {
    const store = createEntityStore();
    store.set("contact", "1", { id: "1", name: "Alice" });
    store.set("contact", "2", { id: "2", name: "Bob" });
    const bystander = store.get("contact", "2").value;
    const optimistic = createOptimisticUpdates(store);

    const tx = optimistic.transaction();
    tx.set("contact", "1", { id: "1", name: "Alicia" });
    tx.rollback();

    expect(store.get("contact", "2").value).toBe(bystander);
  });

  // A2 — optimistic-op cleanup after failures (Dexie #2058 class)
  it("A2: repeated failed transactions leave no residue — state converges and later txs work", () => {
    const store = createEntityStore();
    store.set("contact", "1", { id: "1", name: "Alice" });
    const optimistic = createOptimisticUpdates(store);

    // Simulate a flaky mutation failing 10 times in a row
    for (let i = 0; i < 10; i++) {
      const tx = optimistic.apply("contact", "1", { id: "1", name: `attempt-${i}` });
      tx.rollback();
      expect(store.get("contact", "1").value?.name).toBe("Alice");
    }

    // Bookkeeping is clean: a fresh success works and commits normally
    const tx = optimistic.apply("contact", "1", { id: "1", name: "Final" });
    tx.commit();
    expect(store.get("contact", "1").value?.name).toBe("Final");
  });

  it("A2: rollback storm across MIXED entities restores every snapshot exactly", () => {
    const store = createEntityStore();
    store.set("contact", "1", { id: "1", name: "Alice" });
    const optimistic = createOptimisticUpdates(store);

    const txs = [
      optimistic.apply("contact", "1", { id: "1", name: "X" }),
      optimistic.apply("order", "5", { id: "5", status: "pending" }), // create
      optimistic.apply("contact", "9", { id: "9", name: "New" }), // create
    ];
    // Fail them all, out of order
    txs[1].rollback();
    txs[2].rollback();
    txs[0].rollback();

    expect(store.get("contact", "1").value?.name).toBe("Alice");
    expect(store.has("order", "5")).toBe(false);
    expect(store.has("contact", "9")).toBe(false);
  });
});
