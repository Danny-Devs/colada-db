/**
 * Wire protocol between sqliteEngine (main thread) and runSqliteWorker()
 * (worker). Kept in its own module so both sides share one source of truth
 * and neither drags the other's dependencies into its bundle.
 */

export interface SqliteWorkerRequest {
  id: number;
  op: "open" | "loadAll" | "writeBatch" | "close";
  args?: unknown;
}

export interface SqliteWorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}
