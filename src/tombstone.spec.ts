/**
 * Deep-fix suite (arch review C1 + roadmap 0.4, 2026-07-19):
 * - remove() is an INSTRUCTION, recordable against memory-absent keys —
 *   kills zombie resurrection of evicted entities (C1).
 * - The write channel (runWith) stamps origin/transactionId on events —
 *   the ADR-007 attribution substrate, arriving early for correctness.
 */
import { describe, expect, it } from "vitest";
import type { EntityEvent, EntityKey, StorageEngine } from "./types";
import { createEntityStore } from "./store";
import { enablePersistence } from "./persist";
import { createOptimisticUpdates } from "./transactions";

function recordingEngine(seed: Array<{ key: EntityKey; data: unknown }> = []) {
  const written = new Map<string, unknown>(seed.map((r) => [r.key, r.data]));
  const engine: StorageEngine = {
    isSupported: () => true,
    open: async () => {},
    loadAll: async () => Array.from(written.entries()).map(([key, data]) => ({ key: key as EntityKey, data })),
    loadMany: async (keys) => keys.filter((k) => written.has(k)).map((k) => ({ key: k, data: written.get(k) })),
    async writeBatch(puts, deletes) {
      for (const { key, value } of puts) written.set(key, value);
      for (const key of deletes) written.delete(key);
    },
    close() {},
  };
  return { engine, written };
}

describe("C1 — tombstoned removes (zombie killer)", () => {
  it("remove() of a memory-absent entity still emits the remove event", () => {
    const store = createEntityStore();
    const events: EntityEvent[] = [];
    store.subscribe((e) => events.push(e));

    store.remove("contact", "never-loaded");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("remove");
    expect(events[0].key).toBe("contact:never-loaded");
    expect(events[0].previousData).toBeUndefined();
  });

  it("evict() of a memory-absent entity stays a true no-op (memory operation)", () => {
    const store = createEntityStore();
    const events: EntityEvent[] = [];
    store.subscribe((e) => events.push(e));

    store.evict("contact", "never-loaded");
    expect(events).toHaveLength(0);
  });

  it("END-TO-END: evict → remove deletes the durable row — no resurrection next boot", async () => {
    const { engine, written } = recordingEngine();
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, writeDebounce: 1 });
    await handle.ready;

    store.set("contact", "1", { id: "1", name: "Alice" });
    await handle.flush();
    expect(written.has("contact:1")).toBe(true);

    store.evict("contact", "1"); // memory-absent, durably present (ADR-004)
    store.remove("contact", "1"); // the C1 scenario: delete an evicted entity
    await handle.flush();

    // The fix: the durable row is GONE
    expect(written.has("contact:1")).toBe(false);
    handle.dispose();

    // Next boot: nothing to resurrect
    const store2 = createEntityStore();
    const { engine: engine2 } = recordingEngine(
      Array.from(written.entries()).map(([key, data]) => ({ key: key as EntityKey, data })),
    );
    const handle2 = enablePersistence(store2, { engine: engine2 });
    await handle2.ready;
    expect(store2.has("contact", "1")).toBe(false);
    handle2.dispose();
  });

  it("repeated remove() is idempotent-by-emission (documented: consumers treat deletes idempotently)", () => {
    const store = createEntityStore();
    let removes = 0;
    store.subscribe((e) => {
      if (e.type === "remove") removes++;
    });
    store.remove("contact", "x");
    store.remove("contact", "x");
    expect(removes).toBe(2); // instruction semantics — delete handling downstream is idempotent
  });
});

describe("runWith — the write channel (ADR-007 §1 substrate)", () => {
  it("stamps origin and transactionId on events emitted inside the channel", () => {
    const store = createEntityStore();
    const events: EntityEvent[] = [];
    store.subscribe((e) => events.push(e));

    store.runWith({ origin: "hydration" }, () => {
      store.set("contact", "1", { id: "1", name: "Alice" });
    });
    store.set("contact", "2", { id: "2", name: "Bob" }); // outside the channel

    expect(events[0].origin).toBe("hydration");
    expect(events[1].origin).toBeUndefined();
  });

  it("nesting shadows then restores the outer meta", () => {
    const store = createEntityStore();
    const origins: Array<string | undefined> = [];
    store.subscribe((e) => origins.push(e.origin));

    store.runWith({ origin: "outer" }, () => {
      store.set("a", "1", { id: "1" });
      store.runWith({ origin: "inner" }, () => store.set("a", "2", { id: "2" }));
      store.set("a", "3", { id: "3" });
    });
    expect(origins).toEqual(["outer", "inner", "outer"]);
  });

  it("transaction writes carry local-mutation + a transactionId; rollback restoration carries rollback-replay", () => {
    const store = createEntityStore();
    store.set("contact", "1", { id: "1", name: "Alice" });
    const optimistic = createOptimisticUpdates(store);
    const events: EntityEvent[] = [];
    store.subscribe((e) => events.push(e));

    const tx = optimistic.apply("contact", "1", { id: "1", name: "Alicia" });
    expect(events.at(-1)?.origin).toBe("local-mutation");
    const txId = events.at(-1)?.transactionId;
    expect(txId).toBeTruthy();

    tx.rollback();
    const restore = events.at(-1);
    expect(restore?.origin).toBe("rollback-replay");
    expect(store.get("contact", "1").value?.name).toBe("Alice");
  });

  it("two transactions from one handle carry distinct transactionIds", () => {
    const store = createEntityStore();
    const optimistic = createOptimisticUpdates(store);
    const ids = new Set<string | undefined>();
    store.subscribe((e) => ids.add(e.transactionId));

    optimistic.apply("a", "1", { id: "1" });
    optimistic.apply("a", "2", { id: "2" });
    ids.delete(undefined);
    expect(ids.size).toBe(2);
  });
});
