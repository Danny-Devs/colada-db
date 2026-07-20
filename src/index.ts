/**
 * colada-db — AI-first, local-first client database.
 *
 * The engine: a normalized reactive entity store (synchronous read
 * projection) over pluggable write-behind durability engines
 * (in-memory, IndexedDB, OPFS SQLite).
 *
 * Framework adapters live in separate packages; the first is
 * `pinia-colada-plugin-normalizer` (Vue / Pinia Colada).
 */

// ─── Entity store ───
export { createEntityStore } from "./store";

// ─── Adapter-facing subscription boundary (ADR-008 §3) ───
export { createStoreBoundary } from "./boundary";
export type { StoreBoundary } from "./boundary";

// ─── Normalization engine ───
export { normalize, denormalize } from "./normalize";
// Adapter-facing utilities (used by framework adapters; stable but low-level)
export { splitEntityKey, writeEntitiesToStore } from "./normalize";

// ─── Persistence (write-behind wiring over a StorageEngine) ───
export { enablePersistence } from "./persist";
export type { PersistenceOptions, PersistenceHandle } from "./persist";

// ─── Durability engines ───
export { idbEngine } from "./engines/idb";
export type { IdbEngineOptions } from "./engines/idb";
export { memoryEngine } from "./engines/memory";
export type { MemoryEngine } from "./engines/memory";
export { sqliteEngine } from "./engines/sqlite";
export type { SqliteEngine, SqliteEngineOptions } from "./engines/sqlite";

// ─── Optimistic transactions ───
export { createOptimisticUpdates } from "./transactions";
export type {
  OptimisticTransaction,
  OptimisticUpdates,
  TransactionSettledEvent,
} from "./transactions";

// ─── Real-time coalescing ───
export { createCoalescer } from "./coalesce";

// ─── Pagination merge recipes ───
export { cursorPagination, offsetPagination, relayPagination } from "./pagination";
export type { RelayPageInfo } from "./pagination";

// ─── Entity definitions & types ───
export { defineEntity, ENTITY_REF_MARKER } from "./types";
export type {
  EntityRecord,
  EntityKey,
  EntityRegistry,
  ResolveEntity,
  EntityEvent,
  EntityStore,
  StorageEngine,
  EntityDefinition,
  EntityRef,
  NormalizationResult,
} from "./types";
