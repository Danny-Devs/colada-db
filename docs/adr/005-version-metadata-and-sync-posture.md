# ADR-005: Version Metadata Slot + Sync Posture (cr-sqlite Is Dead)

**Status:** Accepted
**Date:** 2026-07-12

## Context

Nothing in the entity pipeline carries causality: fresh-wins hydration is existence-based (`!store.has(...)`), merges are field-blind spreads, and `EntityEvent` has no version. Any sync layer needs to arbitrate "which write is newer" — arrival order is not an answer once remote changes and in-flight HTTP responses interleave.

The original Phase-4 sync plan was **cr-sqlite** (CRDTs inside SQLite). Verified 2026-07-12: the project is effectively dead — last release v0.16.3 (Jan 2024), last repo push Oct 2024, npm wasm package unpublished-stale since Dec 2023. Its author moved to Rocicorp to build Zero. Nothing has filled the exact "CRDTs inside SQLite" niche.

## Decision

1. **Reserve the slot now, populate later:** `EntityEvent.version?: string | number` exists as of this ADR. The in-memory store never fabricates versions; durability/sync backends attach real ones (engine row version, server `updatedAt`). This is deliberately an *optional metadata slot*, not a causality system — the cheap part is freezing the shape before an adapter calcifies it.
2. **Pagination containers are device-local.** Merge recipes (`cursorPagination`, `offsetPagination`, `relayPagination`) are order-dependent and non-commutative — CRDT-hostile by construction. Paginated container entities are excluded from replication; each device rebuilds its own pages from queries. Only leaf entities replicate.
3. **Sync posture (replaces the cr-sqlite plan):** server-authoritative sync, not P2P CRDT. Candidates when Phase 4's sync stage arrives, in current order of production-readiness: **PowerSync** (mature, syncs to existing Postgres/MongoDB/MySQL, funds the wa-sqlite OPFS ecosystem), **Turso sync-wasm** (embedded-replica model, last-push-wins + transform hook, pre-1.0 — re-evaluate at 1.0). If true CRDT merge semantics ever become a requirement, that's Automerge/Yjs at a document layer — a different product decision, taken to council first.
4. **Version-aware fresh-wins:** when versions exist, hydration and remote-apply compare versions instead of existence. Until then, existence-based fresh-wins stands (documented limitation).

## Alternatives Considered

- **Build on cr-sqlite anyway:** dead upstream, wasm package stale for 2.5 years. No.
- **Full causality metadata now (site-id, column-level versions):** speculative until the sync engine is chosen; the engine dictates the shape. Reserve, don't build.
- **Zero (Rocicorp):** excellent, GA June 2026, but it *replaces* the cache layer wholesale and requires running zero-cache server-side — it competes with this plugin rather than plugging into it.

## Consequences

- Positive: event shape is future-proofed at near-zero cost; the sync decision is de-risked and explicitly server-authoritative; pagination can't silently corrupt replicated state.
- Negative: no conflict arbitration until a backend populates versions; multi-writer optimistic scenarios (ADR-004's remaining MED finding) stay single-writer-assumed until Phase 4's sync stage.
- Risk: PowerSync/Turso landscape may shift; the decision point is "when Phase 4 sync stage starts," not now.
