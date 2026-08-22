# ADR-025: cr-sqlite Stays Rejected — on Correctness, Not on Liveness

**Status:** Proposed
**Implementation:** upheld
**Force:** heuristic
**Date:** 2026-08-21
**Upholds:** ADR-005 §3 (does not supersede it — the posture is unchanged; only the *grounds* are replaced)

## Context

ADR-005 (`Accepted`, `shipped`, 2026-07-12) is titled *"Version Metadata Slot + Sync Posture
(cr-sqlite Is Dead)"*. Its §3 replaced the Phase-4 cr-sqlite plan with server-authoritative sync.
**The posture has never been in doubt and is not reopened here.**

What is a problem is *why* it says so. ADR-005 rejects cr-sqlite on **project liveness**: "last
release v0.16.3 (Jan 2024), last repo push Oct 2024, npm wasm package unpublished-stale since Dec
2023. Its author moved to Rocicorp."

**Every one of those is a fact with an expiry date.** The upstream repository was pushed again on
2026-08-10. A future agent reading `docs/adr/` today learns that cr-sqlite was dropped because a
repo looked stale — and the moment that observation goes out of date, the recorded reason for the
decision evaporates while the decision itself stays on the page with nothing holding it up. That is
how a settled decision gets quietly re-proposed, and cr-sqlite is the version of this that will
actually happen, because *"CRDTs inside SQLite"* is the most rigorous-sounding option anyone can put
on this table.

Between 2026-08-20 and 2026-08-21 this project's agent lane measured cr-sqlite directly, in a real
browser, on a real OPFS database, across two engines — producing **nine** `knowledge/` files. **No
ADR referenced any of them**, and the two commands that establish it are worth running rather than
believing:

```bash
$ grep -rli 'cr-sqlite\|crsql' docs/adr/
docs/adr/005-version-metadata-and-sync-posture.md
docs/adr/006-sync-adapter-interface.md          # both PREDATE the measurement work

$ grep -rl '2026-08-21' docs/adr/
                                                 # (nothing — before this file existed)
```

The second one is the whole ticket in a single line: **an entire lane's worth of measurement, and
the decision record it confirms could not see it.**

This ADR exists to connect the two, and to replace an expiring argument with one that does not
expire. **The evidence is confirmatory of ADR-005 — it just happens to be far stronger than what
ADR-005 actually argued.**

### The evidence, cited not restated

All nine were measured against our own `-Oz` WASM artifact (`sha256 cfc1f23f…262de`), SQLite 3.53.4,
real OPFS asserted, most with a positive control **watched to fail**. Read them before disagreeing
with anything below:

| finding | file |
| -- | -- |
| cr-sqlite runs in the browser on real OPFS at all — with caveats | `knowledge/crsqlite-in-opfs-proven-2026-08-21.md` |
| merge is order-independent | `knowledge/merge-ordering-is-commutative-2026-08-21.md` |
| wall-clock skew does not apply to the merge at all | `knowledge/clock-skew-irrelevant-to-crsqlite-2026-08-21.md` |
| deletes commute; the winner is not arbitrary | `knowledge/tombstone-ordering-and-delete-wins-2026-08-21.md` |
| `cl` and `col_version` are different axes; recovery works | `knowledge/causal-length-is-an-axis-and-recovery-works-2026-08-21.md` |
| the alter guard is required; failures land at three distances | `knowledge/alter-guard-is-necessary-2026-08-21.md` |
| forward migration yes, backward no | `knowledge/schema-migration-and-rolling-upgrade-2026-08-21.md` |
| a wrapped batch rolls back completely, an unwrapped one does not | `knowledge/transactional-batch-apply-2026-08-21.md` |
| Safari works; the `-O0` correctness defect was the real finding | `knowledge/webkit-and-the-O0-defect-2026-08-21.md` |

### ⚠️ One correction the corpus contains and a reader will otherwise miss

`tombstone-ordering-…` calls delete-wins *"silent data loss for the editor."* The later
`causal-length-…`, written after the recovery experiment ran, **corrects this**: a re-insert beats a
held delete in every order, including on a replica that had already applied the delete, so what is
lost is **one update — not the row, and not the user's ability to get it back.**

> **Delete-wins is a silently lost edit, not a trap. The defect is the silence, not the
> irreversibility.**

