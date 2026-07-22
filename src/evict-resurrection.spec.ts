/**
 * DAN-621 / ADR-013 regression suite — eviction has no authority over the
 * durability pipeline.
 *
 * The bug (found pre-existing by the DAN-620 land gauntlet, F3): after
 * remove→set within one debounce window, the set's queued save is the ONLY
 * thing correcting a durable row the remove already invalidated — an evict
 * before the flush cancelled that save under ADR-004's "last flushed value
 * stands" economy, so the stale pre-remove row resurrected on next boot.
 *
 * Invariant under test: after ANY interleaving of confirmed events and
 * evictions within a debounce window, the durable row on next boot
 * reflects the last CONFIRMED store truth — never a dead lineage's value.
 */
import { describe, expect, it } from "vitest";
import { createEntityStore } from "./store";
import { enablePersistence } from "./persist";
import { memoryEngine, type MemoryEngine } from "./engines/memory";
import { createOptimisticUpdates } from "./transactions";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Debounce far beyond test runtime — nothing flushes unless we say so. */
const HELD = 60_000;

/** Session 1: seed contact:1 = v1 into the engine, fully flushed. */
async function seedEngine(): Promise<MemoryEngine> {
  const engine = memoryEngine();
  const store = createEntityStore();
  const handle = enablePersistence(store, { engine, writeDebounce: 1 });
  await handle.ready;
  store.set("contact", "1", { id: "1", name: "v1" });
  await handle.flush();
  handle.dispose();
  await tick();
  return engine;
}

/** Reboot: fresh store hydrated from the engine; returns name of contact:1. */
async function rebootAndRead(engine: MemoryEngine): Promise<string | undefined> {
  const store = createEntityStore();
  const handle = enablePersistence(store, { engine, writeDebounce: 1 });
  await handle.ready;
  const name = store.has("contact", "1")
    ? (store.get("contact", "1").value?.name as string | undefined)
    : undefined;
  handle.dispose();
  await tick();
  return name;
}

describe("DAN-621 — remove→set→evict must not resurrect the pre-remove row", () => {
  it("F3 exact repro: remove→set→evict→flush→reboot yields the set's value, not the stale row", async () => {
    const engine = await seedEngine();
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, writeDebounce: HELD });
    await handle.ready;

    store.remove("contact", "1"); // dirty-delete queued — durable v1 now a dead lineage
    store.set("contact", "1", { id: "1", name: "survivor" }); // cancels delete, queues save
    store.evict("contact", "1"); // must NOT cancel the save
    await handle.flush();
    handle.dispose();
    await tick();

    expect(await rebootAndRead(engine)).toBe("survivor");
  });

  it("remove→set→evict→re-set: the re-set value is what survives reboot", async () => {
    const engine = await seedEngine();
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, writeDebounce: HELD });
    await handle.ready;

    store.remove("contact", "1");
    store.set("contact", "1", { id: "1", name: "survivor" });
    store.evict("contact", "1");
    store.set("contact", "1", { id: "1", name: "re-set" }); // re-add after evict
    await handle.flush();
    handle.dispose();
    await tick();

    expect(await rebootAndRead(engine)).toBe("re-set");
  });

  it("clear()-flavored: a reentrant re-write during the drain (ADR-012) survives a subsequent evict", async () => {
    const engine = await seedEngine();
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, writeDebounce: HELD });
    await handle.ready;

    // ADR-012: a listener reacting to clear()'s drain remove by re-writing
    // the entity has its write survive in MEMORY. The durable row must
    // follow that truth even if the entity is then evicted pre-flush.
    let reborn = false;
    store.subscribe((event) => {
      if (event.type === "remove" && event.key === "contact:1" && !reborn) {
        reborn = true;
        store.set("contact", "1", { id: "1", name: "reborn" });
      }
    });
    store.clear();
    expect(store.get("contact", "1").value?.name).toBe("reborn"); // ADR-012 held
    store.evict("contact", "1");
    await handle.flush();
    handle.dispose();
    await tick();

    expect(await rebootAndRead(engine)).toBe("reborn");
  });

  it("transactional flavor: committed remove→set net effect survives an evict before flush", async () => {
    const engine = await seedEngine();
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, writeDebounce: HELD });
    await handle.ready;

    const tx = createOptimisticUpdates(store).transaction();
    tx.remove("contact", "1");
    tx.set("contact", "1", { id: "1", name: "committed" });
    tx.commit(); // graduates the buffered net-put into the dirty sets
    store.evict("contact", "1"); // must not cancel the graduated save
    await handle.flush();
    handle.dispose();
    await tick();

    expect(await rebootAndRead(engine)).toBe("committed");
  });

  it("set→set(v2)→evict: the NEWEST confirmed value is durable (ADR-013 supersedes 'last flushed value stands')", async () => {
    const engine = await seedEngine();
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, writeDebounce: HELD });
    await handle.ready;

    store.set("contact", "1", { id: "1", name: "v2" }); // pending save, no remove involved
    store.evict("contact", "1");
    await handle.flush();
    handle.dispose();
    await tick();

    expect(await rebootAndRead(engine)).toBe("v2");
  });
});

