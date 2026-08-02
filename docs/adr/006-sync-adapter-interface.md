# ADR-006: The SyncAdapter Interface (Stage-3 Contract, Frozen Early)

**Status:** Proposed (interface frozen; implementation is Phase-4 Stage 3)
**Implementation:** not-started
**Date:** 2026-07-12 · **Revised same day (rev b):** contract upgraded to v2 after a battle-test against seven production sync systems (Replicache, PowerSync, Electric, RxDB, TanStack DB, LiveStore, Evolu) surfaced 12 gaps, 3 critical — full analysis in `../../../knowledge/steal-list-sync-engines.md`. Revision permitted: ADR still Proposed.
· **Revised 2026-07-24 (rev c):** vendor-landscape pass (not protocol — rev b covered protocol) corrected the adapter roadmap and added three door-keeping constraints. See "Rev c" section below. Sources: `../../../knowledge/sync-landscape-2026-07.md` and `../../../knowledge/decentralized-backend-2026-07-24.md`.
· **Revised 2026-08-02 (rev d):** resolved **all 20** unresolved points that writing the Allium specification surfaced (`docs/specs/sync-adapter.allium`, DAN-736) — four contradictions between sections, one undefined referent, two ADR-vs-code naming drifts, four unspecified values, seven behavioural silences, and the two this ADR had itself carried as open since rev b. **No open questions remain in this contract**, and each resolution carries a falsification test rather than a hedge. See "Rev d" below. **The types in the Decision block have been edited to match**; every rev-d change to them is purely additive except one deletion of a path that never had a wire representation.

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
  /** OPTIONAL, rev d / D19. The mutation's INTENT — a named mutator and its args
   *  (Zero / Replicache style), which a matched client+server pair replays
   *  server-side for true rebase. `data` stays the required channel because a
   *  bring-your-own-backend contract cannot assume the server runs client code;
   *  an adapter that does not understand `intent` ignores it and applies `data`.
   *  If a replay disagrees with `data`, the server wins and says so via `transform`. */
  intent?: { name: string; args: unknown };
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
       *  double-apply race and rubber-band flicker). This is the SOLE confirmation
       *  channel as of rev d — see D1. */
      confirmedMutations?: Record<string /* clientId */, number /* seq */>;
      checksum?: string;         // optional per-subscription integrity; mismatch => that subscription resets
      /** rev d / D5 — which partition this outcome belongs to. Opaque: the adapter
       *  owns the namespace and core never parses it. Absent = the single default
       *  partition, which is the whole single-subscription case. */
      subscription?: string;
    }
  | { type: "reset"; cursor?: string; subscription?: string }; // cursor expired / compaction / DDL / corruption:
                                        // discard THAT partition, resync. Coordinator applies per-subscription
                                        // with jitter — never a global storm.

/** rev d / D3 — four-valued, because a three-valued result cannot say "concurrent"
 *  and rev c C2 requires this seam to be able to express a partial order. */
type VersionOrder = "older" | "same" | "newer" | "concurrent";

