/**
 * SQLite engine — SQL core.
 *
 * Pure functions over an sqlite3 oo1-style DB handle. No worker, no OPFS,
 * no message passing — which is exactly what makes them unit-testable in
 * Node against an in-memory sqlite-wasm DB. The worker shell
 * (sqlite-worker.ts) is I/O-only and stays too thin to hide bugs.
 *
 * Schema notes:
 * - `row_version` increments on every write — the engine-side causality
 *   counter that feeds EntityEvent.version / version-aware fresh-wins
 *   later (ADR-005). Written now so rows carry history from day one.
 * - `data` is the JSON-encoded entity (EntityRefs already wire-encoded by
 *   the persistence coordinator).
 */

// Minimal structural type for sqlite-wasm's oo1.DB — avoids a hard type
// dependency on @sqlite.org/sqlite-wasm (an optional peer).
export interface SqliteDb {
  exec(opts: {
    sql: string;
    bind?: unknown[];
    rowMode?: "object" | "array";
    callback?: (row: any) => void;
  }): unknown;
  close(): void;
}

/**
 * Apply and READ BACK `PRAGMA cache_size` on this connection (DAN-926).
 *
 * `cache_size` is a per-CONNECTION setting. Unlike `page_size` it is not
 * stored in the database file, so it must be set on every open or the
 * connection silently runs on the build default — measured `-16384`
 * (16 MiB) at `page_size` 8192 on `@sqlite.org/sqlite-wasm` 3.53.0.
 *
 * The return value is read back FROM the connection rather than echoed
 * from the argument, and that distinction is the point: SQLite is free to
 * clamp or reinterpret the value, and an echo would report a setting that
 * was never confirmed. The benchmark that motivated this option was itself
 * corrupted once by assuming a pragma held (`cache_size` persisted across
 * cases, so the control arm was not a control).
 *
 * @param cacheSize SQLite's own convention, passed through unchanged:
 *   NEGATIVE = KiB of memory, POSITIVE = number of pages. Omit to leave
 *   the current setting alone and only report it.
 * @returns the effective `cache_size`, or `null` if the connection
 *   reported none.
 */
export function applyCacheSize(db: SqliteDb, cacheSize?: number): number | null {
  if (cacheSize !== undefined) {
    // PRAGMA statements take no bind parameters, so the value is
    // interpolated into the SQL text. Validating it to an integer FIRST is
    // what makes that safe; it also refuses a fractional value that SQLite
    // would otherwise truncate without complaint.
    if (!Number.isInteger(cacheSize)) {
      throw new Error(
        `sqliteEngine: cacheSize must be an integer (negative = KiB, positive = pages), got ${cacheSize}`,
      );
    }
    db.exec({ sql: `PRAGMA cache_size=${cacheSize}` });
  }

  const read: unknown[] = [];
  db.exec({
    sql: "PRAGMA cache_size",
    rowMode: "array",
    callback: (row: unknown[]) => {
      read.push(row[0]);
    },
  });
  if (read.length === 0) return null;
  const effective = Number(read[0]);
  return Number.isFinite(effective) ? effective : null;
}

export function initSchema(db: SqliteDb): void {
  db.exec({
    sql: `CREATE TABLE IF NOT EXISTS entities (
      key TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      row_version INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    )`,
  });
}

export function loadAllRows(
  db: SqliteDb,
): Array<{ key: string; data: unknown; version: number }> {
  const rows: Array<{ key: string; data: unknown; version: number }> = [];
  db.exec({
    sql: "SELECT key, data, row_version FROM entities",
    rowMode: "object",
    callback: (row: { key: string; data: string; row_version: number }) => {
      rows.push({ key: row.key, data: JSON.parse(row.data), version: row.row_version });
    },
  });
  return rows;
}

/**
 * Selective load for manifest boot / re-hydration (DAN-578). Chunked at
 * 500 binds per statement — comfortably under every SQLITE_LIMIT_VARIABLE_NUMBER
 * in circulation (999 historic default, 32766 modern builds).
 */
export function loadManyRows(
  db: SqliteDb,
  keys: string[],
): Array<{ key: string; data: unknown; version: number }> {
  const rows: Array<{ key: string; data: unknown; version: number }> = [];
  const CHUNK = 500;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    db.exec({
      sql: `SELECT key, data, row_version FROM entities WHERE key IN (${placeholders})`,
      bind: chunk,
      rowMode: "object",
      callback: (row: { key: string; data: string; row_version: number }) => {
        rows.push({ key: row.key, data: JSON.parse(row.data), version: row.row_version });
      },
    });
  }
  return rows;
}

export function writeBatchRows(
  db: SqliteDb,
  puts: Array<{ key: string; value: unknown }>,
  deletes: string[],
  now: number,
): void {
  // One transaction per batch: a batch that fails applies nothing, so the
  // coordinator's degrade-on-reject contract stays honest.
  db.exec({ sql: "BEGIN IMMEDIATE" });
  try {
    for (const { key, value } of puts) {
      // Name the offending entity on serialization failure — a poison
      // entity (BigInt, circular ref) disables persistence via the
      // coordinator's degrade path, and an anonymous error would leave
      // no way to find which one.
      let json: string;
      try {
        json = JSON.stringify(value);
      } catch (err) {
        throw new Error(
          `Entity '${key}' is not JSON-serializable (sqliteEngine requires JSON-safe fields): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      db.exec({
        sql: `INSERT INTO entities (key, data, row_version, updated_at)
              VALUES (?, ?, 1, ?)
              ON CONFLICT(key) DO UPDATE SET
                data = excluded.data,
                row_version = entities.row_version + 1,
                updated_at = excluded.updated_at`,
        bind: [key, json, now],
      });
    }
    for (const key of deletes) {
      db.exec({ sql: "DELETE FROM entities WHERE key = ?", bind: [key] });
    }
    db.exec({ sql: "COMMIT" });
  } catch (err) {
    db.exec({ sql: "ROLLBACK" });
    throw err;
  }
}
