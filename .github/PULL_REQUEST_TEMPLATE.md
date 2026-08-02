<!--
Thanks for the PR. The checklist is short on purpose — every line is
something this repo has actually been bitten by.
-->

## What this changes

<!-- One paragraph. What was wrong or missing, and what is different now. -->

## Why

<!-- The reasoning, not the diff. If it fixes an issue, link it. -->

## What you ran

<!-- Paste the results, not just the command names. -->

- [ ] `CI=true pnpm -r test`
- [ ] `pnpm -r typecheck`
- [ ] `pnpm -r build`
- [ ] `pnpm -r lint`
- [ ] `CI=true pnpm test:browser` — **required** if this touches a storage engine or the persistence coordinator
- [ ] `cd packages/mcp && pnpm observe` — **required** if this touches the agent surface

## What you watched fail

<!--
If you added a test or a check, break the thing it guards and confirm it goes
red, then say so here. A gate nobody has seen fail is a gate nobody has
verified. See LESSONS.md for the five times this repo learned that.
-->

## Checklist

- [ ] `CHANGELOG.md` updated under `## [Unreleased]`, written from the reader's perspective
- [ ] If the public API surface changed: `node scripts/check-api-report.mjs --update` run **in this commit**, and the reason stated above
- [ ] If a published file was added or removed: `scripts/expected-pack-manifest.txt` updated **in this commit**, and the reason stated above
- [ ] If this crosses an irreversibility line (ADR-022 — persisted format, public API, publish manifest, registry keys, wire shapes, package name): the decision is written down, not just implemented
- [ ] If a reviewer caught a mistake here: the lesson is in `LESSONS.md`, not only the fix
