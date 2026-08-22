# ADR-027: `cache_size` is a dial we did not have, not a default we set wrong

**Status:** Accepted
**Implementation:** shipped
**Force:** heuristic
**Date:** 2026-08-21
**Context ticket:** DAN-926 (the work), DAN-659 / ADR-026 (the observability posture it reuses)

## Context

`knowledge/hybrid-retrieve-benchmark-2026-08-21.md` measured a **59× steady-state
regression** at 100,000 vectors between the default page cache and
`PRAGMA cache_size=-262144` (1731 ms p95 against 29 ms), with the cliff appearing
between 10,000 and 25,000 vectors — two corpus sizes a developer would consider
adjacent. It states the invariant plainly: *any deployment persisting more than
~10,000 vectors must set `cache_size` explicitly.*

The finding was filed as a paragraph in a knowledge file and dispatched to this
lane as *"it is a default at open, not documentation."*

Two facts turned that dispatch into a decision rather than a chore.

**First, the invariant was unsatisfiable.** `grep -rn "cacheSize\|cache_size"`
over `src/`, `tests/`, `playground/` and `scripts/` returned nothing. There was no
option, no protocol field, and no `PRAGMA` anywhere in the engine. A consumer who
read the benchmark and wanted to comply *could not*. The knowledge file was not
merely the weakest rung — it was documenting a control that did not exist.

**Second, the measurement does not cover the workload the default governs.** The
59× was measured against a **`vec0` vector corpus in a custom WASM build**. The
engine this repo ships is a JSON `entities` table with no `vec0` in it, and the
benchmark's own §5 enumerates what it does not establish. Raising the shipped
default on that evidence would report a confident result about a question nobody
evaluated — and would hand every consumer a 256 MiB page-cache ceiling, which is
the same cost that file uses to *disqualify* the in-JS alternative ("146.5 MB, on
a phone, in a tab").

A premise check did move one thing: the benchmark hedged the 16 MiB default as
*"in this build."* Measured here on the **shipped** `@sqlite.org/sqlite-wasm`
3.53.0, `cache_size` reads `-16384` at `page_size` 8192. The default is the same
in both builds, so the finding transfers.

## Decision

**Ship the dial. Leave the default alone. Make the applied value readable.**

1. `SqliteEngineOptions.cacheSize?: number` — SQLite's own sign convention passed
   through unchanged (negative = KiB, positive = pages). Absent by default, so the
   build default stands.
2. `SqliteEngine.cacheSize: number | null` — read back **from the connection**
   after `open()`, never echoed from the request.
3. `applyCacheSize()` validates to an integer before interpolating into the PRAGMA
   text, and reads the value back on every call including the argument-less one.
4. The vec0 threshold is documented **on the option**, where someone setting it
   looks — not only in a knowledge file.

### Why the read-back is a requirement and not a nicety

This change crosses **ADR-022 line 5** — wire and protocol shapes, *"not ours to
upgrade together."* The app bundles `colada-db/sqlite-worker` itself, so main
thread and worker can skew.

Apply ADR-022's test — *if we are wrong, who pays, and can they choose not to?* An
older worker that silently drops `cacheSize` hands the consumer the exact 59× cliff
the option was set to avoid, with nothing reporting it. They pay, and they cannot
choose not to. Reading the value back from the connection makes that case surface
as `null` — observably unknown — instead of a false "applied". Two specs pin it.

It also crosses **line 2** (public API surface). Both additions are additive and
optional; `etc/colada-db.api.md` is regenerated in the same commit.

### Why there is no warning and no new degradation reason

The instinct on skew is a `console.warn`. ADR-026 landed one week's worth of
argument against exactly that, and its own open item names this trap: *a sixth
degradation path added later can go console-only and nothing notices.*

The getter **is** the observability. `engine.cacheSize` is a first-class value any
host can read without a console, which is what ADR-026 asks for, so no new
`DegradationReason` and no warn were added. This keeps the line-2 surface addition
to two optional members.

## Alternatives Considered

- **Set `cache_size=-262144` at open for everyone (the dispatched instruction).**
  Rejected. It generalizes a `vec0` measurement to an entity store that has no
  vectors, and charges every consumer 256 MiB of resident cache for a benefit
  none of them has been measured to receive.
- **Raise the default to some smaller compromise value (e.g. 64 MiB).** Rejected
  as worse than either end: no measurement supports the number, and an unmeasured
  default is harder to argue with later than an unchanged one.
- **Leave it in the knowledge file and cite it from `AGENTS.md`.** Rejected. The
  invariant names an action (`must set cache_size explicitly`) that no API made
  possible; documentation of an impossible action is the defect, not the fix.
- **Echo the requested value back instead of reading the connection.** Rejected —
  it is the cheaper implementation of a getter that then means nothing. The
  benchmark's own instrument was corrupted once by assuming a pragma held.

## Consequences

- **Positive:** the measured invariant becomes obeyable. Whoever adds a vector
  lane gets a documented dial at the point of use and a way to confirm it took.
  Protocol skew is detectable rather than silent.
- **Positive:** the entity-store default stays where measurement left it, and the
  reason is written down — a future agent re-reading the 59× cannot "fix" the
  default without arguing with this ADR first.
- **Negative:** `cacheSize` reading `null` is ambiguous between "old worker" and
  "connection reported nothing". Both mean *unknown*, which is the safe reading,
  but it does not distinguish them.
- **Risk to watch:** the entity workload is **unmeasured**, not measured-fine. If
  a consumer ever reports slow `loadAll` on a large store, the default is a live
  suspect and this ADR is the place to record what the measurement said.
