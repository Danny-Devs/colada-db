# ADR-022: The irreversibility lines — what publish makes permanent, and why they get specified out of phase order

**Status:** Accepted
**Date:** 2026-07-30
**Context ticket:** DAN-724 (the live instance), DAN-653 (how it surfaced)

## Context

Planning here runs near-to-far: the durability seam before trust primitives
before the agent surface before publish. That ordering is correct for
*sequencing work*. It is wrong as a rule for *deciding things*, and the
difference has already cost us once.

Most decisions are cheap to revisit. You change the code, ship a new version,
and consumers upgrade. A small number are not: once a byte has been written to
a real user's disk, or a path has been published to a registry, or a key has
been interned into a global registry, **the decision stops being ours**. The
cost of getting one of those wrong is not rework. It is a migration executed on
other people's data, on devices we do not control, at a time we do not choose.

Those decisions are what this ADR calls **irreversibility lines**, and the
governing property is that they do not respect phase boundaries. A requirement
belonging to Phase 5 can be permanently foreclosed by a Phase 4 freeze. Phase
order tells you what to *build* next; it tells you nothing about what to
*decide* early.

### The live instance (why this ADR exists now rather than at publish)

The DAN-653 conformance kit found on its first run that `memoryEngine` and the
SQLite core populate the optional per-row `version` counter (the ADR-005
arbitration slot) while **`idbEngine` — the default engine — never sets it**
(DAN-724).

That is legal: `version?: number` is optional. It is also latent: nothing in the
coordinator branches on it today. The problem is *where* it becomes live.
`version` is what a Stage-3 sync coordinator (ADR-006, Phase 5) would use to
arbitrate "which write is newer". So a Phase-5 requirement is sitting
unimplemented in the persisted shape of the engine we are about to freeze in
Phase 4.

If publish ships the IndexedDB format without it, adding it later is a
persisted-format migration against live user data. If we decide now — either
implement it, or state in the contract that absence means "unknown" and
consumers must never read it as "older" — it costs a decision.

Nothing was done wrong here. The asymmetry was invisible because the only test
covering it ran against `memoryEngine` alone. That is precisely why the lines
need to be *written down* rather than *noticed*.

## Decision

**Every decision that crosses an irreversibility line is specified to full
detail before publish, regardless of which phase nominally owns it.**

The lines, and what each one makes permanent:

| # | Line | Permanent because | Governed by |
|---|---|---|---|
| 1 | **Persisted format** — on-disk row shape, key encoding, index rows, the `version` slot | a real user's disk already holds the old shape | ADR-018 (`cdb` identifiers, `formatVersion` escape hatch) |
| 2 | **Public API surface** — exported names, type shapes, read-type identity | removing a path later is a breaking change for every consumer | ADR-019 |
| 3 | **Publish manifest** — which files ship, under which paths, from which entry points | *a version already on the registry cannot be un-shipped* | `scripts/expected-pack-manifest.txt` |
| 4 | **Global registry keys** — `ENTITY_REF_MARKER` = `Symbol.for("colada-db/entity-ref@1")` | a registry key interns across copies **and versions**; two majors in one app share it | ADR-020 |
| 5 | **Wire and protocol shapes** — the serializable matcher AST, the SyncAdapter contract | they cross a process, storage or network boundary, so both sides are not ours to upgrade together | ADR-009, ADR-006 |
| 6 | **Package identity** — the npm name, the `colada` naming courtesy | a published name is claimed; a rename orphans every install | DAN-667, Danny's gate |

### The operating rule

When work touches any line above, the question is not "is this in scope for
this phase." It is **"if we are wrong, who pays, and can they choose not
to?"** If the answer is "a user, on their own disk, with no choice," it gets
decided now and written down here or in the ADR that owns it.

Detail is cheap. Certainty is not. Specifying a far-out contract early and
revising it twice costs almost nothing; discovering it after publish costs a
migration. This is the correction to naive rolling-wave planning, which
rationed *detail* by distance because detail used to be expensive. It no longer
is. What still varies with distance is confidence — so far-out work is
specified **fully and revisably**, never left deliberately vague.

## Alternatives considered

- **Handle it at the publish checklist (Phase 4.x).** Rejected: by then the
  engine formats and API surface are already written, and "checklist" is the
  wrong instrument for a decision that needed to be made while the code was
  being designed. DAN-724 is exactly what this failure mode looks like — caught
  eight days before publish by an unrelated test suite, entirely by luck.
- **A blanket "specify everything fully, always."** Rejected as unfalsifiable:
  with no stated criterion, every decision claims to be load-bearing and the
  rule stops discriminating. The table above is deliberately short and each row
  names *who pays* if it's wrong.
- **Encode it as a mechanical gate now.** Deferred, not rejected. Lines 3 and 4
  already have real gates (`check:pack-manifest` both directions;
  `engines.spec.ts` pins the ref-marker shape). Lines 1, 2 and 5 have no
  mechanical enforcement, and inventing one before the shapes are final would
  gate against a moving target. Revisit at the publish checklist — noted as
  known debt rather than claimed as done.

## Consequences

- **Positive.** A cross-phase constraint now has somewhere to live. The
  question "can this wait for its phase?" has a written answer instead of
  depending on who is in the room. New engines and adapters get held to the
  lines before they ship rather than after.
- **Positive.** It makes the *reason* for out-of-order work legible. Specifying
  the SyncAdapter contract (Phase 5) while Phase 4 is open is not scope creep —
  it is line 5, and this ADR is the citation.
- **Negative.** Some far-out specification will be written and then revised, or
  discarded when a phase changes shape. That is the accepted cost, and it is
  small relative to a migration.
- **Risk.** The table can rot: a seventh line could appear (an on-chain
  identifier, a plugin ABI) and go unrecorded. Mitigation is that ADRs are
  append-only — a new line means a new ADR that supersedes this one, and the
  history of what we thought was permanent is itself worth keeping.

## Open

- **DAN-724** — decide line 1's `version` question before the IndexedDB format
  is frozen at publish: implement in `idbEngine`, or state in the contract that
  absence means "unknown" and must never be read as "older."
- ~~**Line 2** has no api-report snapshot yet. Until one exists, "did the public
  surface change?" is answered by review rather than by a diff — which is the
  same class of weakness ADR-021 records for CI. Tracked under Phase 4.~~
  **[RESOLVED 2026-08-01]** — `etc/colada-db.api.md`, generated and diffed by
  `scripts/check-api-report.mjs`, wired into `prepublishOnly` and the CI
  `publish-surface` job. Comments are stripped so a JSDoc edit does not churn
  the report; every signature, optional marker and barrel entry is compared
  verbatim. Watched to fail before being trusted: 7/7 selftest, then a real
  removed export (`memoryEngine`) caught and named at the exact line.
  *(Struck rather than deleted — ADRs here are append-only, and an Open item
  that silently vanishes is indistinguishable from one nobody did.)*
- **DAN-733** — the publish flip crosses lines 1, 2, 3 and 6 simultaneously.
  Suggested order: DAN-724 decided → api-report snapshot exists → publish.
