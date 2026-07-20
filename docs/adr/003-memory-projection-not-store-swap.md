# ADR-003: SQLite Is a Durability Substrate, Not a Store Swap

**Status:** Accepted
**Date:** 2026-07-12

## Context

Phase 4 was originally framed as "SQLite + WASM + OPFS adapter (Level 3 — full EntityStore implementation, not decorator)". The EntityStore read contract is deliberately synchronous: `get()` returns a ref immediately, the plugin's customRef getter denormalizes on every read, and `enablePersistence` load-bears on `subscribe` firing synchronously inside `set()`. SQLite-WASM over OPFS runs in a worker (sync access handles are worker-only), so every main-thread read is async. A direct swap cannot satisfy the contract.

## Decision

The in-memory store remains the **synchronous read projection** — the only thing queries and composables ever touch. Durable engines (IndexedDB today, SQLite-WASM/OPFS next) sit **underneath** as write-behind substrates:

- Boot: bulk-load from the engine → `hydrate()` into memory.
- Runtime: `subscribe()` → batched writes down to the engine.

This is the Linear thick-client model, and `enablePersistence()` (persist.ts) is already the reference implementation of the shape. The SQLite adapter is `enablePersistence` with a different engine — same wiring, plus SQL queryability and versioned rows.

Engine choice (verified 2026-07-12): official `@sqlite.org/sqlite-wasm` with the `opfs-sahpool` VFS in a dedicated worker — canonical build, fastest OPFS option, **no COOP/COEP headers required** (a real constraint for a plugin that doesn't control deployment). Multi-tab via Web Locks leader election (one tab owns the DB, others proxy over BroadcastChannel). Design the adapter behind an engine interface so wa-sqlite (`OPFSCoopSyncVFS`) is a drop-in if VFS-level multi-tab is ever preferred.

## Alternatives Considered

- **Async EntityStore contract:** poisons every read path (customRef getter, denormalize, composables) with async; destroys the plugin's core UX of synchronous reactive reads.
- **Full store swap with sync XHR-style blocking:** not possible on the main thread; OPFS sync handles are worker-only.
- **Turso database-wasm:** browser build exists (Oct 2025) but pre-1.0 beta, several-MB wasm, and requires COOP/COEP. Re-evaluate at 1.0.

## Consequences

- Positive: zero changes to the read path; persistence stays swappable; memory stays the source of UI truth.
- Negative: memory holds the working set (projection ≠ full DB); large datasets need an eviction policy (see ADR-004) and query-driven partial hydration later.
- Risk: dual-representation drift between memory and engine — mitigated by write-behind being the ONLY writer of the engine, and hydrate being the only reader.
