---
title:       "@colada-db/react — React binding scaffold"
kind:        reference
status:      draft
updated:     2026-09-02
owner:       danny
verified_by: "pnpm --filter @colada-db/react test"
---

# @colada-db/react

## What this is

Three React hooks over colada-db's **adapter-facing subscription boundary**
(`createStoreBoundary`, ADR-008 §3). The boundary is `subscribe` plus
synchronous snapshot getters — the exact shape `useSyncExternalStore` wants —
so a React binding is a thin layer and imports nothing but the published
`colada-db` surface. No signal library, no core internals.

One hook is finished. Two are documented stubs whose body is Danny's to write
(DAN-1047). The tests for the stubs are **red on purpose** — they are the work
order, already pinned to the contract.

## Why it is private

- **ADR-008 §4 — the Vite playbook.** Win Vue completely → prove the core on
  vanilla JS → add React *only when the boundary is frozen by two real
  consumers*. Every adapter is a product maintained forever, so the seat is
  not opened speculatively. `packages/sync-demo` is consumer #2 in the making;
  whether it counts is a decision, not a side effect of this package existing.
- **ADR-022 line 2 — the public API surface is an irreversibility line.** A
  published hook signature is a compatibility promise. Nothing in this package
  is on colada-db's API report, pack manifest or publish surface, and the three
  `check:*` gates must stay unchanged-green while it exists. `"private": true`
  is the guard rail; removing it is the deliberate act.

## API

```ts
import { useStoreVersion, useEntity, useEntities } from "@colada-db/react";
```

| Hook | Subscribes via | Snapshot | Status |
|---|---|---|---|
| `useStoreVersion(boundary)` | `boundary.subscribe` (global tier) | `boundary.getVersion()` — a number | **implemented** |
| `useEntity(boundary, type, id)` | `boundary.subscribeEntity` (per-key tier) | `boundary.getEntity(type, id)` — `EntityRecord \| undefined` | **stub, throws** |
| `useEntities(boundary, type)` | `boundary.subscribeType` (per-type tier) | `boundary.getEntities(type)` — `ReadonlyArray<{ id, data }>` | **stub, throws** |

`useStoreVersion` is `useSyncExternalStore(boundary.subscribe, boundary.getVersion)`
with both functions memoized per boundary. Its snapshot is a primitive, so it
has no identity problem — which is exactly why it could be finished here and
the other two could not.

Peers: `react >= 18` (when `useSyncExternalStore` landed) and `colada-db`.

## Snapshot identity

This is the decision the two stubs are waiting on.

`useSyncExternalStore` calls `getSnapshot` on every render and compares the
result with `Object.is`. If two calls with **no intervening store change**
return different references, React concludes the store changed, re-renders,
calls `getSnapshot` again, gets yet another reference — and loops until it
throws *"The result of getSnapshot should be cached to avoid an infinite
loop."* This is the single most common bug in hand-written external-store
bindings, and the boundary hands it to us directly:

- `boundary.getEntities(type)` is `store.getEntriesByType(type)`: a projection
  computed on each call. **A fresh array every time.** Returned naively from
  `getSnapshot`, `useEntities` loops.
- `boundary.getEntity(type, id)` reads the store's own record reference. It is
  *probably* stable between changes, but the store's merge-on-`set` semantics
  mean that should be verified, not assumed — the `useEntity` "(2) same
  reference" test is there to verify it.

So `useEntities` must cache its snapshot and invalidate only when the type
actually changed. Two candidate designs:

**A. Version-keyed memo.** Keep `{ version, snapshot }` per `(boundary, type)`.
In `getSnapshot`, read `boundary.getVersion()`; if it equals the cached
version, return the cached array, otherwise recompute via `getEntities()` and
cache under the new version.
*For:* trivially correct, a few lines, the invalidation key already exists on
the boundary. *Against:* `getVersion()` ticks on **any** store event — a write
to a different entity type invalidates this type's cache too, so consumers get
a new array (and a re-render of anything keyed on its identity) more often
than the type actually changed. The per-type subscription tier prevents the
re-render, but not the recompute-on-next-read. Also: one memo per hook
instance means N components on the same type hold N arrays.

**B. Structural sharing.** Recompute on notification, but diff against the
previous snapshot: keep the same array reference if the id set and every
`data` reference are unchanged, and when they did change, reuse the unchanged
row objects so `React.memo` children keyed on `entry` identity skip. Can be
per-type rather than per-hook by caching on a `WeakMap<StoreBoundary, Map<type,
snapshot>>`, so N components share one snapshot.
*For:* minimal re-renders, one snapshot per type, the shape every mature
binding converges on (Redux's `useSelector` + reselect, Zustand's `shallow`,
TanStack's structural sharing). *Against:* more code, a diff on every
notification (O(n) in rows of that type), and a subtle contract — when is a
row "unchanged"? By `data` reference is cheap and correct for this store
(`set` allocates on change); by deep equality is not.

The two are not exclusive: B's diff can be gated on A's version check.

**Decision: Danny, DAN-1047.** Whichever is chosen must make these three tests
green without touching them: "(2) referentially stable across re-renders",
"(2b) a store change produces a new snapshot", and "(1) unsubscribes on
unmount".

## Running

```
pnpm --filter @colada-db/react test       # 3 green (useStoreVersion), 7 red (the stubs) — see index.spec.tsx
pnpm --filter @colada-db/react typecheck
pnpm --filter @colada-db/react build      # dist/index.mjs; no .d.ts until the publish decision
```

The suite resolves `colada-db` to core **source** (vitest alias + tsconfig
paths, the `packages/mcp` idiom) so it is green on a clean tree. Spec files
also reach `enableSync` and the sync types through a `@core/*` alias because
those are deliberately not on the public entry (ADR-022) — the hooks
themselves never use it.
