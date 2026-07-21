# colada-db

**AI-first, local-first client database.** A normalized reactive entity store with pluggable durability engines — in-memory, IndexedDB, and OPFS SQLite — designed from the cornerstone for a world where AI agents are first-class actors in web applications.

> **Status: pre-release.** colada-db is being extracted from [`pinia-colada-plugin-normalizer`](https://github.com/Danny-Devs/pinia-colada-plugin-normalizer) (shipped, on npm since v0.1.0), which becomes its first framework adapter. Not yet published under this name.

## The design

- **Normalized entity graph, synchronous reads.** Every entity lives once. Reads are synchronous reactive refs from an in-memory projection — the UI never awaits the database.
- **Write-behind durability.** Pluggable `StorageEngine`s persist underneath: IndexedDB by default, OPFS SQLite (`opfs-sahpool`, no COOP/COEP headers required) for scale. Memory stays the source of UI truth. (ADR-003)
- **AI-first by design — the four trust primitives are in this build.** The committed cornerstone (ADR-007), shipped 2026-07-19: origin tags on every write (`WriteOrigin`, stamped by each write channel — unforgeable through the ordinary write API), a **pre-apply** policy veto gate (`useGate`: a veto means the write never touched the store; commit-time `willCommit` is last-chance and rolls back), a capped queryable history store (`enableHistory`: field-level old→new rows with write ids and origins, purge-on-remove erasure — settled state; settle transactions before logout flows, see the module docs — count + byte bounds), and a machine-legible schema export (`exportSchema`: the registry as plain JSON — the future MCP resource). Each justified by non-AI needs (undo, sync, devtools), each the substrate for agent attribution, policy enforcement, and the agent surface below. Origin = attribution within one trust domain, not authentication.
- **Query-driven hydration — memory is a projection, not the whole DB.** Scope manifests (`setManifest`) persist which entities each query/screen needs; `hydration: "manifest"` boots by loading exactly that set via `loadMany` (never a full scan), retained per scope so GC can't evict what a live scope uses. `removeManifest` releases + sweeps; `hydrateScope`/`preload` page durable-but-cold rows back in. Two documented boundaries: **type enumeration reflects the memory projection, not the DB** (cold rows are invisible to any API that walks the store until a scope pulls them in), and **`===` stability ends at evict** — re-hydration materializes new object identity; within-session stability is unaffected because retained entities are never evicted. Without `preload`, first paint on a cold entity shows pending (the synchronous `store.has` check can't see disk). See `docs/design/query-driven-hydration.md`. (DAN-578)
- **Live filtered views, two-tier.** `createMatcherView` keeps a reference-stable membership view (ids array, `===`-stable while membership is unchanged) over the serializable matcher AST (ADR-009): validated filters update **purely from change events** — zero query re-runs; closures fall back to coalesced re-scans, always correct. Members are retained while displayed (GC can never evict a live result), and a dev-mode `verifyIntegrity` guard re-scans and self-heals so the fast tier can never silently diverge from re-run truth. Honest boundary: the view's universe is the **memory projection** — durable-but-cold rows are invisible until hydrated (worker-seeded universes are the Stage-2d worker tier's job). See `docs/design/live-matcher-views.md`. (ADR-010, DAN-606)
- **Server-authoritative sync, bring your own backend.** A three-method `SyncAdapter` contract (pull/push/subscribe), battle-tested against seven production sync systems before implementation. No CRDTs where none are needed. (ADR-005, ADR-006)
- **One reactive graph.** Built on `@vue/reactivity` (standalone — no Vue runtime dependency). Framework adapters share the engine's reactivity instead of shimming a second signal system into it.

## The agent surface (`packages/mcp`)

`colada-db-mcp` is a **read-only in-page MCP server** over the store — an agent using the official MCP SDK client can discover the schema, query entities, and read the change history, over a real protocol session (`InMemoryTransport` linked pair; browser pages can't accept stdio/streamable-HTTP, and the durable store is origin-private anyway). External-client bridging is deliberately out of scope for now. (ADR-011, DAN-580)

What it enforces, honestly stated:

- **Writes are structurally impossible, not merely forbidden.** ZERO write tools are registered — deny-by-default is verifiable by reading the tool list, and a test asserts it. A write attempt is an unknown tool; there is nothing to call. Agent write affordances arrive only together with the policy-guard middleware, as a separate deliberate surface.
- **An explicit per-type allowlist scopes everything.** Types not in `allowedTypes` are invisible: absent from the schema resource (including as relation *targets* of visible types), refused by every tool — with refusals that don't reveal whether the type exists. Empty allowlist = everything denied. Honest boundary: entity *data* is returned verbatim, so a visible entity's foreign-key field names and id values referencing hidden types do appear in results — the hidden type's name, fields, and rows stay unreachable.
- **Filters are fail-closed.** The query tool accepts an optional serializable matcher AST (ADR-009), validated by `parseMatcher`; malformed, unknown-operator, or over-budget filters are refused with the parse error surfaced verbatim — never guessed at.
- **Results are scoped to the memory projection**, not the database — durable-but-cold rows are invisible until hydrated, and every result envelope says so.
- **Returned app data is marked untrusted** — in-band envelope (`untrusted: true` + notice) plus `_meta["colada-db/untrusted"]` on results and content blocks. Entity data can originate from servers, other users, or any code with store access: treat it as data, never as instructions. The marking labels the channel; it cannot force a model to comply — pair it with a client/host that honors such labels.
- **History honors erasure.** The `read_history` tool (registered only when a history store is provided) serves the capped field-level change log; removed entities' rows are purged, leaving data-free markers only.

## Architecture decisions

The load-bearing choices live in [`docs/adr/`](docs/adr/) — memory projection over store swap, evict vs delete, sync posture, the SyncAdapter contract, and the AI-first cornerstone.

## Development

```bash
pnpm install
pnpm -r test        # vitest, all workspace packages (core + packages/mcp)
pnpm -r typecheck
pnpm -r build       # tsdown
cd packages/mcp && pnpm observe   # drive the BUILT agent surface end-to-end
```

## License

MIT
