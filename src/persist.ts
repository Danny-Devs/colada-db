/**
 * Persistence coordinator — write-behind durability for the entity store.
 *
 * The in-memory store stays the synchronous read projection (ADR-003); this
 * module wires a StorageEngine underneath it:
 *
 *   boot:    engine.loadAll() → hydrate memory (fresh-wins)
 *   runtime: store.subscribe() → dirty-set → debounced engine.writeBatch()
 *
 * Engines are swappable: `idbEngine` (default), `sqliteEngine` (OPFS),
 * `memoryEngine` (tests/SSR). The coordinator owns everything engine-
 * agnostic: change detection, debouncing, evict-vs-remove semantics
 * (ADR-004), EntityRef wire encoding, and graceful degradation — if the
 * engine fails, persistence disables itself and the in-memory store keeps
 * working untouched.
 *
 * @module pinia-colada-plugin-normalizer
 */

import type { EntityKey, EntityRecord, EntityStore, StorageEngine } from "./types";
import { encodeEntityRefs, decodeEntityRefs } from "./store";
import { idbEngine } from "./engines/idb";
import { createOptimisticUpdates, type TransactionSettledEvent } from "./transactions";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// Manifest namespace (DAN-578, docs/design/query-driven-hydration.md)
// ─────────────────────────────────────────────
// Scope→entityKeys manifests live in the SAME engine KV table as entities,
// under a reserved type prefix — zero engine schema changes; the
// coordinator owns the semantics (ADR-003 division). `__cdb_manifest__`
// is a RESERVED entity type: never use it for real entities.

const MANIFEST_PREFIX = "__cdb_manifest__:";
const INDEX_KEY = `${MANIFEST_PREFIX}__index__` as EntityKey;

function manifestKey(scopeId: string): EntityKey {
  return `${MANIFEST_PREFIX}${scopeId}` as EntityKey;
}

interface ManifestRow {
  v: 1;
  keys: EntityKey[];
}

interface ManifestIndexRow {
  v: 1;
  scopes: string[];
}

export interface PersistenceOptions {
  /**
   * Storage engine to persist into.
   * @default idbEngine({ dbName }) — IndexedDB
   */
  engine?: StorageEngine;
  /**
   * IndexedDB database name — convenience for the default engine.
   * Ignored when `engine` is provided (configure the engine directly).
   * @default 'pcn_entities'
   */
  dbName?: string;
  /** Debounce interval (ms) for batching writes. @default 100 */
  writeDebounce?: number;
  /** Called when hydration from the engine completes. */
  onReady?: () => void;
  /** Called when persistence degrades (engine failure, quota). */
  onError?: (error: unknown) => void;
  /**
   * Ask the browser to protect this origin's storage from automatic
   * eviction under disk pressure (`navigator.storage.persist()`). The real
   * durability risk in browsers is not corruption — it's silent quota
   * eviction wiping the database. Opt-in because some browsers (Firefox)
   * surface a permission prompt.
   * @default false
   */
  requestDurable?: boolean;
  /**
   * Boot hydration strategy (DAN-578):
   *
   * - `"all"` (default) — `loadAll()` and hydrate every durable row.
   *   Unchanged legacy semantics; right for small datasets.
   * - `"manifest"` — hydrate ONLY entities referenced by persisted scope
   *   manifests (see `setManifest`), each retained under its scope so
   *   `gc()` can never evict what a live scope needs. Unreferenced rows
   *   stay durable-but-cold and page in via `hydrateScope`/`preload`.
   *   Memory becomes a true projection of the DB (ADR-003 at scale).
   */
  hydration?: "all" | "manifest";
}

