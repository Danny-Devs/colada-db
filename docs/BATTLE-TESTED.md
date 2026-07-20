# Battle-Tested: what colada-db took from the field — and what it refuses

colada-db is a deliberate amalgamation: the surviving lessons of 12+ production local-first systems, composed — and their documented failures, structurally prevented. This is the receipts ledger. Sources are primary (post-mortems, issue trackers, engineering blogs); the research corpus lives in the project knowledge base.

## Adopted: the best practice per system

| From | What we took | Where it lives |
|---|---|---|
| **Linear** (Artman) | The body plan: in-memory object graph read synchronously + durable substrate underneath + server-authoritative deltas + optimistic transaction queue. And the anti-CRDT prior: "conflicts are rare — don't over-engineer." | ADR-003, ADR-005, ADR-006 |
| **Notion** | The OPFS VFS that needs **no COOP/COEP headers** (the alternative broke their third-party scripts); single-writer discipline (their concurrent-tab rollout corrupted data: comments attributed to the wrong coworker); Web-Locks leader election blueprint | `sqliteEngine` (ADR-003); Track B |
| **TinyBase** | The `willCommit` veto gate — a validation hook that becomes THE agent-policy enforcement point; transaction-end netting (A→B→A emits nothing) | SHIPPED 2026-07-19 (`useGate` — amended per audit: the veto runs PRE-APPLY, commit-time is last-chance; `policy-gate.spec.ts`). Netting: not adopted (events stream per-write by design) |
| **Evolu** | The capped, queryable history store (`{entity, field, old→new, origin}`) — undo substrate that doubles as agent receipts; `local:`-only entity tier | SHIPPED 2026-07-19 (`enableHistory`, + purge-on-remove erasure beyond Evolu's design; `history.spec.ts`). `local:` flag declared + exported now; sync honors it in Stage 3 (ADR-005) |
| **Replicache** | Pull-channel confirmation (`lastMutationIDChanges`) killing the push-ack/pull-snapshot double-apply race; poke-then-pull; per-client `(clientId, seq)` identity; zombie-tab outbox recovery; undo of pushed changes = compensating forward mutation | SyncAdapter contract (ADR-006 §1b, §1c) |
| **PowerSync** | Write watermarks/checkpoints; the permanent-vs-transient rejection taxonomy (the #1 frozen-queue cause in the wild); checkpoint-atomic batched pulls (resumable initial sync); priority-tiered hydration | ADR-006 (PushResult semantics, PullResult.complete) |
| **TanStack DB** | Overlay+replay optimistic model + mutation-merge table (insert+delete annihilate → free outbox compaction); predicate-subsumption idea for partial sync | ADR-006 notes; Stage-2/3 design |
| **Zero** (Rocicorp) | The query as the unit of hydration/subscription/sync; `preload()`; instant-then-fresh read posture; the KV-without-relations lesson (why Replicache was superseded) | Stage 2b (persisted query manifest) |
| **RxDB** | The `reset` verb (cursor expiry → per-subscription jittered resync); `assumedMasterState` (rejection carries authoritative state) | ADR-006 (PullResult reset) |
| **LiveStore** | Versioned OPFS directories (`store@version` = fresh dir, not migration); **state DB separate from outbox files** (nuke state without losing unpushed writes); leader-worker topology | ADR-006 coordinator notes; Track B |
| **WatermelonDB** | Two-tier query observation (`canEncodeMatcher`: simple filters run in-memory against change-sets, complex ones re-run); raw-JSON-string worker payloads (up to 5.3× vs structuredClone); dirty-column sync bookkeeping | Stage 2d (filter AST); Track C3 |
| **Dexie** | Canonical mutation event + coarsen-on-bulk + BroadcastChannel echo suppression (the cross-tab bus); middleware pipeline shape; numbered schema versions with upgrade callbacks | Track B2; Track C5 |
| **Solid** | The ~60-line keyed array diff (reconcile), without cell-level tracking | Stage-2 reactivity notes |
| **Vue** (structural) | Lazy computeds — off-screen queries cost zero on write (LiveStore ticks eagerly per table); ONE reactive graph end to end, no second signal system shimmed in | core (`@vue/reactivity`), ADR-008 §3 |

## Refused: their documented failures, structurally prevented

| Scar (source) | The failure | How colada-db prevents it |
|---|---|---|
| Dexie #2034 | Cache returned NEW object instances for unchanged rows → `===` broke downstream, everything re-rendered | Referential stability is a pinned contract: `referential-stability.spec.ts` (identity across unrelated writes, no-op writes emit nothing, structural-sharing denormalize) |
| Dexie #2058 | Cache crash filtering optimistic ops after expected write rejections | Optimistic-op cleanup regression tests (Track A2, lands with chip 2.5) |
| WebKit 226547 | `indexedDB.open()` hangs forever — no callback at all — hanging app boot with it | Per-attempt deadline + retry + memory-only degradation: `safari-armor.spec.ts` |
| Quota eviction (the real durability risk) | Browser silently wipes an origin's storage under disk pressure | `requestDurableStorage()` / `enablePersistence({requestDurable})` |
| Notion's corruption incident | Every tab writing OPFS concurrently → users saw wrong data | Single-writer discipline; Web-Locks leader election (Track B1) |
| TanStack #1017 | Sync globally blocked into collections while ANY optimistic mutation pending | Contract scopes the buffer per entity key/mutation, never a global gate |
| TanStack #893 cluster | Temp-ID → server-ID remap as an afterthought = their largest issue cluster | `transform` is a first-class verb with atomic remap in PushResult |
| PowerSync top gotcha | Transient failure misclassified as permanent rejection → frozen outbox forever | `reject` = permanent ONLY; transient = thrown error + backoff; server must advance seq on permanent-invalid |
| Replicache-era race | Push-ack and pull-snapshot interleave → double-apply, rubber-band UI | Confirmation rides the pull channel; overlay dropped only at pulled watermark |
| RxDB pre-16 | Uncheckpointed initial sync → O(N) stall, restart from zero on interrupt | Checkpoint-atomic batched pull; staged apply at `complete` |
| LiveStore #136 | Unbounded eventlog without compaction | Not event-sourced (deliberate, ADR-006 alternatives); history store is capped with byte budget (DAN-577) |
| cr-sqlite | Betting the sync layer on an abandoned dependency (dead since 2024) | Sync is a port (`SyncAdapter`), never a dependency bet; server-authoritative posture (ADR-005) |
| RxDB's business model | $99/mo for client encryption & fast storage | Production-grade storage free; `encryptedEngine` planned FREE (Track C4) |

## Where the contract is ahead of every shipped peer (from the 12-system battle-test)

- **First-class mutation identity** (`mutationId`, HLC-style) — RxDB has none.
- **Multi-entity transaction groups** — RxDB's atomic unit is one document.
- **`transform` as a server-rebase channel** — PowerSync and Electric have no equivalent.
- **Per-`Type:id` invalidation granularity** — finer than LiveStore's per-table ticks.

*Maintained as part of Operation Spick-and-Span (2026-07). Every row either cites a shipped artifact in this repo or names the track that ships it.*
