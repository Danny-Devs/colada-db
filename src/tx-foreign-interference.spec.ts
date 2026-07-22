/**
 * DAN-635 / ADR-016 regression suite — foreign interference with a key an
 * open optimistic transaction has touched.
 *
 * The bug family: the transaction layer assumes a tx-touched key is not
 * concurrently mutated or evicted by a non-tx actor mid-flight. That
 * assumption is unenforced and its failure modes are silent.
 *
 *   Flavor A (must-fix — divergence SURVIVES settlement):
 *     tx.set(c1,"kept") → evict(c1) mid-tx → hydrateScope pages the stale
 *     pre-tx engine row v1 over the optimistic projection. Fresh-wins
 *     (`store.has`) protected the optimistic PUT only while it stayed
 *     RESIDENT — eviction removes it. After commit: memory v1 / disk
 *     "kept" for the rest of the session.
 *
 *   Flavor B (bounded to tx settlement + a documented rollback window):
 *     tx.remove(c1) → foreign confirmed non-tx set(c1,v2) → evict →
 *     hydrateScope. The optimistic-delete mask keeps memory consistent
 *     with the pending delete (correct for commit). The residual is the
 *     rollback clobber: the tx serverTruth snapshot goes stale under the
 *     foreign write, and rollback restores the stale snapshot over it.
 *
 * Invariant under test (ADR-016): an open transaction's buffered op (PUT
 * or DELETE) masks hydration of its key until settlement — a memory-
 * projection or hydration event may never page a value into memory that
 * contradicts the tx's pending authoritative op. The mask generalizes
 * ADR-015 rule 4 (delete-only) to PUTs; it keeps mask-first precedence, so
 * a foreign confirmed write does NOT override it (that would diverge at
 * commit — see the flavor-B commit-leg pin).
 */
import { describe, expect, it } from "vitest";
import type { EntityKey } from "./types";
import { createEntityStore } from "./store";
import { enablePersistence } from "./persist";
import { memoryEngine, type MemoryEngine } from "./engines/memory";
import { createOptimisticUpdates } from "./transactions";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Debounce far beyond test runtime — nothing flushes unless we say so. */
const HELD = 60_000;

/** Session 1: contacts 1..2 = v1 under scope "s", fully flushed. */
async function seedManifest(): Promise<MemoryEngine> {
  const engine = memoryEngine();
  const store = createEntityStore();
  const handle = enablePersistence(store, { engine, writeDebounce: 1 });
  await handle.ready;
  store.set("contact", "1", { id: "1", name: "v1" });
  store.set("contact", "2", { id: "2", name: "v1" });
  handle.setManifest("s", ["contact:1", "contact:2"]);
  await handle.flush();
  handle.dispose();
  await tick();
  return engine;
}

/** Reboot: fresh store hydrated from the engine; returns name of contact:<id>. */
async function rebootAndRead(engine: MemoryEngine, id: string): Promise<string | undefined> {
  const store = createEntityStore();
  const handle = enablePersistence(store, { engine, writeDebounce: 1 });
  await handle.ready;
  const name = store.has("contact", id)
    ? (store.get("contact", id).value?.name as string | undefined)
    : undefined;
  handle.dispose();
  await tick();
  return name;
}

