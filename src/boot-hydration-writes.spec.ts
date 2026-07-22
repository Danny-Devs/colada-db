/**
 * DAN-630 / ADR-014 regression suite — writes racing boot hydration must
 * never be silently dropped from the durability pipeline.
 *
 * The bug: boot held `isHydrating = true` across every `engine.loadAll()` /
 * `engine.loadMany()` await, and the persistence subscriber early-returned
 * on ANY event while the flag was up — so an app `set`/`remove` landing
 * during boot's engine I/O never entered the dirty sets: silently
 * non-durable, no error. The window is real (IDB/SQLite load latency), and
 * apps that write on startup land inside it routinely.
 *
 * Invariant under test (ADR-014): hydration exclusion is decided by event
 * PROVENANCE (`origin: "hydration"`), never by a coordinator phase — there
 * is no instant at which an app write is invisible to persistence. The
 * ADR-013 pending-truth overlay + fresh-wins then reconcile mid-boot writes
 * against stale engine rows, in memory and on disk.
 */
import { describe, expect, it } from "vitest";
import type { EntityKey, StorageEngine } from "./types";
import { createEntityStore } from "./store";
import { enablePersistence } from "./persist";
import { memoryEngine, type MemoryEngine } from "./engines/memory";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Poll until cond() is true (bounded) — sequences async boot deterministically. */
async function waitUntil(cond: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 0));
  }
}

/**
 * Gate an engine's reads: matching loadAll/loadMany calls block until
 * `release()` — the evict-resurrection suite's held-engine idiom, extended
 * with a predicate so manifest-mode tests can hold a SPECIFIC boot load
 * (e.g., only the entity-rows loadMany, after the manifest reads resolved).
 * Writes pass through untouched.
 */
function gateBoot(
  inner: MemoryEngine,
  shouldGate: (kind: "loadAll" | "loadMany", keys?: EntityKey[]) => boolean = () => true,
) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held = 0;
  const engine: StorageEngine = {
    ...inner,
    async loadAll() {
      if (shouldGate("loadAll")) {
        held++;
        await gate;
      }
      return inner.loadAll();
    },
    async loadMany(keys) {
      if (shouldGate("loadMany", keys)) {
        held++;
        await gate;
      }
      return inner.loadMany(keys);
    },
  };
  return { engine, release, heldCount: () => held };
}

/** Record every key writeBatch puts — asserts the no-write-storm pin. */
function spyWrites(inner: MemoryEngine) {
  const putKeys: EntityKey[] = [];
  const engine: StorageEngine = {
    ...inner,
    writeBatch(puts, deletes) {
      for (const p of puts) putKeys.push(p.key);
      return inner.writeBatch(puts, deletes);
    },
  };
  return { engine, putKeys };
}

/** Session 1: seed contact:1 = v1 (and optionally more), fully flushed. */
async function seedV1(extra: Array<[string, string]> = []): Promise<MemoryEngine> {
  const engine = memoryEngine();
  const store = createEntityStore();
  const handle = enablePersistence(store, { engine, writeDebounce: 1 });
  await handle.ready;
  store.set("contact", "1", { id: "1", name: "v1" });
  for (const [id, name] of extra) store.set("contact", id, { id, name });
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

describe("DAN-630 — all-mode boot (loadAll in flight)", () => {
  it("a set() landing mid-boot is durable after flush + reboot", async () => {
    const inner = memoryEngine();
    const { engine, release, heldCount } = gateBoot(inner);
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, writeDebounce: 1 });

    await waitUntil(() => heldCount() === 1); // boot is inside loadAll
    store.set("contact", "1", { id: "1", name: "raced" }); // app write racing boot
    release();
    await handle.ready;

    await handle.flush();
    expect(inner.snapshot().has("contact:1" as EntityKey)).toBe(true);
    handle.dispose();
    await tick();
    expect(await rebootAndRead(inner, "1")).toBe("raced");
  });

  it("a remove() landing mid-boot deletes durably and is NOT resurrected into memory by the stale snapshot", async () => {
    const inner = await seedV1();
    const { engine, release, heldCount } = gateBoot(inner);
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, writeDebounce: 1 });

    await waitUntil(() => heldCount() === 1);
    store.remove("contact", "1"); // memory-absent tombstone remove (C1) — still an event
    release();
    await handle.ready;

    // The loadAll snapshot holds v1, but the pending delete outranks it
    // (ADR-013 rule 2) — hydrating it would resurrect a removed entity.
    expect(store.has("contact", "1")).toBe(false);

    await handle.flush();
    expect(inner.snapshot().has("contact:1" as EntityKey)).toBe(false);
    handle.dispose();
    await tick();
    expect(await rebootAndRead(inner, "1")).toBeUndefined();
  });

  it("a mid-boot write to a key the stale snapshot also holds wins — in memory AND on disk", async () => {
    const inner = await seedV1();
    const { engine, release, heldCount } = gateBoot(inner);
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, writeDebounce: 1 });

    await waitUntil(() => heldCount() === 1);
    store.set("contact", "1", { id: "1", name: "fresh" }); // fresher than the disk row
    release();
    await handle.ready;

    expect(store.get("contact", "1").value?.name).toBe("fresh"); // fresh-wins in memory
    await handle.flush();
    handle.dispose();
    await tick();
    expect(await rebootAndRead(inner, "1")).toBe("fresh"); // ...and on disk
  });

  it("a mid-boot write auto-flushes after boot without an explicit flush() — nothing strands", async () => {
    const inner = memoryEngine();
    const { engine, release, heldCount } = gateBoot(inner);
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, writeDebounce: 1 });

    await waitUntil(() => heldCount() === 1);
    store.set("contact", "7", { id: "7", name: "auto" });
    release();
    await handle.ready;

    // No explicit flush: the debounce path alone must land it.
    await waitUntil(() => inner.snapshot().has("contact:7" as EntityKey));
    handle.dispose();
    await tick();
  });
});

