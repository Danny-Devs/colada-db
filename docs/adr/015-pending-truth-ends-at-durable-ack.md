# ADR-015: Pending Truth Ends Only at Durable Acknowledgment — the In-Flight Overlay

**Status:** Accepted
**Date:** 2026-07-21
**Amends:** ADR-013 (the "dirty window only" boundary bullet and the
pendingTx consequences note), ADR-014 (the direct-`flush()` boundary bullet)

## Context

ADR-013 rule 2 made hydration honor the pending-truth overlay: a confirmed
save or delete sitting in the dirty sets outranks the engine's flushed rows.
But `flush()` drains `dirtySaves`/`dirtyDeletes` synchronously at entry —
BEFORE `await engine.writeBatch` — so for the duration of the batch's
flight, confirmed-but-undurable truth was invisible to `hydrateRow` and
`readManifestRow`. Both ADR-013 and ADR-014 documented this hole as "the
in-flight-overlay follow-up" (DAN-629). Executed repros, all in-session
divergence (disk and next boot stay correct):

1. **Delete in flight:** `remove()` → `flush()` in flight → `hydrateScope`
   pages the pre-remove engine row back into memory — a semantically
   deleted entity resurrects for the rest of the session.
2. **Save in flight:** `set(v2)` → flush in flight → `evict` →
   `hydrateScope` pages stale `v1` while disk converges to `v2`.
3. **Synthesis gap:** a never-flushed new entity, evicted pre-flush, is
   invisible to `hydrateScope` — the engine has no row, so `hydrateRow` is
   never called; the overlay could overlay but not synthesize.
4. **Lifecycle flush (DAN-630 gauntlet F1):** the module's own
   `visibilitychange`/`beforeunload` listeners call `flush()` directly — a
   tab hidden during boot is an AUTOMATIC entry into the window, and boot's
   stale load snapshot (captured before the flush landed) then hydrates a
   row whose delete already ACKED.
5. **Uncommitted optimistic remove (DAN-630 gauntlet F2):** `tx.remove()`
   racing boot — `hydrateRow` deliberately ignored `pendingTx` (ADR-013's
   note), so the stale snapshot un-deleted the optimistic projection
   mid-transaction; after commit+flush, memory kept the resurrected row
   while disk deleted it.

Flavor 4 is the sharp one: the delete is drained AND durably acked before
the stale read resolves — so even an overlay that tracked "the batch
currently in flight" would miss it if it cleared at ack time. The overlay
must stay valid for every read that might predate the ack.

## Decision

**A confirmed op leaves the pending-truth overlay only when its batch is
durably acknowledged AND no hydration read that might predate that
acknowledgment is still outstanding.** Concretely:

1. **Drain is a move, not a clear.** `flush()` moves the drained batch into
   `inflightPuts`/`inflightDeletes` (per-key, latest-op-wins across
   consecutive batches). The overlay consulted by `hydrateRow` and
   `readManifestRow` is now, in precedence order: open-transaction delete
   mask → `dirtyDeletes`/`dirtySaves` (newest confirmed) →
   `inflightDeletes`/`inflightPuts` (drained, possibly acked) → engine row.
   Dirty always outranks in-flight (it is strictly newer for the same key);
   in-flight always outranks the engine row (the row predates the batch).
2. **Clearing is quiescence-gated.** The in-flight sets clear when ALL of:
   no batch in flight, boot hydration settled, and no `hydrateScope` (or
   its `readManifestRow`) bracket open. Until then a retained entry is
   either newer than what a straddling read returns (correct to prefer) or
   byte-identical to the durable row it produced (preferring it is a
   no-op). This is what closes flavor 4: boot's stale snapshot resolves
   after the lifecycle flush acked, but `booting` holds the overlay open.
   On engine failure (`disabled`) the sets are never cleared — persistence
   is dead, and the frozen overlay keeps the remainder of the session's
   hydrations honest about truth the engine lost.
3. **`hydrateScope` synthesizes manifest-declared keys from pending saves**
   (flavor 3). A manifest names the keys its scope needs resident; if the
   only copy of such a key is a dirty or in-flight save (the engine has no
   row yet), `hydrateScope` hydrates from the pending value directly.
   Bounded non-goal: "all"-mode boot does NOT synthesize — a mid-boot
   `set`→manual-`evict` with no manifest stays cold until its flush lands
   (contrived: gc timers defer during boot, so only a manual evict enters;
   no scope has declared residency).
