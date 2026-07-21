# ADR-010: Live Matcher-View Lifecycle — Ids, View-Local Retention, Deferred Divergence Guard

**Status:** Accepted
**Date:** 2026-07-20

## Context

DAN-606 ships roadmap 2.2's in-memory tier: `createMatcherView` — live
filtered membership over one entity type, maintained against change
events on the ADR-009 classifier (WatermelonDB two-tier, steal-list
#1). The prerequisite boundary gap (arch review H4 — listeners were
`() => void`) is closed by the additive `subscribeEvents` tier, landed
BEFORE any ADR-008 §3 freeze ratification. Three lifecycle decisions
deserved a record; the packet granted discretion on each.

## Decision

1. **Views expose member IDS, not rows.** `getMembers()` is a readonly
   ids array — same instance while membership is unchanged, one new
   array per membership change (steal-list #2, the LiveStore-corrected
   shape). Row edits ride the per-entity reactivity channel and never
   touch the array. A rows array cannot be `===`-stable under row edits
   without going stale — ids make reference stability structural.
2. **A view is a retaining scope, view-locally.** Members are
   `store.retain()`ed while they are members (released on exit and
   `dispose()`), so gc sweeps can never evict a live result member —
   the DAN-578 primitive, NOT the persisted manifest namespace: views
   are session-scoped, manifests are boot-scoped. A view that should
   survive reboot cold-start is an adapter concern (`setManifest` with
   the view's members remains available). The store behind the boundary
   is discovered via an internal WeakMap (the persist.ts optimistic-
   handle idiom) — the PUBLIC boundary contract gains only
   `subscribeEvents`; foreign boundary implementations degrade to
   correct-but-unpinned views with a dev warning.
3. **`evict` drops membership.** The view tracks the MEMORY PROJECTION
   (ADR-003) — an evicted entity leaves the projection, so the view can
   no longer claim it matches. Retention makes sweep-driven eviction of
   a live member impossible; a direct `store.evict()` wins, honestly.
4. **The two-tier divergence guard runs deferred.** `verifyIntegrity`
   re-scans and compares at the microtask boundary, coalesced per
   burst — mid-drain the delta tier lawfully lags settled state (the
   H5 queue still holds the correcting events), so a synchronous
   compare false-alarms on reentrant-write patterns. On divergence:
   report + SELF-HEAL to scan truth.

## Alternatives Considered

- **Rows-array views (WatermelonDB shape):** familiar, but forces a
  choice between stale rows and identity churn on every member edit.
  Rejected — ids + per-entity refs is strictly better under this
  store's reactivity model.
- **Manifest-namespace retention (`setManifest` per view):** would
  persist view scopes across sessions and couple every view to the
  persistence coordinator (views must work without persistence
  enabled). Rejected as the default; available to adapters.
- **Retention passthrough on the public boundary (`retain`/`release`
  methods):** widens the adapter contract right before its freeze for
  an internal need. Rejected — WeakMap discovery keeps the additive
  surface to exactly one method.
- **Synchronous divergence guard:** simplest, and wrong — false-alarms
  under the store's own documented reentrancy semantics (H5).

## Consequences

- Positive: `===`-stable live queries with zero re-runs for encodable
  filters; displayed results can't be gc'd; the guard makes silent
  tier divergence structurally loud; boundary freeze can proceed with
  the event tier included.
- Negative: members become gc-TRACKED — after exiting membership they
  are evictable at the next sweep even if previously never-retained
  (the DAN-578 residency ratchet, now documented for views too);
  encodable views notify synchronously while opaque views converge at
  the microtask boundary (a timing asymmetry consumers must not depend
  on).
- Risks: the DAN-579 worker tier must seed/refresh view universes under
  partial hydration without breaking the ids-array stability contract;
  watch the `subscribeEvents` fan-out cost if per-event consumers
  multiply (one shared store subscription bounds it today).
