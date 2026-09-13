---
title:       "sync-demo — the sync story, touchable"
kind:        howto
status:      draft
updated:     2026-09-12
owner:       danny
verified_by: "pnpm --filter @colada-db/sync-demo test && pnpm --filter @colada-db/sync-demo build"
---

# sync-demo

## What this is

Two colada-db **clients** side by side in one page, each owning its own
`createEntityStore()` and its own durability engine, both syncing through
**one in-page, in-memory, server-authoritative hub** that implements
`SyncAdapter` (ADR-006) directly. Add, rename and delete todos in either pane
and watch them arrive in the other. Flip a pane's network off, keep writing,
watch its outbox count climb, flip it back on, watch it drain and reconcile.

It is the honest minimum for DAN-1044: the coordinator (`enableSync`), the
outbox, version-aware apply, tombstones and pull-channel confirmation are all
the real code from `src/`. What is fake is the *transport*, and the page says
so in a banner.

## What this demo does NOT do

- **No backend, no network, no HTTP.** The hub is a `Map` in the page.
  `restAdapter` and wire-protocol v1 are not exercised here.
- **ADR-023 is still open** — this hub is neither the server conformance kit
  (artifact 2) nor the reference server (artifact 3). It is a demo fixture
  that happens to pass the *client* conformance kit.
- **No durable outbox.** `outboxEngine` (ADR-006 §1, DAN-777) is not wired.
  Writes queued while a pane is offline live in the coordinator's memory and
  are lost on an engine switch or a reload. That is a deliberate omission, and
  the banner names it.
- **No rebase.** The hub acks every well-formed write in arrival order — the
  last arrival wins. There is no `transform` verdict and the only `reject` is
  a malformed change, so the reject/revert and remap paths are not shown.
- **The network toggle parks requests; it does not fail them.** See "How the
  toggle works" below — D9's exponential backoff is not exercised.
- **No deploy without a word.** `pnpm --filter @colada-db/sync-demo build`
  produces a static `dist/` (relative asset paths, `base: "./"`).
  `.github/workflows/deploy-sync-demo.yml` publishes it through GitHub Pages at
  <https://danny-devs.github.io/colada-db/> on a push to `main` that touches the
  demo, or on manual dispatch, once the repo's Pages site exists. If that URL
  returns 404, the site was never created; nothing here creates it, and
  creating it is a human decision.

## Running

```
pnpm --filter @colada-db/sync-demo dev        # http://localhost:5179
pnpm --filter @colada-db/sync-demo test       # the ADR-006 conformance kit against hub.ts + 5 hub-specific tests
pnpm --filter @colada-db/sync-demo typecheck
pnpm --filter @colada-db/sync-demo build      # static dist/
```

## How it is wired

```
 pane "left"                              pane "right"
 ┌───────────────────────────┐            ┌───────────────────────────┐
 │ createEntityStore()       │            │ createEntityStore()       │
 │ enablePersistence(engine) │            │ enablePersistence(engine) │
 │ createStoreBoundary       │            │ createStoreBoundary       │
 │ enableSync(clientAdapter) │            │ enableSync(clientAdapter) │
 └────────────┬──────────────┘            └────────────┬──────────────┘
              │ network gate (park / pass)              │ network gate
              └──────────────┬───────────────────────────┘
                             ▼
                  hub.ts — SyncAdapter, in-memory
                  push → apply (LWW by arrival) → ack → poke
                  pull → changes since cursor + tombstones + confirmedMutations
```

- **Writes** go through `createOptimisticUpdates(store).transaction()` →
  `tx.set / tx.remove` → `tx.commit()`. That layer is what stamps
  `origin: "local-mutation"`, the only origin the coordinator's outbox
  accepts. A bare `store.set()` would render locally and never sync.
- **Reads** in the panes go through `useStoreVersion` from `@colada-db/react`
  plus a direct `boundary.getEntities("todo")` in render. This is a marked
  stopgap (`// TEMP: … until Danny lands useEntities (DAN-1047)`); the entity
  hook is deliberately not inlined here.
