/**
 * DAN-629 / ADR-015 regression suite — pending truth ends only at durable
 * acknowledgment: the overlay covers the IN-FLIGHT window too.
 *
 * The bug family: `flush()` drains `dirtySaves`/`dirtyDeletes` synchronously
 * at entry, BEFORE `await engine.writeBatch`. While the batch is in flight,
 * confirmed-but-undurable truth was invisible to `hydrateRow`'s ADR-013
 * overlay and to `readManifestRow` — a `hydrateScope` (or a boot load's
 * stale snapshot) racing that window resurrected removed rows and paged in
 * values staler than last confirmed store truth. Executed flavors:
 *
 *   1. delete in flight  → removed entity resurrects into memory
 *   2. save in flight    → evict→hydrateScope pages stale v1 over v2
 *   3. synthesis gap     → never-flushed entity invisible to hydrateScope
 *   4. lifecycle flush   → tab-hide flush() during boot = automatic entry
 *   5. uncommitted tx    → optimistic remove un-deleted by a boot snapshot
 *
 * Invariant under test (ADR-015): a confirmed op leaves the pending-truth
 * overlay only when its batch is durably acknowledged AND no hydration read
 * that might predate the ack is still outstanding. Uncommitted optimistic
 * DELETES additionally mask hydration of their key (never hydrate, never
 * flush — but hydration must not un-delete an optimistic projection).
 */
import { describe, expect, it } from "vitest";
import type { EntityKey, StorageEngine } from "./types";
import { createEntityStore } from "./store";
import { enablePersistence } from "./persist";
import { memoryEngine, type MemoryEngine } from "./engines/memory";
import { createOptimisticUpdates } from "./transactions";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Debounce far beyond test runtime — nothing flushes unless we say so. */
const HELD = 60_000;

/** Poll until cond() is true (bounded) — sequences async boot deterministically. */
async function waitUntil(cond: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 0));
  }
}

/**
 * Gate an engine's WRITES: `writeBatch` blocks until `release()` — the
 * write-side sibling of boot-hydration-writes' `gateBoot`. Reads pass
 * through untouched, so a hydrate can observe the engine mid-batch.
 */
function gateWrites(inner: MemoryEngine) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held = 0;
  const engine: StorageEngine = {
    ...inner,
    async writeBatch(puts, deletes) {
      held++;
      await gate;
      return inner.writeBatch(puts, deletes);
    },
  };
  return { engine, release, heldCount: () => held };
}

/**
 * Gate an engine's reads with STALE-SNAPSHOT semantics: matching loads
 * capture their rows EAGERLY (before the gate), then hold until
 * `release()`. Models the gauntlet-F1 condition — a load snapshot taken
 * before an intervening writeBatch, delivered after it acked. (gateBoot in
 * boot-hydration-writes.spec gates BEFORE reading, so a released load sees
 * post-write state; here the whole point is that it must not.)
 */
function gateBootStale(
  inner: MemoryEngine,
  shouldGate: (kind: "loadAll" | "loadMany", keys?: EntityKey[]) => boolean = () => true,
) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held = 0;
  const engine: StorageEngine = {
    ...inner,
    async loadAll() {
      const rows = await inner.loadAll();
      if (shouldGate("loadAll")) {
        held++;
        await gate;
      }
      return rows;
    },
    async loadMany(keys) {
      const rows = await inner.loadMany(keys);
      if (shouldGate("loadMany", keys)) {
        held++;
        await gate;
      }
      return rows;
    },
  };
  return { engine, release, heldCount: () => held };
}

