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

## [2026-07-21] — an exclusion window keyed to a phase flag is a span bug waiting to happen

**Mistake:** the persistence subscriber excluded hydration-origin writes via
a coordinator phase flag (`isHydrating`), and boot held that flag across
every `engine.loadAll()`/`loadMany()` await. The exclusion of ONE write
channel (hydration) thereby became the exclusion of ALL writes for the
duration of engine I/O — an app `set`/`remove` racing boot was applied to
memory, evented, and silently dropped from the durability pipeline
(DAN-630; flagged by DAN-621's self-review, executed here).

**Why it happened:** the flag conflated two different claims — "this write
IS hydration" (a property of the write) with "hydration is HAPPENING" (a
property of time). The temporal claim is only correct while every edit
preserves the exact span; boot's span had quietly widened to cover awaits.
The tell was in the codebase twice over: `hydrateScope` scoped the same
flag tightly around only its synchronous loop, and `hydrateRow` already
stamped every hydration write `origin: "hydration"` through the privileged
`runWith` channel — the exact per-event fact the flag was approximating.

**Fix:** ADR-014 (hydration exclusion by provenance: the subscriber skips
exactly `origin === "hydration"` events; the flag is deleted; debounce/gc
timers defer during boot so the ADR-013 overlay stays authoritative) +
`src/boot-hydration-writes.spec.ts` (8 regression tests, 6 verified
failing pre-fix — the strongest available encoding) + this entry.

**For future agents:** when excluding a write CHANNEL from a pipeline, key
the exclusion to per-event provenance (origin stamps), never to a
coordinator phase flag — any flag held across an `await` excludes
everything that races the await, and the failure is silent by
construction. If a phase flag and a provenance stamp both exist for the
same concept, the flag is the redundant, drift-prone one: delete it.

## [2026-07-21] — a drain before an await hides truth from every observer for the flight

**Mistake:** `flush()` drained the dirty sets into local arrays before
`await engine.writeBatch` — correct for the write path, but the dirty
sets were ALSO the pending-truth overlay that `hydrateRow` and
`readManifestRow` consult. For the batch's whole flight (and, worse,
after an ack that a stale load snapshot straddled), confirmed truth was
invisible: removed entities resurrected into memory, evicted keys paged
back stale, and boot's lifecycle-listener flush walked straight into the
window (DAN-629; flavors executed across the DAN-621/DAN-630 gauntlets).

**Why it happened:** the drain read as a private handoff to the engine
("these are the batch's inputs now"). It wasn't private — the dirty sets
were doing double duty as the readable record of un-durable truth, and
the drain silently ended that duty a full await earlier than the
durability it was standing in for. The tell: ADR-013 had just promoted
the dirty sets from "write queue" to "overlay", and nobody re-audited
who else depended on their lifetime.

**Fix:** ADR-015 (drain is a MOVE into `inflightPuts`/`inflightDeletes`;
clearing is quiescence-gated — batch acked AND boot settled AND no
hydration bracket open) + `src/inflight-overlay.spec.ts` (11 regression
tests, 9 verified failing pre-fix — the strongest available encoding) +
this entry.

**For future agents:** when a queue is both a work buffer AND a truth
overlay, consuming it for one role must not blind the other — drain by
moving entries to a visible in-flight stage, and retire that stage only
at quiescence (acknowledged AND no reader that might predate the ack
still running), never at hand-off. If you find yourself clearing shared
state right before an `await`, list every reader of that state first.
