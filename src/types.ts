/**
 * pinia-colada-plugin-normalizer
 *
 * Normalized entity caching plugin for Pinia Colada.
 *
 * @module pinia-colada-plugin-normalizer
 */

import type { ComputedRef, ShallowRef } from "@vue/reactivity";

// ─────────────────────────────────────────────
// Entity Store Interface (the swappable contract)
// ─────────────────────────────────────────────

/**
 * A single entity record in the store.
 * Entities are plain objects with at least an ID field.
 */
export type EntityRecord = Record<string, unknown>;

/**
 * Composite key that uniquely identifies an entity: type + id.
 *
 * @example 'contact:42', 'order:abc-123'
 */
export type EntityKey = `${string}:${string}`;

// ─────────────────────────────────────────────
// Entity Type Registry
// ─────────────────────────────────────────────

/**
 * User-extensible type registry for entity types.
 * Augment this interface via module augmentation to get full type safety
 * across the entire API surface.
 *
 * @example
 * ```typescript
 * declare module 'colada-db' {
 *   interface EntityRegistry {
 *     contact: { contactId: string; name: string; email: string }
 *     order: { orderId: string; total: number; status: string }
 *   }
 * }
 *
 * // Now fully typed:
 * entityStore.get('contact', '1')          // ShallowRef<Contact | undefined>
 * entityStore.set('contact', '1', data)    // data must match Contact
 * useEntityQuery('contact', c => c.name)   // c is Contact
 * onEntityAdded('contact', e => e.data)    // data is Contact | undefined
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface EntityRegistry {}

/** Resolve entity type from registry, falling back to EntityRecord. */
export type ResolveEntity<K extends string> = K extends keyof EntityRegistry
  ? EntityRegistry[K]
  : EntityRecord;

/**
 * The write-channel origin vocabulary (ADR-007 §1, enum amended per the
 * 2026-07-12 council audit).
 *
 * - `local-mutation` — an optimistic transaction's write (user intent).
 * - `query-response` — normalization of fetched server data (the most
 *   common write; stamped by `writeEntitiesToStore`).
 * - `sync-pull` — a sync adapter applying remote changes (Stage 3).
 * - `hydration` — persistence restoring durable rows at boot.
 * - `rollback-replay` — the transaction layer's compensating writes and
 *   replays after a rollback (always paired with the owning transactionId).
 * - `undo` — an undo/redo system reverting a change (reserved).
 * - `agent` — an AI agent writing through an agent surface; agent origins
 *   may carry an identifier suffix (e.g., `agent:assistant-1`), which is
 *   why the type stays open beyond the known values.
 *
 * ⚠️ Origin is ATTRIBUTION within one trust domain, not AUTHENTICATION.
 * Any code with a store reference can call `runWith` — the channel makes
 * origins unforgeable through the ordinary write API (set/remove never
 * accept one), not against a hostile caller in the same JS realm.
 * Receipts and audit layers built on origins inherit this caveat.
 */
export type WriteOrigin =
  | "local-mutation"
  | "query-response"
  | "sync-pull"
  | "hydration"
  | "rollback-replay"
  | "undo"
  | "agent"
  | (string & {});

/**
 * Event emitted when the entity store changes.
 * When the entity type is registered in `EntityRegistry`, `data` and
 * `previousData` are typed accordingly.
 */