/** Session 1: seed contact:1 = v1 into the engine, fully flushed. */
async function seedV1(): Promise<MemoryEngine> {
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

/** Session 1, manifest flavor: contacts 1..2 = v1 under scope "s". */
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

describe("DAN-629 — hydrateScope during an in-flight writeBatch", () => {
  it("flavor 1 (delete in flight): a removed entity must not resurrect into memory", async () => {
    const inner = await seedManifest();
    const { engine, release, heldCount } = gateWrites(inner);
    const store = createEntityStore();
    const handle = enablePersistence(store, {
      engine,
      hydration: "manifest",
      writeDebounce: HELD,
    });
    await handle.ready;
    expect(store.get("contact", "1").value?.name).toBe("v1");

    store.remove("contact", "1"); // confirmed delete — dirty
    const flushP = handle.flush(); // drains dirty → batch in flight
    await waitUntil(() => heldCount() === 1);

    // Remount while the delete is in flight: the engine still holds v1,
    // but the in-flight delete is confirmed truth — no resurrection.
    await handle.hydrateScope("s");
    expect(store.has("contact", "1")).toBe(false);
    expect(store.get("contact", "2").value?.name).toBe("v1"); // sibling unaffected

    release();
    await flushP;
    expect(inner.snapshot().has("contact:1" as EntityKey)).toBe(false);
    handle.dispose();
    await tick();
    expect(await rebootAndRead(inner, "1")).toBeUndefined();
  });

  it("flavor 2 (save in flight): evict→hydrateScope pages in v2, never the engine's stale v1", async () => {
    const inner = await seedManifest();
    const { engine, release, heldCount } = gateWrites(inner);
    const store = createEntityStore();
    const handle = enablePersistence(store, {
      engine,
      hydration: "manifest",
      writeDebounce: HELD,
    });
    await handle.ready;

    store.set("contact", "1", { id: "1", name: "v2" }); // confirmed — dirty
    const flushP = handle.flush(); // v2 now in flight
    await waitUntil(() => heldCount() === 1);
    store.evict("contact", "1"); // memory drops it; engine still says v1

    await handle.hydrateScope("s");
    expect(store.get("contact", "1").value?.name).toBe("v2"); // in-flight truth wins

    release();
    await flushP;
    handle.dispose();
    await tick();
    expect(await rebootAndRead(inner, "1")).toBe("v2");
  });

  it("manifest-row flavor: a manifest update in flight outranks the engine's stale manifest", async () => {
    const inner = await seedManifest();
    const { engine, release, heldCount } = gateWrites(inner);
    const store = createEntityStore();
    const handle = enablePersistence(store, {
      engine,
      hydration: "manifest",
      writeDebounce: HELD,
    });
    await handle.ready;

    handle.setManifest("s", ["contact:2"]); // scope shrinks — contact:1 released
    const flushP = handle.flush(); // new manifest row in flight
    await waitUntil(() => heldCount() === 1);
    store.evict("contact", "1");

    // The engine's manifest row still lists contact:1 — hydrating from it
    // would resurrect the entity AND re-pin it under a reference the scope
    // dropped. The in-flight manifest is the confirmed truth.
    const hydrated = await handle.hydrateScope("s");
    expect(hydrated).toBe(0);
    expect(store.has("contact", "1")).toBe(false);

    release();
    await flushP;
    handle.dispose();
    await tick();
  });

  it("flavor 3 (synthesis, dirty): a never-flushed entity named by its manifest pages back in", async () => {
    const engine = memoryEngine();
    const store = createEntityStore();
    const handle = enablePersistence(store, {
      engine,
      hydration: "manifest",
      writeDebounce: HELD,
    });
    await handle.ready;

    store.set("contact", "3", { id: "3", name: "fresh" }); // dirty, never flushed
    handle.setManifest("s", ["contact:3"]);
    store.evict("contact", "3");
    expect(store.has("contact", "3")).toBe(false);

    // The engine has NO row for contact:3 (nothing flushed) — the pending
    // save is the only copy. The manifest declares the scope needs it
    // resident: hydrateScope must synthesize from the pending save.
    const hydrated = await handle.hydrateScope("s");
    expect(hydrated).toBe(1);
    expect(store.get("contact", "3").value?.name).toBe("fresh");

    await handle.flush();
    handle.dispose();
    await tick();
    expect(await rebootAndRead(engine, "3")).toBe("fresh");
  });

  it("flavor 3 (synthesis, in-flight): same, while the first flush is still in the engine", async () => {
    const inner = memoryEngine();
    const { engine, release, heldCount } = gateWrites(inner);
    const store = createEntityStore();
    const handle = enablePersistence(store, {
      engine,
      hydration: "manifest",
      writeDebounce: HELD,
    });
    await handle.ready;

    store.set("contact", "3", { id: "3", name: "fresh" });
    handle.setManifest("s", ["contact:3"]);
    const flushP = handle.flush(); // put in flight — engine row not yet visible
    await waitUntil(() => heldCount() === 1);
    store.evict("contact", "3");

    const hydrated = await handle.hydrateScope("s");
    expect(hydrated).toBe(1);
    expect(store.get("contact", "3").value?.name).toBe("fresh");

    release();
    await flushP;
    handle.dispose();
    await tick();
    expect(await rebootAndRead(inner, "3")).toBe("fresh");
  });
});

describe("DAN-629 — boot racing a direct flush (lifecycle flavor, gauntlet F1)", () => {
  it("a mid-boot remove + direct flush must not be resurrected by the stale boot snapshot", async () => {
    const inner = await seedV1();
    // Stale-snapshot gate: boot's loadAll captured v1 BEFORE the flush below
    // lands its delete — the exact tab-hidden-during-boot interleaving (the
    // module's own lifecycle listeners call flush() directly).
    const { engine, release, heldCount } = gateBootStale(inner);
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, writeDebounce: 1 });

    await waitUntil(() => heldCount() === 1); // boot holds a snapshot with v1
    store.remove("contact", "1");
    await handle.flush(); // direct flush (lifecycle path) — delete acks mid-boot
    expect(inner.snapshot().has("contact:1" as EntityKey)).toBe(false);

    release(); // stale snapshot (still holding v1) now hydrates
    await handle.ready;

    // The delete was drained AND acked — but it is confirmed truth the
    // stale snapshot predates. It must still outrank the snapshot row.
    expect(store.has("contact", "1")).toBe(false);

    handle.dispose();
    await tick();
    expect(await rebootAndRead(inner, "1")).toBeUndefined();
  });

  it("a mid-boot set(v2) + direct flush outranks the stale boot snapshot's v1", async () => {
    const inner = await seedV1();
    const { engine, release, heldCount } = gateBootStale(inner);
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, writeDebounce: 1 });

    await waitUntil(() => heldCount() === 1);
    store.set("contact", "1", { id: "1", name: "v2" });
    await handle.flush(); // v2 durable mid-boot
    store.evict("contact", "1"); // memory forgets — only the overlay remembers now

    release();
    await handle.ready;

    // Fresh-wins can't protect an evicted key; the acked-but-boot-straddling
    // save must. Hydrating the stale v1 here is the DAN-621 staleness class
    // reopened through the in-flight/acked window — the overlay's retained
    // copy of the confirmed v2 is what hydrates instead.
    expect(store.get("contact", "1").value?.name).toBe("v2");

    handle.dispose();
    await tick();
    expect(await rebootAndRead(inner, "1")).toBe("v2"); // disk converged to v2
  });
});

