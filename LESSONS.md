# LESSONS.md — colada-db

Append-only failure log. Every recurring mistake gets encoded so the next
agent never makes it again. Strongest-encoding rule: lint > test > skill >
LESSONS entry (the entry then explains *why* the stronger encoding exists).

## [2026-07-21] — snapshot-then-bulk-clear is never reentrant-safe when listeners can write

**Mistake:** `clear()` drained per-entity `remove` events (listeners run
synchronously inside each emission — the H5 contract *invites* them to
write) and then ran a trailing `typeMap.clear()` + `refCounts.clear()`.
Any write or `retain()` a listener made during the drain was applied,
evented... and silently erased by the bulk wipe, with no event for the
erasure. Every event consumer (live views, history, persistence
dirty-sets) permanently diverged from store truth (DAN-620; executed
repro in the DAN-606 land gauntlet).

**Why it happened:** the bulk wipe read as a harmless belt-and-suspenders
finish ("the loop already removed everything"). It wasn't redundant — it
was a second, *unevented* mutation path racing everything the listeners
did. The tell was already in the codebase: `gc()` handles the identical
problem correctly with per-item `refCounts.delete(key)` **before** each
evict emission, so drain-time retains survive. `clear()` just didn't
follow its own sibling's pattern.

**Fix:** ADR-012 (semantics: clear() removes exactly its entry snapshot;
reentrant writes survive) + `src/clear-reentrancy.spec.ts` (10 regression
tests, 7 verified failing pre-fix — the strongest available encoding) +
this entry.

**For future agents:** in any drain-that-delivers-events, every mutation
must go through the evented per-item path — a trailing bulk `.clear()`
(or any unevented cleanup) after a listener-visible loop is a silent
divergence bug by construction; snapshot what you intend to destroy at
entry and destroy exactly that, item by item.

## [2026-07-21] — a cache-layer event must never cancel a truth-layer correction

**Mistake:** the persistence subscriber's `evict` branch dropped any
pending save ("the last flushed value stands", ADR-004). After
remove→set within one debounce window, that pending save was the ONLY
thing correcting a durable row the remove had already invalidated —
cancelling it resurrected the pre-remove value on next boot (DAN-621;
found by the DAN-620 land gauntlet's adjacent-hole sweep).

**Why it happened:** the drop clause read as a harmless write-economy
("we'd only re-write what's already durable"). It carried a hidden
soundness assumption nobody wrote down: dropping a queued write is valid
only while the flushed state it falls back to is a *prior confirmed value
of a surviving entity*. An intervening `remove` breaks the lineage — the
fallback row is then dead state, and the queued write is a correction,
not a redundancy. Cancellation-as-optimization in a write-behind pipeline
is only safe when the cancelled write is provably redundant with flushed
truth under EVERY event interleaving, not just the common one.

**Fix:** ADR-013 (eviction has no authority over the durability pipeline
— evict never mutates the dirty sets; hydration honors the pending-truth
overlay) + `src/evict-resurrection.spec.ts` (9 regression tests, 6
verified failing pre-fix — the strongest available encoding) + this
entry.

**For future agents:** memory-projection events (evict, gc) may never
cancel, reorder, or suppress queued confirmed writes — the durability
pipeline must stay monotone in confirmed store truth; if an optimization
drops a queued write, prove the fallback state is a surviving lineage
first, and encode that proof as a test.
