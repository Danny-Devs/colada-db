# ADR-019: colada-db Owns Its Public Read Type (`ColadaRef`)

**Status:** Accepted
**Date:** 2026-07-23

## Context

colada-db's headline claim is that it is a **framework-agnostic** local-first
engine (ADR-008: boring core, ports at every volatile edge). Line 1 of the
published declarations said otherwise:

```ts
// dist/index.d.mts
import { ComputedRef, ShallowRef } from "@vue/reactivity";
```

`EntityStore.get()` returned `ShallowRef<T | undefined>` and `getByType()`
returned `ComputedRef<T[]>`. These two methods are the **primary read API** —
the first thing any consumer calls, and the first thing their IDE resolves.

The honest deflation, which shapes the fix: `@vue/reactivity` is *already* the
runtime core of this engine (ADR-008 §3, a deliberate choice — it is standalone,
battle-tested, and the engine Vue itself trusts). `dist/index.mjs` imports it
unconditionally on line 1 too. So "you must install it to typecheck" was never a
*new* burden, and this was never a dependency bug.

The real issue is narrower and structural: **ownership of the contract.** ADR-008
§2 says everything volatile is a port *we* own, so that outside churn becomes a
free upgrade rather than a breaking change. Reactivity was the one volatile
dependency with no port — its vocabulary was welded directly into the public read
API. Consequences of that:

1. The agnosticism claim was false at the layer people actually read. A grant
   reviewer or first GitHub visitor checks the `.d.ts`; it named a framework.
2. The read type was not ours to evolve. Any change `@vue/reactivity` makes to
   `ShallowRef`'s shape (it already grew a second type parameter,
   `ShallowRef<T, S = T>`) is a change to *colada-db's public API*, arriving
   without our consent.
3. It pre-committed the ADR-008 §3 escape hatch. That section reserves the right
   to swap the signal engine (flip-trigger: TC39 Signals advancing) and calls it
   "a non-event." It would not have been a non-event: it was a breaking change to
   every consumer's types.

## Decision

**1. Declare an owned read type.** `src/types.ts`:

```ts
export interface ColadaRef<T> {
  readonly value: T;
}
```

Minimal by intent — a value box you observe through `.value`, which is the whole
of what the public read contract promises.

**2. The public read API is typed against it.** `EntityStore.get()` and
`getByType()` (both overloads each) now return `ColadaRef<…>`. `ColadaRef` is
barrel-exported; nothing else about the surface changes.

**3. This is a widening of the DECLARED type, never a change to the RETURNED
value.** The objects handed out are the same live `shallowRef` / `computed`
instances as before, which satisfy `ColadaRef` structurally. No runtime line
changed anywhere in this ADR's implementation.

**4. `value` is `readonly`.** The read API hands out a *view* of store state.
Writing through the ref would rewrite the projection without emitting an event
and desynchronize every consumer — the same read-only contract the boundary's
event payloads already carry (ADR-008 §3 note; `subscribeEvents` payloads are
live store references). Writes go through `set` / `replace` / `update`. No
setter variant is introduced, because **no write-facing surface hands out a
ref**: every mutation on `EntityStore` is a method taking plain data, and
`update()` already exists for read-modify-write. A `MutableColadaRef` would be a
type with no inhabitant on this API.

**5. The Vue fast path is preserved, and pinned.** ADR-008 §3 grants the Vue
adapter a privileged path: it may bypass the subscription boundary and share the
store's *actual* refs. `src/store.ts` declares an `@internal`,
**non-barrel-exported** `RefBackedEntityStore` — `EntityStore` with `get` /
`getByType` narrowed back to `ShallowRef` / `ComputedRef` — and annotates the
implementation object with it. So if those methods ever stopped handing out real
engine refs, `store.ts` stops compiling. It stays internal on purpose:
re-exporting it would put the framework import straight back on line 1, which is
the exact leak this ADR closes.

**6. Two regression pins, because they fail in different places.**

- *Compile-time* (`pnpm typecheck`): `src/public-read-type.spec.ts` asserts a
  plain, framework-free object literal is assignable to
  `ReturnType<EntityStore["get"]>`. A framework ref type carries a unique-symbol
  brand (`Ref` declares `[RefSymbol]: true`), so any regression makes that
  assignment fail. Verified by executed negative control: reverting `get()` to
  `ShallowRef` produced `TS2322: Property '[RefSymbol]' is missing`.
- *Build-time* (`scripts/check-public-types.mjs`, wired into `pnpm build`): greps
  the emitted `dist/index.d.mts` for `@vue/reactivity` / `@vue/shared` and exits
  1 on any hit. This is the only guard that catches a leak arriving through some
  *other* barrel-exported type, in a file nobody touched. Verified by the same
  negative control.

## Peer-dependency consequence (the deliberate non-decision)

Removing the type-level import makes `@vue/reactivity` *eligible* to become an
optional peer for boundary-only consumers. **We are not making it optional now,**
and the reasoning is worth recording because the eligibility invites the change:

