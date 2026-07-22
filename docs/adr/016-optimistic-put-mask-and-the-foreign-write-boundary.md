# ADR-016: The Optimistic Mask Covers PUTs Too — and the Foreign-Write Boundary

**Status:** Accepted
**Date:** 2026-07-21
**Amends:** ADR-015 (rule 4: the mask was delete-only; it now covers any
buffered op, and its precedence vs. confirmed writes is named)

## Context

ADR-015 rule 4 gave an uncommitted optimistic DELETE a hydration mask:
memory's absence of an optimistically-removed key is a deliberate
projection, so a boot or remount load must not un-delete it mid-transaction.
Rule 4 deliberately gave optimistic PUTs no mask, on this premise: *"while
the optimistic value stays resident, fresh-wins (`store.has`) blocks
hydration."* ADR-015 itself flagged that the premise **fails when the key is
EVICTED mid-transaction**, and filed both that hole and the
foreign-confirmed-write sibling into "the tx-vs-foreign-writes follow-up
ticket" (DAN-635). This ADR resolves it.

The transaction layer (`src/transactions.ts`) assumes a tx-touched key is
not concurrently mutated or evicted by a non-tx actor mid-flight. That
assumption is unenforced and its failure modes are silent. Two executed
repros (both verified pre-existing at `71fdf82`, byte-identical with and
without ADR-015's overlay):

**Flavor A — divergence SURVIVES settlement (the must-fix).**
1. `tx.set(contact:1, "kept")` — buffered in `pendingTx`; memory holds
   "kept"; the durable row still holds the pre-tx `v1`.
2. `evict(contact:1)` — memory drops "kept". Fresh-wins protected the
   optimistic put ONLY while it was resident; eviction removed it.
3. `hydrateScope` (or any remount/boot load) inside the tx — `hydrateRow`
   sees no dirty/in-flight entry (the write is in the tx buffer, not the
   dirty sets), the delete-only mask does not fire (this is a PUT),
   fresh-wins passes (the key is absent), so the **stale engine row `v1`
   pages into memory**.
4. `commit()` graduates "kept" to the dirty sets → disk becomes "kept",
   while memory holds `v1`. **Memory `v1` / disk "kept" for the rest of the
   session** — a divergence that outlives the transaction.

**Flavor B — bounded to settlement, plus a documented rollback window.**
1. `tx.remove(contact:1)` — buffered delete; serverTruth snapshots `v1`.
2. A foreign, confirmed, non-tx `set(contact:1, v2)` — lands in the dirty
   sets (it never went through the transaction).
3. `evict` → `hydrateScope` — the delete mask (checked before the dirty
   sets) vetoes hydration, so the scope returns nothing for `contact:1`
   even though `dirtySaves` holds the strictly-newer confirmed `v2`.
4. On rollback, `recompute` restores the serverTruth snapshot `v1` over the
   foreign write. End state: memory `v1` / disk `v2`.

## Decision

**An open transaction's buffered op — PUT or DELETE — masks hydration of its
key until the transaction settles.** Concretely, `hydrateRow`'s optimistic
mask changes from `buffer.get(key)?.op === "delete"` to `buffer.has(key)`.
The mask keeps its **mask-first precedence** (it is consulted before the
dirty/in-flight overlay). Everything else in the ADR-013/014/015 overlay is
unchanged.

This closes **flavor A** completely: the stale engine row can no longer page
over an evicted optimistic put. After eviction, memory is legitimately
absent (ADR-004: an evicted key is durable-but-cold and re-hydrates later);
on commit the tx op graduates to disk and any subsequent hydrate pages in
the committed value, so **memory converges to the same truth disk converges
to, by settlement.** The rollback leg is coherent too: the put never
graduated, the engine row was never touched, and the mask lifting pages the
untouched server truth back in.

**Flavor B is bounded, not fixed, and deliberately so.** The mask must stay
mask-first — see the rejection of "mask yields to the confirmed write"
below. What remains is the **rollback clobber**: the tx's serverTruth
snapshot goes stale the moment a foreign confirmed write lands on a
tx-touched key, and rollback restores the stale snapshot over that write.
That is a `serverTruth`-staleness hazard in the transaction layer, not a
`hydrateRow` precedence question, and it is the exact class the sync
coordinator's server-authoritative rebase owns (ADR-006 §6: the client
rebases in-flight optimistic transactions on post-apply confirmed state via
the transaction system's clear-and-replay). Solving it locally would mean
teaching the tx layer to observe foreign confirmed writes and
refresh/invalidate its snapshots — widening the tx conflict model ahead of
the sync coordinator that will own it, and touching the very serverTruth
machinery ADR-006 §1 freezes as the sync outbox. The mask keeps flavor B's
**commit** leg coherent today (memory absent matches the committed delete);
the rollback window is byte-identical pre/post this ADR, now NAMED and
pinned (`tx-foreign-interference.spec.ts`, flavor-B rollback leg) instead of
silent.

### Sync-contract coherence (ADR-006 §1)

The change is confined to `hydrateRow`'s read-side overlay. It never mutates
`pendingTx`, never flushes an uncommitted buffer, and never touches
`serverTruth`, `recompute`, or the settlement path. The tx buffers remain
inviolate — the outbox semantics of ADR-006 §1 (the optimistic-transaction
system IS the sync outbox; commit graduates a buffer, rollback discards it)
are untouched. The mask only SUPPRESSES a hydration that would contradict a
buffered op; suppressing a write is not a state transition, so the
no-transition-without-event invariant is preserved (there is no silent
memory correction — there is a hydration that does not happen).

## Alternatives Considered

- **Mask yields to strictly-newer confirmed writes (candidate d):** move the
  mask below the dirty/in-flight overlay so a foreign confirmed write to a
  tx-touched key hydrates instead of being vetoed. Fixes flavor B's
  hydration-veto framing — but **breaks commit-coherence**, which is worse.
  Trace: `tx.remove(c1)` + foreign `set(c1, v2)` + evict + hydrate would
  page `v2` into memory; on `commit()` the buffered delete graduates and disk
  deletes `c1`, leaving memory holding `v2` disk no longer has — a NEW
  commit-time divergence where today there is none. The mask's purpose is to
  keep memory consistent with the tx's PENDING AUTHORITATIVE op; a foreign
  write, though chronologically newer, is not the settlement outcome. The
  flavor-B commit-leg pin encodes exactly this reason. Rejected: it trades a
  coherent commit for a divergent one and mislocates flavor B's real defect
  (which is serverTruth staleness, not read precedence).

- **Evict-immunity — pin tx-touched keys against eviction (candidate b):**
  fixes flavor A at its source (the eviction is what breaks fresh-wins).
  Rejected on three counts. (1) It doesn't fix the repro: `store.evict()` is
  a direct memory operation that bypasses refcounts entirely — `retain()`
  only stops `gc()`, so a manual evict (the repro's trigger) still fires.
  Making `evict()` itself consult transaction state couples the store to the
  transaction layer, violating the boring-core split (ADR-003/ADR-008: the
  store knows nothing about transactions). (2) A never-settled transaction
  could then hold memory hostage — pinned entries that never release. (3) It
  addresses only flavor A and says nothing about the foreign-write class. The
  mask achieves flavor A's fix with zero store coupling, zero hostage risk
  (it is consulted only during hydration and lifts at settlement), and reuses
  the exact mechanism ADR-015 already ships for deletes.

- **Settlement reconciliation — re-apply the tx's net effect on commit
  (candidate c):** fixes flavor A at commit by re-applying "kept" over the
  hydrated `v1`. Rejected. Commit is event-silent by design (re-applying
  identical data is no-op-suppressed — correct for reactivity); making it
  re-apply means either emitting new corrective events (commit now mutates
  memory and can loop with the persist subscriber — a contract change) or
  correcting memory silently (FORBIDDEN by the no-transition-without-event
  invariant). It also only covers the commit path: a hydration that pages
  `v1` in DURING the open transaction shows the wrong value for the whole tx
  lifetime. The mask prevents the wrong value from ever entering memory and
  needs no commit-time machinery.

- **Fix flavor B's rollback clobber by refreshing serverTruth on foreign
  writes:** have the tx layer subscribe to store events and update a
  snapshot when a foreign confirmed write lands on a tx-touched key.
  Rejected for THIS ticket: it widens the transaction conflict model into
  territory ADR-006 §6's server-authoritative rebase is designed to own,
  touches the frozen serverTruth/outbox machinery (ADR-006 §1), and the
  concurrent local pattern it addresses (an app both optimistically mutating
  a key via a tx AND confirm-writing the same key via a plain `set`) is
  unusual pre-sync. Deferred to the sync-rebase work; the window is pinned so
  it can't regress silently in the meantime.

## Consequences

- Positive: flavor A is dead by construction — an evicted optimistic put can
  no longer be paged over by a stale engine row, so the survives-settlement
  divergence is gone. The fix is a one-predicate generalization of an
  existing, tested mask (delete → any op), symmetric and self-describing.
- Positive: no new state, no store coupling, no commit-contract change, no
  serverTruth touch — the change lives entirely in `hydrateRow`'s read-side
  overlay and cannot affect the write path, the sync outbox, or the flush
  pipeline.
- Positive: the mask keeps flavor B's commit leg coherent (memory tracks the
  pending delete), and mask-first precedence is now a NAMED invariant with a
  pinned rationale, so a future "prefer the confirmed write" refactor trips a
  red test instead of silently reopening a commit-time divergence.
- Negative / bounded: flavor B's rollback clobber (foreign confirmed write
  survives to disk; memory reverts to the stale pre-tx snapshot) is NOT
  fixed here. It is byte-identical pre/post this ADR, pinned as the
  flavor-B rollback leg, and pointed at the sync coordinator's rebase
  (ADR-006 §6) as its true owner.
- Boundary (unchanged from ADR-015): the mask is entity-only — `pendingTx`
  never holds `__cdb_manifest__` keys, so `readManifestRow` is untouched.
  Optimistic PUTs that remain RESIDENT are still blocked by fresh-wins, not
  the mask; the mask matters only once residency is lost (eviction).