4. **An uncommitted optimistic DELETE masks hydration of its key**
   (flavor 5; amends ADR-013's pendingTx note). Unconfirmed state still
   never flushes and never hydrates — but memory's absence of an
   optimistically-removed key is a deliberate projection, and hydration
   must not un-delete it mid-transaction. On commit the delete graduates
   to the dirty sets (normal path); on rollback the buffer dies and the
   mask lifts — the untouched durable row pages back in on the next
   hydrate. Optimistic PUTs get no mask: while the optimistic value stays
   resident, fresh-wins (`store.has`) blocks hydration — but that premise
   fails if the key is EVICTED mid-transaction (a stale engine row can
   page over the optimistic projection; gauntlet F2, pre-existing at
   base). Boundary, not a rule: the mask is also checked before the dirty
   sets, so an older uncommitted tx.remove vetoes hydration of a newer
   confirmed non-tx write to the same key until settlement (gauntlet F1,
   end state byte-identical pre/post this ADR). Both are the "foreign
   interference with a tx-touched key" class — tracked in the tx-vs-
   foreign-writes follow-up ticket, deliberately NOT solved by widening
   this overlay. **[RESOLVED by ADR-016 (DAN-635):** the evicted-put hole is
   closed — the mask now covers PUTs too (`buffer.has(key)`), so a stale
   engine row can no longer page over an evicted optimistic put (flavor A).
   The mask stays mask-first ON PURPOSE — yielding to the confirmed write
   would diverge at commit; the residual foreign-confirmed-write hazard is
   the rollback clobber, bounded to the sync-rebase seam (ADR-006 §6).]**

## Alternatives Considered

- **Per-read overlay snapshot** (capture dirty∪inflight at read issue,
  reconcile rows against snapshot ∪ live): covers reads issued after the
  truth was confirmed, but NOT truth confirmed mid-read-flight and acked
  before reconciliation — which is exactly flavor 4. Rejected: more
  machinery than the quiescence gate, strictly weaker coverage.
- **Await the in-flight batch before hydration reads** (`hydrateScope`/boot
  await `inflightFlush` first): doesn't help — a new flush can start during
  the read (the drain-mid-read hole remains), and it adds a full batch
  latency to every remount. Retention is both necessary and sufficient;
  blocking is neither.
- **Engine-level read-your-writes ordering contract:** pushes the seam into
  every engine (protocol change — DO-NOT-TOUCH) and still can't cover the
  drain itself (the engine never saw the dirty sets).
- **Bound flavor 5 to a tx-graduation-semantics ticket:** rejected — the
  mask is not graduation (commit/rollback flows are untouched); it is
  projection integrity, three lines, and the executed F2 repro shows
  commit-side divergence (memory keeps a row disk deletes) with no other
  owner.

## Consequences

- Positive: flavors 1–5 all closed with zero engine-protocol change; the
  full un-durable window (dirty AND in-flight AND acked-but-straddled) is
  one overlay with one precedence rule.
- Positive: the overlay's validity no longer depends on engine read/write
  ordering. The only engine assumption is the trivial one: a read does not
  return data staler than the engine's committed state when the read was
  ISSUED (all three engines are single-apply-loop; this cannot fail
  in-repo).
- Memory: the in-flight sets hold references to already-encoded values (the
  same objects the dirty sets held — no copies) and clear at quiescence.
  Under continuous overlapping hydrate+flush traffic they can transiently
  accumulate up to the keys flushed since the last quiescent instant;
  bounded by total write volume, freed at the first idle moment. Degraded
  mode retains at most the final batch, for the life of the session.
- Boundary (bounded, not fixed): boot's manifest-mode INDEX and scope-row
  loads read the engine directly (only `readManifestRow` — the remount
  path — consults the overlay). A manifest write racing boot via a direct
  mid-boot flush can therefore boot-hydrate a stale scope SET (under- or
  over-hydration of entities, each row still individually reconciled by
  `hydrateRow`'s overlay); memory converges via `preload`/`hydrateScope`
  post-boot. Requires pre-ready `setManifest` + a direct flush racing the
  index read; retention correctness is unaffected.
- Test idiom: `gateBootStale` (in `inflight-overlay.spec.ts`) captures load
  rows EAGERLY then holds delivery — the stale-snapshot interleaving
  `gateBoot` (which gates before reading) cannot produce. Use it whenever
  the claim under test is "confirmed truth outranks a snapshot that
  predates it".
