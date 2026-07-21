/**
 * The adapter-facing subscription boundary (ADR-008 §3).
 *
 * Framework adapters consume the store through THIS contract — plain
 * callbacks + synchronous snapshot reads, the `useSyncExternalStore`-class
 * shape every framework natively supports (React's hook, Svelte's store
 * contract, Solid's `from()`). Adapters never import the internal signal
 * library, so the core's reactivity substrate can be swapped (e.g., to
 * TC39 Signals) without touching any adapter.
 *
 * The Vue adapter is the deliberate exception: it MAY bypass this boundary
 * and consume the store's refs directly (its privileged fast path).
 *
 * Snapshot semantics: `getVersion()` is a monotonic tick that advances on
 * every store event. External-store integrations use the version as the
 * snapshot value and re-read entities on change. No-op writes emit no
 * event and therefore do not tick — referential stability is preserved
 * end to end.
 */
import type { EntityEvent, EntityKey, EntityRecord, EntityStore } from "./types";

export interface StoreBoundary {
  /** Notify on ANY store change. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Notify when one entity changes (set / remove / evict). */
  subscribeEntity(entityType: string, id: string, listener: () => void): () => void;
  /** Notify when any entity of a type changes. */
  subscribeType(entityType: string, listener: () => void): () => void;
  /**
   * The event-carrying tier (arch review H4; added 2026-07-20, BEFORE
   * any ADR-008 §3 freeze ratification — the roadmap 2.2 prerequisite).
   *
   * Unlike the three void tiers above, listeners receive the full
   * {@link EntityEvent} payload (`type`/`data`/`previousData`/`origin`/
   * `transactionId`), which is what change-set-driven consumers — live
   * matcher views, history, cross-tab buses — need: a void callback
   * would force them to re-diff full snapshots on every tick.
   *
   * Delivery order within one store event: event-carrying listeners run
   * FIRST, then the void tiers — so derived-state maintainers (views)
   * have already settled by the time snapshot re-readers fire. Same
   * per-listener error isolation as every other tier, PLUS payload
   * isolation: each listener receives a per-emission shallow copy, so a
   * consumer that mutates its event cannot poison later listeners.
   *
   * ⚠️ Contract (land-review 2026-07-20): `data`/`previousData` are LIVE
   * store references, not copies — treat them as read-only; mutating
   * them rewrites store state WITHOUT an event and desynchronizes every
   * consumer. Listeners subscribed during a delivery may receive the
   * in-flight event (Set iteration semantics). Dispose consumers built
   * on this tier (e.g. matcher views) BEFORE disposing the boundary —
   * a disposed boundary leaves late subscribers frozen, not torn down.
   */
  subscribeEvents(listener: (event: EntityEvent) => void): () => void;
  /**
   * Monotonic change counter — the snapshot value for
   * `useSyncExternalStore`-style integrations.
   */
  getVersion(): number;
  /**
   * Non-reactive snapshot read of one entity. Never creates reactive
   * subscriptions or phantom refs on miss.
   */
  getEntity(entityType: string, id: string): EntityRecord | undefined;
  /** Non-reactive snapshot of all entities of a type (id + data pairs). */
  getEntities(entityType: string): Array<{ id: string; data: EntityRecord }>;
  /** Tear down the boundary's own store subscription. */
  dispose(): void;
}

/**
 * Create a subscription boundary over a store.
 *
 * One underlying store subscription fans out to three listener tiers
 * (global / per-type / per-key). Listener errors are isolated per
 * listener so one broken consumer cannot starve the others.
 */
export function createStoreBoundary(store: EntityStore): StoreBoundary {
  let version = 0;
  const globalListeners = new Set<() => void>();
  const typeListeners = new Map<string, Set<() => void>>();
  const keyListeners = new Map<EntityKey, Set<() => void>>();
  const eventListeners = new Set<(event: EntityEvent) => void>();

  const safeCall = (fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      // A consumer's listener must never break other consumers.
      console.error("[colada-db] boundary listener threw:", err);
    }
  };

  const unsubscribeStore = store.subscribe((event: EntityEvent) => {
    version++;
    // Event-carrying tier first: derived-state maintainers (live views)
    // settle before the void tiers' snapshot re-readers run. Each
    // listener gets a per-emission shallow copy (payload isolation —
    // one mutating consumer must not poison the rest); `data` itself
    // stays a live reference per the subscribeEvents contract.
    for (const fn of eventListeners) safeCall(() => fn({ ...event }));
    for (const fn of globalListeners) safeCall(fn);
    const forType = typeListeners.get(event.entityType);
    if (forType) for (const fn of forType) safeCall(fn);
    const forKey = keyListeners.get(event.key);
    if (forKey) for (const fn of forKey) safeCall(fn);
  });

  const addTo = <K>(map: Map<K, Set<() => void>>, mapKey: K, listener: () => void): (() => void) => {
    let set = map.get(mapKey);
    if (!set) {
      set = new Set();
      map.set(mapKey, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) map.delete(mapKey);
    };
  };

  const boundary: StoreBoundary = {
    subscribe(listener) {
      globalListeners.add(listener);
      return () => globalListeners.delete(listener);
    },
    subscribeEvents(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    subscribeEntity(entityType, id, listener) {
      return addTo(keyListeners, `${entityType}:${id}` as EntityKey, listener);
    },
    subscribeType(entityType, listener) {
      return addTo(typeListeners, entityType, listener);
    },
    getVersion() {
      return version;
    },
    getEntity(entityType, id) {
      // has() guard first: get() on a miss would mint a phantom ref.
      if (!store.has(entityType, id)) return undefined;
      return store.get(entityType, id).value;
    },
    getEntities(entityType) {
      return store.getEntriesByType(entityType);
    },
    dispose() {
      unsubscribeStore();
      globalListeners.clear();
      typeListeners.clear();
      keyListeners.clear();
      eventListeners.clear();
    },
  };
  boundaryStores.set(boundary, store);
  return boundary;
}

// ─────────────────────────────────────────────
// Internal store discovery (matcher views)
// ─────────────────────────────────────────────

/**
 * boundary → store, so first-party core modules built ON the boundary
 * (live matcher views) can reach store-level primitives the public
 * adapter contract deliberately omits (`retain`/`release`/`gc`). The
 * WeakMap-discovery idiom persist.ts already uses for the optimistic
 * handle — no new public boundary surface.
 */
const boundaryStores = new WeakMap<StoreBoundary, EntityStore>();

/**
 * Resolve the store behind a boundary created by {@link createStoreBoundary}.
 * Returns `undefined` for foreign boundary implementations (they were
 * never registered) — callers must degrade gracefully.
 * @internal
 */
export function resolveBoundaryStore(boundary: StoreBoundary): EntityStore | undefined {
  return boundaryStores.get(boundary);
}
