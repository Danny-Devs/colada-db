# ADR-006: The SyncAdapter Interface (Stage-3 Contract, Frozen Early)

**Status:** Proposed (interface frozen; implementation is Phase-4 Stage 3)
**Implementation:** not-started
**Date:** 2026-07-12 · **Revised same day (rev b):** contract upgraded to v2 after a battle-test against seven production sync systems (Replicache, PowerSync, Electric, RxDB, TanStack DB, LiveStore, Evolu) surfaced 12 gaps, 3 critical — full analysis in `../../../knowledge/steal-list-sync-engines.md`. Revision permitted: ADR still Proposed.
· **Revised 2026-07-24 (rev c):** vendor-landscape pass (not protocol — rev b covered protocol) corrected the adapter roadmap and added three door-keeping constraints. See "Rev c" section below. Sources: `../../../knowledge/sync-landscape-2026-07.md` and `../../../knowledge/decentralized-backend-2026-07-24.md`.

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
2. **Echo suppression by construction:** remote changes are applied under a `remote` origin stamp (the provenance pattern — ADR-014 retired the phase-flag approach this section originally mirrored), so they never re-enter the outbox.
3. **Version-aware apply:** a `RemoteChange` is applied only if its `version` is newer than the entity's last-known version (populates `EntityEvent.version`, upgrading fresh-wins from existence-based to version-based — ADR-005 §4 redeemed).
4. **ADR-004 holds at the sync boundary:** local `evict` is never pushed; remote `remove` is a semantic delete (store.remove → durable delete). `clear()` does not push deletes by default (a local reset is not an instruction to the fleet) — explicit fleet-wide deletion goes through normal removes.
5. **Device-local entity types** (pagination containers, UI state) are excluded via `sync: false` on `defineEntity` — per ADR-005 §2.
6. **Conflict posture: server-authoritative.** The server's verdict (ack/reject/transform) is final; the client rebases in-flight optimistic transactions on the post-apply state (clear-and-replay, which the tx system already implements). No CRDTs, no P2P — deliberately (ADR-005 §3).

### Adapter roadmap

~~`restAdapter` → `powerSyncAdapter` (client SDK is Apache-2.0; their service is self-hostable) → `tursoAdapter` (re-evaluate at their 1.0).~~ **Superseded by rev c below** — the PowerSync reasoning was sound on licensing and wrong on layering.

**Current roadmap (rev c, 2026-07-24):** `restAdapter` (reference implementation + the documented protocol for any custom backend) → `electricAdapter` (read-path only: fills `pull()`/`subscribe()`, leaves `push()` to the outbox) → re-evaluate.

## Rev c (2026-07-24) — adapter roadmap correction + three door-keeping constraints

A vendor-landscape pass (distinct from rev b, which was protocol-level) produced one correction and three constraints. Full evidence, with primary-source citations and measured maturity signals, in `../../../knowledge/sync-landscape-2026-07.md`.

### C1. The layering finding: most sync engines are rivals, not transports

Rev b's roadmap assumed sync engines are *transports* that can sit behind this adapter. Verified against primary docs 2026-07-24: for most of the field that is false. Zero, PowerSync, LiveStore, Jazz, InstantDB and Triplit each own the client store, the query layer, and the outbox — they *are* what colada-db is. Adopting one is replacement, not integration.

**PowerSync specifically** — the rev-b reasoning ("client SDK is Apache-2.0, service self-hostable") remains factually correct, but does not add up to a workable adapter: PowerSync's client SDK manages **its own local SQLite database and its own upload queue**, duplicating the outbox this ADR's §1 builds on. An adapter means either two stores and two outboxes, or bypassing their client and speaking the raw protocol from our coordinator. The first is incoherent; the second forfeits most of the reason to pick PowerSync. It is a well-engineered system (causal+ consistency, Jepsen-verified) that is a poor fit for *this role*.

**Electric takes that slot** because it is the only significant engine in the field that is read-path only. Per its own docs: *"Electric does read-path sync... Electric does not do write-path sync."* It fills `pull()` and `subscribe()` and leaves `push()` to the machinery in §1, which is a complement rather than a contest. Apache-2.0, fully self-hostable, plain HTTP that works through CDNs, and no auth model of its own (you proxy and authorize the request), so no identity lock-in is inherited.

