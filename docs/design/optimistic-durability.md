# Design: optimistic writes never touch disk until commit (roadmap 0.3 / arch review C3)

**Status:** IMPLEMENTED 2026-07-19 — resolution (a) chosen (replay under the owner's identity); commit signal = `onSettled` on the optimistic-updates handle, exactly as designed below. Done-defining tests live in `src/optimistic-durability.spec.ts` (all 6, verified failing against pre-0.3 source).
**Fixes:** C3 (rollback durably deletes rows the tx never owned) and the fourth bug found during analysis: an optimistic `set` on a cold (evicted-but-durable) entity flushes PARTIAL optimistic data over durable server truth within the debounce window — corruption even on the happy path, before any rollback.

## Principle

The durable store persists **confirmed state only**. Optimistic state is a memory-layer phenomenon; disk never sees a write that might be rolled back. (TanStack overlay lesson, adapted to our write-into-store model via event attribution instead of a separate overlay map.)

## Mechanism (uses the shipped write channel)

`enablePersistence` becomes transaction-aware using `EntityEvent.origin`/`transactionId` (shipped `15a65f3`):

1. Events with `origin: "local-mutation"` **and** a `transactionId` are routed to a per-transaction buffer (`pendingTx: Map<txId, Map<EntityKey, put|delete>>`), NOT to `dirtySaves`/`dirtyDeletes`.
2. On **commit**, the transaction's buffered entries move into the dirty sets and flush normally.
3. On **rollback**, the buffer for that txId is discarded. The store's compensating events arrive as `origin: "rollback-replay"` — see the trap below.

## ⚠️ The trap discovered 2026-07-19 (why the naive version corrupts)

`recompute()` (rollback) replays the mutations of **other still-active transactions** under `origin: "rollback-replay"` — **without those transactions' own txIds**. A naive filter ("buffer only events carrying a txId") would let those replayed optimistic writes flow into `dirtySaves` as if confirmed — re-introducing the exact bug through the side door.

**Resolution (pick at implementation, in this order of preference):**
- **(a) Replay under the owner's identity:** `recompute` wraps each replayed transaction's mutations in `runWith({ origin: "rollback-replay", transactionId: <that tx's id> })` — replayed optimistic writes land back in their own buffers (idempotent re-buffer). Requires `activeTransactions` entries to carry their txId (trivial). This keeps ALL routing decisions purely event-driven. **Preferred.**
- (b) Persistence treats ANY `rollback-replay` event as non-durable — simpler, but then the restore-server-truth writes inside recompute (which ARE confirmed state) never re-persist; harmless only because the durable row already holds server truth… which is exactly the kind of implicit invariant that rots. Rejected unless (a) proves ugly.

## The commit signal

Commit currently emits nothing (re-applying identical data is no-op-suppressed — correct for reactivity). Persistence needs to learn "txId N is confirmed":

- **Chosen design:** the transaction layer notifies through the store's event stream with a **lifecycle event**, NOT an entity event: extend `subscribe` with a second stream OR (cleaner, non-breaking) add `EntityEvent.type: "tx"`? — No. Entity semantics stay pure. Instead: `EntityStore` gains an internal, non-forgeable pairing: `createOptimisticUpdates` (which already holds the store) exposes `onSettled(listener: (e: { transactionId: string; outcome: "commit" | "rollback" }) => void)` on the handle, and `enablePersistence` — when it detects transactional events — obtains the store's handle via `createOptimisticUpdates(store)` (WeakMap-backed, same instance by construction, shipped tonight) and subscribes. No new public store surface; the WeakMap IS the discovery mechanism.
- Buffered entries for uncommitted transactions at `dispose()`/unload: flushed? NO — unconfirmed writes die with the session (correct: they were never confirmed; the app's mutation will re-run or fail visibly). Document in the durability-window guide.
- Boot: `pendingTx` is memory-only by definition — nothing to recover (an uncommitted tx cannot survive a reload anyway; its `commit()` can never be called).

## Interactions

- **Cold-entity snapshot correctness (C3 proper):** with this design, rollback's `store.remove()` of an optimistically-created-in-memory entity emits a tombstone remove — which persistence must now IGNORE when it originates from `rollback-replay` for a key whose only writes this session were buffered-optimistic (the row on disk, if any, was never touched). Resolution (a) handles this for free: the remove arrives under the rolled-back tx's identity → discarded with its buffer. Verify with the C3 end-to-end test: cold entity + optimistic set + flush window + rollback ⇒ durable row BYTE-UNCHANGED.
- **willCommit gate (DAN-577):** sits pre-apply in the SAME transaction layer; a veto means the write never happens, so persistence never sees it. No interaction beyond sharing the handle.
- **Sync outbox (ADR-006 §1):** "the outbox is the optimistic-transaction system" — this buffer IS the proto-outbox; Stage 3 upgrades entries to `LocalChange` with HLC mutationIds. Design the buffer's entry shape with that in mind (keep per-key net-effect + op type).

## Tests that define done

1. Optimistic set → rollback: engine write count for that key = 0 (never touched disk).
2. Cold entity (evicted, durable) + optimistic set + debounce elapses + rollback ⇒ durable row byte-identical to pre-tx.
3. Optimistic set → commit → flush ⇒ durable row = optimistic value.
4. Tx A rollback while tx B active (both touching one key): B's writes remain buffered under B; after B commits, disk = B's value; after B rollback too, disk = original.
5. Uncommitted tx at dispose(): buffered entries NOT flushed; confirmed dirty entries ARE.
6. Non-transactional writes (no txId) flow to disk exactly as today (regression: whole existing durability suite).
