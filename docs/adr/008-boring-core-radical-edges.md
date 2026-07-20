# ADR-008: Boring Core, Radical Edges (the Port Map)

**Status:** Accepted
**Date:** 2026-07-19

## Context

colada-db extracted into its own repo (2026-07-19) with a mandate from Danny: AI as a first-class citizen, framework-agnostic ("Vue preferred, not wedded"), and the "layer game" — abstract the commoditizing outside world (sync vendors, model providers, signal libraries, in-flux standards) away from users. Council deliberation (2026-07-19, six voices) resolved the three load-bearing forks. Market facts feeding the decision: 8/10 peers are standalone-core + adapters; nobody monetizes adapters or normalization; RxDB charges $99/mo for encryption-at-rest; the four-leg AI seat and data-locality routing lane are empty but bracketed (Electric/Turso/LocalMode).

## Decision

### 1. The core stays boring — and that is the AI strategy

Zero AI code in core. The core's contribution to AI is its **primitives** (ADR-007: origin tags, pre-apply `willCommit` gate, capped history store, machine-legible schema export) — timeless database virtues that happen to be exactly what agents need. AI *capabilities* ship as first-party **edge packages** the core knows nothing about.

### 2. Everything volatile is a port we own

| Port | Contract | Status |
|---|---|---|
| Storage | `StorageEngine` | shipped (memory / IDB / OPFS SQLite) |
| Sync | `SyncAdapter` (ADR-006) | frozen, Stage 3 |
| Framework | adapter-facing subscription boundary (§3) | this ADR |
| Agent surface | MCP server package over schema export + query surface | Stage 2c |
| Encryption | `encryptedEngine(inner, keySource)` — a StorageEngine wrapper | edge package, FREE (commoditizes RxDB's paid tier; adopted from the council's dissent) |
| Model / routing | deferred port; data-locality signal comes from the store (see knowledge/routing-landscape.md) | after MCP |
| Vector | deferred; optional index over the query surface, never the product | watch item |

Churn outside a port becomes a free upgrade for users, never a breaking change. A port is added when a real consumer exists — never speculatively.

### 3. Reactivity: `@vue/reactivity` inside, a subscription boundary outside

The core keeps `@vue/reactivity` as its internal signal engine (battle-tested, standalone, the engine Vue itself trusts). **Framework adapters never import the signal library.** They consume a thin boundary: entity/store events + synchronous snapshot getters (`subscribe`/`get`), the shape `useSyncExternalStore`-class APIs expect in every framework. Consequences: a future swap to TC39 Signals (flip-trigger: Stage 2/3 advancement) is a non-event; and the Vue adapter MAY bypass the boundary to share refs natively — that privileged path is Vue's structural advantage, kept deliberately.

### 4. Sequencing: the Vite playbook

Win Vue completely (the plugin = adapter #1, the only occupied seat we hold) → prove the core on vanilla JS (the MCP/agent demo runs framework-free) → add React ONLY when the boundary is frozen by two real consumers (Vue + vanilla). Two adapters, not five: every adapter is a product maintained forever.

### 5. The reach-for moment is the agent demo

The wedge is filmable: "open Claude; it sees and safely edits your app's local data — deny-by-default, with receipts." Requires only Stage-2c scope (schema export + MCP + gate). No peer can film it (none has both a normalized store and a policy gate). Boring reliability is the retention; the demo is the acquisition.

## Alternatives Considered

- **AI features in core** (embeddings, model calls): rejected — dates the library, bloats the neutral substrate, violates the trust-layer separation (ADR-007's product/primitive split).
- **Hand-rolled or third-party-new signals** (alien-signals direct, custom): rejected — re-creates TanStack's two-graph friction and buys nothing the boundary doesn't.
- **All-frameworks day one**: rejected — adapter tax without consumers; contradicts the Vite playbook evidence.
- **Sync-first identity** ("another Zero/Electric"): rejected — sync is the commoditizing layer; it's a port here, not the product.

## Consequences

- Positive: outside churn is absorbed at ports; the AI story can't rot the core; Vue keeps a privileged fast path; a complete fallback identity exists if the AI wave cools (Kleppmann's dissent, kept pinned: "the encrypted, user-owned local database with receipts" — same architecture, re-titled).
- Negative: the subscription boundary is one more contract to design well NOW (chip-2/Stage-2 adjacency); edge packages multiply release surface.
- Risks / watch: Electric wiring vector+embeddings into TanStack DB (accelerate Stage 2c); `@tanstack/vue-db` shipping real features (Vue window narrowing); TC39 Signals advancing (schedule the swap).