**Licensing note for the open-core plan:** PowerSync's *service* is FSL-1.1-ALv2 (raw LICENSE read 2026-07-24), whose "Competing Use" clause bars offering a commercial product that substitutes for it. Shipping an adapter against a user's own deployment is a Permitted Purpose; building a hosted colada-db sync service on PowerSync Service is not, until the 2-year Apache-2.0 conversion has elapsed for the relevant version. Their *client SDKs* are Apache-2.0.

### C2. Three constraints that keep the decentralized path open

Danny's standing direction (2026-07-24): pursue the decentralized lane if it is competitive; otherwise ship the traditional way but **design so we can move**, coupled to no vendor. These three constraints are what "able to move" costs. All are cheap now, before the coordinator exists, and expensive after.

1. **Partial-sync selection must stay client-side-expressible. Core never learns what a server-side shape is.** This is the sharpest one-way door found. Electric's Shape is *"a SQL query against your Postgres"* and Zero's ZQL runs server-side against a replica — both evaluate predicates over **plaintext**, which a server that cannot decrypt your data can never do. If that model reaches the coordinator, E2EE is foreclosed permanently and no future adapter recovers it. Server-evaluated shapes are permitted **inside the Electric adapter only**; the coordinator's model of "what do I have, what am I missing" stays cursor-and-range shaped, which `PullResult` already is. (Observed in the wild: Walrus Memory needed server-side semantic search, so its server must read user data, so its E2EE property was spent.)

2. **Version comparison routes through a single adapter-supplied comparator.** ADR-005 §1 correctly made `version` opaque and backend-supplied. The narrow gap: a scalar orders **totally**, while CRDT causality needs a **partial** order (vector clock / Lamport-plus-actor). A vector clock can be smuggled into the `string` case, but then "is this newer" stops being a numeric comparison. Every `>` on a version is a site that would otherwise need changing later. Default the comparator to numeric/lexicographic; let an adapter override it.

3. **`clientId` stays an opaque string. Core never generates or validates its format.** Server-authoritative deployments let a server allocate them; decentralized ones have no server to vouch, so identity must be a **public key** (as in Keyhive and Jazz). The door closes the moment anything assumes clientIds are server-assigned or unique-by-fiat. Cost to keep open: effectively zero, plus a test asserting core never inspects the format.

### C3. What this does NOT change

- **§6 server-authoritative conflict posture stands.** It is not a one-way door: `transform` is an *adapter-level* verdict, and an E2EE relay adapter simply never emits one. The posture lives in the adapter, not the store.
- **The CRDT tripwire remains unfired.** SweeAI settled on ADOPT, not COLLABORATE (confirmed 2026-07-24). Agents act and then report; publishing an outcome is append-only, which merges by ordering alone.
- **Requiring Postgres is a deployment lock-in, not an architectural one** — it constrains the app developer's backend, not colada-db's core, and is reversible by writing another adapter.

### C4. The reframe worth keeping

Nobody chose Postgres because it is the best database — they chose it because it ships **logical replication**, an ordered, durable, resumable change feed. That is the single primitive sync requires. PowerSync proves it by supporting exactly the other databases with usable change feeds (MySQL binlog, MongoDB change streams, SQL Server CDC).

Consequence: this contract needs *a cursor over an ordered log*, not Postgres. A Sui object pointing at a chain of Walrus blobs is such a log — the pointer is the cursor, the blob chain is the history. The decentralized backend fits `PullResult` more naturally than much of the centralized field does. Economics force it to be epoch-grained (Walrus bills `4.5 × size + 64 MB` per blob, so per-mutation writes are arithmetically absurd and batching is mandatory), which is fine for the append-only receipt data that is SweeAI's actual product and wrong for live collaborative state, which SweeAI does not have.

### C5. Design note for `restAdapter` — HTTP QUERY (RFC 10008)

