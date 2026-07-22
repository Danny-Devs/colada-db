# ADR-014: Hydration Exclusion by Provenance, Not Coordinator Phase

**Status:** Accepted
**Date:** 2026-07-21

## Context

The persistence subscriber must ignore hydration-origin writes — re-persisting
what was just loaded is a write-storm. The mechanism was a coordinator phase
flag: `isHydrating = true` during hydration, and the subscriber early-returned
on ANY event while the flag was up.

The defect was the flag's SPAN, not its existence (DAN-630, flagged as a known
hole in the DAN-621 self-review). Boot raised the flag before its first
`await engine.loadMany(...)` / `await engine.loadAll()` and lowered it in a
`finally` after hydration — so the flag was up across every engine-I/O await.
A legitimate app write (`set`/`remove`) landing during those awaits emitted its
store event synchronously, the subscriber dropped it, and it never entered the
dirty sets: silently non-durable, no error. The window is real — IDB/SQLite
load latency on boot — and apps that write on startup land inside it routinely.
`hydrateScope` already demonstrated the tight scoping (flag only around its
synchronous `hydrateRow` loop), but boot did not follow its sibling; and even
tight scoping remains a *temporal* claim that the next refactor can silently
widen again.

The information needed to make the exclusion exact already exists: `hydrateRow`
stamps its writes `origin: "hydration"` via `store.runWith` (ADR-007 §1), a
privileged channel that cannot be forged through the ordinary write API, and
`origin.spec.ts` pins it.

## Decision

**1. The persistence subscriber excludes exactly the events stamped
`origin: "hydration"` — the phase flag is deleted.** Provenance travels WITH
the event, so the exclusion is correct at every instant by construction: there
is NO temporal window in which an app write is invisible to the durability
pipeline. During boot, confirmed app writes enter the dirty sets immediately,
and the ADR-013 pending-truth overlay then does exactly its job for the rest
of boot: `hydrateRow` skips keys with a pending delete and prefers a pending
save's value over the stale engine row, while fresh-wins (`store.has`) keeps a
mid-boot write from being clobbered in memory.

**2. The debounced auto-flush defers while boot hydration is in flight** (the
timer re-arms instead of flushing; same for the gc-sweep timer). Rule 1 makes
mid-boot dirt possible, and flushing it mid-boot would drain the dirty sets
out from under the overlay while an engine load snapshot is still in flight —
a `remove` flushed mid-boot leaves nothing for `hydrateRow` to skip on, and
the stale snapshot row resurrects into memory. Deferring keeps the overlay
authoritative for every row boot will hydrate; the existing post-boot
re-schedule plus the re-arm guarantee the dirt lands immediately after.
Explicit `flush()` calls (public handle, `dispose()`, `beforeunload`) keep
their current mid-boot semantics — see Consequences.

## Alternatives Considered

- **Tight-scope the flag around the synchronous hydration loops (the
  `hydrateScope` pattern):** behaviorally equivalent today, but it keeps the
  invariant temporal — correct only while every future edit preserves the
  span. This bug WAS that span drifting. Provenance makes the exclusion
  self-describing (the ADR-004 argument for first-class semantics over
  side-channel state, applied to this seam).
- **Buffer-and-replay events arriving during hydration:** a second queue with
  its own ordering and failure semantics, solving a problem provenance
  dissolves outright. More state, no additional correctness.
- **Origin filter WITHOUT the flush deferral:** leaves the timer free to drain
  a mid-boot `remove` from the dirty sets while a load snapshot predating the
  delete is in flight — stale-row resurrection through the overlay's blind
  spot. The deferral closes the timer path; direct `flush()` calls (app code
  or the lifecycle listeners) can still enter the in-flight window — see the
  boundary bullet under Consequences.

## Consequences

- Positive: writes racing boot are durable (or deliberately reconciled by the
  overlay) — never silently dropped. The exclusion set is exact: hydration
  writes and nothing else, at every instant.
- Positive: less state — `isHydrating` and both of its try/finally spans are
  gone; `hydrateScope` needs no flag choreography either.
- Boundary (pre-existing class, ADR-013's in-flight bullet, narrowed here): a
  DIRECT `flush()` during boot still drains the dirty sets while a load may
  be in flight; engine-level read/write ordering then decides whether a stale
  snapshot row hydrates. The deferral removes the debounce/gc-timer entry
  into that window, but "direct" is broader than app code: the module's own
  `visibilitychange`/`beforeunload` lifecycle listeners call `flush()` and are
  automatic entries (a tab hidden during boot walks straight in — gauntlet F1,
  executed). The path stays open because `dispose()` racing boot and unload
  MUST flush acknowledged dirt or it dies with the tab (C2). Tracked with the
  in-flight-overlay follow-up (which also owns the uncommitted-optimistic-
  remove-racing-boot flavor, gauntlet F2).
- Semantics note: a listener that reacts to a hydration event by writing
  *synchronously inside the delivery* inherits the `hydration` origin
  (`runWith` is still on the stack) and is therefore not persisted — identical
  to the old flag behavior, now visible in the event stream instead of hidden
  in coordinator state.
- Trust note: `origin` is attribution within one trust domain (ADR-011
  caveat) — any code holding the store can `runWith` a hydration origin and
  bypass persistence. That was equally true of the flag era (any code could
  race the window); nothing weakens.
