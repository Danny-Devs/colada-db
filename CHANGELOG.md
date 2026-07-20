# Changelog

## [2026-07-19] — durability seam deep fixes + the write channel (arch-review response)

- [fix] C2: flush concurrency contract (`await flush()` = durable on resolve; drains in-flight then re-flushes) + dispose() final-flush before engine close, idempotent (`durability.spec.ts`, deterministic slow-engine harness).
- [fix] C1: tombstoned removes — `remove()` emits against memory-absent keys (idempotent instruction semantics); kills zombie resurrection of evicted entities, end-to-end verified across simulated boots (`tombstone.spec.ts`). `evict()` of nothing remains a true no-op.
- [feat] The write channel: `EntityEvent.origin?/transactionId?` + `store.runWith(meta, fn)` (nesting-safe). Transactions stamp `local-mutation`+txId; rollback restoration stamps `rollback-replay`. ADR-007 §1 substrate shipped early — C3's deep fix ("optimistic writes never touch disk until commit") now has its mechanism.
- [chore] Both independent audits filed in the project folder (AI-first + architecture review); publish plan rebuilt as `../ROADMAP-TO-PUBLISH.md` (phases 0–4; live queries promoted to Phase 2 per Danny).
- Verified: 149/149 tests, typecheck, build, lint — every commit.

## [2026-07-19] — Operation Spick-and-Span, night one: Track A complete + chip 2.5 + honesty pass

- [feat] Chip 2.5: `createOptimisticUpdates(store)` (src/transactions.ts) + `createCoalescer` (src/coalesce.ts) moved from the plugin's composables.ts, logic unchanged — TanStack-style clear-and-replay transactions, concurrency-correct commit folding. This is the substrate the Stage-2a `willCommit` gate wraps.
- [feat] A3 Safari armor: idbEngine open() per-attempt deadline + retry + memory-only degradation (WebKit 226547 — open() can hang with no callback). A4 quota armor: `requestDurableStorage()` + `enablePersistence({requestDurable})`.
- [test] A1 referential-stability suite (Dexie #2034 class) incl. rollback leg; A2 optimistic-op cleanup after failure storms (Dexie #2058 class). **Track A complete. 137 tests green** (113 → 137 tonight); typecheck/build/lint clean each commit.
- [chore] docs/BATTLE-TESTED.md added (adopted/refused/ahead receipts ledger); llms.txt added; README + BATTLE-TESTED tense-honesty pass per AI-first audit (unshipped ADR-007 primitives now clearly marked PLANNED — the audit's verdict: "architecture-true, code-false"; full audit in project folder).

## [2026-07-19] — subscription boundary (ADR-008 §3)

- [feat] `createStoreBoundary(store)` in `src/boundary.ts` — the adapter-facing contract: global / per-type / per-entity listeners fanned out from one store subscription, monotonic `getVersion()` as the external-store snapshot (no tick on no-op writes), `has()`-guarded snapshot reads that never mint phantom refs, per-listener error isolation, `dispose()`. 9 tests incl. the `useSyncExternalStore`-shaped vanilla-consumer contract test. 113 total green; typecheck/build/lint clean.
- [chore] DAN-577 re-targeted to this repo via Linear comment; discovered prerequisite chip 2.5 (optimistic-transaction system must move from plugin `composables.ts` into core before the pre-apply gate can wrap it).

## [2026-07-19] — ADR-008 design verdict + chip-2 normalization engine

- [feat] Chip 2: `normalize`/`denormalize` + helpers (`identifyEntity`, `splitEntityKey`, `writeEntitiesToStore`, walkers) extracted verbatim from the plugin's `plugin.ts` into `src/normalize.ts`; `normalize.spec.ts` came along. 104 tests green; typecheck/build/lint clean.
- [feat] ADR-008 accepted (council 2026-07-19): boring core, radical edges — port map (storage/sync/framework/agent/encryption/model/vector), `@vue/reactivity` internal behind an adapter-facing subscription boundary (TC39-swappable), Vite-playbook sequencing (Vue → vanilla → React), `encryptedEngine` planned as a FREE StorageEngine wrapper, agent demo = the acquisition wedge.
- Note: chip 3 (plugin swaps to `colada-db` dependency) is gated on the package being installable from the plugin repo — i.e., Danny's npm publish (or a git-URL dependency); a `file:` path out of the repo would break plugin CI.

## [2026-07-19] — repo born: chip-1 extraction from pinia-colada-plugin-normalizer

- [feat] Standalone engine extracted from `pinia-colada-plugin-normalizer` 0.3.0 (decision record: sweeos `core/projects/pinia-colada-normalizer-project/COMPETITIVE-PHASE-2026-07.md`). Moved verbatim where possible: `store.ts`, `persist.ts`, `pagination.ts`, `engines/` (memory / IndexedDB / OPFS SQLite + worker protocol), `sqlite-worker.ts`, and the framework-free spec files (`store.spec`, `persist.spec`, `engines.spec` — 80 tests).
- [feat] Core now imports `@vue/reactivity` (declared as a required peer) instead of `vue` — no Vue runtime dependency; adapters share one reactivity instance.
- [chore] `types.ts` reduced to the engine subset: removed `NormalizerQueryOptions`, `NormalizerPluginOptions`, `NormMeta`, `NORM_META_KEY`, and the `@pinia/colada` module augmentation (all stay plugin-side). `NormalizationResult` retained for the chip-2 `normalize`/`denormalize` move.
- [chore] Founding ADRs 003–007 adopted from the plugin repo (append-only; numbering continues here for engine decisions).
- [chore] Two spec sites replaced Vue's `nextTick` with a plain microtask flush (`Promise.resolve()`) — the tests only ever needed a tick, not the Vue scheduler.
- Verified: `CI=true pnpm test` 80/80 green · `pnpm typecheck` clean · `pnpm build` clean (tsdown, esm + dts) · `pnpm lint` clean. OPFS observe-run in Chromium deferred to chip 3 (no engine-code changes beyond import paths; the plugin's live verification from 0.3.0 still covers the identical engine files).
