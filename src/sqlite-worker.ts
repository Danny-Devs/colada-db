/**
 * SQLite engine — worker entry (`pinia-colada-plugin-normalizer/sqlite-worker`).
 *
 * Runs inside a dedicated Worker created by the APP (bring-your-own-worker,
 * see sqliteEngine docs) so the app's bundler resolves
 * `@sqlite.org/sqlite-wasm` and its .wasm asset:
 *
 * ```typescript
 * // app/sqlite.worker.ts — the whole file
 * import { runSqliteWorker } from 'pinia-colada-plugin-normalizer/sqlite-worker'
 * runSqliteWorker()
 * ```
 *
 * Storage: OPFS via the `opfs-sahpool` VFS (fastest, no COOP/COEP headers).
 * If OPFS is unavailable (insecure context, old browser, Node test env),
 * falls back to a transient in-memory DB and reports `persistent: false`.
 */

import type { SqliteWorkerRequest, SqliteWorkerResponse } from "./engines/sqlite-protocol";
import { initSchema, loadAllRows, writeBatchRows, type SqliteDb } from "./engines/sqlite-core";

interface WorkerState {
  db: SqliteDb | null;
  persistent: boolean;
}

async function handleOpen(state: WorkerState, dbName: string): Promise<{ persistent: boolean }> {
  // Dynamic import: resolved and bundled by the APP's bundler because this
  // module runs inside an app-created worker. Optional peer dependency —
  // apps that never use sqliteEngine never pay for it.
  const sqlite3InitModule = (await import("@sqlite.org/sqlite-wasm")).default;
  const sqlite3 = await sqlite3InitModule();

  try {
    // opfs-sahpool: synchronous access handles, worker-only, no COOP/COEP.
    const poolUtil = await sqlite3.installOpfsSAHPoolVfs({});
    state.db = new poolUtil.OpfsSAHPoolDb(dbName) as unknown as SqliteDb;
    state.persistent = true;
  } catch {
    // OPFS unavailable — transient in-memory DB. The engine warns on the
    // main thread; the app keeps working without durability.
    state.db = new sqlite3.oo1.DB(":memory:", "c") as unknown as SqliteDb;
    state.persistent = false;
  }

  initSchema(state.db);
  return { persistent: state.persistent };
}

/**
 * Install the message handler. Call once, at the top level of the app's
 * worker file.
 */
export function runSqliteWorker(): void {
  const state: WorkerState = { db: null, persistent: false };

  self.onmessage = async (e: MessageEvent<SqliteWorkerRequest>) => {
    const { id, op, args } = e.data;
    const respond = (response: Omit<SqliteWorkerResponse, "id">) =>
      (self as unknown as Worker).postMessage({ id, ...response });

    try {
      if (op === "open") {
        const { dbName } = args as { dbName: string };
        respond({ ok: true, result: await handleOpen(state, dbName) });
      } else if (op === "loadAll") {
        if (!state.db) throw new Error("DB not open");
        respond({ ok: true, result: loadAllRows(state.db) });
      } else if (op === "writeBatch") {
        if (!state.db) throw new Error("DB not open");
        const { puts, deletes } = args as {
          puts: Array<{ key: string; value: unknown }>;
          deletes: string[];
        };
        writeBatchRows(state.db, puts, deletes, Date.now());
        respond({ ok: true });
      } else if (op === "close") {
        state.db?.close();
        state.db = null;
        respond({ ok: true });
      } else {
        throw new Error(`Unknown op: ${op satisfies never}`);
      }
    } catch (err) {
      respond({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  };
}