export interface EntityEvent<T extends EntityRecord = EntityRecord> {
  /**
   * The type of change.
   *
   * - `set` — entity written (created or merged)
   * - `remove` — entity deleted *semantically*: it should cease to exist.
   *   Persistence layers delete the durable row; sync layers replicate the
   *   deletion to other devices.
   * - `evict` — entity dropped from the *memory projection only* (cache
   *   trimming, GC). Persistence layers MUST keep the durable row; sync
   *   layers MUST NOT replicate it. Evicted entities may be re-hydrated later.
   *
   * The evict/remove split exists so that local cache management can never
   * be misread as data deletion by a durability or replication layer.
   */
  type: "set" | "remove" | "evict";
  /** Entity type (e.g., 'contact', 'order') */
  entityType: string;
  /** Entity ID */
  id: string;
  /** The full entity key */
  key: EntityKey;
  /** The entity data (undefined for 'remove'/'evict' events) */
  data: T | undefined;
  /** The previous entity data (undefined if entity didn't exist before) */
  previousData: T | undefined;
  /**
   * Optional causality/version metadata for this change.
   *
   * The in-memory store does not populate this. Persistence and sync
   * backends (e.g., cr-sqlite `db_version`, server `updatedAt`) may attach
   * a version so downstream consumers can arbitrate "which write is newer"
   * instead of relying on arrival order. Reserved now so the event shape
   * doesn't calcify before a sync backend exists (see ADR-005).
   */
  version?: string | number;
  /**
   * Which write CHANNEL produced this change (ADR-007 §1). Stamped via
   * `store.runWith({ origin }, fn)` — never passed by ordinary callers, so
   * privileged origins (`hydration`, `sync-pull`) can't be forged through
   * the public write API. Attribution within one trust domain, not
   * authentication — see {@link WriteOrigin} for the vocabulary and the
   * full caveat. Stamped today: `local-mutation`, `rollback-replay`
   * (transaction layer), `hydration` (persistence boot), `query-response`
   * (normalization writes).
   */
  origin?: WriteOrigin;
  /**
   * Groups the writes of one optimistic transaction. Stamped by the
   * transaction layer via `runWith`. Downstream layers use it to hold
   * optimistic writes out of the durable path until commit (roadmap
   * Phase 0.3) and to correlate receipts.
   */
  transactionId?: string;
}

/** Write-channel metadata applied to events emitted inside `runWith`. */
export interface WriteMeta {
  origin?: WriteOrigin;
  transactionId?: string;
}

/**
 * The EntityStore interface — the core contract that all backends implement.
 *
 * Architecture note (ADR-003): the read side of this contract is
 * deliberately SYNCHRONOUS — `get()` returns a ref immediately and the
 * plugin denormalizes on every read. An async storage engine (IndexedDB,
 * SQLite-WASM/OPFS in a worker) therefore does NOT implement this
 * interface directly. Instead, the in-memory store remains the
 * synchronous read *projection*, and durable engines sit underneath as
 * write-behind substrates wired up via `subscribe()` (writes flow down)
 * and `hydrate()` (boot data flows up) — see `enablePersistence()` for
 * the reference implementation of that pattern.
 */
export interface EntityStore {
  // ── Writes ──────────────────────────────────

  /**
   * Store an entity. If it already exists, shallow-merges incoming data on top
   * of existing data ({ ...existing, ...incoming }). This preserves fields from
   * richer queries (e.g., detail fetch with email) when a lighter query refetches.
   *
   * Use `replace()` instead if you need to overwrite the entity completely.
   */
  set<K extends string & keyof EntityRegistry>(
    entityType: K,
    id: string,
    data: EntityRegistry[K],
  ): void;
  set(entityType: string, id: string, data: EntityRecord): void;

  /**
   * Store an entity with full replacement (no merge).
   * Unlike `set()`, this overwrites the entity completely — any existing fields
   * not present in `data` are removed.
   *
   * Use this when you know the incoming data is the complete entity
   * (e.g., from a full server response or when the server intentionally removed fields).
   */
  replace<K extends string & keyof EntityRegistry>(
    entityType: K,
    id: string,
    data: EntityRegistry[K],
  ): void;
  replace(entityType: string, id: string, data: EntityRecord): void;

  /**
   * Store multiple entities at once (batch write).
   * Uses shallow merge (same as `set()`).
   * More efficient than calling set() in a loop for backends that support transactions.
   */
  setMany(entities: Array<{ entityType: string; id: string; data: EntityRecord }>): void;

  /**
   * Remove an entity from the store — a *semantic delete*.
   * Emits a `remove` event: persistence deletes the durable row and sync
   * layers replicate the deletion. Use `evict()` for cache trimming.
   */
  remove(entityType: string, id: string): void;