Keep `pull()` genuinely side-effect-free, put cursor and predicate in the request **body** rather than the path, and keep responses cacheable. That makes the new HTTP QUERY method — safe, idempotent, *and* cacheable, with a request body — a drop-in when support lands, which buys CDN-cacheable partial sync without adopting a server-evaluated shape model. Do not depend on it yet; the RFC is published but rollout was not measured.

## Alternatives Considered

- **Adopt a vendor's protocol wholesale (PowerSync's or Electric's):** fastest to one backend, but the plugin's identity is backend-neutrality; the vendor protocol becomes *an adapter*, not *the interface*.
- **CRDT merge layer:** wrong fit for entity-graph + server-of-record apps (and cr-sqlite is dead — ADR-005); revisit only if a collaboration-editor use case ever becomes primary. **Concrete tripwire (2026-07-23):** SweeAI's `docs/product/ARCHITECTURE.md` open question #1 (graph edge type: feed/fork/collaborate/ambient — "current read: fork is the spine... settle before building") is the real trigger. If that resolves toward **collaborate** as a first-class spine edge instead of fork, re-open this decision — "collaborate" is defined there as "agents from A and B share work, needs multi-party ceiling algebra," which is the collaboration-editor case named above. Until then M0's own scope ("no social, no sharing, no feed") means the trigger has not fired. Candidate library if it does: Automerge (git-like change history maps onto provenance/recency needs directly), Loro as a benchmark-watch alternative — see `core/projects/colada-db-project/knowledge/competitive-landscape-2026-07-23.md`. **Ceiling caveat (council verdict, 2026-07-23):** a CRDT merges data correctly but cannot undo an already-executed overspend against a SHARED mutable ceiling — that's a reservation/partition problem, not a merge problem (Helland's reservation pattern; Miller's object-capability partitioning). If collaborate ships, ceilings must be split into disjoint per-agent sub-grants up front (a one-time, infrequent, atomic allocation step), never modeled as one shared pool renegotiated live — the latter still needs a live arbiter regardless of which CRDT library is chosen.

**Companion decision (2026-07-24):** SweeAI's `docs/adr/001-graph-edge-adopt-as-spine.md` tracks the identical question from the product side (ADOPT vs. COLLABORATE as the graph-edge spine). These two ADRs should be revisited together — a change on one side almost certainly implies a change on the other.

**Status update (2026-07-24):** SweeAI's `SEMANTIC-MODEL.md` "The graph edge — DECIDED (council, 2026-07-23)" confirms **ADOPT**, not collaborate, as the spine — three independent seats, reasoning: "Adopt is the only edge where the kernel is a feature instead of plumbing. Follow, collaborate, and ambient all work fine on a platform with no trust ceiling." This tripwire is confirmed **unfired**, and per that same reasoning, may never fire in the ceiling-sensitive form anticipated above — collaborate is explicitly kernel-decoupled, so it may ship without ever touching mandate/ceiling enforcement at all. (Note: SweeAI's `ARCHITECTURE.md` open-questions list still shows this as unsettled as of the same date — doc drift between two SweeAI files, flagged there, not resolved here.) Re-check this note if SweeAI's docs change again.
- **Event-sourcing (LiveStore-style):** powerful but demands the app re-model everything as events; violates the drop-in-plugin identity.

## Consequences

- Positive: three-method adapter surface = trivial to implement against any REST/GraphQL/WS backend; outbox reuses shipped machinery; the contract can be documented and community-tested before the coordinator exists.
- Negative: server-authoritative means offline conflicts resolve by server verdict, not merge — a known, documented tradeoff.
- Risks: Proposed status signals fields may still be added (not changed) before Stage 3 lands. Rev b already absorbed the battle-test round (schemaVersion, reset, checkpoints, client identity, tombstones, error taxonomy, id remap); remaining open questions for implementation time: named-mutator rebase (`{name, args}` on LocalChange — composes with Zero-style shared mutators), priority-tiered hydration, and per-subscription checksum defaults.
- Where this contract is already ahead of the field (from the battle-test): first-class `mutationId` (RxDB has no mutation identity), multi-entity transaction groups (RxDB's atomic unit is one document), `transform` as a server-rebase channel (PowerSync and Electric have nothing equivalent), and per-`Typename:id` invalidation granularity (finer than LiveStore's per-table).
