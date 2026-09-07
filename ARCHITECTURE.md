---
title:       colada-db architecture
kind:        architecture
status:      active
updated:     2026-09-06
owner:       danny
verified_by: "N/A — narrative; revisit a couple of times a year, do not sync with code"
---

# Architecture

This is the map. It names files, types and functions and never line numbers,
and it states the invariants that are easiest to miss because they are
*absences* — things the code deliberately does not do. For why a thing is the
way it is, read the ADR it cites. For what changed, `CHANGELOG.md`.

## Bird's-eye view

colada-db is a **normalized entity graph in memory, with durability underneath
and agents held at arm's length.**

```
                     app / framework adapter
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     ▼                     │
        │            StoreBoundary (boundary.ts)     │   ← the only door adapters use
        │                     │                     │
        │   ┌─────────────────┴────────────────┐    │
        │   │   EntityStore  (store.ts)         │    │   reactive projection — reads never await
        │   │   normalize.ts · matcher-view.ts  │    │
        │   │   transactions.ts · history.ts    │    │
        │   └───────┬──────────────┬────────────┘    │
        │           │              │                 │
        │   persist.ts        coordinator.ts         │   write-behind · sync (on main, unexported)
        │           │              │                 │
        │   StorageEngine      SyncAdapter           │   the two ports (ADR-008)
        │   memory · idb ·     restAdapter ·         │
        │   sqlite (OPFS)      wire protocol v1      │
        └───────────────────────────────────────────┘
                              │
                packages/mcp  (read-only agent surface, ADR-011)
                packages/react (useSyncExternalStore binding, ADR-008 §3)
```