Both files are cited above; the later one wins on this point. Anyone quoting the stronger phrasing
is quoting a superseded sentence, and the overstatement is not needed — the narrower claim is
sufficient for this decision and is much harder to argue with.

### 🛑 What this ADR does NOT decide

ADR-005 §3 ends: *"If true CRDT merge semantics ever become a requirement, that's Automerge/Yjs at a
document layer — **a different product decision, taken to council first.**"*

**No council has been convened, and this ADR does not open, close, or substitute for that clause.**
It is Danny's gate. This ADR takes the narrower question only — *given the posture ADR-005 already
set, what are the real grounds for it?* — and leaves the product question where ADR-005 put it.

**Scope fence:** this is about the **cr-sqlite line only**. The libSQL / Turso vector-tier work is
**on-plan** — ADR-005 §3 itself names Turso sync-wasm as a candidate to re-evaluate at 1.0. Nothing
here bears on it, and `knowledge/libsql-vector-tier-measured-…`, `sqlite-vec-in-opfs-proven-…`,
`rag-feasibility-…` and the two benchmark files belong to that separate line.

Nor is anything here a live defect. `README.md` states the shipped sync design is
server-authoritative and *deliberately CRDT-free*, and no adapter ships in this release. **This ADR
is about what a future agent will read and conclude, not about running code.**

## Decision

**cr-sqlite remains rejected as the sync substrate for colada-db, and the recorded grounds are
correctness and operational safety — not upstream project liveness.**

Specifically, ADR-005 §3 stands, and the argument supporting it is replaced with the following four
claims, each measured:

1. **The upstream WASM target does not build, and has not for years.**
   `crsqlite-in-opfs-proven-…` — `__rust_alloc_error_handler` is declared taking a `Layout` that the
   file never imports (`error[E0412]: cannot find type Layout in this scope`), and under
   `-Zbuild-std` the runtime supplies that symbol anyway. Reaching a working artifact required
   pinning **`nightly-2023-10-05`** and carrying a local patch. *Stale metadata suggests neglect;
   source that cannot compile for its own target demonstrates it* — and unlike a push date, that
   does not reverse when someone commits a README fix.

2. **Adopting a `crr` table adopts delete-wins whether or not anyone chose it.** A concurrent update
   is discarded against a delete with **no conflict surfaced**. Recoverable — but the user is never
   told there is anything to recover. This is a **design property, not a defect**: there is no
   upstream fix that removes it while leaving cr-sqlite what it is.

3. **Two of the failure modes are silent at exactly the wrong distance.** `alter-guard-…` measured
   that `DROP COLUMN` throws at the `ALTER` itself (caught in dev), `ADD COLUMN` throws only when
   someone later *edits* the new column, and **`RENAME COLUMN` is locally perfect — migrate, insert,
   update, read and reopen all clean — and fails only inside `crsql_changes`, where the replica
   receives `[]`.** A team that hardens migrations against what it saw in dev fixes the loud one,
   never sees the silent one, and ships it.

4. **The safe operating envelope is narrow and undocumented upstream.**
   `transactional-batch-apply-…`: an untransacted receiver that fails partway **re-publishes its own
   partial state as ordinary well-formed change rows**, becoming an authoritative-looking source of
   it to every peer, with nothing anywhere recording that a batch failed. `BEGIN`-per-batch is
   *unsafe* on a shared connection — transactions do not nest, so one sender's `COMMIT` commits
   another's half-finished batch. And `crsql_automigrate` **panics `unreachable` on 6/6 forms**,
   including a no-change schema and an empty database.

### Ruling: do NOT run cr-sqlite's upstream test suite as evidence for this decision

Recorded here because it is otherwise certain to be re-proposed by every successor as the most
rigorous-sounding available item.

**A green upstream suite certifies upstream's build.** Every finding in this lane is about **our**
`-Oz` artifact, built from a patched tree on a pinned three-year-old nightly. The suite would not
transfer to it, and `webkit-and-the-O0-defect-…` is the direct proof that the *build* is a live
variable: the same source at the default `-O0` fails where `-Oz` passes. Worth doing eventually, as
a check on our patch; **never the next thing**, and never as an answer to the questions above.

## Falsification — per finding, not in general

**What would have to be false for this decision to flip.** Stated per claim, because they do not all
expire the same way, and three of the four could genuinely be repaired upstream.

