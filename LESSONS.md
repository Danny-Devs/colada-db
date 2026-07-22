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
