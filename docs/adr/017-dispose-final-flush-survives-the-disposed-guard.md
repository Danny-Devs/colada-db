# ADR-017: The Dispose Final Flush Survives Its Own `disposed` Guard

**Status:** Accepted
**Date:** 2026-07-22
**Amends:** ADR-014 (the "dispose() racing boot and unload MUST flush
acknowledged dirt" boundary) — the flush that boundary depends on was itself
lossy when it raced an in-flight batch.

## Context

`dispose()` performs a best-effort final flush so an orderly teardown never
drops a debounce-window of acknowledged writes (the C2 durability contract
ADR-014 leans on). It did this as `finalFlush = flush()` then, on the next
line, `disposed = true`. One flag, `disposed`, then defeated the final flush
under a specific interleaving (DAN-647, MEDIUM — verified pre-existing at
`343666e` with an executed gated-`writeBatch` repro):

1. A debounced flush drains X into its batch and parks in
   `await engine.writeBatch` (`flushing === true`).
2. `set(Y)` (or `remove(Y)`) lands — Y enters `dirtySaves`/`dirtyDeletes`.
3. `dispose()` → `finalFlush = flush()`. That flush sees `flushing`, so it
   `await inflightFlush; return flush()`. Then `disposed = true`.
4. The gate releases. The re-entrant `return flush()` now hits
   `if (!opened || disabled || disposed) return` — `disposed` is true → it
   bails BEFORE draining Y.
5. The in-flight batch's tail recovery `if (dirtySaves.size>0)
   scheduleFlush()` is defeated by the SAME flag (`scheduleFlush`
   short-circuits on `disposed`).

Both recovery paths killed by one flag → Y is silently non-durable, no error.
Only real async engines expose it: a synchronous engine resolves `writeBatch`
before `dispose()` runs, so `flushing` is already false. This is the same
family as ADR-012–016 — "the world held still across an async gap": here the
gap is the in-flight batch, and the state that shifted is the `disposed` flag
flipping between the final flush's synchronous entry and its post-`await`
continuation.

## Decision

**`disposed` is set synchronously in `dispose()` (unchanged), and the
final flush is given a single, unforgeable exemption from the `disposed`
guard so it can complete its own re-entrancy.** `flush` takes an internal
`final` parameter (default `false`):

- The guard becomes `if (!opened || disabled || (disposed && !final)) return`.
- The re-entrant call propagates it: `return flush(final)`.
- `dispose()` calls `flush(true)`; every other caller — the public handle,
  the debounce timer, the gc-sweep flush-first step, and the
  `visibilitychange`/`beforeunload` lifecycle listeners — calls `flush()`
  (`final = false`).
- The public handle exposes a wrapper `flush: () => flush()`, so `final`
  is **unreachable** from outside the module.

The final flush therefore drains everything confirmed, including the residue
that entered the dirty sets after the prior drain parked; a plain `flush()`
still no-ops once `disposed`, so no post-dispose external write can start a
batch. The `disposed`-after-`flush()` call order is retained (the exemption,
not the ordering, is what makes it correct), so every boot/hydration
post-`await` `disposed` re-check keeps firing exactly as before.

## Alternatives Considered

- **Defer `disposed = true` until `finalFlush` resolves.** Stops new dirt
  via `unsub()` (already called), but `disposed` guards far more than the
  subscriber: boot's and `hydrateScope`'s post-`await` `disposed` re-checks
  are what prevent hydration/retention after teardown (refcounts outliving
  the coordinator). Leaving `disposed` false across the whole in-flight
  window reopens exactly those guards for a `dispose()` racing boot.
  Rejected — it trades a write-loss bug for a resurrection/retention-leak
  bug in the harder-to-test boot seam.
- **A module-level `finalizing` flag instead of a parameter.** Behaviorally
  equivalent, but it must be un-set at some quiescent point or a
  post-dispose external `flush()` reading the flag would bypass the guard —
  and "when is the re-entrant final chain done" is exactly the fuzzy
  lifetime the parameter sidesteps by traveling with the call. Rejected as
  strictly more state for less safety.
- **Make the in-flight batch's tail `scheduleFlush()` disposed-immune
  instead.** Recovers Y via the timer, but re-introduces a post-dispose
  `setTimeout` (the thing `dispose()` deliberately clears) and still needs
  the re-entrant `flush()` to not bail. Two edits where one guard exemption
  suffices, and it leaves a live timer past teardown. Rejected.

## Consequences

- Positive: `dispose()` racing an in-flight flush is durability-complete for
  both `set` and `remove` residue — the C2/ADR-014 "flush acknowledged dirt
  at teardown" guarantee now actually holds under the in-flight interleaving
  it silently failed on. Dead by construction: the residue rides the final
  flush's own re-entrant re-flush.
- Positive: the fix is a guard exemption plus flag-threading — no new state,
  no change to the drain/overlay machinery (ADR-015), no boot-path edit.
  `disposed` still stops the subscriber, the timers, and every hydration the
  instant it flips.
- Neutral: the final flush is single-write per key (the drain is a move; the
  dirty and in-flight sets are disjoint per key), so no key is written
  twice — pinned by `dispose-flush.spec.ts`.
- Boundary (unchanged, fail-closed): if the in-flight batch fails
  (`writeBatch` throws → `disabled = true`), the re-entrant `flush(true)`
  bails on `disabled` and Y stays unflushed — but the engine is dead, so
  memory was already the only copy; this is the existing degraded-mode
  semantics, not a new loss.