  /**
   * Drop an entity from the memory projection WITHOUT deleting it durably —
   * a *cache eviction*. Emits an `evict` event: persistence keeps the row
   * (the entity can re-hydrate later) and sync layers ignore it.
   * `gc()` evicts; it never deletes. See ADR-004.
   */
  evict(entityType: string, id: string): void;

  /**
   * Atomically read-modify-write an entity. The updater receives the
   * current value (or `undefined` if absent) and returns the complete new
   * value, which is stored with replace semantics (no implicit merge).
   *
   * Custom merge recipes run through this so the read and the write are a
   * single store operation — an interleaving write between a caller's own
   * `get()` and `replace()` can't be lost. On the in-memory store this is
   * trivially atomic (single-threaded); async backends must honor the same
   * guarantee transactionally.
   */
  update(
    entityType: string,
    id: string,
    updater: (existing: EntityRecord | undefined) => EntityRecord,
  ): void;

  // ── Reads ───────────────────────────────────

  /**
   * Get a single entity by type and ID.
   * Returns a reactive ref that updates when the entity changes.
   */
  get<K extends string & keyof EntityRegistry>(
    entityType: K,
    id: string,
  ): ShallowRef<EntityRegistry[K] | undefined>;
  get(entityType: string, id: string): ShallowRef<EntityRecord | undefined>;

  /**
   * Get all entities of a given type.
   * Returns a computed ref that updates when any entity of that type changes.
   */
  getByType<K extends string & keyof EntityRegistry>(
    entityType: K,
  ): ComputedRef<EntityRegistry[K][]>;
  getByType(entityType: string): ComputedRef<EntityRecord[]>;

  /**
   * Get all entities of a given type as id+data pairs.
   * Non-reactive snapshot — use `getByType()` for reactive views.
   *
   * This returns the store's canonical IDs alongside entity data,
   * which is essential for features like indexes that need to map
   * IDs to field values. Unlike `getByType()` (which returns data only),
   * this preserves the ID that the store uses internally.
   */
  getEntriesByType(entityType: string): Array<{ id: string; data: EntityRecord }>;

  /**
   * Check if an entity exists in the store.
   */
  has(entityType: string, id: string): boolean;

  // ── Subscriptions ───────────────────────────

  /**
   * Subscribe to entity changes. Useful for:
   * - Syncing with external systems (WebSocket confirmations)
   * - Analytics / debugging
   * - Cross-tab synchronization
   *
   * Note: no event is emitted for no-op writes (when `set()` is called
   * with data identical to what's already stored). This preserves
   * referential identity and prevents unnecessary downstream work.
   *
   * @returns Unsubscribe function
   */
  subscribe<K extends string & keyof EntityRegistry>(
    listener: (event: EntityEvent<EntityRegistry[K]>) => void,
    filter: { entityType: K },
  ): () => void;
  subscribe(listener: (event: EntityEvent) => void, filter?: { entityType?: string }): () => void;

  // ── Reference counting (GC support) ────────

  /**
   * Increment the reference count for an entity.
   * Called by the plugin when a query extracts this entity.
   * Entities created via direct `set()` (e.g., WebSocket) are untracked
   * and will NOT be collected by `gc()`.
   */
  retain(entityType: string, id: string): void;

  /**
   * Decrement the reference count for an entity.
   * Called by the plugin when a query is removed or its entities change.
   */
  release(entityType: string, id: string): void;

  /**
   * Get the current reference count for an entity.
   * Returns `undefined` if the entity has never been `retain()`ed
   * (i.e., created via direct `set()` — immune to GC).
   *
   * Useful for devtools and debugging GC behavior.
   */
  getRefCount(entityType: string, id: string): number | undefined;

  /**
   * Evict entities with zero or negative reference counts from the memory
   * projection. Only affects entities that have been `retain()`ed at least
   * once — entities created via direct `set()` (never retained) are untouched.
   *
   * This is cache trimming, not deletion: evicted entities emit `evict`
   * events, so persisted copies survive and can re-hydrate (ADR-004).
   * Also sweeps never-populated phantom refs (created by `get()` misses)
   * that no refcount tracks; live watchers of swept phantoms are
   * re-triggered so they re-establish tracking.
   *
   * @returns Array of evicted entity keys (e.g., ['contact:42', 'order:5'])
   */
  gc(): string[];