/** Transport to one backend. Implement three methods; the coordinator does the rest. */
interface SyncAdapter {
  /** PULL: server → client. Cursor-based, batched, resumable (cursor persisted per batch). `null` = initial sync. */
  pull(
    cursor: string | null,
    opts?: { limit?: number; schemaVersion?: string; subscription?: string },
  ): Promise<PullResult>;
  /** PUSH: client → server. Ordered outbox delivery; per-change verdicts. Contract: push MUST NOT
   *  resolve until the write is durable in the same store pull() reads from (async backend queues break sync). */
  push(batch: LocalChange[], opts?: { schemaVersion?: string }): Promise<PushResult>;
  /** Optional live channel — POKE-FIRST: a bare hint that triggers pull(); inline data is an optional
   *  optimization. The stream is licensed to be lossy — reset (above) covers recovery. May emit "reset". */
  subscribe?(onEvent: (event: { type: "poke" } | PullResult) => void): () => void;
  /** OPTIONAL, rev d / D3. The single seam through which every "is this newer" decision
   *  in the coordinator routes. Omit it and core uses the default comparator: numeric
   *  when both tokens parse as numbers, lexicographic otherwise — which never returns
   *  "concurrent". Core never parses a version token either way (C2 + ADR-005 §1). */
  compareVersions?(a: string | number, b: string | number): VersionOrder;
}
```

### Implementation note (2026-08-02) — where the outbox actually taps the store

§1 below says *"`commit()` moves its mutations into a durable outbox."* **That sentence describes a mechanism the shipped API does not offer**, and whoever builds the coordinator needs to know before starting rather than after.

`TransactionSettledEvent` carries `{ transactionId, outcome }` and **nothing else** — it never says what the mutations were. A coordinator built on `onSettled` alone produces an outbox of empty entries. *`src/transactions.ts:112-115`*

**The tap is `store.subscribe()`.** `EntityEvent` carries `origin` and `transactionId`, so filtering on `origin === "local-mutation"` yields the outbox feed and the transaction grouping §1 needs for atomic server apply, from one subscription. *`src/types.ts:161-220`*

**`baseVersion` does NOT come from that event, and assuming it does is the trap here.** `EntityEvent.version` exists but is optional and **the in-memory store never populates it** — its own doc comment says so, and `src/store.ts` contains no `version:` assignment. On a local write the field is always `undefined`. The coordinator must read the entity's last-known version from the store instead — the value a previous `sync-pull` apply stamped — and treat its absence as "no baseVersion", never as version zero.

**Echo suppression must be an explicit accept-list, not a deny-list.** Because `origin` is optional, `origin !== "sync-pull"` would sweep in every unstamped write, while `origin === "local-mutation"` admits only what the outbox should carry. An earlier draft of this note claimed the filter made echo suppression "unfalsifiable"; that overstated it. The filter makes the correct behaviour *easy and the incorrect one visible* — it does not make the bug unwriteable, and §2 still owes a test.

### Coordinator semantics (`enableSync(store, { adapter, ... })`)

1. **The outbox is the existing optimistic-transaction system.** A local mutation = optimistic tx (already shipped, 0.2.0): `commit()` moves its mutations into a durable outbox (persisted via the StorageEngine, so pending pushes survive reloads — and stored in a SEPARATE file/store from entity state, so a state reset never destroys unpushed writes); `push()` verdicts drive it; `reject` triggers the existing rollback machinery immediately; `transform` applies the server's corrected entity and any id remap immediately, but **does not complete** — its overlay waits on the pull channel exactly like `ack` (rev d / D2).
   1b. **Confirmation happens on the pull channel, and `confirmedMutations` is the only way it happens.** A push `ack` records a server watermark but does NOT drop the optimistic overlay; the overlay entry is dropped only when a pulled snapshot carries a `confirmedMutations` mark ≥ that mutation's seq. This single rule eliminates the push-ack/pull-snapshot double-apply race and the ack→catch-up rubber-band flicker. **This applies identically to `transform`** — see D2. *(rev d / D1: through rev c this sentence offered a second path, "or a pulled checkpoint ≥ the ack's serverVersion." That path is deleted. It had no field to travel in, and it presumed versions were totally ordered, which C2 exists to refuse.)*
   1c. **Recovery is relay, not authorship.** Outbox entries are keyed `(clientId, seq)`; on boot, a client may find and push sibling clients' stranded outboxes (crashed/frozen tabs lose no writes) — safe because the server dedups by per-client seq. The adopting client **forwards the entry as it was committed and never re-authors it**; siblings are tabs and workers sharing one StorageEngine on one device, never other machines. *(rev d / D4: this is what reconciles §1c with C3. See the commit-time obligation there.)*
2. **Echo suppression by construction:** remote changes are applied under the `sync-pull` origin stamp (the provenance pattern — ADR-014 retired the phase-flag approach this section originally mirrored), so they never re-enter the outbox. *(rev d: this section said `remote` through rev c; the shipped `WriteOrigin` vocabulary has always spelled it `sync-pull` — `src/types.ts`. The code is published, so the ADR moved.)*
3. **Version-aware apply:** a `RemoteChange` is applied only if the comparator reports its `version` `"newer"` than the entity's last-known version (populates `EntityEvent.version`, upgrading fresh-wins from existence-based to version-based — ADR-005 §4 redeemed). On `"concurrent"` the remote change **is applied** — under §6's server-authoritative posture the pull channel's arrival order is the tiebreak. An adapter wanting merge semantics resolves them inside itself before emitting the change (rev d / D3).
4. **ADR-004 holds at the sync boundary:** local `evict` is never pushed; remote `remove` is a semantic delete (store.remove → durable delete). `clear()` does not push deletes by default (a local reset is not an instruction to the fleet) — explicit fleet-wide deletion goes through normal removes.
5. **Device-local entity types** (pagination containers, UI state) are excluded via `local: true` on `defineEntity` — per ADR-005 §2. *(rev d: this section said `sync: false` through rev c; the shipped `EntityDefinition` has always carried `local?: boolean` — `src/types.ts`. The behaviour was never in dispute, only the name, and the published name wins.)*
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

## Rev d (2026-08-02) — the 20 resolutions

Writing the Allium specification of this contract surfaced 20 unresolved points, all recorded as `open question` declarations in `docs/specs/sync-adapter.allium` so none could be lost (DAN-736). Re-reading the ADR would not have found them: a specification forces every clause to be *representable*, and four of them were not. `allium analyse` independently flagged one as a dead trigger.

Eighteen of the twenty were new — exposed by the transcription itself. The other two, D19 and D20, were points this ADR had already been carrying open in its own Consequences section since rev b; the spec merely refused to let them stay unnamed. All twenty are resolved below, so **the count in this heading is the whole set and not a subset.**

These were resolved at the cheapest moment they will ever have — the contract is frozen and the coordinator is unbuilt. **ADR-022 line 5 is why the moment matters:** wire shapes stop being ours the day a real backend speaks them, and both sides are then not ours to upgrade together.

**Every change below is additive except D1, which deletes a path that never had a wire representation.**

### The four contradictions between sections

**D1. The checkpoint confirmation path is deleted. `confirmedMutations` is the sole confirmation channel.**

§1b offered two ways to confirm a mutation: `confirmedMutations` marks, or "a pulled checkpoint ≥ the ack's serverVersion". `PullResult` carries no checkpoint field, so the second was never implementable.

It is deleted rather than built, and the reason is not that it was unimplemented. **A checkpoint comparison asks "is checkpoint ≥ serverVersion", which presumes versions are totally ordered — and C2 exists precisely to keep them partially ordered so a vector clock or HLC stays representable.** Keeping both paths means keeping one that only works when the other constraint is switched off. The surviving path costs a backend nothing extra, because per-client seq tracking is already mandatory (`LocalChange.seq`: "server ignores seq ≤ lastSeen, rejects gaps").

**D2. `transform` splits into two effects: the id remap is immediate, the overlay waits.**

§1 said transform "applies the server's corrected entity and any id remap **then completes**." §1b said overlays drop only on pull confirmation. Both could not be true.

The resolution is that these were never one operation. **The id remap must apply immediately** — queued outbox entries still reference the temp id and would otherwise keep pushing it. **The overlay drop must wait** — dropping on the push channel is the exact double-apply race §1b was written to kill. So `transform` behaves like `ack` for confirmation purposes and like a local identity correction for the remap. Only `reject` acts entirely on the push channel, which is safe because a reverted write has nothing left to double-apply.

**D3. The comparator is four-valued, adapter-supplied and optional.**

```typescript
type VersionOrder = "older" | "same" | "newer" | "concurrent";
compareVersions?(a: string | number, b: string | number): VersionOrder;
```

C2 requires this seam to express a partial order; three values cannot say *concurrent*. The default comparator — numeric for two numbers, lexicographic otherwise — **never returns `"concurrent"`**, so the fourth value costs a server-authoritative deployment nothing. It exists so a future E2EE or CRDT-ish adapter has somewhere to put causality that today's code will already route through.

**This is the same decision as the pre-publish `version` widening.** `StorageEngine.version` was widened from `number` to `string | number` on 2026-08-01 so that a hybrid logical clock stays representable in the slot. A four-valued comparator is what makes that widening mean something: an HLC that can only report a total order is just a slow integer.

*Coordinator policy on `"concurrent"` is in §3 — the remote change is applied, arrival order is the tiebreak.* *Widening: commit `10b9b74`, ADR-022 Open section.*

**D4. Sibling-outbox adoption is relay, not authorship — and authentication material is minted at commit time.**

§1c has a booting tab push a crashed sibling's stranded entries, stamped with that sibling's `clientId`. C3 wants `clientId` to be able to *be* a public key. An adopting client cannot sign as someone else.

The reconciliation: **the adopter forwards an entry exactly as it was committed, and the server verifies the entry, not the sender.** The constraint that makes this true, and the only expensive part if it is missed: **any authentication material must be attached to the outbox entry at `commit()` time and persisted with it, never computed at `push()` time.** Sign at push time and the recovery mechanism silently stops working the day `clientId` becomes a key.

Also pinned, because it was assumed and never stated: **adoption is same-device only.** Siblings are tabs and workers sharing one StorageEngine. Cross-device adoption was never on the table and would require exactly the authorship this rules out.

C3 stands unchanged.

### The undefined referent

**D5. A subscription is an opaque, adapter-named partition of the pull stream.**

`PullResult` specified per-subscription checksums and per-subscription reset; `pull(cursor, opts)` was global. There was no partition unit at all.

> **The coordinator knows a subscription's name and its cursor. It never knows what predicate produced it.**

- `pull()` takes `opts.subscription?: string`; both `PullResult` variants echo `subscription?: string`.
- Absent means the single default partition — so the entire single-subscription case is unchanged, and this is why the change is additive rather than a break.
- The coordinator holds `Map<subscription, cursor>` and nothing more. The adapter owns the namespace and declares the set.
- **Core never parses the string** — the same discipline C3 imposes on `clientId`.

**This is the shape C2-1 dictates, not a shape chosen for convenience.** C2-1 is the sharpest one-way door in this ADR: core must never learn what a server-side shape is, because a relay that cannot decrypt your data can never evaluate a predicate. An opaque name is the most a partition can be without foreclosing E2EE permanently. It also gives D15 (tombstone retention) and item 20 (priority-tiered hydration) somewhere to attach when they land.

### The two naming drifts — the ADR moved, because the code is published

**D6.** Origin stamp: §2 said `remote`; shipped `WriteOrigin` says **`sync-pull`**. *`src/types.ts:149`*
**D7.** Device-local flag: §5 said `sync: false`; shipped `EntityDefinition` carries **`local?: boolean`**. *`src/types.ts:666`*

Neither behaviour was ever in dispute — only the name. These read like coin flips until you notice one side of each is on npm as of `colada-db@0.1.0`. Changing a document costs nothing; changing a published type is a migration on someone else's disk. §2 and §5 above now carry the shipped names.

### The four unspecified values

**D8. `limit` is a hint, not a contract.** The coordinator suggests `opts.limit` (default 500); an adapter MAY return fewer and MUST NOT return more. Omitted means the adapter chooses. Core imposes no ceiling — a backend knows its own page size and this contract does not.

**D9. Exponential backoff with full jitter, 1s → 60s cap, no attempt ceiling, and deliberately no dead-letter queue.**

This is the one with real teeth. **A dead-letter queue silently drops a user's write, and staying visibly stuck is strictly better than that.** The correct behaviour for a job queue is the wrong behaviour for a local-first database, where the outbox is durable and "offline" is indefinite by design. What a ceiling would buy — bounded growth — is not worth what it costs: the one failure mode this whole contract is built to prevent.

What replaces the ceiling is **observability, not truncation**: the coordinator exposes retry state so the application can surface "this write has not landed" to the human, who can then decide. A write is dropped by a user or by a `reject`. Never by a timer.

**D10. Reset jitter: uniform random in `[0, 30s)`, drawn independently per subscription.** Independence is the whole point — a shared draw is the thundering herd with extra steps.

**D11. Checksum verification is presence-driven, not flag-driven.** Verify iff the adapter supplied a `checksum`. A mismatch resets that subscription and only that one. This deletes a configuration knob: an adapter that sends a checksum is asserting it means something, and a flag that lets a client ignore it makes the field decorative.

### The seven behavioural silences

**D12. `schemaVersion` mismatch never drops writes.** On pull, a backend that cannot serve the client's schema version returns `reset`. On push, it throws a typed `SchemaVersionError`; the coordinator **suspends** the outbox and surfaces the state — it does not drain it, and it does not discard it. A schema bump may need an application-level migration, and the outbox is the one thing that must survive one.

**D13. A server-directed `reset` discards entity state, never the outbox.** `mutationId`s and seqs stay valid and the client resumes pushing the same range. Reset is a statement about the *pull* stream; seq is a fact about the *write* stream, tracked per client on the server. They are independent, which is why the outbox lives in a separate durable store to begin with (§1).

**D14. Id-remap fan-out: rewrite dependent ids, and clear their `baseVersion`.** A `baseVersion` referred to a version of an entity that no longer exists under that key, so carrying it forward asserts something false. For a dependent entry **already pushed** under the old id: the server owns the remap, so the server applies it to entries it has already accepted. The client's rewrite is local bookkeeping and never a second request.

**D15. Tombstone retention, stated as an obligation a conformance kit can check:** a backend MUST retain tombstones at least as long as the oldest cursor it will honour. Compaction that drops tombstones MUST invalidate the affected cursors, which the client observes as `reset`. This turns "how long?" — unanswerable in general — into a relation between two things the backend already knows.

**D16. An inline `reset` on the live channel is a poke, never an instruction.** Inline `changes` may be applied only if they carry a cursor that advances that subscription's cursor monotonically; an inline `reset` schedules a pull and nothing else. The reasoning is forced by the channel's own definition: `subscribe` is licensed to be lossy, and **a lossy channel must never be able to destroy state.**

**D17. At most one push in flight per client; push and pull MAY overlap.** Concurrent pushes are unsound against "ordered delivery, server rejects gaps" — two in flight is a gap the moment either is retried. Overlap across directions is safe, and D1's confirmation rule is exactly what makes it safe.

**D18. An unregistered entity type arriving on pull is applied; a device-local type arriving on pull is ignored and warned.** These look symmetrical and are not. The store keys rows by `Typename:id` and needs no definition to hold one — `EntityDefinition` is consumed by `normalize.ts` alone and never by `store.ts` — so applying an unregistered type loses nested-ref normalization, not the data. A device-local type is different in kind: `local: true` is the *client's* declaration that this type never leaves the device, so receiving one back means the server has data it should never have had. Dropping it is correct and saying so out loud is how anyone finds out.

*Verified: `src/normalize.ts:38,85,98,175`; no `EntityDefinition` reference in `src/store.ts`.*

### D19 and D20 — the last two, resolved rather than deferred

An earlier draft of this section left these open as "additive later, not one-way doors." **That was wrong, and Danny caught it.** The claim is true of the *fields* and false of the *contract*: adding a second way to express a write to a protocol other people's servers already speak means every adapter thereafter must handle both. That is not a deferred decision, it is a permanent wart purchased with a deferral — the exact calcification this ADR was frozen early to prevent.

The general form is worth stating, because it governs the next revision too. **The old reason to leave a specification unfinished was that building teaches you things, so learning beat guessing. When implementation is cheap and the thinking is the expensive part, that trade inverts.** A hole in a spec is not humility; it is a decision handed to whoever implements it, who fills it by accident and makes it permanent. What survives from the old instinct is not the blank — it is **writing down what would prove the decision wrong.** Each resolution below carries its falsification test.

**D19. `LocalChange` gains an optional `intent`; `data` stays required.**

```typescript
interface LocalChange {
  // ... as above
  data?: EntityRecord;              // unchanged: the computed patch
  /** OPTIONAL. The mutation's INTENT — a named mutator and its arguments
   *  (Zero / Replicache style). A matched client+server pair replays this
   *  server-side for true rebase. An adapter that does not understand it
   *  ignores it and applies `data`. */
  intent?: { name: string; args: unknown };
}
```

The fork is whether an outbox entry carries the **result** of a mutation or its **intent**. Intent is strictly more powerful: a server that can replay the named mutator against post-apply state rebases properly, rather than accepting or rejecting a patch computed against stale state.

**What decides it is this plugin's identity, not the power ranking.** Replicache and Zero can require intent because they ship the server — the same mutator code exists on both sides by construction. colada-db's whole premise is bring-your-own-backend, and a REST API someone already operates cannot execute a function from your client bundle. **A contract that requires shared code is not backend-neutral.**

So intent is an adapter-level capability, exactly as `transform` is (§C3: the posture lives in the adapter, not the store). `data` stays required so any backend can apply a change with no shared code; `intent` is an enrichment a matched pair may use. If a replayed intent produces a different result than the submitted `data`, the server wins and reports it through `transform` — the channel already exists, and no new verdict is needed.

*Falsification: if the first two real adapters both populate `intent` and neither meaningfully uses `data`, then `data` was the optional one and this is inverted. If no adapter populates `intent` within a year of `restAdapter` shipping, the field was speculative and should be deprecated rather than left as decoration.*

**D20. Priority is a property of a subscription. No wire field, no coordinator tiers.**

D5 defined subscriptions as independently-cursored named partitions, which is already the whole mechanism: the coordinator issues initial pulls **in declared priority order** and does not wait for one to complete before starting the next.

Not waiting is the load-bearing half. Strictly serial hydration would let one slow high-priority partition block everything behind it — head-of-line blocking, which is a worse failure than unordered hydration and much harder to diagnose. Ordering the *starts* gets the important data moving first without ever letting it stall the rest.

For a phone supervision client this is the difference between "gates render, history fills in" and "wait for everything." **That is a product-visible property obtained with zero additions to the wire**, because D5 had already put the seam in the right place — this ADR simply had not finished the sentence.

*Falsification: if a real client needs priority ordering **within** one partition, then the subscription is the wrong unit and `PullResult` does need a priority field after all.*

**There are now no open questions in this contract.** The Allium spec's Open Questions section is empty by decision, which is a checkable state rather than a claim.

## Alternatives Considered

- **Adopt a vendor's protocol wholesale (PowerSync's or Electric's):** fastest to one backend, but the plugin's identity is backend-neutrality; the vendor protocol becomes *an adapter*, not *the interface*.
- **CRDT merge layer:** wrong fit for entity-graph + server-of-record apps (and cr-sqlite is dead — ADR-005); revisit only if a collaboration-editor use case ever becomes primary. **Concrete tripwire (2026-07-23):** SweeAI's `docs/product/ARCHITECTURE.md` open question #1 (graph edge type: feed/fork/collaborate/ambient — "current read: fork is the spine... settle before building") is the real trigger. If that resolves toward **collaborate** as a first-class spine edge instead of fork, re-open this decision — "collaborate" is defined there as "agents from A and B share work, needs multi-party ceiling algebra," which is the collaboration-editor case named above. Until then M0's own scope ("no social, no sharing, no feed") means the trigger has not fired. Candidate library if it does: Automerge (git-like change history maps onto provenance/recency needs directly), Loro as a benchmark-watch alternative — see `core/projects/colada-db-project/knowledge/competitive-landscape-2026-07-23.md`. **Ceiling caveat (council verdict, 2026-07-23):** a CRDT merges data correctly but cannot undo an already-executed overspend against a SHARED mutable ceiling — that's a reservation/partition problem, not a merge problem (Helland's reservation pattern; Miller's object-capability partitioning). If collaborate ships, ceilings must be split into disjoint per-agent sub-grants up front (a one-time, infrequent, atomic allocation step), never modeled as one shared pool renegotiated live — the latter still needs a live arbiter regardless of which CRDT library is chosen.

**Companion decision (2026-07-24):** SweeAI's `docs/adr/001-graph-edge-adopt-as-spine.md` tracks the identical question from the product side (ADOPT vs. COLLABORATE as the graph-edge spine). These two ADRs should be revisited together — a change on one side almost certainly implies a change on the other.

**Status update (2026-07-24):** SweeAI's `SEMANTIC-MODEL.md` "The graph edge — DECIDED (council, 2026-07-23)" confirms **ADOPT**, not collaborate, as the spine — three independent seats, reasoning: "Adopt is the only edge where the kernel is a feature instead of plumbing. Follow, collaborate, and ambient all work fine on a platform with no trust ceiling." This tripwire is confirmed **unfired**, and per that same reasoning, may never fire in the ceiling-sensitive form anticipated above — collaborate is explicitly kernel-decoupled, so it may ship without ever touching mandate/ceiling enforcement at all. (Note: SweeAI's `ARCHITECTURE.md` open-questions list still shows this as unsettled as of the same date — doc drift between two SweeAI files, flagged there, not resolved here.) Re-check this note if SweeAI's docs change again.
- **Event-sourcing (LiveStore-style):** powerful but demands the app re-model everything as events; violates the drop-in-plugin identity.

## Consequences

- Positive: three-method adapter surface = trivial to implement against any REST/GraphQL/WS backend; outbox reuses shipped machinery; the contract can be documented and community-tested before the coordinator exists.
- Negative: server-authoritative means offline conflicts resolve by server verdict, not merge — a known, documented tradeoff.
- Risks: Proposed status signals fields may still be added (not changed) before Stage 3 lands. Rev b absorbed the battle-test round (schemaVersion, reset, checkpoints, client identity, tombstones, error taxonomy, id remap); **rev d absorbed the specification round** — 18 of the 20 points writing the Allium spec exposed, including the four contradictions between sections. Checksum defaults resolved at D11. Remaining open at implementation time, both additive and neither a one-way door: named-mutator rebase (`{name, args}` on LocalChange — composes with Zero-style shared mutators) and priority-tiered hydration.
- Where this contract is already ahead of the field (from the battle-test): first-class `mutationId` (RxDB has no mutation identity), multi-entity transaction groups (RxDB's atomic unit is one document), `transform` as a server-rebase channel (PowerSync and Electric have nothing equivalent), and per-`Typename:id` invalidation granularity (finer than LiveStore's per-table).