describe("DAN-630 — manifest-mode boot (loadMany in flight)", () => {
  it("writes landing while the index load is in flight are durable and beat stale rows", async () => {
    const inner = await seedManifest();
    const { engine, release, heldCount } = gateBoot(inner); // holds the INDEX loadMany first
    const store = createEntityStore();
    const handle = enablePersistence(store, {
      engine,
      hydration: "manifest",
      writeDebounce: 1,
    });

    await waitUntil(() => heldCount() >= 1); // boot is inside the index load
    store.set("contact", "1", { id: "1", name: "fresh" }); // clobber probe
    store.set("contact", "9", { id: "9", name: "novel" }); // brand-new mid-boot write
    release();
    await handle.ready;

    expect(store.get("contact", "1").value?.name).toBe("fresh"); // not clobbered
    expect(store.get("contact", "2").value?.name).toBe("v1"); // hydration still worked

    await handle.flush();
    handle.dispose();
    await tick();
    expect(await rebootAndRead(inner, "1")).toBe("fresh");
    expect(await rebootAndRead(inner, "9")).toBe("novel");
  });

  it("a remove() landing after the manifests resolved but before entity hydration is honored", async () => {
    const inner = await seedManifest();
    // Tightest window: hold ONLY the entity-rows loadMany (manifest-prefixed
    // key loads pass through), so the write lands right before hydrateRow.
    const { engine, release, heldCount } = gateBoot(
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

    await waitUntil(() => heldCount() === 1); // inside the entity-rows load
    store.remove("contact", "2");
    release();
    await handle.ready;

    expect(store.has("contact", "2")).toBe(false); // pending delete outranks the stale row
    expect(store.get("contact", "1").value?.name).toBe("v1"); // sibling hydrated normally

    await handle.flush();
    expect(inner.snapshot().has("contact:2" as EntityKey)).toBe(false);
    handle.dispose();
    await tick();
    expect(await rebootAndRead(inner, "2")).toBeUndefined();
  });
});

describe("DAN-630 — hydration-origin writes still excluded (behavior pin)", () => {
  it("boot hydration does not re-persist what it just loaded (no write-storm)", async () => {
    const inner = await seedV1([["2", "v1"]]);
    const { engine, putKeys } = spyWrites(inner);
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, writeDebounce: 1 });
    await handle.ready;

    expect(store.get("contact", "1").value?.name).toBe("v1"); // hydrated
    expect(store.get("contact", "2").value?.name).toBe("v1");
    await handle.flush();
    expect(putKeys).toHaveLength(0); // hydration produced zero engine writes
    handle.dispose();
    await tick();
  });

  it("hydrateScope's writes are excluded too — remount pages in without re-persisting", async () => {
    const inner = await seedManifest();
    const { engine, putKeys } = spyWrites(inner);
    const store = createEntityStore();
    const handle = enablePersistence(store, {
      engine,
      hydration: "manifest",
      writeDebounce: 1,
    });
    await handle.ready;
    await handle.flush();

    // Evict via THE gc trigger, then remount the scope.
    handle.removeManifest("s");
    await waitUntil(() => !store.has("contact", "1"));
    handle.setManifest("s", ["contact:1", "contact:2"]);
    await handle.flush();
    putKeys.length = 0; // observe ONLY the remount from here

    const hydrated = await handle.hydrateScope("s");
    expect(hydrated).toBe(2);
    await handle.flush();
    expect(putKeys).toHaveLength(0); // paged-in rows not re-persisted
    handle.dispose();
    await tick();
  });
});