describe("DAN-635 flavor A — an evicted optimistic PUT must not be paged over by a stale engine row", () => {
  it("evict-mid-tx + hydrateScope: the stale engine row must not resurrect as memory truth; memory converges to the committed value", async () => {
    const engine = await seedManifest();
    const store = createEntityStore();
    const handle = enablePersistence(store, {
      engine,
      hydration: "manifest",
      writeDebounce: HELD,
    });
    await handle.ready;
    expect(store.get("contact", "1").value?.name).toBe("v1");

    const tx = createOptimisticUpdates(store).transaction();
    tx.set("contact", "1", { id: "1", name: "kept" }); // optimistic PUT — buffered
    store.evict("contact", "1"); // fresh-wins premise gone: memory drops "kept"

    // Mid-tx remount: the engine still holds v1. Pre-fix this pages v1 into
    // memory — a divergence that SURVIVES commit (memory v1 / disk "kept").
    // The PUT mask (ADR-016) must veto the hydration.
    await handle.hydrateScope("s");
    expect(store.has("contact", "1")).toBe(false); // masked, not resurrected as v1
    expect(store.get("contact", "2").value?.name).toBe("v1"); // sibling unaffected

    tx.commit(); // "kept" graduates into the dirty sets
    await handle.flush();
    await handle.hydrateScope("s"); // mask lifted — pages the committed value
    expect(store.get("contact", "1").value?.name).toBe("kept"); // memory == disk truth
    expect(engine.snapshot().has("contact:1" as EntityKey)).toBe(true);

    handle.dispose();
    await tick();
    expect(await rebootAndRead(engine, "1")).toBe("kept"); // disk converged to "kept"
  });

  it("no mid-tx remount: evict-then-commit converges to the committed value with no divergence (pin)", async () => {
    const engine = await seedManifest();
    const store = createEntityStore();
    const handle = enablePersistence(store, {
      engine,
      hydration: "manifest",
      writeDebounce: HELD,
    });
    await handle.ready;

    const tx = createOptimisticUpdates(store).transaction();
    tx.set("contact", "1", { id: "1", name: "kept" });
    store.evict("contact", "1"); // no stale row paged in — memory simply absent
    tx.commit();
    await handle.flush();
    await handle.hydrateScope("s");

    expect(store.get("contact", "1").value?.name).toBe("kept");
    handle.dispose();
    await tick();
    expect(await rebootAndRead(engine, "1")).toBe("kept");
  });

  it("rollback leg: an evicted optimistic PUT that rolls back leaves memory and disk both at server truth", async () => {
    const engine = await seedManifest();
    const store = createEntityStore();
    const handle = enablePersistence(store, {
      engine,
      hydration: "manifest",
      writeDebounce: HELD,
    });
    await handle.ready;

    const tx = createOptimisticUpdates(store).transaction();
    tx.set("contact", "1", { id: "1", name: "kept" });
    store.evict("contact", "1");
    await handle.hydrateScope("s"); // masked while the tx is open
    expect(store.has("contact", "1")).toBe(false);

    tx.rollback(); // "kept" never committed; the engine row v1 is untouched
    await handle.hydrateScope("s"); // mask lifted — the durable v1 pages back in
    expect(store.get("contact", "1").value?.name).toBe("v1");

    handle.dispose();
    await tick();
    expect(await rebootAndRead(engine, "1")).toBe("v1"); // disk never left v1
  });
});

describe("DAN-635 flavor B — a foreign confirmed write racing a tx-touched key", () => {
  it("commit leg (pin): the optimistic-remove mask keeps memory consistent with the committed delete — memory and disk agree", async () => {
    // This pin is the concrete reason ADR-016 rejects 'mask yields to the
    // confirmed write' (candidate d): if hydration preferred the foreign v2
    // over the delete mask, memory would hold v2 while commit deletes the
    // row on disk — a NEW commit-time divergence. Mask-first keeps it coherent.
    const engine = await seedManifest();
    const store = createEntityStore();
    const handle = enablePersistence(store, {
      engine,
      hydration: "manifest",
      writeDebounce: HELD,
    });
    await handle.ready;

    const tx = createOptimisticUpdates(store).transaction();
    tx.remove("contact", "1"); // optimistic DELETE — buffered
    store.set("contact", "1", { id: "1", name: "v2" }); // FOREIGN confirmed non-tx write → dirty
    store.evict("contact", "1");

    await handle.hydrateScope("s"); // delete mask vetoes → memory absent
    expect(store.has("contact", "1")).toBe(false);

    tx.commit(); // the delete graduates; the foreign v2 in dirtySaves is superseded
    await handle.flush();
    expect(store.has("contact", "1")).toBe(false); // memory
    expect(engine.snapshot().has("contact:1" as EntityKey)).toBe(false); // disk — both agree

    handle.dispose();
    await tick();
    expect(await rebootAndRead(engine, "1")).toBeUndefined();
  });

  it("rollback leg (BOUNDED — ADR-016): a foreign confirmed write survives to disk but is clobbered in memory by the stale serverTruth restore", async () => {
    // BOUNDED, not fixed: the tx serverTruth snapshot for contact:1 was taken
    // at tx.remove (v1); the foreign set(v2) landed after, so the snapshot is
    // stale. Rollback restores v1 into memory while disk keeps the confirmed
    // v2. Root: tx serverTruth staleness under a foreign confirmed write —
    // owned by the sync coordinator's server-authoritative rebase (ADR-006 §6).
    // NOT introduced or worsened by ADR-016; pinned to keep the window visible.
    const engine = await seedManifest();
    const store = createEntityStore();
    const handle = enablePersistence(store, {
      engine,
      hydration: "manifest",
      writeDebounce: HELD,
    });
    await handle.ready;

    const tx = createOptimisticUpdates(store).transaction();
    tx.remove("contact", "1"); // serverTruth[contact:1] snapshotted = v1
    store.set("contact", "1", { id: "1", name: "v2" }); // foreign confirmed — dirty v2
    store.evict("contact", "1");
    await handle.hydrateScope("s"); // masked

    tx.rollback(); // recompute restores the stale serverTruth v1 over the foreign v2
    await handle.flush();

    expect(store.get("contact", "1").value?.name).toBe("v1"); // memory: clobbered (bounded)
    handle.dispose();
    await tick();
    expect(await rebootAndRead(engine, "1")).toBe("v2"); // disk: the foreign write survived
  });
});