describe("DAN-621 — deletes still carry through evictions (behavior pins)", () => {
  it("remove→evict: the durable row is deleted — no resurrection, no zombie", async () => {
    const engine = await seedEngine();
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, writeDebounce: HELD });
    await handle.ready;

    store.remove("contact", "1");
    store.evict("contact", "1"); // memory-absent evict — a true no-op (C1)
    await handle.flush();
    handle.dispose();
    await tick();

    expect(await rebootAndRead(engine)).toBeUndefined();
  });

  it("remove→set→remove→evict: the last confirmed event is a delete — row gone on reboot", async () => {
    const engine = await seedEngine();
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, writeDebounce: HELD });
    await handle.ready;

    store.remove("contact", "1");
    store.set("contact", "1", { id: "1", name: "doomed" });
    store.remove("contact", "1");
    store.evict("contact", "1");
    await handle.flush();
    handle.dispose();
    await tick();

    expect(await rebootAndRead(engine)).toBeUndefined();
  });
});

describe("DAN-621 — hydration honors the pending-truth overlay (ADR-013 rule 2)", () => {
  it("boot does not resurrect a row removed before hydration completes", async () => {
    const engine = await seedEngine();
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, writeDebounce: HELD });
    store.remove("contact", "1"); // pre-ready: tombstoned remove (C1) → pending delete
    await handle.ready;

    // The engine still holds v1 at boot, but the pending delete outranks it.
    expect(store.has("contact", "1")).toBe(false);

    await handle.flush();
    handle.dispose();
    await tick();
    expect(await rebootAndRead(engine)).toBeUndefined();
  });

  it("hydrateScope inside the dirty window pages in the pending value, not the stale engine row", async () => {
    // Seed with a scope manifest referencing contact:1.
    const engine = memoryEngine();
    {
      const store = createEntityStore();
      const handle = enablePersistence(store, { engine, writeDebounce: 1 });
      await handle.ready;
      store.set("contact", "1", { id: "1", name: "v1" });
      handle.setManifest("s", ["contact:1"]);
      await handle.flush();
      handle.dispose();
      await tick();
    }

    const store = createEntityStore();
    const handle = enablePersistence(store, {
      engine,
      hydration: "manifest",
      writeDebounce: HELD,
    });
    await handle.ready;
    expect(store.get("contact", "1").value?.name).toBe("v1");

    store.remove("contact", "1");
    store.set("contact", "1", { id: "1", name: "v2" });
    store.evict("contact", "1");
    expect(store.has("contact", "1")).toBe(false);

    // Remount path: the engine row still says v1 (flush hasn't run), but
    // the pending save is the confirmed truth — hydrate THAT.
    const hydrated = await handle.hydrateScope("s");
    expect(hydrated).toBe(1);
    expect(store.get("contact", "1").value?.name).toBe("v2");

    await handle.flush();
    handle.dispose();
    await tick();
    expect(await rebootAndRead(engine)).toBe("v2");
  });
});
