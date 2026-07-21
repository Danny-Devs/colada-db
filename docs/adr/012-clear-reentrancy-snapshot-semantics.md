# ADR-012: `clear()` Removes Exactly Its Snapshot — Reentrant Writes Survive

**Status:** Accepted
**Date:** 2026-07-21

## Context

`clear()` (ADR-004: a semantic `remove` per entity — logout/reset) drains
per-id remove events, and the H5 drain design *invites* listeners to write
during delivery (transaction replay, history, indexes are exactly such
listeners). The DAN-606 land gauntlet executed the collision: a listener
reacting to a drain `remove` by re-writing an entity had its write applied
and evented — then silently erased by the trailing `typeMap.clear()`, with
**no event for the erasure**. Every event consumer (live views, history,
persistence dirty-sets) permanently diverged from store truth.
`refCounts.clear()` compounded it: retention bookkeeping wiped wholesale,
including pins re-established during the drain AND pins on durable-but-cold
keys that `persist.ts`'s manifest coordinator documents as surviving a
`clear()` ("the coordinator's retention bookkeeping is not reset").

The fork: what does a reentrant write during `clear()` MEAN? (DAN-620,
spec-then-fix.)

## Decision

**A reentrant write during `clear()` survives. `clear()` removes exactly
its snapshot** — the set of `(entityType, id)` map entries present at the
moment `clear()` was called — nothing more:

1. **Entry snapshot.** All `(type, id)` pairs are snapshotted atomically at
   `clear()` entry, across ALL types (the old code snapshotted each type
   lazily when it reached it, so a reentrant write to a later type was
   drained while one to an earlier type was wiped — two behaviors for one
   pattern). Each snapshotted pair is removed via the ordinary
   `removeInternal` path: per-id `remove` event, live-ref invalidation,
   version bump. There is no trailing bulk wipe of any kind.
2. **Writes during the drain are ordinary writes.** They apply, they emit,
   they persist — whether they target a snapshotted id (re-add after its
   remove), a novel id, or a not-yet-drained snapshotted id (which is then
   removed when its snapshot turn comes, with the reentrant value as
   `previousData` — it was present at `clear()` time, so it is cleared,
   honestly).
3. **Retention cleanup is keyed to the snapshot.** Each snapshotted id's
   `refCounts` entry is deleted immediately **before** its remove event is
   emitted — the snapshotted pin dies with the snapshotted entity, and a
   `retain()` re-established by a listener during (or after) that delivery
   creates a fresh entry that survives. Pins on keys with no map entry
   (manifest-coordinator pins on durable-but-cold rows) are untouched.
   This is the same delete-entry-then-emit per-item pattern `gc()` already
   uses.

Post-`clear()` invariant (the DAN-620 goal): store state, the event
stream, and refcount bookkeeping agree under any reentrant-write
interleaving — replaying the emitted stream onto a fresh store reproduces
identical state.

## Alternatives Considered

- **Refuse reentrant writes loudly (throw during the drain):** honest, but
  it breaks the H5 contract that listeners may write during delivery — a
  listener cannot know whether the `remove` it is reacting to came from
  `clear()` or a plain `remove()`, so legal reactive patterns would throw
  nondeterministically depending on who is upstack. Converts a
  data-integrity bug into a control-flow landmine.
- **Keep the bulk wipe but emit synthetic erasure events for it:** makes
  the stream honest but the semantics absurd — the store would knowingly
  destroy writes it just applied and evented, on no principled basis (the
  reentrant writes are causally AFTER `clear()` began; "clear wins" is not
  a real ordering).
- **Refcounts: decrement by snapshot-time count instead of keyed
  deletion:** double-counts under the common interleaving where a
  well-behaved scope (e.g., a matcher view) also releases its own pin on
  seeing the remove event — the trailing decrement then destroys a pin
  re-established mid-drain. Keyed deletion before emission has no such
  race; `release()` on a deleted key is already a guarded no-op.

## Consequences

- Positive: event-stream honesty (NO state transition without its event —
  the `event-ordering.spec.ts` replayability invariant) holds through
  `clear()` by construction; no new event types, no listener-visible mode.
- Positive: phantom refs minted by `get()` during the drain survive — the
  subscribe-before-data contract is no longer silently severed by a
  concurrent `clear()`. Nested `clear()` from inside a listener is safe
  (inner snapshot removes; outer snapshot's already-removed ids take the
  memory-absent tombstone path, ADR/C1 idempotent-by-emission).
- Behavior shift: `clear()` no longer guarantees an empty store on return;
  it guarantees *everything present at call time was removed and evented*.
  With no writing listeners (the overwhelmingly common case) the store is
  empty, exactly as before.
- Behavior shift: pins on memory-absent keys survive `clear()` — aligned
  with `persist.ts`'s documented coordinator posture. Full erasure
  semantics (logout wiping cold rows too) remain DAN-602's scope.
