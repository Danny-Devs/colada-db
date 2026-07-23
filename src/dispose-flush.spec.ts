/**
 * DAN-647 regression suite — dispose() racing an in-flight flush must not
 * drop a confirmed write queued after the drain.
 *
 * The bug family (same shape as ADR-012–016 "the world held still across an
 * async gap"): a debounced flush drains X into its batch and parks in
 * `await engine.writeBatch`. A subsequent `set(Y)`/`remove(Y)` enters the
 * dirty sets. Then `dispose()` runs `finalFlush = flush()` and immediately
 * sets `disposed = true`. That final `flush()` sees `flushing === true`, so
 * it `await inflightFlush; return flush()` — and the re-entrant flush bails
 * on `if (!opened || disabled || disposed) return` now that `disposed` is
 * true. The in-flight batch's tail `if (dirtySaves.size>0) scheduleFlush()`
 * is defeated by the same flag (`scheduleFlush` short-circuits on
 * `disposed`). Both recovery paths killed by one flag → Y is silently lost.
 *
 * Only real async engines expose it (a synchronous engine resolves
 * writeBatch before dispose runs), so the repro gates writeBatch.
 */
import { describe, expect, it } from "vitest";
import type { EntityKey, StorageEngine } from "./types";
import { createEntityStore } from "./store";
import { enablePersistence } from "./persist";

/** Controllable engine: each writeBatch blocks until released, FIFO; records all writes. */
function slowEngine() {
  const written = new Map<string, unknown>();
  const releases: Array<() => void> = [];
  const writeCounts = new Map<string, number>(); // per-key writeBatch touches (put or delete)
  let batches = 0;
  const engine: StorageEngine = {
    isSupported: () => true,
    open: async () => {},
    loadAll: async () => [],
    loadMany: async (keys) =>
      keys.filter((k) => written.has(k)).map((k) => ({ key: k, data: written.get(k) })),
    async writeBatch(puts, deletes) {
      await new Promise<void>((r) => releases.push(r));
      batches++;
      for (const { key, value } of puts) {
        written.set(key, value);
        writeCounts.set(key, (writeCounts.get(key) ?? 0) + 1);
      }
      for (const key of deletes) {
        written.delete(key);
        writeCounts.set(key, (writeCounts.get(key) ?? 0) + 1);
      }
    },
    close() {},
  };
  return {
    engine,
    written,
    releaseOne: () => releases.shift()?.(),
    blocked: () => releases.length,
    writeCountFor: (key: string) => writeCounts.get(key) ?? 0,
    batchCount: () => batches,
  };
}

/** Poll until cond() is true (bounded) — sequences the async flush chain deterministically. */
async function waitUntil(cond: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 0));
  }
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe("DAN-647 — dispose() must not drop a write queued after an in-flight drain", () => {
  it("a set(Y) that lands while a prior flush is in flight is durable across dispose()", async () => {
    const { engine, written, releaseOne, blocked } = slowEngine();
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, writeDebounce: 1 });
    await handle.ready;

    // X flushes: drained into batch 1, parked in the gated writeBatch.
    store.set("contact", "1", { id: "1", name: "X" });
    const firstFlush = handle.flush();
    await waitUntil(() => blocked() === 1); // batch 1 in the engine

    // Y arrives WHILE the first flush is in flight → enters dirtySaves.
    store.set("contact", "2", { id: "2", name: "Y" });

    // Teardown races the in-flight flush.
    handle.dispose();

    // Release batch 1 (X). A correct dispose must then re-flush Y as batch 2.
    releaseOne();
    await tick();
    if (blocked() === 1) releaseOne(); // batch 2 (Y) — present only when Y survived
    await tick();

    await firstFlush.catch(() => {});
    expect(written.has("contact:1" as EntityKey)).toBe(true); // X durable
    expect(written.has("contact:2" as EntityKey)).toBe(true); // Y NOT dropped
    expect(written.get("contact:2" as EntityKey)).toEqual({ id: "2", name: "Y" });
  });

  it("a remove(Y) that lands while a prior flush is in flight is durable across dispose()", async () => {
    const { engine, written, releaseOne, blocked } = slowEngine();
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, writeDebounce: 1 });
    await handle.ready;

    // Y is durable first.
    store.set("contact", "2", { id: "2", name: "Y" });
    const f0 = handle.flush();
    await waitUntil(() => blocked() === 1);
    releaseOne();
    await f0;
    expect(written.has("contact:2" as EntityKey)).toBe(true);

    // X flushes: drained into a batch, parked in the gated writeBatch.
    store.set("contact", "1", { id: "1", name: "X" });
    const firstFlush = handle.flush();
    await waitUntil(() => blocked() === 1);

    // remove(Y) arrives WHILE the flush is in flight → enters dirtyDeletes.
    store.remove("contact", "2");

    handle.dispose();

    releaseOne(); // batch with X completes
    await tick();
    if (blocked() === 1) releaseOne(); // batch deleting Y — present only when the delete survived
    await tick();

    await firstFlush.catch(() => {});
    expect(written.has("contact:2" as EntityKey)).toBe(false); // Y's delete NOT dropped
  });

  it("the final flush writes the residue key exactly once (no double-flush)", async () => {
    const { engine, written, releaseOne, blocked, writeCountFor } = slowEngine();
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, writeDebounce: 1 });
    await handle.ready;

    store.set("contact", "1", { id: "1", name: "X" });
    const firstFlush = handle.flush();
    await waitUntil(() => blocked() === 1);

    store.set("contact", "2", { id: "2", name: "Y" });
    handle.dispose();

    releaseOne();
    await tick();
    if (blocked() === 1) releaseOne();
    await tick();

    await firstFlush.catch(() => {});
    expect(written.get("contact:2" as EntityKey)).toEqual({ id: "2", name: "Y" });
    // Y rode exactly one batch — the drain is a move, so it is never written twice.
    expect(writeCountFor("contact:2")).toBe(1);
    expect(writeCountFor("contact:1")).toBe(1);
  });

  it("a set that arrives AFTER dispose never reaches disk (no post-dispose sneak-in)", async () => {
    const { engine, written, releaseOne, blocked, batchCount } = slowEngine();
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, writeDebounce: 1 });
    await handle.ready;

    store.set("contact", "1", { id: "1", name: "X" });
    const firstFlush = handle.flush();
    await waitUntil(() => blocked() === 1);

    handle.dispose();

    // A write racing teardown, AFTER dispose(): unsub() already detached the
    // subscriber and `disposed` guards it — it must never become durable, and
    // a subsequent external flush() must be a no-op.
    store.set("contact", "9", { id: "9", name: "ghost" });
    await handle.flush(); // external → final=false → no-op under `disposed`

    releaseOne(); // batch 1 (X) completes
    await tick();
    if (blocked() === 1) releaseOne();
    await tick();

    await firstFlush.catch(() => {});
    expect(written.has("contact:1" as EntityKey)).toBe(true); // acknowledged pre-dispose write
    expect(written.has("contact:9" as EntityKey)).toBe(false); // post-dispose write rejected
    expect(batchCount()).toBe(1); // only X's batch ran — no sneak batch for the ghost
  });
});
