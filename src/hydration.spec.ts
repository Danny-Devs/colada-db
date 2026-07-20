/**
 * Query-driven hydration suite (DAN-578, docs/design/query-driven-hydration.md):
 * manifest-mode boot hydrates exactly the scope-referenced set, retained
 * under each scope; removeManifest is THE gc trigger; hydrateScope/preload
 * page cold entities back in via loadMany; default mode is untouched.
 */
import { describe, expect, it } from "vitest";
import type { EntityEvent, EntityKey } from "./types";
import { createEntityStore } from "./store";
import { enablePersistence } from "./persist";
import { memoryEngine, type MemoryEngine } from "./engines/memory";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Wrap an engine to count loadMany calls (observe selective loading). */
function spyEngine(engine: MemoryEngine) {
  let loadManyCalls = 0;
  let loadAllCalls = 0;
  const spied: MemoryEngine = {
    ...engine,
    loadMany(keys) {
      loadManyCalls++;
      return engine.loadMany(keys);
    },
    loadAll() {
      loadAllCalls++;
      return engine.loadAll();
    },
  };
  return { engine: spied, loadManyCount: () => loadManyCalls, loadAllCount: () => loadAllCalls };
}

/**
 * Session 1: seed the engine the way a real app would — entities via the
 * store, manifests via setManifest — then dispose. Returns the engine.
 * Scopes: inbox = contacts 1..3; team = contacts 3..5 (contact:3 shared).
 * contacts 6..9 are durable but referenced by NO scope (must stay cold).
 */
async function seedEngine(): Promise<MemoryEngine> {
  const engine = memoryEngine();
  const store = createEntityStore();
  const handle = enablePersistence(store, { engine, writeDebounce: 1 });
  await handle.ready;

  for (let i = 1; i <= 9; i++) {
    store.set("contact", String(i), { id: String(i), name: `c${i}` });
  }
  handle.setManifest("inbox", ["contact:1", "contact:2", "contact:3"]);
  handle.setManifest("team", ["contact:3", "contact:4", "contact:5"]);
  await handle.flush();
  handle.dispose();
  await tick();
  return engine;
}

describe("manifest-mode boot", () => {
  it("hydrates exactly the union of scope keys; unreferenced rows stay cold; loadAll never called", async () => {
    const seeded = await seedEngine();
    const { engine, loadAllCount } = spyEngine(seeded);

    const store = createEntityStore();
    const events: EntityEvent[] = [];
    store.subscribe((e) => events.push(e));
    const handle = enablePersistence(store, { engine, hydration: "manifest", writeDebounce: 1 });
    await handle.ready;

    for (const id of ["1", "2", "3", "4", "5"]) {
      expect(store.has("contact", id)).toBe(true);
    }
    for (const id of ["6", "7", "8", "9"]) {
      expect(store.has("contact", id)).toBe(false); // durable-but-cold
    }
    expect(loadAllCount()).toBe(0); // selective boot never full-scans
    expect(events).toHaveLength(5);
    for (const e of events) expect(e.origin).toBe("hydration");
    handle.dispose();
  });

  it("empty engine (first boot) hydrates nothing and works", async () => {
    const store = createEntityStore();
    const events: EntityEvent[] = [];
    store.subscribe((e) => events.push(e));
    const handle = enablePersistence(store, {
      engine: memoryEngine(),
      hydration: "manifest",
      writeDebounce: 1,
    });
    await handle.ready;
    expect(events).toHaveLength(0);
    handle.dispose();
  });
});

