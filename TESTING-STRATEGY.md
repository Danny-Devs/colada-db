# Testing Strategy — colada-db

> Why a local-first database needs a different test architecture than an ordinary library, and the layered suite that follows from it. Written 2026-07-23 after the publish-readiness audit found that every green check today proves a mock.

## The core principle: for a local-first DB, the mock is the enemy

An ordinary library's hard parts are pure logic — you test functions, inputs→outputs. A local-first database's hard parts are the exact opposite: **the messy real boundary** — asynchronous persistence to flaky real storage engines, durability across process death and reload, concurrency across tabs and optimistic transactions, and eventual consistency with a backend. None of that is a pure function.

The synchronous in-memory engine we test against resolves every write in one microtask. That makes it a *lie by omission*: every bug that needs a real async gap to exist is invisible to it. This is not hypothetical — the DAN-647 dispose data-loss bug and the entire ADR-012–016 durability family all hid there, green the whole time. The lesson is architectural: **invert the default.** The real engine is the source of truth for correctness; the mock is a speed optimization that must itself be conformance-checked against reality.

Two more properties reshape the design:

- **Process death is an input, not an incident.** A local-first DB's defining promise is "your data survives a kill at any instant." So the crash point must be *injectable* — you test "what survives if we die between issuing this write and its ack," not "does the happy path work."
- **The intended meaning is simple, so the oracle is free.** The store means "a Map that survives reloads." A plain `Map` (+ a refcount map for eviction) is a trivial reference model. That simplicity is leverage: it makes aggressive property-based testing unusually cheap, because comparing against the oracle is easy.

## The layered suite (L0–L6)

Each layer catches a class the layer below cannot. Ranked additions at the end.

