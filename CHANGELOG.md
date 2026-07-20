# Changelog

## [2026-07-19] — repo born: chip-1 extraction from pinia-colada-plugin-normalizer

- [feat] Standalone engine extracted from `pinia-colada-plugin-normalizer` 0.3.0 (decision record: sweeos `core/projects/pinia-colada-normalizer-project/COMPETITIVE-PHASE-2026-07.md`). Moved verbatim where possible: `store.ts`, `persist.ts`, `pagination.ts`, `engines/` (memory / IndexedDB / OPFS SQLite + worker protocol), `sqlite-worker.ts`, and the framework-free spec files (`store.spec`, `persist.spec`, `engines.spec` — 80 tests).
- [feat] Core now imports `@vue/reactivity` (declared as a required peer) instead of `vue` — no Vue runtime dependency; adapters share one reactivity instance.
- [chore] `types.ts` reduced to the engine subset: removed `NormalizerQueryOptions`, `NormalizerPluginOptions`, `NormMeta`, `NORM_META_KEY`, and the `@pinia/colada` module augmentation (all stay plugin-side). `NormalizationResult` retained for the chip-2 `normalize`/`denormalize` move.
- [chore] Founding ADRs 003–007 adopted from the plugin repo (append-only; numbering continues here for engine decisions).
- [chore] Two spec sites replaced Vue's `nextTick` with a plain microtask flush (`Promise.resolve()`) — the tests only ever needed a tick, not the Vue scheduler.
- Verified: `CI=true pnpm test` 80/80 green · `pnpm typecheck` clean · `pnpm build` clean (tsdown, esm + dts) · `pnpm lint` clean. OPFS observe-run in Chromium deferred to chip 3 (no engine-code changes beyond import paths; the plugin's live verification from 0.3.0 still covers the identical engine files).