  // ── Write channel ───────────────────────────

  /**
   * Run `fn` with write-channel metadata: every event emitted by writes
   * inside `fn` (synchronously) carries `meta.origin` / `meta.transactionId`.
   * Nesting-safe — inner `runWith` shadows, then restores, the outer meta.
   *
   * This is THE mechanism by which origins are stamped (ADR-007 §1):
   * channels (transaction layer, hydration, sync coordinator) wrap their
   * writes; ordinary callers never touch it, so privileged origins cannot
   * be forged through the public write API.
   */
  runWith<T>(meta: WriteMeta, fn: () => T): T;

  // ── Lifecycle ───────────────────────────────

  /**
   * Clear all entities from the store — a *semantic delete* of everything
   * (logout, account switch, test reset). Emits a `remove` event per entity,
   * so persistence layers clear their durable copies and reactive consumers
   * (indexes, denorm caches, `useEntityRef`) update. Live refs are set to
   * `undefined` before removal so existing watchers fire.
   */
  clear(): void;

  /**
   * Get a snapshot of all entities (for serialization / SSR hydration).
   */
  toJSON(): Record<EntityKey, EntityRecord>;

  /**
   * Hydrate the store from a snapshot (SSR / persistence restore).
   */
  hydrate(snapshot: Record<EntityKey, EntityRecord>): void;
}

// ─────────────────────────────────────────────
// Storage Engine (durability substrate contract)
// ─────────────────────────────────────────────

/**
 * A durable storage engine that sits UNDERNEATH the in-memory read
 * projection (ADR-003). Engines never serve reads at runtime — the memory
 * store does. An engine's whole job is boot hydration (`loadAll`) and
 * write-behind durability (`writeBatch`).
 *
 * Implementations: `idbEngine` (IndexedDB, default), `sqliteEngine`
 * (SQLite-WASM over OPFS in a worker), `memoryEngine` (tests/SSR).
 *
 * Contract rules:
 * - `writeBatch` must apply puts and deletes atomically where the backend
 *   supports transactions, and MUST reject on failure — the persistence
 *   coordinator treats a rejected write as "engine degraded" and disables
 *   itself (the in-memory store keeps working).
 * - `loadAll` may include a per-row `version` (engine write counter,
 *   server timestamp) — the ADR-005 causality slot. Optional.
 * - Values passed to `writeBatch` have EntityRefs wire-encoded by the
 *   coordinator; USER entity fields pass through untouched. Engines store
 *   and return values opaquely — but their serialization limits leak:
 *   idbEngine structured-clones (Dates survive), sqliteEngine JSON-encodes
 *   (Dates become strings; BigInt/circular throw and fail the batch).
 *   Entities should stick to JSON-safe fields for engine portability.
 */
export interface StorageEngine {
  /**
   * Synchronous environment check. Returning false makes
   * `enablePersistence` a silent no-op (e.g., SSR) — no warning, no error.
   */
  isSupported(): boolean;

  /** Open the underlying database. Called once, before any other method. */
  open(): Promise<void>;

  /** Load every persisted entity for boot hydration. */
  loadAll(): Promise<Array<{ key: EntityKey; data: unknown; version?: number }>>;

  /**
   * Apply puts and deletes as one batch (atomic where supported).
   * MUST reject on failure so the coordinator can degrade gracefully.
   */
  writeBatch(
    puts: Array<{ key: EntityKey; value: unknown }>,
    deletes: EntityKey[],
  ): Promise<void>;

  /** Release handles/workers. No calls after close. */
  close(): void;
}

// ─────────────────────────────────────────────
// Entity Definition (the escape hatch)
// ─────────────────────────────────────────────

