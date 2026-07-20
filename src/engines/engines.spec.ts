import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { StorageEngine } from "../types";
import { idbEngine } from "./idb";
import { memoryEngine } from "./memory";
import { createEntityStore } from "../store";
import { enablePersistence } from "../persist";
import { initSchema, loadAllRows, writeBatchRows, type SqliteDb } from "./sqlite-core";

// ─────────────────────────────────────────────
// StorageEngine contract suite
// Every engine must pass these — add new engines here.
// ─────────────────────────────────────────────

function engineContract(name: string, makeEngine: () => StorageEngine) {
  describe(`StorageEngine contract: ${name}`, () => {
    it("round-trips puts through loadAll", async () => {
      const engine = makeEngine();
      expect(engine.isSupported()).toBe(true);
      await engine.open();

      await engine.writeBatch(
        [
          { key: "contact:1", value: { id: "1", name: "Alice" } },
          { key: "order:5", value: { id: "5", total: 100 } },
        ],
        [],
      );

      const rows = await engine.loadAll();
      const byKey = new Map(rows.map((r) => [r.key, r.data]));
      expect(byKey.get("contact:1")).toEqual({ id: "1", name: "Alice" });
      expect(byKey.get("order:5")).toEqual({ id: "5", total: 100 });
      engine.close();
    });

    it("applies deletes and last-write-wins puts in one batch", async () => {
      const engine = makeEngine();
      await engine.open();

      await engine.writeBatch([{ key: "contact:1", value: { v: 1 } }], []);
      await engine.writeBatch(
        [{ key: "contact:1", value: { v: 2 } }],
        ["order:missing"], // deleting a nonexistent key must not throw
      );
      await engine.writeBatch([], ["contact:1"]);

      const rows = await engine.loadAll();
      expect(rows).toHaveLength(0);
      engine.close();
    });

    it("loadAll on a fresh database is empty", async () => {
      const engine = makeEngine();
      await engine.open();
      expect(await engine.loadAll()).toEqual([]);
      engine.close();
    });
  });
}

engineContract("memoryEngine", () => memoryEngine());
let idbCounter = 0;
engineContract("idbEngine", () => idbEngine({ dbName: `contract-db-${++idbCounter}` }));

// ─────────────────────────────────────────────
// Coordinator × engine option
// ─────────────────────────────────────────────

describe("enablePersistence with a custom engine", () => {
  it("persists through memoryEngine and hydrates from it", async () => {
    const engine = memoryEngine();

    const store1 = createEntityStore();
    const p1 = enablePersistence(store1, { engine, writeDebounce: 0 });
    await p1.ready;
    store1.set("contact", "1", { id: "1", name: "Alice" });
    await p1.flush();
    // dispose() would close the engine; skip it — we reuse the engine to
    // simulate "next session" against the same durable state.

    expect(engine.snapshot().get("contact:1")).toBeTruthy();

    const store2 = createEntityStore();
    const p2 = enablePersistence(store2, { engine });
    await p2.ready;
    expect(store2.get("contact", "1").value?.name).toBe("Alice");
  });

  it("evict keeps the engine row, remove deletes it (ADR-004, engine-agnostic)", async () => {
    const engine = memoryEngine();
    const store = createEntityStore();
    const p = enablePersistence(store, { engine, writeDebounce: 0 });
    await p.ready;

    store.set("contact", "1", { id: "1", name: "Alice" });
    store.set("contact", "2", { id: "2", name: "Bob" });
    await p.flush();

    store.evict("contact", "1");
    store.remove("contact", "2");
    await p.flush();

    const snap = engine.snapshot();
    expect(snap.has("contact:1")).toBe(true); // evicted → durable row survives
    expect(snap.has("contact:2")).toBe(false); // removed → durable row deleted
  });

  it("engine version counter increments per write (ADR-005 slot)", async () => {
    const engine = memoryEngine();
    await engine.open();
    await engine.writeBatch([{ key: "contact:1", value: { v: 1 } }], []);
    await engine.writeBatch([{ key: "contact:1", value: { v: 2 } }], []);
    const [row] = await engine.loadAll();
    expect(row.version).toBe(2);
  });
});

// ─────────────────────────────────────────────
// sqliteEngine RPC lifecycle — protocol-faithful fake worker
// ─────────────────────────────────────────────

