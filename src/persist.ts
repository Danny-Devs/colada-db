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

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

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
}

export interface PersistenceHandle {
  /** Resolves when hydration from the engine is complete. */
  ready: Promise<void>;
  /** Force-flush pending writes to the engine immediately. */
  flush(): Promise<void>;
  /** Unsubscribe from store changes and release the engine. */
  dispose(): void;
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
 * `store.clear()` emits a `remove` per entity, so a full reset clears the
 * durable copies too.
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
  } = options;

  // ── State ──────────────────────────────────
  const dirtySaves = new Map<EntityKey, unknown>(); // key → encoded data
  const dirtyDeletes = new Set<EntityKey>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let opened = false;
  let disabled = false;
  let isHydrating = false;
  let disposed = false;
  let flushing = false;

  // ── Environment guard (SSR etc.) ───────────
  if (!engine.isSupported()) {
    return {
      ready: Promise.resolve(),
      flush: () => Promise.resolve(),
      dispose: () => {},
    };
  }

  // ── Subscribe to store changes ─────────────
  // IMPORTANT: store.subscribe fires synchronously within store.set().
  // The isHydrating guard relies on this — if subscribe were async/batched,
  // hydration would trigger a write-storm (re-persisting loaded entities).
  const unsub = store.subscribe((event) => {
    if (isHydrating || disabled || disposed) return;

    const key = event.key;
    if (event.type === "set" && event.data != null) {
      dirtySaves.set(key, encodeEntityRefs(event.data));
      dirtyDeletes.delete(key);
    } else if (event.type === "remove") {
      // Semantic delete — the entity should cease to exist durably.
      dirtyDeletes.add(key);
      dirtySaves.delete(key);
    } else if (event.type === "evict") {
      // Cache eviction (gc) — the entity leaves the memory projection but
      // the durable row MUST survive so it can re-hydrate next session.
      // Drop any pending save for it (the last flushed value stands), but
      // never translate eviction into a delete (ADR-004).
      dirtySaves.delete(key);
    }
    scheduleFlush();
  });

  // ── Flush logic ────────────────────────────
  function scheduleFlush(): void {
    if (flushTimer || disabled || disposed) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, writeDebounce);
  }

  async function flush(): Promise<void> {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!opened || disabled || disposed || flushing) return;
    if (dirtySaves.size === 0 && dirtyDeletes.size === 0) return;

    flushing = true;
    const puts = Array.from(dirtySaves.entries()).map(([key, value]) => ({ key, value }));
    const deletes = Array.from(dirtyDeletes);
    dirtySaves.clear();
    dirtyDeletes.clear();

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
      // If new writes arrived during the flush, schedule another
      if (dirtySaves.size > 0 || dirtyDeletes.size > 0) {
        scheduleFlush();
      }
    }
  }

  // ── Hydration ──────────────────────────────
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
        const rows = await engine.loadAll();
        for (const row of rows) {
          const key = row.key;
          const separatorIndex = key.indexOf(":");
          if (separatorIndex === -1) continue;

          const entityType = key.slice(0, separatorIndex);
          const id = key.slice(separatorIndex + 1);

          // Fresh-wins: skip entities already in memory (e.g., from a server
          // fetch that completed before the engine finished loading).
          // Existence-based until engines populate row versions (ADR-005).
          if (!store.has(entityType, id)) {
            store.set(entityType, id, decodeEntityRefs(row.data) as EntityRecord);
          }
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

  // ── Public handle ──────────────────────────
  function dispose(): void {
    disposed = true;
    unsub();
    if (flushTimer) clearTimeout(flushTimer);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("beforeunload", onBeforeUnload);
    }
    engine.close();
  }

  return { ready, flush, dispose };
}
