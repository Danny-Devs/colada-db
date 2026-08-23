---
title:       colada-db performance — measurements and how to reproduce them
kind:        reference
status:      active
updated:     2026-08-22
owner:       danny
verified_by: "pnpm bench (timings, median + spread) and pnpm bench:scaling (deterministic counts). Every figure below was produced by one of those two commands on the machine named in Environment."
---

# Performance

Two kinds of number live here, and they are kept apart on purpose.

**Counts** — how many times a reactive projection rebuilds, and how many entities
it touches doing so. These are deterministic: the same operations produce the
same counts on any machine, under any load. They are asserted in
`src/perf-pins.spec.ts` and **run on every push**, so a scaling regression fails
the pull request that caused it.

**Timings** — wall-clock throughput. These are machine-dependent and noisy, so
they **gate nothing**. A flaky gate gets weakened until it asserts nothing at
all; that is how perf suites die. They live behind `pnpm bench`, are reported
with median and spread rather than a best-of-N, and every one is paired with a
baseline measured on the same data in the same run.

> A number with nothing beside it is decoration. Every figure below names what
> it is being compared against.

## Reproduce

```bash
pnpm bench          # timings, with baselines and spread
pnpm bench:scaling  # deterministic count tables (exact, not approximate)
pnpm test           # includes src/perf-pins.spec.ts, the CI-gated pins
```

## Environment

| | |
|---|---|
| Machine | Apple M4 Max, 16 cores, 48 GB |
| OS | macOS 26.3 |
| Runtime | Node v24.12.0 |
| Harness | Vitest 3.2.7 (tinybench) |
| Commit | `perf/DAN-935-perf-receipts`, based on `333eb36` |

