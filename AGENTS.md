# AGENTS.md — colada-db

Codebase manual for any agentic workflow touching this repo.

## What this is

The standalone engine extracted from `pinia-colada-plugin-normalizer` (decision: 2026-07-19, see the competitive brief in the sweeos workspace at `core/projects/pinia-colada-normalizer-project/COMPETITIVE-PHASE-2026-07.md`). The plugin remains the Vue / Pinia Colada adapter and — until the extraction completes (chip 3 below) — still carries its own frozen copy of these engine files. **Until chip 3 lands, engine changes here do NOT automatically reach the plugin.**

## Extraction state (chips)

1. ✅ **Chip 1 (2026-07-19):** framework-free modules moved — `store`, `types` (engine subset), `persist`, `pagination`, `engines/*`, `sqlite-worker` + their specs (80 tests). Core imports `@vue/reactivity` directly (peer), never `vue`.
2. ⬜ **Chip 2:** extract `normalize`/`denormalize` + helpers out of the plugin's `plugin.ts` into the engine (they are already pure functions); `NormalizationResult` is here waiting for them. Branding pass on symbol descriptions.
3. ⬜ **Chip 3:** plugin swaps its internal engine copy for a `colada-db` dependency. Public API unchanged; existing plugin users see nothing.

Stage-2 primitives (Linear DAN-577: origin tags, PRE-apply `willCommit` policy gate, capped+redacting history store, enriched schema registry) are built HERE, not in the plugin.

## Rules

- **Verify by running:** `CI=true pnpm test` + `pnpm typecheck` + `pnpm build` + `pnpm lint`, all green, before reporting done. Storage-engine changes additionally require observing real OPFS behavior in Chromium.
- **Reading order:** this file → `docs/adr/` (003–007 are the founding decisions) → `CHANGELOG.md` (last 3 entries).
- **ADRs are append-only.** 003–007 were adopted from the plugin repo at extraction; new engine decisions continue the numbering here.
- **No publish, no external pushes, no outreach** without Danny's explicit go. The npm name `colada-db` is reserved; `"private": true` stays until Danny flips it.
- **Shared knowledge base:** competitive/architecture research lives in the sweeos workspace at `core/projects/pinia-colada-normalizer-project/knowledge/` (steal-lists, landscape, routing). Read it before architectural work; file new findings back there.
- **The peer-range lesson:** before writing any dependency range, check whether the upstream publishes prerelease-only versions (`npm view <pkg> versions`) — `@sqlite.org/sqlite-wasm` must stay `"*"`. (Inherited from the plugin's LESSONS.md, encoded in `engines.spec.ts`.)
