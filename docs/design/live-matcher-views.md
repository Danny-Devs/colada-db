# Live matcher views (DAN-606, Stage 2d-2)

> Companion to ADR-009 (the matcher AST), ADR-010 (view lifecycle +
> retention decisions), and `src/matcher-view.ts`. Written BEFORE
> implementation (the DAN-578/0.3 spec-first pattern) — the test list
> below defines done.

## What this is

`createMatcherView(boundary, entityType, filter)` returns a live,
reference-stable **membership view**: the set of entity ids of one type
whose entities currently satisfy `filter`, maintained against entity
change events. This is the WatermelonDB two-tier observation design
(steal-list #1) running on the DAN-605 classifier:

- **Encodable tier** — `classifyFilter` validated the filter into a
  canonical AST. Membership is maintained **purely from event
  payloads**: for each `set` event, matched-before × matches-now →
  noop / add / remove (the Zero-IVM 80/20 lesson — single-entity
  deltas, no operator-pipeline IVM). Zero projection re-scans after the
  initial seed.
- **Opaque tier** — the filter is a JS closure (or anything the
  fail-closed classifier refuses). Correct but slower: each relevant
  event schedules a full projection re-scan, coalesced per microtask
  (a synchronous burst of N writes costs one re-scan).

## The honest scope note (memory projection)

The view's universe is the **memory projection** — exactly the same
boundary as `getByType()` / `getEntities()` (ADR-003). Durable-but-cold
rows (manifest mode, DAN-578) are invisible to a view until they
hydrate. Worker-seeded result universes under partial hydration are
DAN-579's scope, not this chip's.

Consequences, deliberately embraced:

- `remove` events drop membership (the entity semantically ceased to
  exist).
- `evict` events ALSO drop membership — the entity left the projection,
  so the view can no longer claim to know it matches. Retention (below)
  makes sweep-driven eviction of a live member impossible; a **direct**
  `store.evict()` call still wins (evict is an explicit memory
  operation, and the view honestly tracks the projection).

## Membership, not rows

`getMembers()` exposes a readonly array of entity **ids** (steal-list
#2, the LiveStore-corrected shape): membership changes mint exactly one
new array; row edits that don't change membership ride the per-entity
reactivity channel and do NOT touch the array — same instance, `===`
stable. Order: seed-scan order, then adds append; removals splice
without reordering. No sort vocabulary exists in the matcher (ADR-009),
so no sort here.

## Retention (a view = a retaining scope)

Every member is `store.retain()`ed by the view while it is a member —
the DAN-578 primitive, view-locally (NOT the persisted manifest
namespace: views are session-scoped, manifests are boot-scoped —
ADR-010). So `gc()` sweeps can never evict a live result member
mid-session (audit blocker #5, memory-tier half). Released on
membership exit and on `dispose()`. Corollary (same as query/scope
retention): a member entity becomes gc-*tracked* — after it exits
membership (release to refcount 0) it is evictable at the next sweep,
even if it was previously gc-immune (never-retained). That is the
DAN-578 residency ratchet: displayed ≠ immortal.

The view resolves the underlying store from the boundary via an
internal WeakMap (`boundary → store`, the persist.ts
`createOptimisticUpdates` discovery idiom) — the PUBLIC boundary
contract gains only `subscribeEvents`. A foreign (hand-rolled)
`StoreBoundary` is not in the map: the view still works, without
pinning (dev-mode warning; documented).

## The event-carrying boundary tier (H4)

`StoreBoundary.subscribeEvents(listener: (event: EntityEvent) => void)`
— fanned from the SAME single store subscription as the three void
tiers, same per-listener error isolation. Additive; lands BEFORE any
ADR-008 §3 freeze ratification (the roadmap 2.2 prerequisite).

## Two-tier divergence guard

An encodable-tier bug must never silently diverge from re-run truth
(HIGH blast radius: wrong live results). Dev-mode invariant check:
`createMatcherView(..., { verifyIntegrity: true })` re-scans, compares
membership, and on divergence reports via `onDivergence` (default
`console.error`) **and self-heals** to scan truth. The check runs at
the **microtask boundary**, coalesced per burst — deferred past the
synchronous drain, because mid-drain the delta tier lawfully lags
settled state (queued events still carry the correction) and a
synchronous compare would false-alarm on reentrant-write patterns
(found in self-review, rework loop 1). Off by default (it costs a scan
per burst — exactly what the encodable tier exists to avoid); on in
this repo's tests.

## Timing semantics

- Encodable views update **synchronously** with the event (delta
  maintenance is O(1) per event).
- Opaque views converge at the **microtask boundary** (coalesced
  re-scan).
- Views created inside a store listener mid-drain may observe
  transiently stale intermediate events (the store's H5 drain queue
  delivers queued events to late subscribers); membership converges by
  the end of the synchronous drain because delta maintenance is
  idempotent against settled state. Creating views inside store
  listeners is legal but discouraged.

## Failure posture

- A filter that is neither encodable nor callable →
  `MatcherViewError` (`unusable-filter`) at creation, fail-visible —
  a malformed AST is a bug, not a fallback (ADR-009 refusal-is-loud).
- An opaque predicate that throws during a scan: per-entity catch,
  `console.error`, entity treated as non-matching (the boundary's
  error-isolation posture; predicates must be total).
- View subscriber errors are isolated per listener (boundary idiom).

## Done-defining test list (`matcher-view.spec.ts` + `boundary.spec.ts` additions)

Boundary event tier:

1. `subscribeEvents` delivers full payloads (`type`/`entityType`/`id`/
   `key`/`data`/`previousData`) for set / remove / evict.
2. Events pass through `origin`/`transactionId` stamped via `runWith`.
3. A throwing event listener starves neither other event listeners nor
   the void tiers; unsubscribe stops delivery; `dispose()` clears it.

Classification & seed:

4. AST filter (`M.eq` builder and plain JSON) → `tier: "encodable"`,
   seeded from the current projection.
5. Closure filter → `tier: "opaque"`, seeded correctly.
6. Malformed non-callable filter → throws `MatcherViewError`
   (`unusable-filter`) carrying the classifier's reason.

Encodable-tier maintenance (the zero-rerun contract):

7. With a `getEntities` scan-count spy pinned at 1 (the seed):
   non-member set that matches → add; member set that stops matching →
   remove; member edit still matching → noop; non-member non-matching
   set → noop. Scan count still 1 at the end.
8. `remove` event drops a member; `evict` event drops a member (honest
   projection scope) — still zero re-scans.
9. Events for other entity types: no membership change, no
   notification, no scan.

Opaque tier:

10. A synchronous burst of N writes → exactly ONE re-scan (microtask
    coalescing), correct final membership.
11. remove/evict drop members; re-add re-enters on the next scan.
12. Unchanged membership after a re-scan keeps the SAME array instance.

Reference stability (Dexie #2034/#2058 scar class, steal-list #2):

13. Same array instance across unrelated-type writes, non-matching
    writes, and member edits that keep membership.
14. A membership change mints exactly one NEW array instance.
15. Rollback leg: an optimistic transaction on an UNRELATED entity,
    rolled back → array `===` throughout. A transaction that
    transiently flips membership then rolls back → final membership
    equals pre-transaction membership.

Retention:

16. A member whose external refcount drops to zero survives `gc()`
    (the view's retention holds it).
17. Membership exit releases: after exit + sweep, the entity is
    evicted.
18. `dispose()` releases all retentions (sweep then evicts) and
    unsubscribes (no further updates or notifications).
19. Repeated enter/exit cycles leave no refcount drift (no leak).

Notifications:

20. Subscriber fires exactly once per membership change, never on noop;
    unsubscribe works; subscriber errors are isolated.

Divergence guard:

21. `verifyIntegrity: true` detects a seeded divergence (an entity
    mutated in place, outside store events — the real-world divergence
    class), reports through `onDivergence`, and self-heals membership
    to scan truth.

Drain-queue race:

22. A view created from inside a store listener during a multi-write
    burst converges to correct membership by the end of the burst.
