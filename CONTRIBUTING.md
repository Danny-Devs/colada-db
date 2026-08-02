# Contributing to colada-db

Thanks for being here. This is a database — the failure mode is someone's data,
on their own device, at a time nobody chose. That shapes most of what follows.

## Getting set up

```bash
pnpm install
pnpm exec playwright install chromium   # once, for the browser lane
```

Node ≥20.19 is required to build (the toolchain needs it). The **published
package** supports Node ≥18, which is a separate promise, tested separately —
see the `engines floor` CI job.

## Verify by running

Before you say something works, run all four. Green means green.

```bash
CI=true pnpm -r test
pnpm -r typecheck
pnpm -r build
pnpm -r lint
```

`-r` is load-bearing: it covers the core **and** `packages/*`.

Two additional lanes, needed when you touch their area:

```bash
CI=true pnpm test:browser              # storage-engine changes — real IndexedDB + real OPFS
cd packages/mcp && pnpm observe        # agent-surface changes — drives the BUILT server
```

## Read before you write

1. `AGENTS.md` — how to work in this repo
2. `docs/adr/` — the decisions. 003–007 are founding; **022 is the one to read
   before touching anything permanent**
3. `CHANGELOG.md` (last 3 entries) — what changed recently and why
4. `LESSONS.md` — skim for your area
5. `TESTING-STRATEGY.md` — if you are adding tests (L0–L6)

## The house rules

**A gate is not proven until you have watched it fail.** This repo has a
documented history of checks that reported success on a question they never
evaluated — five separate instances, all in `LESSONS.md`. If you add a test or
a check, break the thing it guards and confirm it goes red. Say so in the PR.

**Never weaken a gate to make CI green.** A CI-only failure is a finding, not
an obstacle. Same for `pnpm lint`: `--deny-warnings` is deliberate, because
oxlint exits 0 on warnings. Fix the warning; don't drop the flag.

**ADRs are append-only.** A decision that gets reversed earns a *new* ADR that
supersedes the old one. The history is the value.

**Changes that cross an irreversibility line need an ADR-022 read first.**
Persisted format, public API surface, the publish manifest, the
`Symbol.for("colada-db/entity-ref@1")` registry key, wire/protocol shapes, the
package name. The test is *"if we are wrong, who pays, and can they choose not
to?"* If the answer is "a user, on their own disk, with no choice," it gets
decided deliberately and written down.

**If you change the public API surface**, regenerate the report in the same
commit as the change that caused it, and say why:

```bash
node scripts/check-api-report.mjs --update
```

An unexplained update is the one thing that gate cannot catch.

**If you add or remove a published file**, edit `scripts/expected-pack-manifest.txt`
in the same commit, and say why.

**Storage-engine work belongs in `tests/browser/`**, and must assert
`engine.persistent === true` before any survival claim. The SQLite worker falls
back to an in-memory database when OPFS is unavailable, so without that flag a
green run proves nothing durable.

**Shipped source cannot reference bare `process`.** It must run in bundler-less
runtimes (CDN, plain browser ESM) where `process` does not exist. Guard with
`typeof process !== "undefined"`, and spell `process.env.NODE_ENV` literally —
optional chaining defeats the substitution bundlers key on, which leaks dev
warnings into consumers' production builds. `scripts/no-unguarded-process-env.mjs`
enforces this; read its message rather than reaching for an ignore.

## Pull requests

`main` is protected and accepts **no direct pushes from anyone**, maintainer
included. Every change arrives through a PR whose six required checks passed:
`gate (node 20 | 22 | 24)`, `browser durability lane`, `publish surface`, and
`engines floor (node 18 consumer)`. Your branch also has to be up to date with
`main` before it can merge.

Two consequences worth knowing before they surprise you:

- **Don't use `[skip ci]`.** With required checks, a skipped workflow leaves
  those contexts *pending* rather than absent, and the PR can never merge.
- **If you rename a CI job**, the required-contexts list has to change in the
  same PR — a required check that is never reported blocks `main` permanently.

Then:

- One concern per PR. A refactor and a fix in one diff is two reviews.
- Update `CHANGELOG.md` under `## [Unreleased]`, written from the reader's
  perspective — *"fixed an issue where X"*, not *"ensured Y always receives Z."*
- If you made a mistake that a reviewer caught, add the lesson to `LESSONS.md`.
  Fixing the bug throws away the most expensive part.
- Say what you ran, and what you watched fail.

## Reporting bugs

Use the issue templates — they ask which engine, which browser, and whether
`persistent` was true, because those three answers determine whether a
durability report is reproducible at all.

**Security issues do not go in the tracker.** See [`SECURITY.md`](SECURITY.md).

## Scope

colada-db's core stays framework-free. Adapters (Vue/Pinia Colada and others)
consume the subscription boundary; they do not get special cases inside the
engine. If a change makes the core aware of a specific framework, it belongs in
that framework's adapter instead.