describe("retention lifecycle — the residency-ratchet fix", () => {
  it("boot-hydrated entities are retained: gc() evicts nothing while scopes live", async () => {
    const engine = await seedEngine();
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, hydration: "manifest", writeDebounce: 1 });
    await handle.ready;

    expect(store.gc()).toEqual([]); // every hydrated key retained by a scope
    expect(store.has("contact", "1")).toBe(true);
    handle.dispose();
  });

  it("removeManifest releases the scope and the debounced sweep evicts its exclusive keys — shared keys survive, disk untouched", async () => {
    const engine = await seedEngine();
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, hydration: "manifest", writeDebounce: 1 });
    await handle.ready;

    handle.removeManifest("inbox");
    await tick(15); // debounced gc sweep fires

    expect(store.has("contact", "1")).toBe(false); // inbox-exclusive → evicted
    expect(store.has("contact", "2")).toBe(false);
    expect(store.has("contact", "3")).toBe(true); // shared with team → survives
    expect(store.has("contact", "4")).toBe(true);

    await handle.flush();
    // Evict ≠ delete (ADR-004): rows persist; only the manifest row is gone
    expect(engine.snapshot().has("contact:1" as EntityKey)).toBe(true);
    expect(engine.snapshot().has("__cdb_manifest__:inbox" as EntityKey)).toBe(false);
    handle.dispose();
  });

  it("dispose releases all coordinator retentions (refcounts don't outlive it)", async () => {
    const engine = await seedEngine();
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, hydration: "manifest", writeDebounce: 1 });
    await handle.ready;
    handle.dispose();
    await tick();

    // Counts are back to zero → a sweep can evict everything hydrated
    const evicted = store.gc();
    expect(evicted.length).toBe(5);
  });
});

describe("hydrateScope / preload — paging cold data back in", () => {
  it("hydrateScope re-hydrates evicted keys via loadMany, skips memory-present keys, retains", async () => {
    const engine = await seedEngine();
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, hydration: "manifest", writeDebounce: 1 });
    await handle.ready;

    // Simulate a remount after the scope was dropped: release + evict
    handle.removeManifest("inbox");
    await tick(15);
    expect(store.has("contact", "1")).toBe(false);

    // The scope returns (remount) — restore its manifest, then hydrate
    handle.setManifest("inbox", ["contact:1", "contact:2", "contact:3"]);
    const hydrated = await handle.hydrateScope("inbox");

    expect(hydrated).toBe(2); // 1 and 2 were cold; 3 stayed via team
    expect(store.has("contact", "1")).toBe(true);
    expect(store.gc()).toEqual([]); // re-retained under inbox
    handle.dispose();
  });

  it("preload() warms every scope in the persisted index — usable from 'all'-mode handles too", async () => {
    const engine = await seedEngine();
    const store = createEntityStore();
    // "all" mode boot on a spy: hydrates everything, but preload still works
    const { engine: spied, loadManyCount } = spyEngine(engine);
    const handle = enablePersistence(store, { engine: spied, writeDebounce: 1 });
    await handle.ready;

    store.evict("contact", "1");
    store.evict("contact", "5");
    const hydrated = await handle.preload();
    expect(hydrated).toBe(2);
    expect(store.has("contact", "1")).toBe(true);
    expect(store.has("contact", "5")).toBe(true);
    expect(loadManyCount()).toBeGreaterThan(0);
    handle.dispose();
  });

  it("preload(['team']) warms exactly one scope", async () => {
    const engine = await seedEngine();
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, hydration: "manifest", writeDebounce: 1 });
    await handle.ready;

    handle.removeManifest("team"); // note: also drops team's manifest row
    await tick(15);
    handle.setManifest("team", ["contact:3", "contact:4", "contact:5"]);

    const hydrated = await handle.preload(["team"]);
    expect(hydrated).toBe(2); // 4 and 5 (3 survived via inbox)
    expect(store.has("contact", "4")).toBe(true);
    handle.dispose();
  });
});

