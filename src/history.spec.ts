/**
 * History store suite (DAN-577 scope item 3 / ADR-007 §3): field-level
 * rows with write ids and origins; purge-on-remove erasure; evict
 * excluded; count cap AND byte budget enforced oldest-first.
 */
import { describe, expect, it } from "vitest";
import { createEntityStore } from "./store";
import { createOptimisticUpdates } from "./transactions";
import { enableHistory, createWriteIdGenerator } from "./history";

describe("recording", () => {
  it("records one row per changed field, sharing a mutationId, with origin + txId", () => {
    const store = createEntityStore();
    const history = enableHistory(store);

    store.set("contact", "1", { id: "1", name: "Alice", age: 30 });
    const opt = createOptimisticUpdates(store);
    const tx = opt.transaction();
    tx.set("contact", "1", { id: "1", name: "Alicia", age: 30, city: "LA" });
    tx.commit();

    const created = history.list({ origin: undefined }); // all
    // First write: id, name, age (3 fields from nothing)
    const firstIds = new Set(created.slice(0, 3).map((e) => e.mutationId));
    expect(created.slice(0, 3).map((e) => e.field).sort()).toEqual(["age", "id", "name"]);
    expect(firstIds.size).toBe(1); // one write id for the whole event

    // Second write: name changed + city added (age unchanged — no row)
    const txRows = history.list({ transactionId: "tx-1" });
    expect(txRows.map((e) => e.field).sort()).toEqual(["city", "name"]);
    expect(txRows[0].origin).toBe("local-mutation");
    expect(txRows[0].mutationId).not.toBe([...firstIds][0]);
    const nameRow = txRows.find((e) => e.field === "name")!;
    expect(nameRow.old).toBe("Alice");
    expect(nameRow.new).toBe("Alicia");
    history.dispose();
  });

  it("excludes evict events entirely — rows for the entity remain", () => {
    const store = createEntityStore();
    const history = enableHistory(store);
    store.set("contact", "1", { id: "1", name: "Alice" });
    const before = history.size();

    store.evict("contact", "1");
    expect(history.size()).toBe(before); // no new rows, nothing purged
    history.dispose();
  });

  it("write ids are unique and monotonic per store", () => {
    const gen = createWriteIdGenerator();
    expect([gen(), gen(), gen()]).toEqual(["w-1", "w-2", "w-3"]);
  });
});

describe("erasure — purge on remove/clear", () => {
  it("remove purges every retained row for the entity and leaves a data-free marker", () => {
    const store = createEntityStore();
    const history = enableHistory(store);
    store.set("contact", "1", { id: "1", secret: "hunter2" });
    store.set("contact", "1", { id: "1", secret: "hunter3" });
    store.set("contact", "2", { id: "2", name: "other" });

    store.remove("contact", "1");

    const rows1 = history.list({ entityType: "contact", id: "1" });
    expect(rows1).toHaveLength(1); // only the marker survived
    expect(rows1[0].type).toBe("remove");
    expect(rows1[0].field).toBeNull();
    expect(rows1[0].old).toBeUndefined(); // no data retained
    expect(JSON.stringify(history.list())).not.toContain("hunter"); // truly erased
    expect(history.list({ id: "2" }).length).toBeGreaterThan(0); // others untouched
    history.dispose();
  });

  it("clear() scrubs entity data from history (logout path)", () => {
    const store = createEntityStore();
    const history = enableHistory(store);
    store.set("contact", "1", { id: "1", email: "a@example.com" });
    store.set("order", "9", { id: "9", card: "4242" });

    store.clear();

    const dump = JSON.stringify(history.list());
    expect(dump).not.toContain("a@example.com");
    expect(dump).not.toContain("4242");
    expect(history.list().every((e) => e.type === "remove")).toBe(true);
    history.dispose();
  });
});

describe("erasure boundary — KNOWN LIMIT, pinned until transaction-aware invalidation lands", () => {
  // Review finding F1 (2026-07-19): replay bookkeeping in the transaction
  // layer survives remove/clear. This test PINS the current (unwanted)
  // resurrection so the boundary is visible and the follow-up fix flips
  // exactly one assertion set. The documented contract: settle or abort
  // all transactions BEFORE erasure flows.
  it("a rollback AFTER clear() re-records replayed data (why logout must settle transactions first)", () => {
    const store = createEntityStore();
    const history = enableHistory(store);
    store.set("contact", "1", { id: "1", secret: "hunter2" });

    const opt = createOptimisticUpdates(store);
    const tx = opt.transaction();
    tx.set("contact", "1", { id: "1", secret: "hunter3" });

    store.clear(); // erasure with tx still in flight
    expect(JSON.stringify(history.list())).not.toContain("hunter"); // scrubbed…

    tx.rollback(); // …but replay bookkeeping resurrects the snapshot
    expect(JSON.stringify(history.list())).toContain("hunter2"); // ← the known limit

    // The SAFE pattern the docs mandate: settle first, then erase
    const store2 = createEntityStore();
    const history2 = enableHistory(store2);
    store2.set("contact", "1", { id: "1", secret: "hunter2" });
    const opt2 = createOptimisticUpdates(store2);
    const tx2 = opt2.transaction();
    tx2.set("contact", "1", { id: "1", secret: "hunter3" });
    tx2.rollback(); // settle FIRST
    store2.clear(); // then erase
    expect(JSON.stringify(history2.list())).not.toContain("hunter"); // holds
    history.dispose();
    history2.dispose();
  });
});

describe("bounds", () => {
  it("count cap drops oldest rows first", () => {
    const store = createEntityStore();
    const history = enableHistory(store, { maxEntries: 3 });
    for (let i = 1; i <= 5; i++) {
      store.set("n", String(i), { id: String(i), v: i });
    }
    // each set = 2 rows (id, v) → far over cap; newest survive
    expect(history.size()).toBe(3);
    const kept = history.list().map((e) => e.id);
    expect(kept).toContain("5");
    expect(kept).not.toContain("1");
    history.dispose();
  });

  it("byte budget is enforced; an oversize single row is not retained", () => {
    const store = createEntityStore();
    const history = enableHistory(store, { maxBytes: 400 });
    store.set("doc", "small", { id: "small", body: "ok" });
    expect(history.size()).toBeGreaterThan(0);
    expect(history.bytes()).toBeLessThanOrEqual(400);

    store.set("doc", "huge", { id: "huge", body: "x".repeat(2000) });
    // The huge body row cannot fit the budget at all
    expect(history.bytes()).toBeLessThanOrEqual(400);
    expect(history.list().some((e) => e.field === "body" && e.id === "huge")).toBe(false);
    history.dispose();
  });

  it("dispose stops recording but retained rows stay readable", () => {
    const store = createEntityStore();
    const history = enableHistory(store);
    store.set("contact", "1", { id: "1" });
    const size = history.size();
    history.dispose();
    store.set("contact", "2", { id: "2" });
    expect(history.size()).toBe(size);
  });
});
