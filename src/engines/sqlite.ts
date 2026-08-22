/**
 * SQLite storage engine — main-thread side.
 *
 * SQLite-WASM with OPFS runs in a Worker (synchronous OPFS access handles
 * are worker-only), so this engine is a thin RPC client: it owns a Worker
 * running `runSqliteWorker()` (exported from `colada-db/sqlite-worker`) and
 * speaks a four-op protocol: open / loadAll / writeBatch / close.
 *
 * Bring-your-own-worker: the APP creates the worker file so the app's
 * bundler resolves `@sqlite.org/sqlite-wasm` and its .wasm asset — the one
 * approach that is robust across bundlers. Two lines of app code:
 *
 * ```typescript
 * // app/sqlite.worker.ts
 * import { runSqliteWorker } from 'colada-db/sqlite-worker'
 * runSqliteWorker()
 * ```
 * ```typescript
 * // app setup
 * enablePersistence(store, {
 *   engine: sqliteEngine({
 *     worker: () => new Worker(new URL('./sqlite.worker.ts', import.meta.url), { type: 'module' }),
 *   }),
 * })
 * ```
 *
 * Requires `@sqlite.org/sqlite-wasm` (optional peer dependency) installed in
 * the app. Uses the `opfs-sahpool` VFS — fastest OPFS option, no COOP/COEP
 * headers needed, single-connection (ADR-003). If OPFS is unavailable the
 * worker falls back to a transient in-memory DB and reports
 * `persistent: false` (inspect `engine.persistent` after open).
 */

import type { EntityKey, StorageEngine } from "../types";
import type { SqliteWorkerRequest, SqliteWorkerResponse } from "./sqlite-protocol";

export interface SqliteEngineOptions {
  /**
   * Worker factory (or instance) running `runSqliteWorker()`.
   * A factory is preferred — the worker is only created on `open()`.
   */
  worker: Worker | (() => Worker);
  /** Database file name inside OPFS. @default 'cdb_entities.sqlite3' */
  dbName?: string;
  /**
   * Page cache for this connection, applied at open as `PRAGMA cache_size`,
   * in SQLite's own sign convention passed through unchanged:
   * **negative = KiB of memory, positive = number of pages.**
   *
   * @default undefined — the build default is left in place (measured
   * `-16384`, i.e. 16 MiB, on `@sqlite.org/sqlite-wasm` 3.53.0).
   *
   * ⚠️ **Raise this deliberately, not reflexively.** The cache is real
   * memory held for as long as the connection is open — on a phone, in a
   * tab. For the JSON entity table this engine ships, the default has not
   * been measured to be a problem.
   *
   * Where it becomes load-bearing is a **vector corpus** (`vec0`) sharing
   * the connection: a KNN scan revisits pages, so once the working set
   * outgrows the cache *every* query thrashes rather than just the first.
   * Measured at 384 dimensions in Chromium, p95 at 100,000 vectors was
   * 1731 ms on the default against 29 ms at `-262144` — a **59×** penalty
   * that appears between 10,000 and 25,000 vectors, two corpus sizes a
   * developer would reasonably consider adjacent. Any deployment
   * persisting more than ~10,000 vectors must set this explicitly.
   *
   * Read {@link SqliteEngine.cacheSize} after `open()` to confirm what the
   * connection actually applied. Never assume this value took.
   */
  cacheSize?: number;
}

export interface SqliteEngine extends StorageEngine {
  /**
   * Whether the worker landed on durable OPFS storage (true) or fell back
   * to a transient in-memory DB (false). `null` until `open()` resolves.
   */
  readonly persistent: boolean | null;
  /**
   * `PRAGMA cache_size` as read back FROM the connection after `open()`,
   * in SQLite's own units (negative = KiB, positive = pages).
   *
   * `null` until `open()` resolves — and still `null` afterwards if the
   * worker reported none, which is how an app bundling an **older**
   * `colada-db/sqlite-worker` than its `colada-db` shows up. The two sides
   * cross a process boundary and are not ours to upgrade together
   * (ADR-022 line 5), so a requested {@link SqliteEngineOptions.cacheSize}
   * that reads back `null` means the pragma was never confirmed applied.
   * Treat that as unknown, never as set.
   */
  readonly cacheSize: number | null;
}