describe("review-hardening regressions (B1–B4, A2)", () => {
  it("B1a · setManifest BEFORE boot completes merges with prior sessions' index — never clobbers", async () => {
    const engine = await seedEngine();
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, hydration: "manifest", writeDebounce: 1 });
    handle.setManifest("newScope", ["contact:6"]); // fires while engine is opening
    await handle.ready;
    await handle.flush();

    const index = engine.snapshot().get("__cdb_manifest__:__index__" as EntityKey);
    expect(index).toBeDefined();
    const scopes = (index!.data as { scopes: string[] }).scopes.sort();
    expect(scopes).toEqual(["inbox", "newScope", "team"]);
    handle.dispose();
  });

  it("B1b · 'all'-mode sessions preserve the persisted index when adding scopes", async () => {
    const engine = await seedEngine();
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, writeDebounce: 1 }); // all mode
    await handle.ready;
    handle.setManifest("extra", ["contact:7"]);
    await handle.flush();

    const index = engine.snapshot().get("__cdb_manifest__:__index__" as EntityKey);
    expect(index).toBeDefined();
    const scopes = (index!.data as { scopes: string[] }).scopes.sort();
    expect(scopes).toEqual(["extra", "inbox", "team"]);
    expect(engine.snapshot().has("__cdb_manifest__:inbox" as EntityKey)).toBe(true); // no orphaning
    handle.dispose();
  });

  it("B2 · the gc sweep flushes BEFORE evicting — an unflushed write survives to disk", async () => {
    const engine = await seedEngine();
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, hydration: "manifest", writeDebounce: 5 });
    await handle.ready;

    handle.removeManifest("inbox"); // schedules the sweep
    store.set("contact", "1", { id: "1", name: "LAST-WRITE" }); // pending, unflushed
    await tick(40); // sweep fires: flush → then gc

    expect(store.has("contact", "1")).toBe(false); // evicted (scope gone)
    expect(engine.snapshot().get("contact:1" as EntityKey)?.data).toMatchObject({
      name: "LAST-WRITE", // …but the write reached disk FIRST
    });
    handle.dispose();
  });

  it("B3 · dispose during hydrateScope's engine read leaves no retention behind", async () => {
    const seeded = await seedEngine();
    const slow: MemoryEngine = {
      ...seeded,
      async loadMany(keys) {
        await tick(20); // hold the read so dispose can land mid-flight
        return seeded.loadMany(keys);
      },
    };
    const store = createEntityStore();
    const handle = enablePersistence(store, {
      engine: slow,
      hydration: "manifest",
      writeDebounce: 1,
    });
    await handle.ready;
    handle.removeManifest("inbox");
    await tick(40); // sweep: contact 1,2 evicted
    handle.setManifest("inbox", ["contact:1", "contact:2", "contact:3"]);

    const pending = handle.hydrateScope("inbox");
    handle.dispose(); // races the loadMany above
    expect(await pending).toBe(0); // post-await check refused to hydrate
    expect(store.has("contact", "1")).toBe(false); // nothing resurrected

    const evicted = store.gc(); // and nothing left pinned by the dead handle
    expect(evicted.length).toBeGreaterThan(0); // team's keys were released by dispose
  });

  it("B4 · hydrateScope inside removeManifest's debounce window cannot re-pin a dead scope", async () => {
    const engine = await seedEngine();
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, hydration: "manifest", writeDebounce: 5 });
    await handle.ready;

    handle.removeManifest("inbox");
    const hydrated = await handle.hydrateScope("inbox"); // same window — must refuse
    expect(hydrated).toBe(0);
    await tick(40); // sweep

    expect(store.has("contact", "1")).toBe(false); // evicted, not re-pinned
    expect(store.gc()).toEqual([]); // and no stray refcounts holding anything
    handle.dispose();
  });

  it("A2 · shrinking a scope's manifest releases the dropped keys' pins now", async () => {
    const engine = await seedEngine();
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, hydration: "manifest", writeDebounce: 1 });
    await handle.ready;

    handle.setManifest("inbox", ["contact:1"]); // drops 2 and 3
    const evicted = store.gc().sort();

    expect(evicted).toEqual(["contact:2"]); // dropped + not otherwise referenced
    expect(store.has("contact", "1")).toBe(true); // still in inbox
    expect(store.has("contact", "3")).toBe(true); // survives via team
    handle.dispose();
  });
});

describe("default 'all' mode — unchanged, manifest-safe", () => {
  it("hydrates every entity row but never materializes manifest rows as entities", async () => {
    const engine = await seedEngine();
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, writeDebounce: 1 }); // default mode
    await handle.ready;

    for (let i = 1; i <= 9; i++) {
      expect(store.has("contact", String(i))).toBe(true); // all contacts hydrate
    }
    expect(store.has("__cdb_manifest__", "inbox")).toBe(false);
    expect(store.has("__cdb_manifest__", "__index__")).toBe(false);
    handle.dispose();
  });
});