export interface PersistenceHandle {
  /** Resolves when hydration from the engine is complete. */
  ready: Promise<void>;
  /**
   * Resolves `true` if the browser granted durable (eviction-protected)
   * storage. Always `false` unless `requestDurable: true` was passed and
   * the platform granted it. Never rejects.
   */
  durable: Promise<boolean>;
  /** Force-flush pending writes to the engine immediately. */
  flush(): Promise<void>;
  /**
   * Persist (or replace) a scope's manifest: the set of entity keys this
   * scope needs resident. Adapters call this whenever a query's entity
   * mapping changes (plugin: on NORM_META update). Rides the normal write
   * flush; kept on evict; next manifest-mode boot hydrates exactly these.
   * Does NOT retain at runtime — retention of freshly-fetched entities is
   * the adapter's concern; boot/hydrateScope/preload retention is ours.
   */
  setManifest(scopeId: string, keys: EntityKey[]): void;
  /**
   * Delete a scope's manifest, release every retention this coordinator
   * holds under it, and schedule the debounced `gc()` sweep — THE trigger
   * that makes eviction actually happen (nothing else calls `gc()`).
   */
  removeManifest(scopeId: string): void;
  /**
   * Re-hydrate a scope's entities from the engine via `loadMany` (the
   * post-evict remount path). Loads only keys absent from memory; retains
   * every scope key. Resolves to the number of entities hydrated.
   */
  hydrateScope(scopeId: string): Promise<number>;
  /**
   * Warm scopes ahead of use (router hook, pre-mount). No arguments =
   * every scope in the persisted index. Without `preload`, first paint on
   * a durable-but-cold entity shows pending — the synchronous `store.has`
   * redirect check cannot see disk (documented boundary).
   */
  preload(scopeIds?: string[]): Promise<number>;
  /** Unsubscribe from store changes and release the engine. */
  dispose(): void;
}

/**
 * Ask the browser to mark this origin's storage as durable (protected from
 * automatic eviction under storage pressure). Safe to call anywhere:
 * resolves `false` on unsupported platforms and never rejects.
 */
export async function requestDurableStorage(): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.persist) return false;
    // Already granted (e.g., an installed PWA or a prior grant)?
    if (navigator.storage.persisted && (await navigator.storage.persisted())) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────
// enablePersistence
// ─────────────────────────────────────────────

/**
 * Enable write-behind persistence for an entity store.
 *
 * On startup, hydrates the store from the engine (fresh-wins: skips entities
 * already in memory). Subscribes to store changes and writes back
 * incrementally — only changed entities are flushed, in a single engine
 * batch per debounce window.
 *
 * Gracefully degrades if the engine is unavailable (private browsing, quota
 * exceeded, SSR). The in-memory store continues to work normally.
 *
 * **Semantics:** `remove` events delete the durable row; `evict` events
 * (cache GC) keep it — evicted entities re-hydrate next session (ADR-004).
 * `store.clear()` emits a `remove` per RESIDENT entity, so a reset clears
 * their durable copies too — but only what memory holds: in manifest mode,
 * durable-but-cold rows, scope manifests, and the index all survive a
 * `clear()`, and the coordinator's retention bookkeeping is not reset.
 * Full erasure semantics (logout flows) are tracked in DAN-602 — until it
 * lands, treat `clear()` as a projection reset, not a disk wipe.
 *
 * **Optimistic writes never touch disk until commit:** events carrying a
 * `transactionId` are buffered per-transaction; commit graduates the
 * buffer's net effect into the normal write path, rollback discards it.
 * Uncommitted buffers die at `dispose()`/unload by design — they were
 * never confirmed. See `docs/design/optimistic-durability.md`.
 *
 * @example
 * ```typescript
 * import { useEntityStore, enablePersistence, sqliteEngine } from 'pinia-colada-plugin-normalizer'
 *
 * const entityStore = useEntityStore()
 *
 * // Default: IndexedDB
 * const { ready } = enablePersistence(entityStore)
 *
 * // Or: SQLite over OPFS (see docs/persistence for the worker setup)
 * const { ready } = enablePersistence(entityStore, {
 *   engine: sqliteEngine({ worker: () => new Worker(new URL('./sqlite.worker.ts', import.meta.url), { type: 'module' }) }),
 * })
 * await ready // entities from last session are restored
 * ```
 */
