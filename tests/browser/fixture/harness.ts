/**
 * L4 real-browser durability fixture (DAN-652).
 *
 * Every other lane in this repo proves a mock: `idbEngine` runs against
 * fake-indexeddb, `sqliteEngine` against a `:memory:` database. This fixture
 * is the one that isn't a proxy — real IndexedDB and real OPFS, driven
 * through the REAL persistence coordinator (`enablePersistence`), not the
 * raw `StorageEngine` port. That matters: the DAN-647 dispose data-loss bug
 * and the ADR-012–016 durability family all lived in the coordinator's
 * write-behind path and hid precisely because a synchronous engine resolves
 * before the race window opens.
 *
 * The page exposes `window.__cdb`; the specs drive it and reload between
 * seed and verify. Nothing here asserts — assertions belong in the specs so
 * a failure names itself in Playwright's report.
 */
import { createEntityStore, enablePersistence, idbEngine, sqliteEngine } from "../../../src/index";
import type { StorageEngine } from "../../../src/index";

/** The instant we round-trip. Fixed, so a spec can compare it exactly. */
const WHEN_ISO = "2026-07-30T12:34:56.789Z";

export interface SeedResult {
  /**
   * `null` for engines with no such concept (IndexedDB is durable or it
   * throws). For `sqliteEngine` this is THE anti-vacuity signal: the worker
   * silently falls back to an in-memory database when OPFS is unavailable,
   * so a `false` here means the run proves nothing durable.
   */
  persistent: boolean | null;
  /** Rows the engine reports on disk immediately after the flush. */
  rowsOnDisk: number;
}

export interface VerifyResult {
  persistent: boolean | null;
  /** Entity ids hydrated from storage on a cold boot, sorted. */
  ids: string[];
  title: string | undefined;
  count: number | undefined;
  /** `"Date"` when structured-clone fidelity held; `"string"` when JSON-encoded. */
  whenType: string;
  /** Normalised to an ISO string either way, so specs can compare instants. */
  whenIso: string | undefined;
}

interface Item {
  id: string;
  title: string;
  count: number;
  when: Date;
}

function persistentOf(engine: StorageEngine): boolean | null {
  const p = (engine as StorageEngine & { persistent?: boolean | null }).persistent;
  return p === undefined ? null : p;
}

/**
 * Write two entities and force them all the way to storage.
 *
 * `flush()` then `dispose()` is deliberate: flush resolves when the engine
 * has ACKED the batch, so the data is durable before the page goes away.
 */
async function seed(engine: StorageEngine): Promise<SeedResult> {
  const store = createEntityStore();
  const handle = enablePersistence(store, { engine, writeDebounce: 10 });
  await handle.ready;

  store.set("item", "1", {
    id: "1",
    title: "alpha",
    count: 42,
    when: new Date(WHEN_ISO),
  } satisfies Item);
  store.set("item", "2", { id: "2", title: "beta", count: 7, when: new Date(WHEN_ISO) });

  await handle.flush();
  const rows = await engine.loadAll();
  const rowsOnDisk = rows.filter((r) => !r.key.startsWith("__cdb_manifest__:")).length;
  const persistent = persistentOf(engine);

  handle.dispose();
  return { persistent, rowsOnDisk };
}

/**
 * Cold-boot a BRAND NEW store over the same storage and read back what
 * hydration produced. This is the canonical local-first invariant: nothing
 * is carried over in memory, so anything present came off disk.
 */
async function verify(engine: StorageEngine): Promise<VerifyResult> {
  const store = createEntityStore();
  const handle = enablePersistence(store, { engine, writeDebounce: 10 });
  await handle.ready;

  const persistent = persistentOf(engine);
  const ids = store
    .getByType("item")
    .value.map((e) => String((e as unknown as Item).id))
    .sort();

  const one = store.get("item", "1").value as unknown as Item | undefined;
  const when: unknown = one?.when;
  const whenType = when instanceof Date ? "Date" : typeof when;
  const whenIso =
    when instanceof Date ? when.toISOString() : typeof when === "string" ? when : undefined;

  handle.dispose();
  return { persistent, ids, title: one?.title, count: one?.count, whenType, whenIso };
}

function makeSqliteEngine(): StorageEngine {
  return sqliteEngine({
    worker: () => new Worker(new URL("./sqlite.worker.ts", import.meta.url), { type: "module" }),
    dbName: "cdb_browser_lane.sqlite3",
  });
}

function makeIdbEngine(): StorageEngine {
  return idbEngine({ dbName: "cdb_browser_lane" });
}

const api = {
  expectedWhenIso: WHEN_ISO,
  idb: {
    seed: () => seed(makeIdbEngine()),
    verify: () => verify(makeIdbEngine()),
  },
  sqlite: {
    seed: () => seed(makeSqliteEngine()),
    verify: () => verify(makeSqliteEngine()),
  },
};

declare global {
  interface Window {
    __cdb: typeof api;
  }
}

window.__cdb = api;
document.getElementById("status")!.textContent = "ready";
