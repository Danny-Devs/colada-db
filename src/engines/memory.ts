/**
 * In-memory storage engine — for tests, SSR demos, and as the reference
 * implementation of the StorageEngine contract (it's the contract with all
 * I/O removed; read it first when writing a new engine).
 *
 * Persists nothing across page loads by definition. `snapshot()` is exposed
 * for tests that want to assert what "reached the engine".
 */

import type { EntityKey, StorageEngine } from "../types";

export interface MemoryEngine extends StorageEngine {
  /** Test hook: current engine contents as a plain Map. */
  snapshot(): Map<EntityKey, { data: unknown; version: number }>;
}

export function memoryEngine(): MemoryEngine {
  const rows = new Map<EntityKey, { data: unknown; version: number }>();

  return {
    isSupported() {
      return true;
    },

    async open() {},

    async loadAll() {
      return Array.from(rows.entries()).map(([key, row]) => ({
        key,
        data: row.data,
        version: row.version,
      }));
    },

    async writeBatch(puts, deletes) {
      for (const { key, value } of puts) {
        const existing = rows.get(key);
        rows.set(key, { data: value, version: (existing?.version ?? 0) + 1 });
      }
      for (const key of deletes) {
        rows.delete(key);
      }
    },

    close() {},

    snapshot() {
      return new Map(rows);
    },
  };
}
