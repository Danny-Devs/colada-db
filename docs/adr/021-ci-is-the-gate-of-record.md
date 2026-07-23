# ADR-021: CI is the gate of record, and the Node matrix splits toolchain floor from artifact floor

**Status:** Accepted
**Date:** 2026-07-23
**Context ticket:** DAN-658

## Context

Until this decision, colada-db had no CI and no git hooks — no workflow file, no
pre-commit, no pre-push, and `core.hooksPath` unset.

That is not merely a missing convenience. The house grooming doctrine ranks
durable encodings **lint > test > skill > LESSONS.md**, and the entire
justification for that ranking is that a lint rule "fires on every CI run" and
therefore cannot be ignored. With no CI, the top two rungs of that ladder were
false here. The 437-test suite, the `no-unguarded-process-env` rule, the
DAN-647/648 durability pins, and the ADR-019 type-surface gate all executed only
when a human remembered to type the command. Five durability fixes and three
data-integrity fixes shipped across 2026-07-22 and 2026-07-23 on the premise
that they would keep firing. None of them did, automatically.

Two forces shaped the design beyond "add a workflow":

1. **The `engines` claim could not be tested by the obvious matrix.**
   `package.json` declares `engines.node: ">=18"`. The dev toolchain floor is
   materially higher — `tsdown@0.21` requires `>=20.19.0`, and `oxlint@1.74`,
   `vite@8.1.5` and `oxfmt` all require `^20.19.0 || >=22.12.0`. A matrix that
   naively included Node 18 could not install, let alone build.
2. **A gate that has only ever been observed passing is not verified.** The
   repo's own LESSONS.md (2026-07-23) records a lint rule that tested
   containment instead of dominance: it was green over code that crashed, and
   "two green gates over code that crashes is strictly worse than no gate,
   because the next author trusts the tick."

## Decision

**CI is the gate of record.** `.github/workflows/ci.yml` runs on every push and
every pull request, and is the authority on whether a change is green. Three
independent jobs, so a failure names itself: `gate` (the four
Definition-of-Done commands across a Node matrix), `publish-surface` (textual
invariants of the built artifact), and `engines-floor` (the artifact runs on the
Node version `engines` claims).

**The two Node claims are tested separately, and neither is weakened to make the
other convenient.** `gate` runs on Node 20, 22 and 24 — the versions the
*toolchain* supports. `engines-floor` builds on Node 22, packs the tarball, then
switches the runtime to Node 18 and consumes the package the way a user would:
`npm install` the tarball plus the declared peer range, import by bare
specifier, exercise the store. The contributor floor and the consumer floor are
different promises to different audiences, and one matrix axis cannot express
both.

**The pre-push hook is opt-in, not automatic.** `.githooks/pre-push` mirrors the
gate locally; `pnpm hooks:install` enables it. Nothing installs it implicitly.

**Every publish-surface detector must prove it can fail.**
`scripts/check-publish-surface.mjs` runs each assertion against a synthetic
counter-example *before* asserting against `dist/`, and reports a detector that
does not fire on its own counter-example as a broken gate rather than a passing
one.

## Alternatives Considered

- **Matrix literally on `engines` (18, 20, 22, 24).** Rejected: cannot install
  or build on 18. The only ways to make it green are to drop Node 18 from the
  matrix silently — leaving the consumer promise untested while looking like it
  is tested — or to relax `engines` to `>=20`, which is a real narrowing of the
  supported audience being made for CI's convenience rather than on the merits.
  Both trade a true claim for a green tick.
- **Raise `engines` to `>=20.19` to match the toolchain.** Rejected as a
  category error. `engines` describes what a *consumer's* runtime must provide
  to run the shipped artifact; the toolchain requirement describes what a
  *contributor's* machine must provide to build it. The artifact was measured
  running correctly on Node 18.20.8, so `>=18` is accurate, and narrowing it
  would drop real users to simplify a config file. If the artifact ever stops
  running on 18, `engines-floor` goes red and the decision gets made on
  evidence.
- **One job running everything.** Rejected: a single red X forces a log dive to
  learn whether the failure was a test, a lint, or a publish invariant. Job
  names are free diagnostics.
- **Publish-surface assertions inline in the workflow as `grep` lines only.**
  Rejected as the primary implementation, for the reason the ticket itself
  identifies: an assertion that only fires in CI is the same disease as an
  assertion that only fires when a human types the command, relocated. The
  checks live in a script that also runs from `pnpm check:publish-surface`, the
  pre-push hook, and `prepublishOnly`. A `grep`-based leg is **retained as an
  independent cross-check** (`scripts/cross-check-publish-surface.sh`) — the
  script's positive controls prove each *detector* can fire, but cannot catch
  the script reading a wrong yet existing path, under which controls and
  assertions would both pass vacuously. Two implementations with genuinely
  independent failure modes.

  *Amended during self-review, before merge:* the cross-check was first written
  as four inline `! grep -q ...` lines under `set -euo pipefail`, exactly as the
  ticket specified. Three of them were no-ops — POSIX disables `set -e` for
  `!`-negated commands — so the leg asserted almost nothing. It now uses
  explicit `if ... exit 1` helpers and self-tests them against poisoned fixtures
  before asserting. Recorded here rather than quietly fixed because it is the
  strongest available evidence for this ADR's central claim: **a gate whose
  failure path has never executed is not a gate.** See LESSONS.md 2026-07-23.
- **Auto-installing the pre-push hook via a `prepare` lifecycle script.**
  Rejected. It would silently mutate a contributor's git config on `pnpm
  install`, which is a surprise, and it buys little: a hook is bypassable with
  `--no-verify`, so it can never be the authority. Making it *feel*
  authoritative while remaining bypassable is the false comfort this repo has
  already been burned by once.
- **A background watcher running the suite on file change.** Rejected on
  standing preference: transparent and event-driven over hidden daemons.

## Consequences

- **Positive.** Every encoding shipped in the 2026-07-22/23 durability family now
  fires without human memory. The `engines.node` claim is verified rather than
  asserted — it had never been tested before this ADR. `pnpm pack` runs on every
  push, so the `files` allowlist is checked continuously instead of on publish
  day. The publish-surface invariants are runnable in four places (CI, local
  script, pre-push, `prepublishOnly`), not one.
- **Negative.** Three jobs install dependencies separately, so CI does redundant
  work for a small repo. `engines-floor` reaches the npm registry outside the
  pnpm store, adding a flake surface the other jobs do not have. The `grep`
  cross-check duplicates four assertions that must be kept in step with the
  script.
- **Risks to watch.** `tsdown` builds with `target: "esnext"` and nothing pins
  that to the engines floor, so a toolchain bump can emit syntax Node 18 cannot
  parse. `engines-floor` will catch it; the honest responses are to lower the
  build target or raise `engines` on the evidence — never to delete the
  assertion. Separately, when the real-browser lane (DAN-652) and the
  property-based suite (DAN-653) land, they should arrive as their own CI jobs
  from the first commit rather than being retrofitted, since retrofitting is the
  failure this ADR exists to correct.