- **Live channel:** the hub pokes every subscriber after each apply, so a push
  in one pane triggers a pull in the other without waiting for the 30s poll.
- **`clientId`** is minted fresh per client instance because there is no
  `outboxEngine` (see `EnableSyncOptions.clientId`). An engine switch rebuilds
  the client and mints a new id.

### Engines

| Choice | What happens |
|---|---|
| `memory` | `memoryEngine()` — nothing survives a reload; the new client re-pulls from the hub. |
| `idb` | `idbEngine({ dbName: "cdb_sync_demo_<pane>" })` — one IndexedDB per pane, survives reload. Distinct names so the panes cannot "sync" through a shared disk. |
| `sqlite-opfs` | `sqliteEngine` with the bring-your-own worker (`src/sqlite.worker.ts`, same as `playground/`). `opfs-sahpool` is single-connection (ADR-003), so if both panes pick it the second lands on `persistent: false` (a transient in-memory DB) — the pane shows the flag rather than pretending. Expect sqlite-wasm to log `opfs-sahpool: NoModificationAllowedError … another open Access Handle` to the console when that happens; it is the library reporting the lock before it falls back, not a bug in the demo. No COOP/COEP headers are needed for sahpool, so none are set. |

Observed headless in the built bundle (Chromium, 2026-09-02): first pane on
sqlite-OPFS → `persistent: true`; second pane → `persistent: false` with that
console line; add / offline-queue (pending 2) / reconnect-drain (pending 0) /
rename / delete / idb switch all propagated between panes.

### How the toggle works

`client-adapter.ts` wraps the hub per pane. Offline, `push()` and `pull()`
return promises that **park** until the toggle flips back on; pokes are held
and re-delivered once. The coordinator sees a push that has not returned yet,
so every further local write accumulates in the outbox — `getPendingCount()`
is the number on screen. On reconnect the parked push resolves against the
hub, the hub pokes, the pull brings back `confirmedMutations`, and the outbox
drains to zero.

Why park instead of throw: a thrown push is retried with D9's full-jitter
backoff (1s → 60s) and the coordinator handle exposes no "retry now", so a
fail-fast offline would drain on reconnect at some random moment up to a
minute later. Parking models a partition (requests hang until it heals) and
drains immediately, which is what a demo needs. The trade is stated on the
page: D9's backoff path is not shown. **Open question for Danny:** should
`SyncCoordinatorHandle` grow a `flushNow()` (kick push + pull) so a real
adapter can fail fast *and* an app can drain on `navigator.onLine`? The
coordinator is unpublished (ADR-022), so adding it is still cheap.

## Verification

- `src/hub.spec.ts` runs `runSyncAdapterContract` with **every hook supplied**
  (`seedRemote`, `removeRemote`, `simulateTransientFailure`,
  `unsupportedSchemaVersion`, `supportsSubscriptions: true`,
  `suppliesComparator: false`) — zero skipped blocks — plus five hub-specific
  tests (poke-on-apply, no poke on replay, LWW by arrival, schema refusal, the
  stats the UI shows).
- The React panes are not unit-tested here; the hook they use is tested in
  `packages/react`. Observe-run it in a browser: `pnpm --filter
  @colada-db/sync-demo dev`, add in one pane, watch the other.

## Source seams

Everything resolves to core **source** via aliases (`vite.config.ts`,
`vitest.config.ts`, `tsconfig.json` — kept in lockstep): `colada-db` →
`src/index.ts`, `@colada-db/react` → `packages/react/src/index.ts`, and
`@core/*` → `src/*`. The last one is the honest seam: `enableSync`, the
`SyncAdapter` types and the conformance kit are deliberately **not** on
colada-db's public entry (ADR-022 lines 1-2), so this demo consumes
unpublished internals. That is also why it is `"private": true` and why, as a
"consumer #2" candidate for ADR-008 §4, it only counts for the *boundary*
(which is public) — not for the sync surface.
