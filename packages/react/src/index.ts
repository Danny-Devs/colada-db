/**
 * @colada-db/react — React hooks over colada-db's adapter-facing subscription
 * boundary (ADR-008 §3).
 *
 * The boundary is `subscribe` + synchronous snapshot getters, which is exactly
 * the shape `useSyncExternalStore` consumes. These hooks import from the
 * PUBLISHED `colada-db` surface only — never from the internal signal library
 * (that is the whole point of the boundary) and never from core internals.
 *
 * ## Status — PRIVATE scaffold (DAN-1047)
 *
 * ADR-008 §4 sequences React AFTER the boundary is frozen by two real
 * consumers (Vue + vanilla). `packages/sync-demo` is consumer #2 in the
 * making; this package stays `"private": true` until that decision is taken
 * deliberately. Nothing here is on colada-db's public API surface (ADR-022
 * line 2), so nothing here is a compatibility promise yet.
 *
 * All three hooks are implemented. `useEntities` carries the one real
 * decision in this package — snapshot identity — and README §Snapshot
 * identity records which design was taken and why (DAN-1047).
 */
import { useCallback, useSyncExternalStore } from "react";
import type { EntityRecord, StoreBoundary } from "colada-db";

/** One row of `boundary.getEntities(type)` — `id` + the entity's data. */
export interface EntityEntry {
  id: string;
  data: EntityRecord;
}

/**
 * The store's monotonic change counter, as React state.
 *
 * `boundary.getVersion()` ticks on EVERY store event (any type, any key) and
 * never on a no-op write, so this hook re-renders its component on any
 * change and is referentially trivial: the snapshot is a primitive number,
 * so there is no identity problem to solve — React compares snapshots with
 * `Object.is`, and two reads of an unchanged counter are the same number.
 *
 * Use it when a component reads several things off the boundary and wants
 * one subscription rather than one per read. The `sync-demo` panes use it
 * as the TEMPORARY read path until `useEntities` lands.
 */
