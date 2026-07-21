# colada-db

**AI-first, local-first client database.** A normalized reactive entity store with pluggable durability engines — in-memory, IndexedDB, and OPFS SQLite — designed from the cornerstone for a world where AI agents are first-class actors in web applications.

> **Status: pre-release.** colada-db is being extracted from [`pinia-colada-plugin-normalizer`](https://github.com/Danny-Devs/pinia-colada-plugin-normalizer) (shipped, on npm since v0.1.0), which becomes its first framework adapter. Not yet published under this name.

## The design

- **Normalized entity graph, synchronous reads.** Every entity lives once. Reads are synchronous reactive refs from an in-memory projection — the UI never awaits the database.
- **Write-behind durability.** Pluggable `StorageEngine`s persist underneath: IndexedDB by default, OPFS SQLite (`opfs-sahpool`, no COOP/COEP headers required) for scale. Memory stays the source of UI truth. (ADR-003)
- **AI-first by design — the four trust primitives are in this build.** The committed cornerstone (ADR-007), shipped 2026-07-19: origin tags on every write (`WriteOrigin`, stamped by each write channel — unforgeable through the ordinary write API), a **pre-apply** policy veto gate (`useGate`: a veto means the write never touched the store; commit-time `willCommit` is last-chance and rolls back), a capped queryable history store (`enableHistory`: field-level old→new rows with write ids and origins, purge-on-remove erasure — settled state; settle transactions before logout flows, see the module docs — count + byte bounds), and a machine-legible schema export (`exportSchema`: the registry as plain JSON — the future MCP resource). Each justified by non-AI needs (undo, sync, devtools), each the substrate for agent attribution, policy enforcement, and the Stage-2c agent surface (not yet built). Origin = attribution within one trust domain, not authentication.
- **Query-driven hydration — memory is a projection, not the whole DB.** Scope manifests (`setManifest`) persist which entities each query/screen needs; `hydration: "manifest"` boots by loading exactly that set via `loadMany` (never a full scan), retained per scope so GC can't evict what a live scope uses. `removeManifest` releases + sweeps; `hydrateScope`/`preload` page durable-but-cold rows back in. Two documented boundaries: **type enumeration reflects the memory projection, not the DB** (cold rows are invisible to any API that walks the store until a scope pulls them in), and **`===` stability ends at evict** — re-hydration materializes new object identity; within-session stability is unaffected because retained entities are never evicted. Without `preload`, first paint on a cold entity shows pending (the synchronous `store.has` check can't see disk). See `docs/design/query-driven-hydration.md`. (DAN-578)
- **Live filtered views, two-tier.** `createMatcherView` keeps a reference-stable membership view (ids array, `===`-stable while membership is unchanged) over the serializable matcher AST (ADR-009): validated filters update **purely from change events** — zero query re-runs; closures fall back to coalesced re-scans, always correct. Members are retained while displayed (GC can never evict a live result), and a dev-mode `verifyIntegrity` guard re-scans and self-heals so the fast tier can never silently diverge from re-run truth. Honest boundary: the view's universe is the **memory projection** — durable-but-cold rows are invisible until hydrated (worker-seeded universes are the Stage-2d worker tier's job). See `docs/design/live-matcher-views.md`. (ADR-010, DAN-606)
- **Server-authoritative sync, bring your own backend.** A three-method `SyncAdapter` contract (pull/push/subscribe), battle-tested against seven production sync systems before implementation. No CRDTs where none are needed. (ADR-005, ADR-006)
- **One reactive graph.** Built on `@vue/reactivity` (standalone — no Vue runtime dependency). Framework adapters share the engine's reactivity instead of shimming a second signal system into it.

## Architecture decisions

The load-bearing choices live in [`docs/adr/`](docs/adr/) — memory projection over store swap, evict vs delete, sync posture, the SyncAdapter contract, and the AI-first cornerstone.

## Development

```bash
pnpm install
pnpm test        # vitest
pnpm typecheck
pnpm build       # tsdown
```

## License

MIT
