/**
 * Optimistic-durability suite (roadmap 0.3 / arch review C3, spec:
 * docs/design/optimistic-durability.md): the durable store persists
 * CONFIRMED state only. Optimistic writes buffer per-transaction inside
 * persistence; commit graduates them to disk, rollback discards them —
 * disk never sees a write that might be rolled back.
 *
 * The six tests here are the spec's "tests that define done".
 */
import { describe, expect, it } from "vitest";
import type { EntityKey, StorageEngine } from "./types";
import { createEntityStore } from "./store";
import { enablePersistence } from "./persist";
import { createOptimisticUpdates } from "./transactions";

/** Recording engine: tracks durable rows and every batch that touches them. */
function recordingEngine(seed: Array<{ key: string; data: unknown }> = []) {
  const rows = new Map<string, unknown>(seed.map((r) => [r.key, r.data]));
  const writeLog: Array<{ puts: EntityKey[]; deletes: EntityKey[] }> = [];
  const engine: StorageEngine = {
    isSupported: () => true,
    open: async () => {},
    loadAll: async () => seed.map((r) => ({ key: r.key as EntityKey, data: r.data })),
    async writeBatch(puts, deletes) {
      writeLog.push({ puts: puts.map((p) => p.key), deletes: [...deletes] });
      for (const { key, value } of puts) rows.set(key, value);
      for (const key of deletes) rows.delete(key);
    },
    close() {},
  };
  const touched = (key: string) =>
    writeLog.some(
      (b) => b.puts.includes(key as EntityKey) || b.deletes.includes(key as EntityKey),
    );
  return { engine, rows, writeLog, touched };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("0.3 — optimistic writes never touch disk until commit", () => {
  it("1. optimistic set → rollback: engine write count for that key = 0", async () => {
    const { engine, touched } = recordingEngine();
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, writeDebounce: 1 });
    await handle.ready;

    const opt = createOptimisticUpdates(store);
    const { rollback } = opt.apply("contact", "1", { id: "1", name: "optimistic" });
    await tick(10); // debounce window elapses with the write still unsettled
    await handle.flush();
    rollback(); // emits a compensating tombstone remove — must also stay off disk
    await handle.flush();

    expect(touched("contact:1")).toBe(false);
    handle.dispose();
  });

  it("2. cold entity + optimistic set + debounce elapses + rollback ⇒ durable row byte-unchanged", async () => {
    const serverRow = { id: "1", name: "server-truth" };
    const { engine, rows, touched } = recordingEngine([{ key: "contact:1", data: serverRow }]);
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, writeDebounce: 1 });
    await handle.ready; // hydrates contact:1 into memory

    store.evict("contact", "1"); // cold: durable on disk, absent from memory
    const before = JSON.stringify(rows.get("contact:1"));

    const opt = createOptimisticUpdates(store);
    // Pre-0.3 this flushed PARTIAL optimistic data over durable server truth
    // within the debounce window — corruption before any rollback (C3's
    // sibling bug), then rollback durably deleted the row (C3 proper).
    const { rollback } = opt.apply("contact", "1", { id: "1", name: "optimistic-partial" });
    await tick(10);
    await handle.flush();
    rollback();
    await handle.flush();

    expect(touched("contact:1")).toBe(false);
    expect(JSON.stringify(rows.get("contact:1"))).toBe(before);
    handle.dispose();
  });

  it("3. optimistic set → commit → flush ⇒ durable row = optimistic value", async () => {
    const { engine, rows } = recordingEngine();
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, writeDebounce: 1 });
    await handle.ready;

    const opt = createOptimisticUpdates(store);
    const { commit } = opt.apply("contact", "1", { id: "1", name: "confirmed" });
    commit();
    await handle.flush();

    expect(rows.get("contact:1")).toMatchObject({ id: "1", name: "confirmed" });
    handle.dispose();
  });

  it("4a. tx A rollback while tx B active on one key: B stays buffered; after B commits, disk = B", async () => {
    const { engine, rows, touched, writeLog } = recordingEngine();
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, writeDebounce: 1 });
    await handle.ready;

    // Confirmed baseline on disk
    store.set("contact", "1", { id: "1", name: "baseline" });
    await handle.flush();
    const baselineBatches = writeLog.length;

    const opt = createOptimisticUpdates(store);
    const txA = opt.transaction();
    txA.set("contact", "1", { id: "1", name: "A" });
    const txB = opt.transaction();
    txB.set("contact", "1", { id: "1", name: "B" });

    // A's rollback replays B's write under B's OWN identity (the trap fix):
    // it must re-buffer under B, not masquerade as a confirmed write.
    txA.rollback();
    await handle.flush();
    expect(writeLog.length).toBe(baselineBatches); // nothing new reached disk
    expect(rows.get("contact:1")).toMatchObject({ name: "baseline" });

    txB.commit();
    await handle.flush();
    expect(rows.get("contact:1")).toMatchObject({ name: "B" });

    expect(touched("contact:1")).toBe(true); // sanity: assertions above were live
    handle.dispose();
  });

  it("4b. tx A rollback, then tx B rollback too ⇒ disk = original", async () => {
    const { engine, rows } = recordingEngine();
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, writeDebounce: 1 });
    await handle.ready;

    store.set("contact", "1", { id: "1", name: "baseline" });
    await handle.flush();

    const opt = createOptimisticUpdates(store);
    const txA = opt.transaction();
    txA.set("contact", "1", { id: "1", name: "A" });
    const txB = opt.transaction();
    txB.set("contact", "1", { id: "1", name: "B" });

    txA.rollback();
    txB.rollback();
    await handle.flush();

    expect(rows.get("contact:1")).toMatchObject({ name: "baseline" });
    expect(store.get("contact", "1").value).toMatchObject({ name: "baseline" });
    handle.dispose();
  });

  it("5. uncommitted tx at dispose(): buffered entries NOT flushed; confirmed dirty entries ARE", async () => {
    const { engine, rows } = recordingEngine();
    const store = createEntityStore();
    // Huge debounce: nothing flushes before dispose's final flush
    const handle = enablePersistence(store, { engine, writeDebounce: 10_000 });
    await handle.ready;

    store.set("contact", "confirmed", { id: "confirmed", name: "keep" });
    const opt = createOptimisticUpdates(store);
    const tx = opt.transaction();
    tx.set("contact", "optimistic", { id: "optimistic", name: "drop" });
    // tx never settles — unconfirmed writes die with the session
    handle.dispose();
    await tick();

    expect(rows.has("contact:confirmed")).toBe(true);
    expect(rows.has("contact:optimistic")).toBe(false);
  });

  it("6. non-transactional writes flow to disk exactly as today, even with a tx open", async () => {
    const { engine, rows } = recordingEngine([{ key: "contact:old", data: { id: "old" } }]);
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, writeDebounce: 1 });
    await handle.ready;

    const opt = createOptimisticUpdates(store);
    const tx = opt.transaction();
    tx.set("contact", "tx-key", { id: "tx-key", name: "buffered" });

    store.set("contact", "plain", { id: "plain", name: "direct" });
    store.remove("contact", "old");
    await handle.flush();

    expect(rows.get("contact:plain")).toMatchObject({ name: "direct" });
    expect(rows.has("contact:old")).toBe(false); // remove deleted the durable row
    expect(rows.has("contact:tx-key")).toBe(false); // still buffered, unsettled

    tx.commit();
    await handle.flush();
    expect(rows.get("contact:tx-key")).toMatchObject({ name: "buffered" });
    handle.dispose();
  });
});