export function sqliteEngine(options: SqliteEngineOptions): SqliteEngine {
  const { worker: workerOrFactory, dbName = "cdb_entities.sqlite3", cacheSize } = options;

  let worker: Worker | null = null;
  let nextId = 1;
  let persistent: boolean | null = null;
  let effectiveCacheSize: number | null = null;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();

  function call<T>(op: SqliteWorkerRequest["op"], args?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!worker) return reject(new Error("SQLite engine not open"));
      const id = nextId++;
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      worker.postMessage({ id, op, args } satisfies SqliteWorkerRequest);
    });
  }

  function attach(w: Worker): void {
    worker = w;
    w.onmessage = (e: MessageEvent<SqliteWorkerResponse>) => {
      const { id, ok, result, error } = e.data;
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (ok) entry.resolve(result);
      else entry.reject(new Error(error));
    };
    w.onerror = (e) => {
      // A crashed worker fails every in-flight call — the coordinator sees
      // a rejected writeBatch and degrades (memory keeps working).
      const err = new Error(`SQLite worker error: ${e.message ?? "unknown"}`);
      for (const entry of pending.values()) entry.reject(err);
      pending.clear();
    };
  }

  return {
    get persistent() {
      return persistent;
    },

    get cacheSize() {
      return effectiveCacheSize;
    },

    isSupported() {
      return typeof Worker !== "undefined";
    },

    async open() {
      attach(typeof workerOrFactory === "function" ? workerOrFactory() : workerOrFactory);
      const info = await call<{ persistent: boolean; cacheSize?: number | null }>("open", {
        dbName,
        cacheSize,
      });
      persistent = info.persistent;
      // `?? null` rather than a default: an older worker omits the field
      // entirely, and reporting "unknown" is the only honest answer there.
      effectiveCacheSize = info.cacheSize ?? null;
      if (
        !info.persistent &&
        typeof process !== "undefined" &&
        process.env &&
        process.env.NODE_ENV !== "production"
      ) {
        console.warn(
          "[cdb-persist] OPFS unavailable — SQLite engine running in-memory (no durability). " +
            "OPFS requires a secure context (https/localhost) and a browser with " +
            "navigator.storage.getDirectory support.",
        );
      }
    },

    loadAll() {
      return call<Array<{ key: EntityKey; data: unknown; version: number }>>("loadAll");
    },

    loadMany(keys) {
      if (keys.length === 0) return Promise.resolve([]);
      return call<Array<{ key: EntityKey; data: unknown; version: number }>>("loadMany", { keys });
    },

    async writeBatch(puts, deletes) {
      await call("writeBatch", { puts, deletes });
    },

    close() {
      if (!worker) return;
      const w = worker;
      worker = null;

      // Termination must be UNCONDITIONAL and every pending call must
      // settle. Gating terminate on the worker's close-reply deadlocks:
      // dispose() during an in-flight open() gets the close handled first
      // (the worker's handler is async), the worker dies before the open
      // response exists, and enablePersistence().ready hangs forever.
      // A crashed worker similarly never replies. Best-effort graceful
      // close, then a hard deadline.
      const id = nextId++;
      let finished = false;
      const finish = () => {
        // Idempotent: the close sentinel below is itself in `pending`, so
        // rejecting the map re-enters finish — the guard makes that a no-op.
        if (finished) return;
        finished = true;
        pending.delete(id);
        w.terminate();
        const err = new Error("SQLite engine closed");
        for (const entry of pending.values()) entry.reject(err);
        pending.clear();
      };
      const timer = setTimeout(finish, 500);
      pending.set(id, {
        resolve: () => {
          clearTimeout(timer);
          finish();
        },
        reject: () => {
          clearTimeout(timer);
          finish();
        },
      });
      try {
        w.postMessage({ id, op: "close" } satisfies SqliteWorkerRequest);
      } catch {
        clearTimeout(timer);
        finish();
      }
    },
  };
}
