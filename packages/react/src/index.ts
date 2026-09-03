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
 * `useStoreVersion` is complete. `useEntity` / `useEntities` are DOCUMENTED
 * STUBS — the contract is written in their JSDoc, the tests in
 * `index.spec.tsx` are red against them by design, and the body is Danny's
 * to write (see README §Snapshot identity for the decision it forces).
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
  const subscribe = useCallback((listener: () => void) => boundary.subscribe(listener), [boundary]);
  const getVersion = useCallback(() => boundary.getVersion(), [boundary]);
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

/**
 * One entity's data, re-rendering only when THAT entity changes.
 *
 * ## Contract (the body is Danny's — DAN-1047)
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
 *
 * @throws until DAN-1047 lands.
 */
export function useEntity(_boundary: StoreBoundary, entityType: string, id: string): EntityRecord | undefined {
  throw new Error(
    `TODO(Danny): DAN-1047 — write the hook (useEntity(${entityType}, ${id})); see packages/react/README.md §Snapshot identity`,
  );
}

/**
 * Every entity of one type, re-rendering when any entity of that type
 * changes.
 *
 * ## Contract (the body is Danny's — DAN-1047)
 *
 * - **subscribe:** `boundary.subscribeType(entityType, listener)` — the
 *   per-type tier. Memoize on `[boundary, entityType]`; the returned
 *   unsubscribe MUST run on unmount (pinned by the test "unsubscribes from
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
 *   The snapshot therefore has to be CACHED and invalidated only when the
 *   type actually changed. Two candidate designs are laid out in README
 *   §Snapshot identity (a version-keyed memo vs. structural sharing); the
 *   choice is deliberately not made here.
 * - **Do not** "fix" this by reading through `useStoreVersion` and calling
 *   `getEntities()` in render — that works (the demo does it as a stopgap)
 *   but subscribes to the WHOLE store and hands every consumer a fresh
 *   array, which defeats `React.memo` downstream. It is the stopgap, not
 *   the hook.
 * - **getServerSnapshot:** same getter as `getSnapshot`.
 *
 * @throws until DAN-1047 lands.
 */
export function useEntities(_boundary: StoreBoundary, entityType: string): ReadonlyArray<EntityEntry> {
  throw new Error(
    `TODO(Danny): DAN-1047 — write the hook (useEntities(${entityType})); see packages/react/README.md §Snapshot identity`,
  );
}