- **L0 — Pure unit tests.** `normalize`, matcher AST, schema export. Fast, example-based. *Have — solid.*
- **L1 — Deterministic interleaving tests.** The gated-engine idiom (`gateWrites`/`slowEngine`) that holds `writeBatch`/`loadMany` open mid-flight and drives a specific interleaving. This is genuinely state-of-the-art *example-based* concurrency testing and is where the ADR-012–016 regressions live. *Have — excellent. Keep and extend.*
- **L2 — Engine-conformance suite.** ONE contract test set run against EVERY engine (memory, fake-idb, real-idb, sqlite). If memory passes and real-idb fails, that divergence *is* a mock-hides-reality bug, caught mechanically. Ship it as a kit a third-party `StorageEngine` author runs to prove their impl — executable spec and regression suite in one. Same pattern for `SyncAdapter` when Stage 3 lands. ***LANDED 2026-07-30** (DAN-653 Part B) — `src/engine-conformance.ts`, applied by `src/engine-conformance.spec.ts` against memory, fake-idb and the real sqlite-wasm SQL core. Capabilities (`reopen`, `versioned`) are declared and checked in both directions, so an engine that cannot satisfy a property is recorded as declining it rather than skipped silently. Found its first divergence immediately: DAN-724. Not yet published as a consumable export — DAN-725.*
- **L3 — Stateful property-based model testing.** The highest-ROI addition. Use `fast-check` `fc.commands` to generate random op sequences (`set/setMany/remove/evict/retain/release/tx-commit/tx-rollback/flush/dispose+reboot`), run them against the store AND the Map+refcount reference model, and assert agreement after every command and after a simulated reload. Add gated-engine IO-completion order as a generated dimension to shake out async races. This **searches the schedule space instead of hoping we guessed the interleaving** — the class no example test can cover. It would have found DAN-647 and most of the durability family automatically, and every failure yields a minimal, seed-reproducible counterexample. ***LANDED 2026-07-30** (DAN-653 Part A) — `src/model.property.spec.ts`. Oracle is three plain Maps (`mem`/`disk`/`refs`); IO-completion order is a generated dimension; the DAN-647 interleaving is pinned as an always-executed example; a committed negative control proves the oracle rejects a dropped write; a liveness floor asserts the search actually searched (~2100 commands/run).*
- **L4 — Real-browser durability lane.** Playwright against real IndexedDB + real OPFS/SQLite: write → reload the page → read, assert survival. The canonical local-first test — does data actually survive process death on real storage. The only lane that turns L1's mocked confidence into real evidence. ***LANDED 2026-07-31** (DAN-652) — `playwright.config.ts` + `tests/browser/{idb-reload,opfs-sqlite-reload}.spec.ts` over a vite-served fixture (`tests/browser/fixture/`), run by `pnpm test:browser` and deliberately OUT of `pnpm test` so the vitest inner loop stays sub-2s. Drives the real `enablePersistence` coordinator, not the raw port, because the DAN-647 class lived in the write-behind path. Three properties worth knowing: (1) the sqlite specs assert `engine.persistent === true` — the worker silently falls back to a `:memory:` DB when OPFS is unavailable, so without that flag a green run could prove nothing durable; (2) each file carries a **negative control** that boots a fresh profile and asserts it reads EMPTY, so the suite is known to be able to observe absence; (3) the Date divergence is pinned in BOTH directions — `Date` out of IDB, ISO `string` out of SQLite — which is the `types.ts` contract, not a defect. Verified by mutation: suppressing the seed writes turns the 4 survival/fidelity tests red while both negative controls stay green. Chromium only; WebKit is 4.2.*
- **L5 — Multi-actor / concurrency simulation.** N stores over one shared backend = the multi-tab model. Concurrent op sequences, assert the *documented* consistency model (today: last-writer-wins). Catches the D2/D3 multi-tab class; extends to the distributed model when sync lands. *Missing. Queue after L3/L4.*
- **L6 — Deterministic Simulation Testing (frontier / aspirational).** The FoundationDB / TigerBeetle discipline: make ALL nondeterminism (time, random, task/IO scheduling) injectable and seeded, then run millions of randomized schedules deterministically — a failing seed reproduces exactly. In JS the practical form is a seeded scheduler controlling microtask/timer/engine-resolution order layered under L3's op generator. This is the moonshot version of "we searched the schedule space"; worth prototyping once the library is published and load-bearing, not before.

**Cross-cutting:**
- **Perf-regression pins** — assert `getByType` recompute counts and heap growth so an O(n²) regression fails CI (catches the P1 class). Not correctness, but belongs in the suite.
- **The conformance kits (L2) double as documentation** — the executable spec a StorageEngine/SyncAdapter author reads.

## Priority order (what to build, in order)

1. ~~**L3 property-based model suite (DAN-653A)**~~ — ✅ **DONE 2026-07-30.**
2. ~~**L4 real-browser lane (DAN-652)**~~ — ✅ **DONE 2026-07-31.** Converted mocked durability confidence into real evidence; the publish/grant credibility artifact. L2 sharpened the case for it: the SQLite conformance run uses a `:memory:` database, so its reopen property proves data survives dropping the *engine*, not the *process*. Real process-death on real OPFS is only provable in a browser — and now is.
3. ~~**L2 conformance kit (DAN-653B)**~~ — ✅ **DONE 2026-07-30** (unified; publishing it as a third-party-author spec is DAN-725).
4. **Perf-regression pins** — ⬅️ **NEXT.** Cheap, stops the known scaling cliffs from regressing silently.
5. **L5 multi-actor sims** — before/with Stage-3 sync.
6. **L6 DST** — post-publish moonshot.

## The strategic payoff

"339 example tests pass" is a weak publish claim. "Correctness is property-searched against a reference model, crash-tested across reloads, and proven against real browser storage" is a fundamentally stronger one — and it is exactly the adversarial-verification-as-product story the broader trust thesis rests on. The test suite is not overhead here; for a database whose entire pitch is *trust your local data*, it is part of the product.