describe("DAN-629 — uncommitted optimistic remove racing boot (gauntlet F2)", () => {
  it("commit leg: a boot snapshot must not un-delete an optimistic remove; commit deletes durably", async () => {
    const inner = await seedV1();
    const { engine, release, heldCount } = gateBootStale(inner);
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, writeDebounce: 1 });

    await waitUntil(() => heldCount() === 1);
    const tx = createOptimisticUpdates(store).transaction();
    tx.remove("contact", "1"); // optimistic — buffered, NOT dirty
    release();
    await handle.ready;

    // The stale snapshot holds v1, but memory's absence of contact:1 is an
    // optimistic projection mid-transaction — hydration must not undo it.
    expect(store.has("contact", "1")).toBe(false);

    tx.commit(); // graduates the delete into the dirty sets
    await handle.flush();
    expect(inner.snapshot().has("contact:1" as EntityKey)).toBe(false);
    expect(store.has("contact", "1")).toBe(false); // memory and disk agree

    handle.dispose();
    await tick();
    expect(await rebootAndRead(inner, "1")).toBeUndefined();
  });

  it("rollback leg: the mask lifts on rollback — the durable row pages back in untouched", async () => {
    const inner = await seedManifest();
    // Hold only the entity-rows load (manifest reads pass through) — the
    // tightest window, right before hydrateRow.
    const { engine, release, heldCount } = gateBootStale(
      inner,
      (kind, keys) =>
        kind === "loadMany" && !!keys && keys.some((k) => !k.startsWith("__cdb_manifest__")),
    );
    const store = createEntityStore();
    const handle = enablePersistence(store, {
      engine,
      hydration: "manifest",
      writeDebounce: 1,
    });

    await waitUntil(() => heldCount() === 1);
    const tx = createOptimisticUpdates(store).transaction();
    tx.remove("contact", "1");
    release();
    await handle.ready;

    expect(store.has("contact", "1")).toBe(false); // masked while the tx is open
    expect(store.get("contact", "2").value?.name).toBe("v1"); // sibling hydrated

    tx.rollback(); // the remove never happened — disk was never touched
    const hydrated = await handle.hydrateScope("s");
    expect(hydrated).toBe(1); // mask lifted: the durable row pages back in
    expect(store.get("contact", "1").value?.name).toBe("v1");

    handle.dispose();
    await tick();
    expect(await rebootAndRead(inner, "1")).toBe("v1");
  });
});

describe("DAN-629 — behavior pins", () => {
  it("flush concurrency contract unchanged: dirt arriving during an in-flight batch still lands", async () => {
    const inner = memoryEngine();
    const { engine, release, heldCount } = gateWrites(inner);
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, writeDebounce: HELD });
    await handle.ready;

    store.set("contact", "1", { id: "1", name: "a" });
    const p1 = handle.flush();
    await waitUntil(() => heldCount() === 1);
    store.set("contact", "2", { id: "2", name: "b" }); // arrives mid-batch
    const p2 = handle.flush(); // must cover contact:2 (await-then-reflush)
    release();
    await p1;
    await p2;

    expect(inner.snapshot().has("contact:1" as EntityKey)).toBe(true);
    expect(inner.snapshot().has("contact:2" as EntityKey)).toBe(true);
    handle.dispose();
    await tick();
  });

  it("quiesced overlay does not shadow newer durable truth: v2→v3 across two full flushes hydrates v3", async () => {
    const inner = await seedManifest();
    const store = createEntityStore();
    const handle = enablePersistence(store, {
      engine: inner,
      hydration: "manifest",
      writeDebounce: HELD,
    });
    await handle.ready;

    store.set("contact", "1", { id: "1", name: "v2" });
    await handle.flush(); // fully acked
    store.set("contact", "1", { id: "1", name: "v3" });
    await handle.flush(); // fully acked
    store.evict("contact", "1");

    await handle.hydrateScope("s");
    expect(store.get("contact", "1").value?.name).toBe("v3");

    handle.dispose();
    await tick();
  });
});