| # | claim | what would have to become true | would that flip the decision? |
| -- | -- | -- | -- |
| 1 | upstream WASM does not build | a released cr-sqlite that builds on **stable** Rust for `wasm32`, no local patch, no pinned nightly | **Partly.** Removes the maintenance objection and the ADR-005 liveness point in one stroke. Does not touch #2. |
| 2 | delete-wins discards a concurrent edit silently | either upstream surfaces the conflict, **or** an adapter of ours detects the discarded update and prompts — `causal-length-…` shows the merge already behaves well enough for this to be buildable | **This is the one that matters.** #2 is a design property; the others are defects. If #2 is genuinely resolved, this ADR should be reopened. If it is not, none of the rest is sufficient. |
| 3 | `RENAME` desyncs replicas with no local symptom | the guard bracket becomes unnecessary, **or** the failure becomes loud at the point of the `ALTER` | **No, on its own.** Already fully repairable in place today (`crsql_begin_alter`/`crsql_commit_alter`, byte-identical after the fact, idempotent). It raises the cost of correct operation; it does not by itself forbid adoption. |
| 4 | narrow envelope, panicking `automigrate` | `crsql_automigrate` stops panicking; nesting-safe batch application is documented upstream | **No, on its own.** Working practice exists — `SAVEPOINT`, or one connection per sender. Cost, not prohibition. |

**Read that table honestly: three of the four are fixable, and only #2 is structural.** The decision
does not rest on the pile being large. It rests on #2 being a property of what cr-sqlite *is*, with
#1, #3 and #4 establishing that the cost of operating it correctly is high and largely undocumented.

**Two things that would NOT flip it,** stated because they look like they should:
- **Upstream activity resuming.** Already happened (pushed 2026-08-10). It is what made ADR-005's
  original argument expire, and it is precisely why this ADR exists.
- **More green measurements from this lane.** The merge is commutative, clock skew does not apply,
  deletes converge, Safari works, recovery works. **All of that is true and none of it is an
  argument for adoption** — a substrate can be correct on every axis you measured and still impose
  a merge semantic the product did not choose.

## Alternatives Considered

- **Amend ADR-005 in place.** Rejected: ADRs are append-only here, and the *original* reasoning is
  worth preserving precisely because watching a liveness argument expire is the lesson.
- **Supersede ADR-005.** Rejected and it would be wrong: §§1, 2 and 4 (the version slot, device-local
  pagination, version-aware fresh-wins) are shipped and untouched. Only the grounds under §3 change.
  Marked `Upholds:`, not `Supersedes:`.
- **File nothing — the knowledge files exist.** Rejected: that is the status quo this ADR corrects.
  Nine files nobody is required to read do not stop a re-proposal; `docs/adr/` is in the standard
  reading order and `knowledge/` is consulted by topic.
- **Write it as an invariant with a CI ratchet** (grep for `@vlcn.io/*` in every `package.json`).
  **Rejected as dishonest.** The adoption path this lane actually walked was **vendoring a
  locally-built WASM artifact** — no npm dependency at any point. A manifest grep would pass, green,
  while the exact thing it purports to guard sat in the tree. Per the workspace convention, an ADR
  that cannot name a mechanical check is not an invariant, so this one says `Force: heuristic` and
  names its consumer instead.

## Consequences

- **Positive:** the recorded reason for a shipped posture no longer expires. Nine measured files gain
  an artifact that the standard reading order actually reaches. The re-proposal that was otherwise
  certain now costs its proposer a specific, falsifiable rebuttal instead of a fresh opinion.
- **Positive:** the falsification table names #2 as the load-bearing claim, so a future evaluation
  knows which single experiment would matter and can skip re-measuring the other eight files.
- **Negative:** this is a `heuristic` with no ratchet. It propagates by being read at one specific
  moment — **when a `SyncAdapter` with merge semantics is proposed.** Its named consumer is ADR-006's
  adapter roadmap, which should point here. If nobody reads it at that moment, it fails the same way
  ADR-005 §3 just did, and that is the honest risk.
- **Open, and not ours:** ADR-005 §3's council clause is unresolved. Two days of evaluation happened
  without it. **Danny decides** whether that was in-scope diligence — in which case this ADR should
  say so on ratification — or whether the direction is genuinely being reconsidered, in which case
  it goes to council. Tracked as DAN-920 Part 2.
