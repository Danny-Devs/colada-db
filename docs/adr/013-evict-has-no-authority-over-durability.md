# ADR-013: Eviction Has No Authority Over the Durability Pipeline

**Status:** Accepted
**Date:** 2026-07-21
**Amends:** ADR-004 (one subscriber-rule clause: "drops any pending save;
last flushed value stands" — the evict/remove split itself is untouched)

## Context

ADR-004's subscriber rule for persistence read: *"persistence keeps rows on
evict (drops any pending save; last flushed value stands)."* The keep-rows
half is the invariant that matters (cache trimming must never destroy
durable data). The drop-pending-save half was a write-economy clause, and
it carried a hidden soundness assumption: **dropping a pending save is
valid only while the durable row still holds some prior confirmed value of
a surviving entity** — stale-but-legitimate, so re-hydrating it is a
bounded-staleness outcome, never a wrong-lineage one.

An intervening `remove` breaks that assumption. The DAN-620 land gauntlet
executed the repro (verified pre-existing at `699a951`, no `clear()`
required):

1. Durable row holds `v1` (flushed).
2. `remove()` — semantic delete; a dirty-delete is queued. The durable
   row's standing is now INVALID: it holds a value from a dead lineage.
3. `set(v2)` — the entity is re-created; the dirty-delete is correctly
   cancelled (the save supersedes it) and a save of `v2` is queued. That
   save is now the ONLY thing scheduled to correct the durable row.
4. `evict()` before the debounced flush — the old rule cancels the
   pending save. Nothing dirty remains. The flush is a no-op.
5. Next boot re-hydrates `v1`: a value the store semantically deleted
   resurrects, even though the last store truth was `v2`.

The same shape reaches disk through the transaction path (`tx.remove` →
`tx.set` nets to a buffered put; commit graduates it into the dirty sets;
evict cancelled it) and through `clear()` (ADR-012: a reentrant re-write
during the drain survives in memory — but its save could be cancelled by
a subsequent evict, resurrecting the pre-clear row).

## Decision

**Eviction is a memory-projection event with zero authority over the
durability pipeline.** Two rules:

1. **`evict` never mutates the dirty sets.** A pending confirmed write
   (save or delete) always flushes; nothing an evict does can cancel,
   reorder, or suppress it. The persistence subscriber's evict branch is
   a no-op. Consequence: the durable pipeline is *monotone in confirmed
   store truth* — a dirty entry can only be displaced by a NEWER
   confirmed event for the same key (a later `set` or `remove`), never
   by a cache-management event.
2. **Engine reads honor the pending-truth overlay** (the review-B4
   principle `readManifestRow` already applies to manifest rows,
   generalized to entity rows): confirmed-but-unflushed state outranks
   the engine's flushed rows. `hydrateRow` skips a key with a pending
   dirty-delete (hydrating it would resurrect a semantically-deleted
   entity into memory) and hydrates the pending save's value in
   preference to the engine's stale row (the evict→`hydrateScope`
   remount inside the debounce window otherwise pages the pre-remove
   value back into memory while the fresh value is still in flight to
   disk).

ADR-004's core split is unchanged: `evict` still never deletes a durable
row, and evicted entities still re-hydrate next session. What changes is
the freshness of what re-hydrates: previously "the last flushed value",
now "the last confirmed value" — strictly more truthful.

## Alternatives Considered

- **Taint-gated cancel (the "untrusted row" set):** track keys with an
  unflushed remove since the last flush; evict keeps the pending save
  only for tainted keys, preserving the drop-economy elsewhere. Rejected:
  it needs a new bookkeeping set with its own lifecycle (taint on remove,
  taint on commit-graduated deletes — which requires per-transaction
  removed-key tracking, since a remove→set buffer nets to a put and the
  taint information is otherwise lost — untaint per-key at flush
  materialization), all to preserve an economy that is nearly dead code:
  the only in-repo gc trigger (`scheduleGcSweep`) flushes FIRST (review
  B2), so gc-path evicts never see a pending save — the drop only ever
  fired on manual evicts, exactly where it was dangerous. And it leaves
  the plain `set→set(v2)→evict` staleness in place (durable row reverts
  to `v1` on reboot despite `v2` being confirmed).
- **Delete-carry-through:** keep the dirty-delete queued when a `set`
  follows a `remove`, so the flush deletes then re-puts. Rejected on a
  concrete engine fact: `writeBatch(puts, deletes)` has no same-key
  ordering contract, and all three engines apply puts THEN deletes — a
  same-key put+delete in one batch means the delete wins and destroys
  the re-set value. Fixing that means changing the engine protocol
  (DO-NOT-TOUCH here) or splitting batches (a new partial-failure
  window).
- **Dirty-generation counter:** stamp each dirty entry with a generation;
  evict cancels only entries whose generation predates the last remove.
  Rejected: heavier machinery for exactly the taint-set's semantics.

## Consequences

- Positive: the F3 resurrection class is dead by construction — for the
  plain, transactional, and `clear()`-flavored interleavings at once,
  with zero new state (the fix is deletion of authority, not addition of
  bookkeeping).
- Positive: durable rows converge to the *newest* confirmed value even
  under `set→evict` with no remove — the old rule silently discarded up
  to a debounce window of confirmed updates on every manual evict.
- Positive: hydration can no longer resurrect a row the current session
  already removed (pre-boot `remove`, or remount `hydrateScope` racing
  the debounce window). Boundary: the overlay covers the *dirty* window
  only — once `flush()` drains the dirty sets, an in-flight
  `engine.writeBatch` is invisible to the overlay, so a `hydrateScope`
  racing that in-flight window can still page in the pre-batch engine
  row (pre-existing class, narrowed by this ADR — CLOSED by ADR-015:
  the drain is now a move into a quiescence-gated in-flight overlay,
  DAN-629).
- Negative: an evicted entity with a pending save now costs one row in
  the next flush batch instead of zero writes. The gc path is unaffected
  (sweep pre-flushes, so its evicts see clean keys); only manual
  evict-with-pending-dirt pays, and it pays for correctness.
- Note: uncommitted transaction buffers (`pendingTx`) are deliberately
  NOT part of the pending-truth overlay — they are unconfirmed and must
  neither flush nor hydrate (`docs/design/optimistic-durability.md`).
  [Amended by ADR-015: still never flushes, never hydrates — but an
  uncommitted optimistic DELETE now masks hydration of its key, so a
  stale load snapshot cannot un-delete an optimistic projection
  mid-transaction (DAN-630 gauntlet F2).]
