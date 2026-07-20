# Design: query-driven hydration — manifest, loadMany, retained boot (DAN-578 / Stage 2b)

**Status:** IMPLEMENTED 2026-07-19 (same session as spec — design locked before code per house rule).
**Fixes:** audit blocker #2 (query→entity mapping doesn't exist at boot) and the ADR-004 residency ratchet (hydrated entities were GC-immune: bare `store.set`, `gc()` never invoked by anything). Makes ADR-003's "memory is a projection, not the full DB" true at scale.

## Principle

The **scope** (adapter-side: a query) is the unit of hydration. Boot loads only entities referenced by persisted scopes; everything else stays durable-but-cold and pages in on demand (Zero steal-list #1–2, translated). The core knows nothing about queries — it persists a neutral `scope → entityKeys` manifest that any adapter (Pinia Colada plugin via NORM_META, vanilla apps directly) maintains.

## Storage design — reserved namespace, zero engine schema changes

Manifest rows live in the SAME engine KV table as entities, under a reserved type prefix:

- `__cdb_manifest__:<scopeId>` → `{ v: 1, keys: EntityKey[] }`
- `__cdb_manifest__:__index__` → `{ v: 1, scopes: string[] }` — the boot entry point; manifest-mode boot never calls `loadAll`.

Why not a second table/object store: IDB would need a version-bump migration, sqlite a schema change, and every future engine would inherit both. The coordinator already owns all engine-agnostic semantics (ADR-003 division); a reserved prefix keeps engines dumb KV. `__cdb_manifest__` is a reserved entity type — collision is documented; EntityKey validation (roadmap L2) will enforce.

Consequences:
- Manifest writes ride the normal dirty-set flush (coordinator injects them directly into `dirtySaves` — they are NOT store entities and never touch the memory projection).
- Default-mode (`hydration: "all"`) boot FILTERS `__cdb_manifest__:*` rows out of hydration, so switching modes never mints phantom entities.

## Engine contract: `loadMany(keys)`

`loadMany(keys: EntityKey[]): Promise<Array<{key, data, version?}>>` — selective load; missing keys are omitted (not errors); empty input returns `[]` without I/O; order unspecified. Pre-1.0 breaking addition to `StorageEngine` (ADR-004 precedent). sqlite chunks `WHERE key IN (…)` at 500 binds; worker protocol gains a `loadMany` op.

## Boot flows

- **`hydration: "all"` (default, unchanged semantics):** `loadAll` → hydrate everything except the reserved namespace. No retention (existing behavior — apps without scopes rely on gc never firing, which remains true: nothing calls `gc()` in this mode).
- **`hydration: "manifest"`:** `loadMany([index])` → `loadMany(scope rows)` → union entityKeys → `loadMany(entities)` → hydrate (fresh-wins skip on `store.has`, `hydration` origin stamped) and **retain each key under every scope that references it**. Entities on disk but in no scope stay cold. An empty/missing index hydrates nothing — correct for first boot.

## Retention lifecycle (the residency-ratchet fix)

Coordinator keeps `scopeRetentions: Map<scopeId, Set<EntityKey>>`; a key retained under N scopes has N refcounts (store refcounts already sum). Sources of retention: manifest boot, `hydrateScope`, `preload`.

- `setManifest(scopeId, keys)` — persists row + index. Does NOT retain (runtime retention of freshly-fetched entities is the adapter's concern — plugin aggregates already do this; double-retaining here would leak).
- `removeManifest(scopeId)` — deletes row, updates index, releases the scope's retentions, schedules the **debounced `gc()` sweep** (THE named trigger; nothing else calls gc).
- `hydrateScope(scopeId)` — post-evict remount path: `loadMany` manifest row → `loadMany` keys absent from memory → hydrate + retain under scope. Idempotent.
- `preload(scopeIds?)` — pre-mount warm (router hook); no args = every scope in the index. Sugar over `hydrateScope`.
- `dispose()` — releases ALL scope retentions (refcounts must not outlive the coordinator that created them).

## Documented boundaries

- **Type enumeration reflects the projection, not the DB** — any API that walks the memory store (`getByType`-style, indexes, boundary snapshots) sees only hydrated entities; durable-but-cold rows are invisible until a scope pulls them in.
- **=== stability ends at evict** — re-hydration materializes new object identity (JSON round-trip). Within-session referential stability (Dexie #2034 suite) is unaffected because eviction of retained entities never happens; the boundary only bites evict→rehydrate cycles.
- **First paint without `preload`** — a durable-but-cold entity fails the synchronous `store.has` check, so redirect/placeholder paths show pending until hydration lands. Accepted; `preload` exists precisely to move that ahead of mount.

## Tests that define done (core)

1. `loadMany` contract on all three engines: subset load, missing keys omitted, empty input = no I/O (memory/idb spy; sqlite via core-fn unit test), sqlite chunking >500 keys.
2. Manifest-mode boot hydrates exactly the union of scope keys; unreferenced durable rows stay cold; hydrated events carry `origin: "hydration"`.
3. Boot-hydrated entities are retained: `gc()` immediately after boot evicts nothing; after `removeManifest(scope)` + sweep, that scope's exclusive keys evict, shared keys survive.
4. `hydrateScope` re-hydrates evicted keys via `loadMany` (engine call observed), skips memory-present keys, retains.
5. `preload()` warms all scopes; `preload(["a"])` warms one.
6. Default mode: manifest rows never hydrate as entities; existing durability suites all green unchanged.
7. Dispose releases retentions (refcounts return to pre-boot).
