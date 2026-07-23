# AGENTS.md — colada-db

Codebase manual for any agentic workflow touching this repo.

## What this is

The standalone engine extracted from `pinia-colada-plugin-normalizer` (decision: 2026-07-19, see the competitive brief in the sweeos workspace at `core/projects/pinia-colada-normalizer-project/COMPETITIVE-PHASE-2026-07.md`). The plugin remains the Vue / Pinia Colada adapter and — until the extraction completes (chip 3 below) — still carries its own frozen copy of these engine files. **Until chip 3 lands, engine changes here do NOT automatically reach the plugin.**

## Extraction state (chips)

1. ✅ **Chip 1 (2026-07-19):** framework-free modules moved — `store`, `types` (engine subset), `persist`, `pagination`, `engines/*`, `sqlite-worker` + specs.
2. ✅ **Chip 2 (2026-07-19):** `normalize`/`denormalize` + helpers in `src/normalize.ts`.
3. ✅ **Chip 2.5 (2026-07-19):** optimistic transactions (`src/transactions.ts`) + coalescer (`src/coalesce.ts`) in core. ⚠️ One-handle-per-store is currently a doc contract, not enforced (arch review H3) — see roadmap Phase 0.6.
4. ⬜ **Chip 3:** plugin swaps its internal engine copy for a `colada-db` dependency (GATED on npm publish / git-dep). ✅ The persisted-format branding collision (arch review C4) is RESOLVED: DAN-654 / ADR-018 unified every wire/disk identifier on `cdb` (`__cdb_ref`, `cdb_entities`, `cdb_entities.sqlite3`) as a clean break — free because colada-db is unpublished and the plugin never shipped persisted data. No migration exists by design; a `formatVersion` escape hatch is reserved in the manifest index row. The chip-3 plugin wrapper must share ONE optimistic-updates handle per store (the current per-call composable is a live bug).

**Master plan:** `../ROADMAP-TO-PUBLISH.md` (phases 0–4; Phase 0 = the durability seam — read `../REVIEW-ARCH-2026-07-19.md` before touching store/persist/transactions). Stage-2 primitives (DAN-577) build HERE, not in the plugin, on the Phase-0-frozen event shape.

## Rules

- **Verify by running:** `CI=true pnpm -r test` + `pnpm -r typecheck` + `pnpm -r build` + `pnpm -r lint`, all green, before reporting done (workspace-recursive since 2026-07-20: the repo `.npmrc` sets `include-workspace-root=true`, so `-r` covers the core AND `packages/*`). Storage-engine changes additionally require observing real OPFS behavior in Chromium. Agent-surface changes additionally require the observe-run: `pnpm -r build && cd packages/mcp && pnpm observe`.
- **Workspace shape:** core engine at the root; edge packages under `packages/*` (ADR-008 §2 — core knows nothing about them). First member: `packages/mcp`, the read-only MCP agent surface (ADR-011, `docs/design/mcp-agent-surface.md`). Deny-by-default is structural there — never register a write tool on that surface; agent write affordances arrive only with the guard middleware, as their own deliberate surface.
- **Reading order:** this file → `docs/adr/` (003–007 are the founding decisions) → `CHANGELOG.md` (last 3 entries).
- **ADRs are append-only.** 003–007 were adopted from the plugin repo at extraction; new engine decisions continue the numbering here.
- **No publish, no external pushes, no outreach** without Danny's explicit go. The npm name `colada-db` is reserved; `"private": true` stays until Danny flips it.
- **Shared knowledge base:** competitive/architecture research lives in the sweeos workspace at `core/projects/pinia-colada-normalizer-project/knowledge/` (steal-lists, landscape, routing). Read it before architectural work; file new findings back there.
- **`pnpm lint` is oxlint PLUS a repo-local rule.** `no-unguarded-process-env` (`scripts/no-unguarded-process-env.mjs`) bans any reference to the global `process` in shipped source (`.ts`/`.tsx`/`.mts`/`.cts`) unless DOMINATED by a `typeof process !== "undefined"` guard — shipped code must run in bundler-less runtimes (CDN / plain browser ESM) where `process` does not exist, and the failure only appears on degradation paths. It also catches `globalThis.process` / `self.process` / `window.process`, which fail identically with a `TypeError`. Accepted guard shapes include an inverted early return and a hoisted `const` (the repo's own house idioms), and there is an auditable escape hatch — `// lint-ok: no-unguarded-process-env — <reason>`, reason mandatory. Spec files are exempt. **The guard must spell the literal `process.env.NODE_ENV`, never `process.env?.NODE_ENV`** — optional chaining defeats the literal `define`/`replace` substitution bundlers key on, so the dev warnings leak into consumers' production bundles; `src/process-guard.spec.ts` pins this and no semantic test can. If the rule fires, read its message rather than reaching for an ignore: see LESSONS.md 2026-07-23.
- **`ENTITY_REF_MARKER` is a VERSIONED global registry key** (`Symbol.for("colada-db/entity-ref@1")`, ADR-019). Bump the `@N` suffix on any breaking change to the ref shape. All three branch sites — `encodeEntityRefs`, `decodeEntityRefs`, `isEntityRef` — must validate the SAME full shape (`entityType`/`id`/`key` all `string`); a global registry interns across copies and versions, so the marker alone is never sufficient.
- **The peer-range lesson:** before writing any dependency range, check whether the upstream publishes prerelease-only versions (`npm view <pkg> versions`) — `@sqlite.org/sqlite-wasm` must stay `"*"`. (Inherited from the plugin's LESSONS.md, encoded in `engines.spec.ts`.)
