# ADR-006: The SyncAdapter Interface (Stage-3 Contract, Frozen Early)

**Status:** Proposed (interface frozen; implementation is Phase-4 Stage 3)
**Date:** 2026-07-12 · **Revised same day (rev b):** contract upgraded to v2 after a battle-test against seven production sync systems (Replicache, PowerSync, Electric, RxDB, TanStack DB, LiveStore, Evolu) surfaced 12 gaps, 3 critical — full analysis in `../../../knowledge/steal-list-sync-engines.md`. Revision permitted: ADR still Proposed.

## Context

Stage 3 turns the plugin into a full local-first data layer: the client database (ADR-003) synchronizes with any backend, Linear-style. The plugin's moat is *bring-your-own-backend* — so the sync **protocol** belongs to the plugin and the **transport** belongs to an adapter, exactly as `StorageEngine` split durability. Freezing the adapter contract now (while implementation is months out) prevents the same calcification risk ADR-005 flagged for versions: the first shipped adapter would otherwise define the interface by accident.

Reference architectures studied: Linear's sync engine (normalized in-memory model store + delta packets + transaction queue + partial bootstrap; see knowledge/local-first-landscape.md), PowerSync (client SDKs Apache-2.0; service FSL→Apache-after-2y), Turso sync-wasm, TanStack DB 0.6's query-driven sync. All converge on server-authoritative deltas over a cursor — that is the shape adopted here.

## Decision

### The contract

```typescript
/** A change arriving FROM the backend. Deletes are tombstones, never omissions. */
interface RemoteChange {
  type: "set" | "remove";        // remove = tombstone (deleted:true server-side); hard deletes are unsyncable
  entityType: string;
  id: string;
  data?: EntityRecord;           // absent for remove
  version: string | number;      // authoritative ordering (fills EntityEvent.version, ADR-005)
}

/** A committed local write heading TO the backend (an outbox entry). */
interface LocalChange {
  mutationId: string;            // idempotency key — HLC-style: time + counter + clientId (unique AND ordered)
  clientId: string;              // stable per client (tab-group aware); enables recovery + server-side ordering
  seq: number;                   // monotonic per client; server ignores seq <= lastSeen, rejects gaps
  transactionId?: string;        // groups multi-entity optimistic transactions for atomic server apply
  op: "set" | "remove";
  entityType: string;
  id: string;
  data?: EntityRecord;           // PATCH-style dirty fields preferred over full rows
  baseVersion?: string | number; // version the client last saw (server may use for conflict checks)
}

interface PushResult {
  results: Array<{
    mutationId: string;
    /**
     * ack       — applied; carries serverVersion (the write watermark, see coordinator §1b)
     * reject    — PERMANENTLY invalid: drop outbox entry, revert overlay. Server MUST still
     *             advance its per-client seq (else the client wedges forever).
     *             Transient failures are NOT rejects — throw from push() instead (coordinator retries with backoff).
     * transform — server rebased the write; carries corrected entity and MAY carry an id remap
     *             (temp-ID → server-ID), applied atomically: rekey entity, rewrite outbox refs, one move event.
     */
    status: "ack" | "reject" | "transform";
    data?: EntityRecord;
    version?: string | number;
    remappedId?: string;
  }>;
}

type PullResult =
  | {
      type: "changes";
      changes: RemoteChange[];
      cursor: string;            // opaque; adapters may encode Electric-style {handle, offset}
      complete: boolean;         // false = more batches; coordinator STAGES and applies only at complete
      /** Which of this client's mutations this snapshot already contains (Replicache
       *  lastMutationIDChanges): the coordinator drops overlay/outbox entries <= these
       *  marks HERE, on the pull channel — never on push-ack alone (kills the
       *  double-apply race and rubber-band flicker). */
      confirmedMutations?: Record<string /* clientId */, number /* seq */>;
      checksum?: string;         // optional per-subscription integrity; mismatch => client resets
    }
  | { type: "reset"; cursor?: string }; // cursor expired / compaction / DDL / corruption: discard partition, resync.
                                        // Coordinator applies per-subscription with jitter — never a global storm.

/** Transport to one backend. Implement three methods; the coordinator does the rest. */
interface SyncAdapter {
  /** PULL: server → client. Cursor-based, batched, resumable (cursor persisted per batch). `null` = initial sync. */
  pull(cursor: string | null, opts?: { limit?: number; schemaVersion?: string }): Promise<PullResult>;
  /** PUSH: client → server. Ordered outbox delivery; per-change verdicts. Contract: push MUST NOT
   *  resolve until the write is durable in the same store pull() reads from (async backend queues break sync). */
  push(batch: LocalChange[], opts?: { schemaVersion?: string }): Promise<PushResult>;
  /** Optional live channel — POKE-FIRST: a bare hint that triggers pull(); inline data is an optional
   *  optimization. The stream is licensed to be lossy — reset (above) covers recovery. May emit "reset". */
  subscribe?(onEvent: (event: { type: "poke" } | PullResult) => void): () => void;
}
```

