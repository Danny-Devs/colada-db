/**
 * Origin attribution suite (DAN-577 scope item 1 / ADR-007 §1): every
 * write path stamps its channel's origin; the ordinary write API stamps
 * nothing. Origin = attribution within one trust domain, not
 * authentication — these tests pin the vocabulary each coordinator owns.
 */
import { describe, expect, it } from "vitest";
import type { EntityEvent, EntityKey, StorageEngine } from "./types";
import { createEntityStore } from "./store";
import { enablePersistence } from "./persist";
import { createOptimisticUpdates } from "./transactions";
import { writeEntitiesToStore } from "./normalize";

function collect(store: ReturnType<typeof createEntityStore>) {
  const events: EntityEvent[] = [];
  const unsub = store.subscribe((e) => events.push(e));
  return { events, unsub };
}

describe("origin attribution — every write path carries its channel", () => {
  it("ordinary store.set / remove carry NO origin (nothing to forge through)", () => {
    const store = createEntityStore();
    const { events } = collect(store);

    store.set("contact", "1", { id: "1" });
    store.remove("contact", "1");

    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.origin).toBeUndefined();
      expect(e.transactionId).toBeUndefined();
    }
  });

  it("hydration writes carry origin 'hydration'", async () => {
    const engine: StorageEngine = {
      isSupported: () => true,
      open: async () => {},
      loadAll: async () => [{ key: "contact:1" as EntityKey, data: { id: "1", name: "durable" } }],
      loadMany: async () => [],
      writeBatch: async () => {},
      close() {},
    };
    const store = createEntityStore();
    const { events } = collect(store);
    const handle = enablePersistence(store, { engine });
    await handle.ready;

    const hydrated = events.filter((e) => e.key === "contact:1");
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0].origin).toBe("hydration");
    handle.dispose();
  });

  it("normalization writes carry origin 'query-response' — both setMany and custom-merge paths", () => {
    const store = createEntityStore();
    const { events } = collect(store);

    writeEntitiesToStore(
      [
        { entityType: "contact", id: "1", data: { id: "1", name: "plain" } },
        { entityType: "thread", id: "9", data: { id: "9", replies: ["a"] } },
      ],
      { thread: { merge: (existing, incoming) => ({ ...existing, ...incoming }) } },
      store,
    );

    expect(events).toHaveLength(2);
    for (const e of events) expect(e.origin).toBe("query-response");
  });

  it("transactional writes carry 'local-mutation' + txId; rollback compensation and replay carry 'rollback-replay' + the OWNER's txId", () => {
    const store = createEntityStore();
    store.set("contact", "1", { id: "1", name: "server" }); // confirmed baseline
    const opt = createOptimisticUpdates(store);

    const { events } = collect(store);
    const txA = opt.transaction();
    txA.set("contact", "1", { id: "1", name: "A" });
    const txB = opt.transaction();
    txB.set("contact", "1", { id: "1", name: "B" });

    expect(events.map((e) => [e.origin, e.transactionId])).toEqual([
      ["local-mutation", "tx-1"],
      ["local-mutation", "tx-2"],
    ]);

    events.length = 0;
    txA.rollback();

    // Step 1 (restore server truth) is attributed to the DYING transaction;
    // step 2 (replay B) is attributed to B — never id-less (the trap fix).
    expect(events.length).toBeGreaterThanOrEqual(2);
    for (const e of events) expect(e.origin).toBe("rollback-replay");
    expect(events[0].transactionId).toBe("tx-1"); // restore under A
    expect(events.at(-1)!.transactionId).toBe("tx-2"); // replay under B
    txB.rollback();
  });
});
