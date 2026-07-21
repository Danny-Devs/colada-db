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
export { createOptimisticUpdates, PolicyVetoError } from "./transactions";
export type {
  OptimisticTransaction,
  OptimisticUpdates,
  TransactionSettledEvent,
  PolicyGate,
  ProposedWrite,
  GateVerdict,
} from "./transactions";

// ─── Schema export (machine-legible registry, ADR-007 §4) ───
export { exportSchema } from "./schema";
export type {
  ColadaDbSchema,
  ExportedEntitySchema,
  ExportedField,
  ExportedRelation,
} from "./schema";

// ─── Matcher AST (serializable filters, ADR-009 — the live-query substrate) ───
export {
  M,
  parseMatcher,
  evaluateMatcher,
  classifyFilter,
  serializeMatcher,
  MatcherParseError,
  MATCHER_MAX_DEPTH,
  MATCHER_MAX_LIST_LENGTH,
  MATCHER_MAX_COST,
} from "./matcher";
export type {
  MatcherNode,
  MatcherScalar,
  MatcherOrderedScalar,
  MatcherComparisonNode,
  MatcherOrderedNode,
  MatcherListNode,
  MatcherExistsNode,
  MatcherGroupNode,
  MatcherNotNode,
  MatcherClassification,
  MatcherParseCode,
} from "./matcher";

// ─── Live matcher views (two-tier reactive membership, DAN-606) ───
export { createMatcherView, MatcherViewError } from "./matcher-view";
export type {
  MatcherView,
  MatcherViewTier,
  MatcherViewFilter,
  MatcherViewOptions,
  MatcherViewDivergence,
  MatcherPredicate,
} from "./matcher-view";

// ─── History (capped field-level change log, ADR-007 §3) ───
export { enableHistory, createWriteIdGenerator } from "./history";
export type { HistoryStore, HistoryEntry, HistoryOptions } from "./history";

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
  WriteOrigin,
  WriteMeta,
} from "./types";