### Coordinator semantics (`enableSync(store, { adapter, ... })`)

1. **The outbox is the existing optimistic-transaction system.** A local mutation = optimistic tx (already shipped, 0.2.0): `commit()` moves its mutations into a durable outbox (persisted via the StorageEngine, so pending pushes survive reloads — and stored in a SEPARATE file/store from entity state, so a state reset never destroys unpushed writes); `push()` verdicts drive it; `reject` triggers the existing rollback machinery; `transform` applies the server's corrected entity (and any id remap) then completes.
   1b. **Confirmation is watermark-based, on the pull channel.** A push `ack` records a server watermark but does NOT drop the optimistic overlay; the overlay entry is dropped only when a pulled snapshot confirms it (`confirmedMutations` ≥ that mutation's seq, or a pulled checkpoint ≥ the ack's serverVersion). This single rule eliminates the push-ack/pull-snapshot double-apply race and the ack→catch-up rubber-band flicker.
   1c. **Recovery:** outbox entries are keyed `(clientId, seq)`; on boot, a client may find and push sibling clients' stranded outboxes (crashed/frozen tabs lose no writes) — safe because the server dedups by per-client seq.
2. **Echo suppression by construction:** remote changes are applied inside an `isApplyingRemote` guard (same pattern as `isHydrating`), so they never re-enter the outbox.
3. **Version-aware apply:** a `RemoteChange` is applied only if its `version` is newer than the entity's last-known version (populates `EntityEvent.version`, upgrading fresh-wins from existence-based to version-based — ADR-005 §4 redeemed).
4. **ADR-004 holds at the sync boundary:** local `evict` is never pushed; remote `remove` is a semantic delete (store.remove → durable delete). `clear()` does not push deletes by default (a local reset is not an instruction to the fleet) — explicit fleet-wide deletion goes through normal removes.
5. **Device-local entity types** (pagination containers, UI state) are excluded via `sync: false` on `defineEntity` — per ADR-005 §2.
6. **Conflict posture: server-authoritative.** The server's verdict (ack/reject/transform) is final; the client rebases in-flight optimistic transactions on the post-apply state (clear-and-replay, which the tx system already implements). No CRDTs, no P2P — deliberately (ADR-005 §3).

### Adapter roadmap

`restAdapter` (reference implementation + the documented protocol for any custom backend) → `powerSyncAdapter` (client SDK is Apache-2.0; their service is self-hostable) → `tursoAdapter` (re-evaluate at their 1.0).

## Alternatives Considered

- **Adopt a vendor's protocol wholesale (PowerSync's or Electric's):** fastest to one backend, but the plugin's identity is backend-neutrality; the vendor protocol becomes *an adapter*, not *the interface*.
- **CRDT merge layer:** wrong fit for entity-graph + server-of-record apps (and cr-sqlite is dead — ADR-005); revisit only if a collaboration-editor use case ever becomes primary.
- **Event-sourcing (LiveStore-style):** powerful but demands the app re-model everything as events; violates the drop-in-plugin identity.

## Consequences

- Positive: three-method adapter surface = trivial to implement against any REST/GraphQL/WS backend; outbox reuses shipped machinery; the contract can be documented and community-tested before the coordinator exists.
- Negative: server-authoritative means offline conflicts resolve by server verdict, not merge — a known, documented tradeoff.
- Risks: Proposed status signals fields may still be added (not changed) before Stage 3 lands. Rev b already absorbed the battle-test round (schemaVersion, reset, checkpoints, client identity, tombstones, error taxonomy, id remap); remaining open questions for implementation time: named-mutator rebase (`{name, args}` on LocalChange — composes with Zero-style shared mutators), priority-tiered hydration, and per-subscription checksum defaults.
- Where this contract is already ahead of the field (from the battle-test): first-class `mutationId` (RxDB has no mutation identity), multi-entity transaction groups (RxDB's atomic unit is one document), `transform` as a server-rebase channel (PowerSync and Electric have nothing equivalent), and per-`Typename:id` invalidation granularity (finer than LiveStore's per-table).