export function enablePersistence(
  store: EntityStore,
  options: PersistenceOptions = {},
): PersistenceHandle {
  const {
    dbName = "pcn_entities",
    engine = idbEngine({ dbName }),
    writeDebounce = 100,
    onReady,
    onError,
    requestDurable = false,
    hydration = "all",
  } = options;

  // ── State ──────────────────────────────────
  const dirtySaves = new Map<EntityKey, unknown>(); // key → encoded data
  const dirtyDeletes = new Set<EntityKey>();
  // Per-transaction buffers — optimistic writes parked here until settlement
  // (docs/design/optimistic-durability.md). Disk persists CONFIRMED state
  // only: commit graduates a buffer into the dirty sets; rollback discards
  // it. Entry shape is per-key net effect + op type — this buffer is the
  // proto-outbox (ADR-006 §1); Stage 3 upgrades entries to LocalChange.
  type BufferedOp = { op: "put"; value: unknown } | { op: "delete" };
  const pendingTx = new Map<string, Map<EntityKey, BufferedOp>>();
  let settledUnsub: (() => void) | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let opened = false;
  let disabled = false;
  let isHydrating = false;
  let disposed = false;
  let flushing = false;

  // ── Scope retention bookkeeping (DAN-578) ──
  // Keys this coordinator has retained, per scope. A key referenced by N
  // scopes carries N refcounts (store refcounts sum); releaseScope gives
  // back exactly what THIS coordinator took, never the adapter's own.
  const scopeRetentions = new Map<string, Set<EntityKey>>();
  // Live index mirror. Seeded from the PERSISTED index at boot (both
  // modes) and merged with pre-boot setManifest calls — never written
  // eagerly (review B1: an eager snapshot taken before boot seeding
  // clobbered prior sessions' scopes). The index row is computed lazily
  // at flush time from this Set.
  const manifestScopes = new Set<string>();
  const removedPreBoot = new Set<string>(); // removeManifest before boot seeding
  let indexDirty = false;
  let indexSeeded = false;
  let gcTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Environment guard (SSR etc.) ───────────
  if (!engine.isSupported()) {
    return {
      ready: Promise.resolve(),
      durable: Promise.resolve(false),
      flush: () => Promise.resolve(),
      setManifest: () => {},
      removeManifest: () => {},
      hydrateScope: () => Promise.resolve(0),
      preload: () => Promise.resolve(0),
      dispose: () => {},
    };
  }

  // ── Eviction protection (A4) ───────────────
  // Fire-and-forget alongside engine open; never blocks hydration.
  const durable = requestDurable ? requestDurableStorage() : Promise.resolve(false);

  // ── Subscribe to store changes ─────────────
  // IMPORTANT: store.subscribe fires synchronously within store.set().
  // The isHydrating guard relies on this — if subscribe were async/batched,
  // hydration would trigger a write-storm (re-persisting loaded entities).
  const unsub = store.subscribe((event) => {
    if (isHydrating || disabled || disposed) return;

    const key = event.key;

    // ── Transactional writes: buffer until settlement ──
    // Any set/remove carrying a transactionId is optimistic — it may yet
    // roll back, so it must not reach the dirty sets. This routing is safe
    // ONLY because the transaction layer replays under the owner's identity
    // (resolution (a)): rollback-replay events carry their transaction's id
    // too, so nothing optimistic ever arrives id-less. The buffer is keyed
    // net-effect-per-key, so idempotent re-buffering during replay is free.
    const txId = event.transactionId;
    if (txId !== undefined && (event.type === "set" || event.type === "remove")) {
      if (!settledUnsub) {
        // First transactional event seen — obtain THE store's optimistic
        // handle (WeakMap-backed, same instance by construction) and learn
        // about settlements. No new public store surface.
        settledUnsub = createOptimisticUpdates(store).onSettled(onTxSettled);
      }
      let buffer = pendingTx.get(txId);
      if (!buffer) {
        buffer = new Map();
        pendingTx.set(txId, buffer);
      }
      if (event.type === "set" && event.data != null) {
        buffer.set(key, { op: "put", value: encodeEntityRefs(event.data) });
      } else if (event.type === "remove") {
        buffer.set(key, { op: "delete" });
      }
      return; // nothing confirmed changed — no flush to schedule
    }

    if (event.type === "set" && event.data != null) {
      dirtySaves.set(key, encodeEntityRefs(event.data));
      dirtyDeletes.delete(key);
    } else if (event.type === "remove") {
      // Semantic delete — the entity should cease to exist durably.
      dirtyDeletes.add(key);
      dirtySaves.delete(key);
    } else if (event.type === "evict") {
      // Cache eviction (gc) — the entity leaves the memory projection but
      // the durable layer is UNTOUCHED: never a delete (ADR-004), and any
      // pending save stays queued and flushes (ADR-013). Cancelling the
      // save here was the DAN-621 resurrection bug: after remove→set
      // within one debounce window, the set's save is the only thing
      // correcting a durable row the remove already invalidated — dropping
      // it let the stale pre-remove row stand and resurrect on next boot.
      // Eviction has no authority over the durability pipeline.
      return;
    }
    scheduleFlush();
  });

  // ── Transaction settlement ─────────────────
  // Commit: the buffer's net effects are now confirmed state — graduate
  // them into the dirty sets and flush normally. Rollback: the transaction
  // never happened; its buffer (including the compensating rollback-replay
  // events re-buffered under its id) dies in memory. Disk untouched.
  function onTxSettled(event: TransactionSettledEvent): void {
    const buffer = pendingTx.get(event.transactionId);
    if (!buffer) return;
    pendingTx.delete(event.transactionId);
    if (disabled || disposed || event.outcome === "rollback") return;

    for (const [key, entry] of buffer) {
      if (entry.op === "put") {
        dirtySaves.set(key, entry.value);
        dirtyDeletes.delete(key);
      } else {
        dirtyDeletes.add(key);
        dirtySaves.delete(key);
      }
    }
    scheduleFlush();
  }

  // ── Flush logic ────────────────────────────
  function scheduleFlush(): void {
    if (flushTimer || disabled || disposed) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, writeDebounce);
  }

  let inflightFlush: Promise<void> | null = null;

  async function flush(): Promise<void> {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!opened || disabled || disposed) return;
    // Concurrency contract: `await flush()` means "everything dirty as of
    // this call is durable when I resolve". If a flush is in-flight, wait
    // for it, then flush again — writes that arrived DURING the in-flight
    // batch are in the dirty sets and must not be silently skipped.
    if (flushing) {
      await inflightFlush;
      return flush();
    }
    if (dirtySaves.size === 0 && dirtyDeletes.size === 0 && !indexDirty) return;

    // Materialize the manifest index row NOW, from the live mirror —
    // lazy so pre-boot writes can never snapshot a half-seeded index
    // (review B1).
    if (indexDirty) {
      const row: ManifestIndexRow = { v: 1, scopes: [...manifestScopes] };
      dirtySaves.set(INDEX_KEY, row);
      indexDirty = false;
    }

    flushing = true;
    const puts = Array.from(dirtySaves.entries()).map(([key, value]) => ({ key, value }));
    const deletes = Array.from(dirtyDeletes);
    dirtySaves.clear();
    dirtyDeletes.clear();

    let settle!: () => void;
    inflightFlush = new Promise<void>((r) => (settle = r));
    try {
      await engine.writeBatch(puts, deletes);
    } catch (err) {
      disabled = true;
      onError?.(err);
      if (process.env.NODE_ENV !== "production") {
        console.warn("[pcn-persist] Write failed, persistence disabled:", err);
      }
    } finally {
      flushing = false;
      settle();
      inflightFlush = null;
      // If new writes arrived during the flush, schedule another
      if (dirtySaves.size > 0 || dirtyDeletes.size > 0) {
        scheduleFlush();
      }
    }
  }

  // ── Hydration machinery ────────────────────

  /**
   * Hydrate one engine row into memory. Fresh-wins: skips entities already
   * in memory (e.g., a server fetch that beat the engine open) —
   * existence-based until engines populate row versions (ADR-005).
   * Stamped `hydration` (ADR-007 §1): this coordinator OWNS the privileged
   * origin — undo stacks skip these, sync must not echo them, history
   * attributes them. (Persistence's own subscriber ignores them via
   * isHydrating regardless.) Returns true if a write happened.
   */
  function hydrateRow(row: { key: EntityKey; data: unknown }): boolean {
    const key = row.key;
    const separatorIndex = key.indexOf(":");
    if (separatorIndex === -1) return false;
    // Pending-truth overlay (ADR-013 rule 2 — the readManifestRow/B4
    // principle generalized to entity rows): confirmed-but-unflushed state
    // outranks the engine's flushed rows. A pending delete means this row
    // is doomed — hydrating it would resurrect a semantically-deleted
    // entity into memory; a pending save means the engine row is stale —
    // hydrate the pending value instead. Uncommitted transaction buffers
    // (pendingTx) are deliberately NOT consulted: unconfirmed state must
    // neither flush nor hydrate.
    if (dirtyDeletes.has(key)) return false;
    const pending = dirtySaves.get(key);
    const data = pending !== undefined ? pending : row.data;
    const entityType = key.slice(0, separatorIndex);
    const id = key.slice(separatorIndex + 1);
    if (store.has(entityType, id)) return false;
    store.runWith({ origin: "hydration" }, () =>
      store.set(entityType, id, decodeEntityRefs(data) as EntityRecord),
    );
    return true;
  }

  /** Retain `key` under `scopeId` (idempotent per scope+key). */
  function retainUnder(scopeId: string, key: EntityKey): void {
    let keys = scopeRetentions.get(scopeId);
    if (!keys) {
      keys = new Set();
      scopeRetentions.set(scopeId, keys);
    }
    if (keys.has(key)) return;
    const separatorIndex = key.indexOf(":");
    if (separatorIndex === -1) return;
    store.retain(key.slice(0, separatorIndex), key.slice(separatorIndex + 1));
    keys.add(key);
  }

  /** Release a single key held under `scopeId` (no-op if not held). */
  function releaseKey(scopeId: string, key: EntityKey): void {
    const keys = scopeRetentions.get(scopeId);
    if (!keys?.has(key)) return;
    keys.delete(key);
    const separatorIndex = key.indexOf(":");
    if (separatorIndex === -1) return;
    store.release(key.slice(0, separatorIndex), key.slice(separatorIndex + 1));
  }

  /** Release every retention held under `scopeId`. */
  function releaseScope(scopeId: string): void {
    const keys = scopeRetentions.get(scopeId);
    if (!keys) return;
    scopeRetentions.delete(scopeId);
    for (const key of keys) {
      const separatorIndex = key.indexOf(":");
      if (separatorIndex === -1) continue;
      store.release(key.slice(0, separatorIndex), key.slice(separatorIndex + 1));
    }
  }

  /**
   * THE gc trigger (audit item: `gc()` is otherwise never invoked).
   * Debounced so a burst of removeManifest calls sweeps once.
   *
   * The sweep FLUSHES FIRST (review B2). Under ADR-013 evict no longer
   * cancels pending saves, so sweeping first can't destroy an unflushed
   * write anymore — but the ordering stays: evicted entities' rows should
   * be durable BEFORE their memory copy disappears, not a debounce window
   * later. Never sweeps in degraded mode (review A3): with the engine
   * dead, memory is the ONLY copy — evict-is-safe doesn't hold.
   */
  function scheduleGcSweep(): void {
    if (gcTimer || disposed || disabled) return;
    gcTimer = setTimeout(() => {
      gcTimer = null;
      void flush()
        .catch(() => {})
        .then(() => {
          if (!disposed && !disabled) store.gc();
        });
    }, writeDebounce);
  }

  /**
   * Mark the manifest index dirty. The row itself is materialized at
   * flush time from the live `manifestScopes` — never snapshotted here
   * (review B1: pre-boot snapshots clobbered prior sessions' scopes).
   */
  function markIndexDirty(): void {
    indexDirty = true;
    dirtyDeletes.delete(INDEX_KEY);
  }

  /** Seed the live index mirror from the persisted index (once, at boot). */
  function seedIndex(scopes: string[]): void {
    for (const s of scopes) {
      if (!removedPreBoot.has(s)) manifestScopes.add(s);
    }
    indexSeeded = true;
    removedPreBoot.clear();
  }

  /**
   * Read a manifest row: pending state wins over the engine — including
   * pending DELETES (review B4: a removeManifest inside the debounce
   * window must make the scope unreadable immediately, or a remount
   * hydrateScope resurrects retention under a dead scope).
   */
  async function readManifestRow(scopeId: string): Promise<ManifestRow | null> {
    const key = manifestKey(scopeId);
    if (dirtyDeletes.has(key)) return null;
    const pending = dirtySaves.get(key);
    if (pending) return pending as ManifestRow;
    const rows = await engine.loadMany([key]);
    return rows.length > 0 ? (rows[0].data as ManifestRow) : null;
  }

  // ── Boot ───────────────────────────────────
  const ready = engine
    .open()
    .then(async () => {
      if (disposed) {
        engine.close();
        return;
      }
      opened = true;

      isHydrating = true;
      try {
        // Post-await `disposed` re-checks throughout (review B3): a
        // dispose() racing boot must not hydrate or retain afterward —
        // refcounts must never outlive the coordinator.
        if (hydration === "manifest") {
          // Selective boot: index → scope rows → referenced entities.
          // Never calls loadAll; unreferenced rows stay durable-but-cold.
          const indexRows = await engine.loadMany([INDEX_KEY]);
          if (disposed) return;
          const persisted =
            indexRows.length > 0 ? (indexRows[0].data as ManifestIndexRow).scopes : [];
          const bootScopes = persisted.filter((s) => !removedPreBoot.has(s));
          seedIndex(persisted);

          const scopeRows = await engine.loadMany(bootScopes.map(manifestKey));
          if (disposed) return;
          const keysByScope = new Map<string, EntityKey[]>();
          const union = new Set<EntityKey>();
          for (const row of scopeRows) {
            const scopeId = row.key.slice(MANIFEST_PREFIX.length);
            const keys = (row.data as ManifestRow).keys;
            keysByScope.set(scopeId, keys);
            for (const k of keys) union.add(k);
          }

          const entityRows = await engine.loadMany([...union]);
          if (disposed) return;
          for (const row of entityRows) hydrateRow(row);
          // Retention AFTER hydration: every scope retains every key it
          // references — including fresh-wins keys already in memory (the
          // scope needs them resident either way). This is the residency-
          // ratchet fix: hydrated ≠ immortal; unreferenced = evictable.
          for (const [scopeId, keys] of keysByScope) {
            for (const key of keys) retainUnder(scopeId, key);
          }
        } else {
          const rows = await engine.loadAll();
          if (disposed) return;
          for (const row of rows) {
            // Manifest rows are coordinator state, never entities — filter
            // so switching modes can't mint phantom `__cdb_manifest__`s.
            // The index row seeds the live mirror even in "all" mode, so
            // this session's setManifest calls MERGE with prior sessions
            // instead of clobbering them (review B1).
            if (row.key === INDEX_KEY) {
              seedIndex((row.data as ManifestIndexRow).scopes);
              continue;
            }
            if (row.key.startsWith(MANIFEST_PREFIX)) continue;
            hydrateRow(row);
          }
          if (!indexSeeded) seedIndex([]); // no index row on disk yet
        }
      } finally {
        isHydrating = false;
      }

      // Writes that happened while the engine was still opening consumed
      // their debounce timer against an unopened engine and early-returned.
      // Re-schedule so they aren't stranded until the next store event.
      if (dirtySaves.size > 0 || dirtyDeletes.size > 0) {
        scheduleFlush();
      }

      onReady?.();
    })
    .catch((err) => {
      disabled = true;
      onError?.(err);
      if (process.env.NODE_ENV !== "production") {
        console.warn("[pcn-persist] Storage engine unavailable, running memory-only:", err);
      }
    });

  // ── Lifecycle hooks ────────────────────────
  // Flush on tab hide (mobile) and before unload (desktop close).
  // Neither is 100% reliable, but together they cover most cases.
  function onVisibilityChange(): void {
    if (document.visibilityState === "hidden") flush();
  }
  function onBeforeUnload(): void {
    flush();
  }

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", onBeforeUnload);
  }

  // ── Manifest verbs (DAN-578) ───────────────

  function setManifest(scopeId: string, keys: EntityKey[]): void {
    if (disabled || disposed) return;
    manifestScopes.add(scopeId);
    removedPreBoot.delete(scopeId);

    // Reconcile retention for a SHRUNK scope (review A2): keys the scope
    // no longer references lose this scope's pin now, not at next boot.
    const held = scopeRetentions.get(scopeId);
    if (held) {
      const next = new Set(keys);
      // Set deletion during iteration is well-defined — no copy needed.
      for (const key of held) {
        if (!next.has(key)) releaseKey(scopeId, key);
      }
    }

    const row: ManifestRow = { v: 1, keys: [...keys] };
    dirtySaves.set(manifestKey(scopeId), row);
    dirtyDeletes.delete(manifestKey(scopeId));
    markIndexDirty();
    scheduleFlush();
  }

  function removeManifest(scopeId: string): void {
    if (disposed) return;
    manifestScopes.delete(scopeId);
    if (!indexSeeded) removedPreBoot.add(scopeId);
    releaseScope(scopeId);
    if (disabled) return; // degraded: refcount hygiene only — no writes, no sweep (A3)
    dirtyDeletes.add(manifestKey(scopeId));
    dirtySaves.delete(manifestKey(scopeId));
    markIndexDirty();
    scheduleGcSweep();
    scheduleFlush();
  }

  async function hydrateScope(scopeId: string): Promise<number> {
    await ready;
    if (disabled || disposed) return 0;

    const manifest = await readManifestRow(scopeId);
    // Liveness after EVERY await (reviews B3/B4): a dispose() or
    // removeManifest() that landed while we were in the engine must win —
    // hydrating or retaining under a dead scope pins entities forever.
    if (!manifest || disposed || !manifestScopes.has(scopeId)) return 0;

    // Load only what memory lacks; retain everything the scope references.
    const missing = manifest.keys.filter((key) => {
      const separatorIndex = key.indexOf(":");
      return (
        separatorIndex !== -1 &&
        !store.has(key.slice(0, separatorIndex), key.slice(separatorIndex + 1))
      );
    });
    const rows = missing.length > 0 ? await engine.loadMany(missing) : [];
    if (disposed || !manifestScopes.has(scopeId)) return 0;

    let hydrated = 0;
    isHydrating = true;
    try {
      for (const row of rows) {
        if (hydrateRow(row)) hydrated++;
      }
    } finally {
      isHydrating = false;
    }
    for (const key of manifest.keys) retainUnder(scopeId, key);
    return hydrated;
  }

  async function preload(scopeIds?: string[]): Promise<number> {
    await ready;
    if (disabled || disposed) return 0;

    // No args = every scope in the live mirror — seeded from the persisted
    // index at boot in BOTH modes, so it IS the index (review B1).
    const targets = scopeIds ?? [...manifestScopes];
    const counts = await Promise.all(targets.map((s) => hydrateScope(s)));
    return counts.reduce((a, b) => a + b, 0);
  }

  // ── Public handle ──────────────────────────
  function dispose(): void {
    if (disposed) return;
    // Stop new dirt first, then best-effort final flush of everything
    // already acknowledged to memory — an orderly teardown must not
    // silently drop up to a debounce-window of writes. Buffered entries of
    // UNCOMMITTED transactions are deliberately NOT flushed: they were
    // never confirmed, so they die with the session (the app's mutation
    // re-runs or fails visibly — see the durability-window guide).
    unsub();
    settledUnsub?.();
    settledUnsub = null;
    pendingTx.clear();
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (gcTimer) {
      clearTimeout(gcTimer);
      gcTimer = null;
    }
    // Refcounts must not outlive the coordinator that took them.
    // (Deleting the current entry during Map iteration is well-defined.)
    for (const scopeId of scopeRetentions.keys()) releaseScope(scopeId);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("beforeunload", onBeforeUnload);
    }
    const finalFlush = opened && !disabled ? flush() : Promise.resolve();
    disposed = true;
    void finalFlush.catch(() => {}).then(() => engine.close());
  }

  return { ready, durable, flush, setManifest, removeManifest, hydrateScope, preload, dispose };
}