describe("sqliteEngine lifecycle", () => {
  it("close() during an in-flight open() settles open (no hang) and terminates the worker", async () => {
    // Regression: terminate used to be gated on the worker's close-reply;
    // a dispose during boot handled `close` before `open` ever answered,
    // so enablePersistence().ready hung forever.
    const { sqliteEngine } = await import("./sqlite");

    let terminated = false;
    // Fake worker: answers `close` immediately, NEVER answers `open`
    // (mimics the real worker mid-wasm-init).
    const fakeWorker = {
      onmessage: null as ((e: { data: unknown }) => void) | null,
      onerror: null as unknown,
      postMessage(msg: { id: number; op: string }) {
        if (msg.op === "close") {
          queueMicrotask(() =>
            this.onmessage?.({ data: { id: msg.id, ok: true } }),
          );
        }
        // `open` is swallowed — no reply, ever.
      },
      terminate() {
        terminated = true;
      },
    };

    const engine = sqliteEngine({ worker: fakeWorker as unknown as Worker });
    const openPromise = engine.open();
    engine.close();

    // open() must SETTLE (reject) — a hang here fails the test by timeout
    await expect(openPromise).rejects.toThrow("SQLite engine closed");
    expect(terminated).toBe(true);
  });

  it("close() on a dead worker still terminates after the deadline", async () => {
    const { sqliteEngine } = await import("./sqlite");
    let terminated = false;
    const deadWorker = {
      onmessage: null,
      onerror: null,
      postMessage() {}, // corpse: never replies to anything
      terminate() {
        terminated = true;
      },
    };
    const engine = sqliteEngine({ worker: deadWorker as unknown as Worker });
    const openPromise = engine.open().catch(() => {}); // will be rejected by close
    engine.close();
    await new Promise((r) => setTimeout(r, 600)); // past the 500ms deadline
    expect(terminated).toBe(true);
    await openPromise;
  });
});

// ─────────────────────────────────────────────
// Packaging invariant (LESSONS.md 2026-07-12)
// ─────────────────────────────────────────────

describe("packaging", () => {
  it("sqlite-wasm peer range stays '*' — every upstream release is a prerelease", async () => {
    // Any normal range (>=3.50.0) matches ZERO published versions of
    // @sqlite.org/sqlite-wasm because they all carry -buildN prerelease
    // tags, which semver excludes → npm install hard-fails for consumers.
    // Read via fs, NOT import: a JSON module import would pull the package
    // root into tsc's inferred rootDir and break declaration bundling.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
    expect(pkg.peerDependencies["@sqlite.org/sqlite-wasm"]).toBe("*");
  });
});

// ─────────────────────────────────────────────
// SQLite SQL core — real sqlite-wasm, in-memory, in Node.
// The worker shell is I/O-only; this is where the SQL lives.
// Skipped gracefully if the wasm module can't load in this environment.
// ─────────────────────────────────────────────

async function tryOpenSqlite(): Promise<SqliteDb | null> {
  try {
    const sqlite3InitModule = (await import("@sqlite.org/sqlite-wasm")).default;
    const sqlite3 = await sqlite3InitModule();
    return new sqlite3.oo1.DB(":memory:", "c") as unknown as SqliteDb;
  } catch {
    return null;
  }
}

const sqliteDb = await tryOpenSqlite();

describe.skipIf(sqliteDb === null)("sqlite-core (real sqlite-wasm, :memory:)", () => {
  it("schema init is idempotent", () => {
    initSchema(sqliteDb!);
    initSchema(sqliteDb!);
  });

  it("round-trips entities with JSON encoding and row_version bookkeeping", () => {
    const db = sqliteDb!;
    initSchema(db);

    writeBatchRows(db, [{ key: "contact:1", value: { id: "1", name: "Alice" } }], [], 1000);
    writeBatchRows(db, [{ key: "contact:1", value: { id: "1", name: "Alicia" } }], [], 2000);
    writeBatchRows(db, [{ key: "order:5", value: { id: "5", total: 100 } }], [], 3000);

    const rows = loadAllRows(db);
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect(byKey.get("contact:1")!.data).toEqual({ id: "1", name: "Alicia" });
    expect(byKey.get("contact:1")!.version).toBe(2); // upsert incremented
    expect(byKey.get("order:5")!.version).toBe(1);

    writeBatchRows(db, [], ["contact:1"], 4000);
    expect(loadAllRows(db).map((r) => r.key)).toEqual(["order:5"]);
  });

  it("a failing batch applies nothing (transaction atomicity)", () => {
    const db = sqliteDb!;
    initSchema(db);
    writeBatchRows(db, [], ["order:5"], 4500); // clean slate for this test

    expect(() =>
      writeBatchRows(
        db,
        [
          { key: "contact:9", value: { ok: true } },
          // Circular structure — JSON.stringify throws mid-batch
          { key: "contact:10", value: (() => { const o: any = {}; o.self = o; return o; })() },
        ],
        [],
        5000,
      ),
    ).toThrow();

    // The first put must have been rolled back with the batch
    expect(loadAllRows(db).find((r) => r.key === "contact:9")).toBeUndefined();
  });
});