Memory is the source of UI truth. Everything below it is a **port** with a
narrow contract, and everything beside it is an **edge** that consumes the
boundary and knows nothing about the internals (ADR-008, "boring core,
radical edges").

## The core

**`store.ts` — `EntityStore`.** A `Map` of `entityType:id → EntityRecord`,
reactive through `@vue/reactivity` (standalone, no Vue runtime). `set` /
`replace` / `setMany` / `update` / `remove` / `evict`, refcounted retention
with `gc()`, and one event stream. `getByType` is a projection recomputed from
the map. Every write passes through `runWith({ origin })`, which is how a
`WriteOrigin` gets stamped (ADR-007).

**`normalize.ts`.** `normalize()` walks a nested payload and lifts every
entity out once, leaving an `EntityRef` in its place; `denormalize()` resolves
refs back with structural sharing. `__typename` is the only auto-detection;
everything else is a `defineEntity` declaration (`types.ts`).

**`transactions.ts` — `createOptimisticUpdates`.** Optimistic writes with
clear-and-replay rollback, a pre-apply **policy gate** (`useGate`), and a
commit-time last chance (`willCommit`). A veto means the write never touched
the store — `PolicyVetoError` is thrown before apply, not after.

**`matcher.ts` + `matcher-view.ts`.** A serializable filter AST (`M`,
`parseMatcher`, `evaluateMatcher`) that **fails closed** — anything the
classifier cannot prove maintainable from change events falls to a re-scan
(ADR-009). `createMatcherView` keeps a reference-stable ids array over it
(ADR-010).

**`history.ts` — `enableHistory`.** A capped field-level change log with
purge-on-remove erasure. **`schema.ts` — `exportSchema`.** The entity registry
as plain JSON, the machine-legible surface an agent reads first.

**`boundary.ts` — `StoreBoundary`.** `subscribe` (global), `subscribeType`,
`subscribeEntity`, plus synchronous snapshot getters. This is the whole
contract a framework adapter is allowed to depend on; it is the exact shape
`useSyncExternalStore` wants, which is why `packages/react` is thin.

## Durability

**`persist.ts` — `enablePersistence(store, { engine })`.** Boot hydration
(`loadAll` or manifest-scoped `loadMany`), then `store.subscribe → dirty set →
debounced engine.writeBatch`. It owns everything engine-agnostic: evict-vs-remove
semantics (ADR-004), the in-flight overlay that keeps pending truth visible
until the engine acknowledges (ADR-015), the optimistic mask (ADR-016), and
graceful degradation — an engine failure disables persistence and the
in-memory store keeps working untouched.

**`engines/` — the `StorageEngine` port.** `memory` (tests, SSR), `idb`
(default; Safari-hang armor), `sqlite` over OPFS `sahpool` in a worker
(`sqlite-worker.ts`, `sqlite-core.ts`, `sqlite-protocol.ts`; no COOP/COEP
headers). All three are run against one contract kit,
`engine-conformance.ts`, and the persisted format shares one `cdb` prefix and a
reserved `formatVersion` slot (ADR-018).

**`coalesce.ts`.** The debounced batch flusher shared by persistence and
matcher views.

## Sync (on `main`, not exported — ADR-022)

**`sync-types.ts` — `SyncAdapter`.** Three methods, `push` / `pull` /
`subscribe`, server-authoritative and deliberately CRDT-free (ADR-005,
ADR-006). **`coordinator.ts` — `enableSync(store, { adapter })`.** A durable
outbox of locally-committed writes, push with per-mutation verdicts, pull with
version-aware apply, and revert-and-replay for rejected or transformed
mutations. **`rest-adapter.ts`** is the reference adapter speaking
**`wire-protocol.ts`** v1 (`docs/protocol/sync-wire-protocol-v1.md`, ADR-023).
`sync-conformance.ts` and `coordinator-conformance.ts` are the contract kits.

## The edges

**`packages/mcp`.** An in-page MCP server over a `StoreBoundary`: schema
resource, query tool (matcher-AST filters, validated fail-closed), optional
history tool. Per-type allowlist; every data result marked untrusted. Runs
over `InMemoryTransport` today (ADR-011).

**`packages/react`.** `useStoreVersion`, `useEntity`, `useEntities` —
`useSyncExternalStore` over the boundary. `useEntities` caches per
`(boundary, type)` with structural sharing so an unchanged type returns the
same array.

## Invariants, especially as absences

- **Architecture Invariant:** reads never await. There is no async read path
  anywhere above the engine. A screen that needs cold rows calls `preload` /
  `hydrateScope` *before* it renders, not during.
- **Architecture Invariant:** engines never serve reads at runtime. The
  `StorageEngine` contract is open / load / writeBatch / close; memory is the
  only thing a read touches (ADR-003). A worker query tier would be an ADR-003
  amendment, not an engine method.
- **Architecture Invariant:** the agent surface registers **zero** write
  tools. A write attempt is an unknown tool — there is no handler to
  misconfigure. Agent write affordances arrive only with a separate,
  deliberate guard surface (ADR-011).
- **Architecture Invariant:** types outside the MCP allowlist do not exist to
  the agent — absent from the schema, refused by every tool, with refusals
  that do not reveal existence. An empty allowlist denies everything.
- **Architecture Invariant:** `evict` has no authority over durability
  (ADR-013). Eviction is a memory decision; only `remove` is a semantic delete.
- **Architecture Invariant:** a `WriteOrigin` is stamped by the write channel,
  never supplied by the caller through the ordinary API. Origin is attribution
  within one trust domain, not authentication.
- **Architecture Invariant:** the sync adapter's arbitration never returns
  `"concurrent"` — the server is authoritative and there is no merge (ADR-005,
  ADR-006).
- **Architecture Invariant:** nothing in `src/` or `packages/*` imports a
  framework runtime or an application-specific type. The Vue reactivity
  package is the signal engine, not a Vue dependency (ADR-019 owns the public
  read type so it never leaks).
- **Architecture Invariant:** the published surface is asserted, never
  printed — `check:api-report`, `check:publish-surface`, `check:pack-manifest`
  (ADR-021, ADR-022). What is on npm is exactly what those three say.

## Where the bodies are buried

`docs/adr/012`–`017` are one bug family — projection integrity, "the world
held still" — and the philosophy that replaced the patches: order-independence
→ authority → provenance → quiescence → symmetry. Read them before touching
`persist.ts` or `transactions.ts`. `docs/adr/022` lists the six things publish
makes permanent. `LESSONS.md` is the failure log.