All timings below are **Node**, not a browser. Browser-engine figures are not
yet measured — see [What this does not measure](#what-this-does-not-measure).

---

## Finding 1 — bulk ingest must be batched, and the penalty is quadratic

`getByType()` returns a reactive projection that rebuilds by walking the whole
type map. `setMany` bumps the type version **once per type**; a loop of single
`set()` calls bumps it **once per entity**. With a live subscriber attached,
that difference is the difference between O(n) and O(n²).

Deterministic, from `pnpm bench:scaling`:

| entities | one-at-a-time visits | `setMany` visits | ratio |
|---:|---:|---:|---:|
| 100 | 5,050 | 100 | 50.5× |
| 200 | 20,100 | 200 | 100.5× |
| 400 | 80,200 | 400 | 200.5× |
| 800 | 320,400 | 800 | 400.5× |
| 1,600 | 1,280,800 | 1,600 | 800.5× |

The ratio doubles every time n doubles. That is the signature of a quadratic,
and it is exactly n(n+1)/2 visits.

In wall-clock, writing 1,000 entities with one live subscriber:

| arm | median | ops/sec | spread |
|---|---:|---:|---:|
| `setMany` — one batch | 0.155 ms | 6,449 | ±0.48% |
| baseline: `set()` in a loop | 15.3 ms | 65 | ±3.20% |

**≈ 99× faster**, stable across three independent runs (98.4×, 98.7×, 100.7×).

**What to do with this:** ingest through `setMany` (which is what
`writeEntitiesToStore` already does). The pins in `src/perf-pins.spec.ts` fail
if `setMany` ever loses its once-per-type batching — verified by injecting that
exact regression and watching the canary read 4.0× instead of its 2.5 ceiling.

---

## Finding 2 — a single field update costs a full walk of the type map

**This one is not fixed. It is measured and open.**

The projection built by `getByType()` reads `ref.value` for every entity while
assembling its array, so it registers a reactive dependency on **every entity
ref of that type** — not merely on the version counter. Changing one field on
one entity therefore invalidates the whole projection, which then re-walks all
n entities.

Deterministic, from `pnpm bench:scaling`:

| graph size | entity visits per single-field update |
|---:|---:|
| 100 | 100 |
| 200 | 200 |
| 400 | 400 |
| 800 | 800 |
| 1,600 | 1,600 |

Exactly n, at every size. m updates against a graph of n cost O(n·m).

Some rebuild is unavoidable — a projection that returns entity *values* must
react when a value changes. The full re-walk is not: one element moved.

**The likely fix is an ids-only projection** that depends solely on the type
version, letting components subscribe to individual entities and re-render only
the row that changed. That is the pattern the rest of the library is built
around; `getByType()` simply does not offer it today.

🛑 **That is a public API addition, which ADR-022 line 2 makes an irreversible
act, so it is Danny's call and not an agent's.** This document measures the cost
and stops there. The pin in `src/perf-pins.spec.ts` asserts only that the
current behavior does not get *worse* than one rebuild per update; it
deliberately does not bless the O(n) walk as correct.

---

## Finding 3 — normalization costs about what a deep clone costs

Normalizing a 601-entity feed (50 posts × 10 comments, 25 shared authors),
against `structuredClone` of the identical payload — the floor cost of merely
walking the data and extracting nothing:

| arm | median | ops/sec | spread |
|---|---:|---:|---:|
| `normalize()` | 0.377 ms | 2,652 | ±2.42% |
| baseline: `structuredClone()` | 0.401 ms | 2,492 | ±1.59% |

**≈ 1.1×** — within a rounding error of a deep clone. Two runs gave 1.14× and
1.09×, so treat this as *"normalization is approximately free relative to
touching the payload at all,"* not as a claim that it is faster.

Full ingest, normalize plus `writeEntitiesToStore` for the same 601 entities:
**0.494 ms median, 2,027 ops/sec, ±1.15%.**

---

## Finding 4 — `denormalize()`'s entity cache buys no measurable time

An unflattering result, kept because it is true. The optional cache argument on
`denormalize()`, on a 601-entity response with 25 shared authors:

| arm | median | ops/sec | spread |
|---|---:|---:|---:|
| `denormalize()` — no cache | 0.309 ms | 3,239 | ±0.35% |
| `denormalize()` — with cache | 0.305 ms | 3,278 | ±0.38% |

**1.01×**, identical on both runs. If that parameter exists for speed, it is not
delivering on this shape. If it exists for referential identity — returning the
same object for a repeated entity — then this benchmark is not the instrument
that judges it, and that property needs its own test rather than a timing.
Worth resolving either way; right now the answer is unrecorded.

---

## Finding 5 — the fan-out claim, measured

The claim normalization exists to make: *one copy, and every view holding it
sees the change.*

Setup: 40 cached query results, each nesting the **same** author entity. Rename
that author once. Both graphs are built before the clock starts; the name varies
per iteration so neither arm can short-circuit on an unchanged-fields check.

| arm | median | ops/sec | spread |
|---|---:|---:|---:|
| normalized — one `store.set()` | 0.0002 ms | 4,980,972 | ±0.85% |
| baseline: naive cache, patch every embedded copy | 0.031 ms | 32,633 | ±0.34% |

**≈ 153×** (152.6× and 156.6× across two runs).

The baseline is not a strawman: it does the minimum *correct* work a
response-shaped cache can do — walk each held response and patch the copies it
owns. The gap is structural. One entity lives in one place, so an update is one
write regardless of how many views hold it.

⚠️ **Scope of this figure:** it measures the *write*, not the downstream
re-render. What the update costs subscribers is a count, not a timing, and it is
governed by Finding 2 and pinned in `src/perf-pins.spec.ts`.

---

## What this does not measure

Named explicitly, because a benchmark that quietly omits its weak spots reads as
though it covered everything.

- **Storage engines.** Memory vs IndexedDB vs OPFS SQLite, cold and warm, is
  unmeasured. It needs a real browser, so it belongs in the L4 durability lane
  (`tests/browser/`), not in this Node harness. Any engine claim must assert
  `engine.persistent === true` first — the SQLite worker silently falls back to
  an in-memory database when OPFS is unavailable, so without that check a green
  run proves nothing durable.
- **Crash-consistency timing.** The differentiated lane, and also browser-only.
- **Heap growth.** `TESTING-STRATEGY.md` names it alongside recompute counts.
  Not pinned here; it needs `--expose-gc` and a settling protocol to be anything
  but noise.
- **One machine, one runtime.** Every timing is Node 24 on an M4 Max. Ratios
  between arms should travel; absolute figures will not.

## An earlier draft was wrong, and how

Two figures were removed rather than published, recorded here because the reason
is reusable:

1. **`store.get()` measured 8,531× faster than `denormalize()`.** A strawman: a
   Map lookup and a full 601-entity tree rebuild are not two ways of doing one
   task. No consumer re-derives a whole response to read one field. Deleted.
2. **The fan-out gap first read 3.96×.** The naive arm was constructing 40
   payloads *inside* the timed region while the normalized arm constructed one,
   so it was mostly timing object allocation. Moving setup out of the clock
   raised the true figure to ≈153×.

The second is the instructive one: **the bug made the library look worse, and
fixing it made the number both larger and honest.** Arms that do not share their
setup are measuring the setup.
