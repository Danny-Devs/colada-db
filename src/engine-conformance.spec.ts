/**
 * DAN-653 Part B — the conformance kit, run against every engine we ship.
 *
 * The kit itself lives in `./engine-conformance` so a third-party
 * `StorageEngine` author can execute the same contract against their own
 * implementation. This file is the in-repo application of it.
 *
 * Coverage, and what each engine is actually proving:
 *
 * | engine  | backing store                    | durable across reopen |
 * |---------|----------------------------------|-----------------------|
 * | memory  | a per-instance closure           | no — capability omitted |
 * | idb     | fake-indexeddb (real IDB algos)  | yes — same dbName       |
 * | sqlite  | real sqlite-wasm, `:memory:`     | partial — see below     |
 *
 * The memory engine's row is the honest one: it is NOT durable, the kit does
 * not pretend otherwise, and `describe.skipIf` records that rather than
 * silently passing a property it cannot satisfy. That asymmetry is the entire
 * argument of `TESTING-STRATEGY.md` — the mock is a speed optimisation that
 * must itself be conformance-checked, not a stand-in for reality.
 */
import "fake-indexeddb/auto";
import { describe, it } from "vitest";
import type { EntityKey, StorageEngine } from "./types";
import { runStorageEngineContract } from "./engine-conformance";
import { memoryEngine } from "./engines/memory";
import { idbEngine } from "./engines/idb";
import {
  initSchema,
  loadAllRows,
  loadManyRows,
  writeBatchRows,
  type SqliteDb,
} from "./engines/sqlite-core";

// ── memory ───────────────────────────────────
// No `reopen`: rows live in a per-call closure, so there is nothing to reopen.
runStorageEngineContract("memoryEngine", () => memoryEngine(), { versioned: true });

// ── idb ──────────────────────────────────────
// fake-indexeddb runs the real IndexedDB algorithms (structured clone,
// transaction semantics, key ordering) over an in-process store, so a second
// engine on the same dbName genuinely re-reads persisted rows.
let idbCounter = 0;
const idbNames = new WeakMap<StorageEngine, string>();

runStorageEngineContract(
  "idbEngine (fake-indexeddb)",
  () => {
    const dbName = `conformance-idb-${++idbCounter}`;
    const engine = idbEngine({ dbName });
    idbNames.set(engine, dbName);
    return engine;
  },
  { reopen: (engine) => idbEngine({ dbName: idbNames.get(engine)! }), versioned: false },
);

// ── sqlite ───────────────────────────────────
/**
 * An in-process `StorageEngine` over the REAL SQL layer.
 *
 * The shipped `sqliteEngine` is an RPC shell around a worker; the SQL that
 * actually decides correctness lives in `sqlite-core`. Binding the contract
 * directly to the core runs every conformance property against real
 * sqlite-wasm — real transactions, real JSON encoding, real bind-variable
 * limits — with no worker plumbing in the way.
 *
 * `close()` deliberately does NOT close the database: the handle is owned by
 * the harness, mirroring how the shipped engine owns a worker rather than a
 * connection. That makes the reopen property a proxy — it proves data
 * survives dropping the ENGINE, not the process. A `:memory:` database cannot
 * prove more than that, and overstating it would be exactly the mock-hides-
 * reality failure this kit exists to catch. Real process-death on real OPFS
 * storage is DAN-652's browser lane.
 */
function sqliteDirectEngine(db: SqliteDb): StorageEngine {
  return {
    isSupported: () => true,
    async open() {
      initSchema(db);
    },
    async loadAll() {
      return loadAllRows(db) as Array<{ key: EntityKey; data: unknown; version: number }>;
    },
    async loadMany(keys) {
      return loadManyRows(db, keys as unknown as string[]) as Array<{
        key: EntityKey;
        data: unknown;
        version: number;
      }>;
    },
    async writeBatch(puts, deletes) {
      writeBatchRows(
        db,
        puts as Array<{ key: string; value: unknown }>,
        deletes as unknown as string[],
        Date.now(),
      );
    },
    close() {
      /* handle owned by the harness — see the note above */
    },
  };
}

interface Sqlite3Module {
  oo1: { DB: new (filename: string, flags: string) => SqliteDb };
}

/** Skipped gracefully when the wasm module cannot load in this environment. */
async function loadSqlite(): Promise<Sqlite3Module | null> {
  try {
    const init = (await import("@sqlite.org/sqlite-wasm")).default;
    return (await init()) as unknown as Sqlite3Module;
  } catch {
    return null;
  }
}

const sqlite3 = await loadSqlite();
const sqliteDbs = new WeakMap<StorageEngine, SqliteDb>();

if (sqlite3) {
  runStorageEngineContract(
    "sqliteEngine (real sqlite-wasm SQL core)",
    () => {
      const db = new sqlite3.oo1.DB(":memory:", "c");
      const engine = sqliteDirectEngine(db);
      sqliteDbs.set(engine, db);
      return engine;
    },
    { reopen: (engine) => sqliteDirectEngine(sqliteDbs.get(engine)!), versioned: true },
  );
} else {
  describe("StorageEngine contract: sqliteEngine (real sqlite-wasm SQL core)", () => {
    it.skip("sqlite-wasm unavailable in this environment", () => {});
  });
}