/**
 * Configuration for an entity type. Only needed when conventions don't fit.
 *
 * Convention: objects with an `id` field are auto-detected as entities.
 * Use defineEntity() when your API uses non-standard ID fields.
 *
 * @typeParam T - The entity shape. Provides type safety for `getId` and `merge`
 *   callbacks. Defaults to `EntityRecord` if not specified.
 *
 * @example
 * interface Contact {
 *   contactId: string
 *   name: string
 *   email: string
 * }
 *
 * const contact = defineEntity<Contact>({
 *   idField: 'contactId',
 *   getId: (entity) => entity.contactId, // entity is typed as Contact
 *   merge: (existing, incoming) => ({ ...existing, ...incoming }), // both typed
 * })
 */
export interface EntityDefinition<T extends EntityRecord = EntityRecord> {
  /**
   * The field name that contains the entity's unique ID.
   *
   * Note: there is NO implicit default here. A definition without `idField`
   * and without `getId` never matches via the explicit-definition path —
   * such objects are only normalized through the `__typename` convention
   * (GraphQL). For REST APIs without `__typename`, set `idField` (or
   * `getId`) explicitly. Applying an implicit `'id'` default would make any
   * id-bearing object match this type (cross-type collisions), so it is
   * deliberately not done.
   */
  idField?: (string & keyof T) | (string & {});

  /**
   * A function to extract the ID from an entity.
   * Use this for composite keys or computed IDs.
   * Takes precedence over `idField`.
   *
   * Must return `null` or `undefined` for objects that are NOT this entity type.
   * This is important when the same `getId` function could match unrelated objects.
   *
   * @example
   * // Composite key — only match objects that have both fields
   * getId: (entity) => {
   *   if (entity.orgId == null || entity.userId == null) return undefined
   *   return `${entity.orgId}-${entity.userId}`
   * }
   */
  getId?: (entity: T) => string | null | undefined;

  /**
   * Custom merge function for this entity type.
   * Called instead of the default shallow merge when updating an existing entity.
   * If omitted, the default `{ ...existing, ...incoming }` merge is used.
   *
   * Use cases: pagination (array append), deep nested objects, counters, etc.
   *
   * @example
   * // Append to a replies array instead of replacing it
   * merge: (existing, incoming) => ({
   *   ...existing,
   *   ...incoming,
   *   replies: [...(existing.replies || []), ...(incoming.replies || [])],
   * })
   */
  merge?: (existing: T, incoming: T) => T;
}

/**
 * Helper to define an entity configuration with type safety.
 *
 * @typeParam T - The entity shape. When provided, `getId`, `merge`, and
 *   `idField` get type-checked against your entity interface.
 *
 * @example
 * // Without generic (still works, no type checking on callbacks):
 * defineEntity({ idField: 'contactId' })
 *
 * // With generic (getId and merge are typed):
 * defineEntity<Contact>({ idField: 'contactId' })
 */
export function defineEntity<T extends EntityRecord = EntityRecord>(
  config: EntityDefinition<T>,
): EntityDefinition<T> {
  return config;
}

// ─────────────────────────────────────────────


// ─────────────────────────────────────────────
// Internal Symbols & Types
// ─────────────────────────────────────────────

/**
 * Symbol used to mark objects as entity references.
 * Using a Symbol prevents collision with any API data.
 * @internal
 */
export const ENTITY_REF_MARKER = Symbol("pinia-colada-entity-ref");

/**
 * An entity reference that replaces the actual entity data in the query cache.
 * Uses a Symbol marker to prevent collision with API data (Issue #13 fix).
 * @internal
 */
export interface EntityRef {
  /** Symbol marker to identify this as a reference (not a string property) */
  [ENTITY_REF_MARKER]: true;
  /** Entity type */
  entityType: string;
  /** Entity ID */
  id: string;
  /** Full entity key */
  key: EntityKey;
}


/**
 * The result of normalizing a query response.
 * @internal
 */
export interface NormalizationResult {
  /** The transformed data with entities replaced by references */
  normalized: unknown;
  /** The entities extracted from the response */
  entities: Array<{ entityType: string; id: string; data: EntityRecord }>;
}

// ─────────────────────────────────────────────
