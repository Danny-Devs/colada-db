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
 * `store.clear()` emits a `remove` per entity, so a full reset clears the
 * durable copies too.
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

  // ── Environment guard (SSR etc.) ───────────
  if (!engine.isSupported()) {
    return {
      ready: Promise.resolve(),
      durable: Promise.resolve(false),
      flush: () => Promise.resolve(),
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
      // the durable row MUST survive so it can re-hydrate next session.
      // Drop any pending save for it (the last flushed value stands), but
      // never translate eviction into a delete (ADR-004).
      dirtySaves.delete(key);
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
    if (dirtySaves.size === 0 && dirtyDeletes.size === 0) return;

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
          // Stamped `hydration` (ADR-007 §1): this coordinator OWNS the
          // privileged origin — undo stacks skip these, sync must not echo
          // them, history attributes them. (Persistence's own subscriber
          // ignores them via isHydrating regardless.)
          if (!store.has(entityType, id)) {
            store.runWith({ origin: "hydration" }, () =>
              store.set(entityType, id, decodeEntityRefs(row.data) as EntityRecord),
            );
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

  return { ready, durable, flush, dispose };
}
