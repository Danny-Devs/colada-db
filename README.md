# colada-db

**AI-first, local-first client database.** A normalized reactive entity store with pluggable durability engines — in-memory, IndexedDB, and OPFS SQLite — designed from the cornerstone for a world where AI agents are first-class actors in web applications.

> **Status: pre-release.** colada-db is being extracted from [`pinia-colada-plugin-normalizer`](https://github.com/Danny-Devs/pinia-colada-plugin-normalizer) (shipped, on npm since v0.1.0), which becomes its first framework adapter. Not yet published under this name.

## The design

- **Normalized entity graph, synchronous reads.** Every entity lives once. Reads are synchronous reactive refs from an in-memory projection — the UI never awaits the database.
- **Write-behind durability.** Pluggable `StorageEngine`s persist underneath: IndexedDB by default, OPFS SQLite (`opfs-sahpool`, no COOP/COEP headers required) for scale. Memory stays the source of UI truth. (ADR-003)
- **AI-first by design — the four trust primitives are in this build.** The committed cornerstone (ADR-007), shipped 2026-07-19: origin tags on every write (`WriteOrigin`, stamped by each write channel — unforgeable through the ordinary write API), a **pre-apply** policy veto gate (`useGate`: a veto means the write never touched the store; commit-time `willCommit` is last-chance and rolls back), a capped queryable history store (`enableHistory`: field-level old→new rows with write ids and origins, purge-on-remove erasure, count + byte bounds), and a machine-legible schema export (`exportSchema`: the registry as plain JSON — the future MCP resource). Each justified by non-AI needs (undo, sync, devtools), each the substrate for agent attribution, policy enforcement, and the Stage-2c agent surface (not yet built). Origin = attribution within one trust domain, not authentication.
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
