# ADR-004: Evict (Memory-Only) vs Remove (Semantic Delete)

**Status:** Accepted
**Date:** 2026-07-12

## Context

`EntityEvent.type` was `"set" | "remove"`. `gc()` trimmed the cache via `store.remove()`, and the persistence layer translated every `remove` into a durable delete. Locally that merely meant "GC also clears IndexedDB." Under any replication layer it becomes catastrophic: one device trimming its cache emits deletes that replicate as tombstones fleet-wide. Compounding it, `hydrate()` restores entities without `retain()`, so persisted entities were GC-immune — the durable store could only grow, and the only trim lever (GC) destroyed data.

## Decision

Split the semantics at the event level:

- **`evict`** — entity leaves the *memory projection only* (GC, cache trimming). Persistence keeps the durable row; sync layers must ignore it. Evicted entities re-hydrate next session.
- **`remove`** — *semantic delete*: the entity should cease to exist. Persistence deletes the row; sync layers replicate the deletion.

`gc()` evicts. `deleteEntity()` / explicit `remove()` / `clear()` delete. `clear()` now emits a `remove` per entity (logout/reset means "wipe my data," including durable copies — previously it silently bypassed all subscribers, leaving indexes, denorm caches, and IDB stale).

Subscriber rules: persistence keeps rows on evict (drops any pending save; last flushed value stands); `onEntityRemoved` fires only on `remove` (an eviction is not an app-level deletion); indexes drop entries on both (they mirror the memory projection); devtools labels evictions distinctly.

## Alternatives Considered

- **Keep one event, let persistence ignore GC-origin removes via a flag:** provenance flags on events leak intent through layers and every subscriber must know about GC; a first-class event type makes the semantics self-describing.
- **Never GC persisted entities:** unbounded durable growth with no trim lever at all.

## Consequences

- Positive: cache management can never be misread as data deletion by durability/sync layers; the invariant is structural, not conventional.
- Negative: the durable store still grows until a TTL/LRU policy exists on the durability layer itself (Phase 4 work — an engine-side `last_touched` column makes this trivial in SQLite).
- Breaking (pre-1.0): external EntityStore implementations must add `evict()`; subscribers pattern-matching on event type must handle `"evict"`.