export function useStoreVersion(boundary: StoreBoundary): number {
  // Memoized per boundary: `useSyncExternalStore` resubscribes whenever the
  // `subscribe` function identity changes, and a fresh closure per render
  // would tear the subscription down and up on every commit.
  const subscribe = useCallback(
    (listener: () => void) => boundary.subscribe(listener),
    [boundary],
  );
  const getVersion = useCallback(() => boundary.getVersion(), [boundary]);
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

/**
 * One entity's data, re-rendering only when THAT entity changes.
 *
 * ## Contract (DAN-1047)
 *
 * - **subscribe:** `boundary.subscribeEntity(entityType, id, listener)` — the
 *   per-key tier, so a change to any other entity does not re-render this
 *   component. Memoize the subscribe function on `[boundary, entityType, id]`;
 *   the unsubscribe it returns MUST be called on unmount and on any change of
 *   those three inputs (`useSyncExternalStore` does this when the memoized
 *   function's identity changes — the test "unsubscribes from
 *   `subscribeEntity` on unmount" pins it).
 * - **getSnapshot:** returns `boundary.getEntity(entityType, id)` —
 *   `EntityRecord | undefined`. `getEntity` reads the store's own record
 *   reference (no copy, no phantom ref on miss), so two reads with no
 *   intervening change return the SAME reference. That satisfies the
 *   invariant below without extra work — verify it rather than assuming it,
 *   because the store's merge-on-`set` semantics mean a `set` that changes
 *   nothing may or may not allocate.
 * - **Invariant (`useSyncExternalStore` law):** `getSnapshot` MUST return a
 *   referentially identical value whenever nothing changed. React calls it
 *   on every render and compares with `Object.is`; a fresh object each call
 *   means "changed" every time → an infinite re-render loop ("The result of
 *   getSnapshot should be cached to avoid an infinite loop").
 * - **getServerSnapshot:** pass the same getter — there is no SSR store here,
 *   and a missing third argument throws under hydration.
 */
export function useEntity(
  boundary: StoreBoundary,
  entityType: string,
  id: string,
): EntityRecord | undefined {
  const subscribe = useCallback(
    (listener: () => void) =>
      boundary.subscribeEntity(entityType, id, listener),
    [boundary, entityType, id],
  );
  const getSnapshot = useCallback(
    () => boundary.getEntity(entityType, id),
    [boundary, entityType, id],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Every entity of one type, re-rendering when any entity of that type
 * changes.
 *
 * ## Contract (DAN-1047)
 *
 * - **subscribe:** `boundary.subscribeType(entityType, listener)` — the
 *   per-type tier. Memoized on `[boundary, entityType]`; the returned
 *   unsubscribe runs on unmount (pinned by the test "unsubscribes from
 *   `subscribeType` on unmount").
 * - **getSnapshot:** returns `ReadonlyArray<EntityEntry>`, the shape of
 *   `boundary.getEntities(entityType)`.
 * - **Invariant (`useSyncExternalStore` law):** `getSnapshot` MUST return a
 *   referentially identical array whenever nothing changed. **This is the
 *   trap:** `boundary.getEntities()` builds a NEW array on every call (it is
 *   `store.getEntriesByType`, a projection over the store, not a stored
 *   value), so returning it directly from `getSnapshot` is the textbook
 *   infinite-loop bug — React sees a different reference each render, treats
 *   the store as changed, re-renders, reads again, sees another new array…
 *
 * ## The decision taken: structural sharing, gated on the version
 *
 * README §Snapshot identity laid out two designs. This is B gated on A:
 *
 * 1. **Version gate (A).** One cache entry per `(boundary, entityType)`,
 *    keyed by `boundary.getVersion()`. While the version is unchanged the
 *    cached array is returned without touching the store — the common case,
 *    every render with no write in between, costs a Map lookup.
 * 2. **Structural diff (B).** When the version HAS moved — for this type or
 *    any other, the counter is store-wide — recompute via `getEntities()` and
 *    diff against the cached snapshot by `id` and by `data` reference. Rows
 *    whose `data` reference is unchanged keep their old `EntityEntry` object,
 *    so `React.memo` children keyed on the entry skip; if every row survived
 *    and the order held, the OLD ARRAY is returned and consumers see no
 *    change at all. A write to a different type therefore costs one O(n)
 *    diff on the next read of this type and never a new reference.
 *
 * The cache is a module-level `WeakMap<StoreBoundary, Map<type, entry>>`, so
 * N components reading the same type share ONE snapshot instead of holding N
 * arrays, and a boundary that is garbage-collected takes its cache with it.
 * "Unchanged" is by `data` reference, which is correct for this store:
 * `set` allocates a new record on change and emits no event on a no-op.
 *
 * - **getServerSnapshot:** same getter as `getSnapshot`.
 */
export function useEntities(boundary: StoreBoundary, entityType: string): ReadonlyArray<EntityEntry> {
  const subscribe = useCallback(
    (listener: () => void) => boundary.subscribeType(entityType, listener),
    [boundary, entityType],
  );
  const getSnapshot = useCallback(() => readEntitiesCached(boundary, entityType), [boundary, entityType]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

interface TypeSnapshot {
  version: number;
  snapshot: ReadonlyArray<EntityEntry>;
}

/** One cache per boundary, one entry per type — shared by every hook instance. */
const typeSnapshots = new WeakMap<StoreBoundary, Map<string, TypeSnapshot>>();

function readEntitiesCached(boundary: StoreBoundary, entityType: string): ReadonlyArray<EntityEntry> {
  let perType = typeSnapshots.get(boundary);
  if (!perType) {
    perType = new Map();
    typeSnapshots.set(boundary, perType);
  }
  const version = boundary.getVersion();
  const cached = perType.get(entityType);
  if (cached && cached.version === version) return cached.snapshot;

  const fresh = boundary.getEntities(entityType);
  const snapshot = cached ? shareRows(cached.snapshot, fresh) : fresh;
  perType.set(entityType, { version, snapshot });
  return snapshot;
}

/**
 * Structural sharing: reuse the previous `EntityEntry` object for every row
 * whose `data` reference is unchanged, and the previous ARRAY when every row
 * survived in the same order. Returns `fresh` (with shared rows spliced in)
 * only when something actually differs.
 */
function shareRows(prev: ReadonlyArray<EntityEntry>, fresh: Array<EntityEntry>): ReadonlyArray<EntityEntry> {
  const prevById = new Map<string, EntityEntry>();
  for (const row of prev) prevById.set(row.id, row);

  let identical = prev.length === fresh.length;
  for (let i = 0; i < fresh.length; i++) {
    const next = fresh[i]!;
    const before = prevById.get(next.id);
    if (before && before.data === next.data) {
      fresh[i] = before;
      if (identical && prev[i] !== before) identical = false;
    } else {
      identical = false;
    }
  }
  return identical ? prev : fresh;
}