`dist/index.mjs` line 1 is `import { computed, shallowRef, triggerRef } from
"@vue/reactivity"` — a top-level, unconditional **value** import (`tsdown.config.ts`
lists it under `neverBundle`). It is not behind a lazy path or an opt-in engine.
`peerDependenciesMeta.optional` tells a package manager it is *fine to omit*; a
consumer who omits it gets a module-resolution failure at import time — a hard
crash with a confusing message, not a graceful degradation. That is exactly the
distinction against `@sqlite.org/sqlite-wasm`, which is legitimately optional
because it is reachable only through `sqliteEngine()`.

So the peer stays **required** (`>=3.3.0`). The optional-peer move becomes
correct only if and when the signal engine moves behind a real port with a
default that needs no external package — a separate decision, on ADR-008 §2's
terms, with actual runtime consequences. This ADR removes the *type* blocker and
leaves the runtime question open and honestly stated.

## What we are NOT doing

- **Not writing our own reactivity system.** `@vue/reactivity` remains the
  runtime signal engine, unchanged, unbundled, and required. `ColadaRef` is a
  declaration, not an implementation; it contains no tracking, no scheduling, no
  code at all.
- **Not adding a port for reactivity.** ADR-008's rule is that a port is added
  when a real consumer exists, never speculatively. Owning the type is the cheap
  precondition; the port is a later decision if the swap ever comes due.
- **Not making `@vue/reactivity` optional** (above).
- **Not adding a `colada-db/vue` subpath entry.** That is the standard way to
  give the Vue adapter first-class `ShallowRef` typing without touching the main
  declarations, and it is the designated future move if chip 3 wants it. It costs
  build config and a second published surface, and no consumer needs it yet — the
  adapter can re-narrow at its own boundary, where the Vue dependency is honest.

## Alternatives Considered

- **Leave it; the runtime dep already exists.** Rejected. It conflates two
  different claims: "we depend on this at runtime" (true, deliberate, documented)
  and "our public API is defined in terms of this" (the thing being retired).
  Only the second one costs us the right to evolve.
- **Re-export `ShallowRef` / `ComputedRef` under our own names**
  (`export type ColadaRef<T> = ShallowRef<T>`). Rejected — a pure alias. The
  framework import stays on line 1 of the `.d.mts`, the shape is still theirs,
  and nothing is actually owned. It would satisfy the aesthetics and none of the
  substance.
- **Model the full `Ref` surface** (writable `value`, `[RefSymbol]` brand,
  `toRaw`, etc.). Rejected. A brand makes the type nominal, which would break the
  structural conformance that makes this a zero-runtime-cost widening — and
  writability is wrong on a read projection (§4).
- **Return a snapshot value instead of a box.** Rejected — that is not a retype,
  it is a different API, and it deletes the reactivity that makes the read
  projection useful. The subscription boundary (`createStoreBoundary`) already
  exists precisely for consumers who want snapshots and callbacks.
- **Ship the fix inside DAN-649** (pre-publish hygiene). Rejected at cut time:
  this is a deliberate public-API shape change on the most-read surface in the
  library and does not belong in the same review gauntlet as find-replace
  hygiene.

## Consequences

- **Positive:** the framework-agnostic claim is now true at the layer people
  check. The read type is ours to evolve, so the ADR-008 §3 signal-engine swap
  really is the non-event that ADR promised. The Vue fast path is unchanged and
  is now pinned by the compiler rather than by memory. A non-Vue consumer can
  satisfy the read contract with an ordinary object (pinned by test).
- **Negative / accepted:** a Vue consumer who wants `ShallowRef`-specific
  affordances (`triggerRef`, `unref`, `isRef` narrowing) no longer gets them from
  colada-db's declarations and must re-narrow at their boundary. Acceptable: the
  deliberate adapter (chip 3) is exactly the place that dependency is honest, and
  it is one declaration there instead of a framework name in everyone's `.d.ts`.
  `ColadaRef` is now a public type with the compatibility obligations that
  implies.
- **The one sharp edge, named explicitly:** Vue's template auto-unwrapping is
  *runtime* behavior driven by `isRef()`, but its **typing** (`ShallowUnwrapRef`)
  keys off the `[RefSymbol]` brand. A store ref returned straight out of
  `setup()` therefore still unwraps at runtime (it really is a ref) while the
  template's *types* now see a `ColadaRef` and will not unwrap it. Types and
  runtime disagree in that one spot — the direction that yields a spurious type
  error, not a silent wrong value, but a confusing one. This is precisely the
  seam the chip-3 Vue adapter exists to own: it should hand components its own
  properly-branded refs rather than passing engine refs through raw. Recorded
  here so the adapter author meets it as a known decision instead of a surprise.
- **Risks watched:** the type surface can regress from a file nobody edited —
  any newly barrel-exported type that transitively names a framework type puts
  the import back. That is precisely why the build gate exists and why it greps
  the emitted artifact rather than the source. If a second published entry point
  is ever added, add it to `DECLARATION_FILES` in
  `scripts/check-public-types.mjs`; the gate only covers what it is told about.
