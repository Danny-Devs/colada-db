# ADR-026: Degradation is observable without anything from the host

**Status:** Accepted
**Implementation:** shipped
**Force:** invariant
**Date:** 2026-08-21

## Context

This library degrades rather than fails. An engine that will not open, a write
that is rejected, OPFS missing outside a secure context, a database written by a
newer build, a matcher view over a boundary we cannot resolve a store from — in
every one of those the app keeps running. That posture is deliberate and is not
in question here.

Its cost is: **a degraded database is indistinguishable from an empty one.** The
page renders, reads return nothing, and no one is told. ADR-008 §4's critical
path is a framework-free vanilla-JS demo, and its single most likely real-world
failure is OPFS being unavailable because the page is not a secure context.

Of the five degradation paths, three were already observable in any runtime —
`writeBatch` failure and engine `open()` failure call `onError`, and the
SQLite/OPFS fallback is readable off the public `engine.persistent` getter. Two
spoke only through `console.warn`, behind the guard ADR-024's sibling work
(DAN-649) installed:

```ts
typeof process !== "undefined" && process.env && process.env.NODE_ENV !== "production"
```

That guard is correct and stays. But where `process` is absent it evaluates
false, so a CDN or `<script type="module">` consumer — the exact audience the
guard was written to rescue from a `ReferenceError` — got graceful degradation
with **no diagnostic at all**. The two silent paths were `format-version-newer`
(ADR-018's forward-tolerance escape hatch announcing itself) and a matcher view
losing gc pinning on a foreign `StoreBoundary`.

## Decision

Every degradation path is observable through a channel that requires **nothing
from the host runtime** — no `process`, no `console`, no bundler, no globals.
The channel is a callback the consumer supplies: `onDegraded`, on
`PersistenceOptions` and on `MatcherViewOptions`, receiving a `DegradationEvent`
carrying a **stable machine-readable `reason` code**.

Three sub-decisions inside that, each of which could have gone the other way:

**The reason vocabulary is OPEN, not a closed union.** `DegradationReason` is
`"format-version-newer" | "matcher-view-foreign-boundary" | (string & {})`. A
consumer's exhaustive `switch` must therefore already handle a code it does not
recognize. This mirrors ADR-018's own boot policy: a database stamped with a
version this build has never heard of is read anyway rather than refused, and a
diagnostic vocabulary for a forward-tolerant system should be forward-tolerant
in the same direction. The known codes are permanent — they are matched by
string equality in consumer code, so renaming one is a breaking change with no
compiler error anywhere to announce it.

**The matcher view gets BOTH a callback and a `retained: boolean` flag**, where
DAN-659 asked for one and justified. The deciding fact is that this particular
condition is settled **synchronously during `createMatcherView`, before it
returns** — so the callback carries no timing information the flag lacks, and
the flag can never be missed by a consumer who already holds the view. That
makes the flag the better primitive *here*. The callback still earns its place
for a different reason: it is what lets **one handler observe every degradation
in the library**, persistence and views alike, which a per-subsystem flag can
never do.

**`onDegraded` is separate from `onError`, not folded into it.** They answer
different questions. `onError` means persistence has been **disabled**;
`onDegraded` means it is still **running, under a caveat**. Folding them would
force every consumer to re-derive that distinction from an error's contents,
and would make "did my database stop working" unanswerable without parsing.

The dev `console.warn`s stay exactly as they are. This ADR adds a channel; it
does not move one.

## Alternatives Considered

- **Assume-dev-when-the-environment-is-unknown**, so the warnings survive where
  `process` is absent. Rejected, and it is worth recording why the obvious fix
  is the wrong one: the runtimes lacking `process` are precisely those most
  likely to lack a full `console` (embedded engines, QuickJS-class hosts,
  restricted worker sandboxes), so this would reintroduce an unguarded global
  read on the exact paths whose whole purpose is never to crash. It is
  self-defeating. It also gives a CDN production consumer un-silenceable console
  noise, since they have no `NODE_ENV` with which to turn it off.
- **Reuse `onError` for both.** Rejected above — it destroys the
  disabled-vs-degraded distinction, which is the one thing a consumer needs to
  decide whether to warn the user.
- **A flag only, no callback.** Works for the matcher view, impossible for
  persistence (the format-version check happens during an async boot the
  consumer is awaiting), and gives up the one-handler-for-everything property.
- **A closed reason union.** Better autocomplete ergonomics and true
  exhaustiveness today, at the cost of making every future code a silent change
  of meaning for anyone who wrote an exhaustive match. Deferring a code is not
  additive on a published contract.

## Consequences

- **Positive.** A framework-free page can detect degraded persistence
  programmatically and tell its user. The playground harness now asserts
  `A0b · no silent degradation`, so a "durable" measurement standing on an
  unreported caveat fails visibly instead of reading as a pass.
- **Positive.** One handler covers persistence and every view.
- **Negative.** The format-version message string now ships to production
  instead of being dead-code-eliminated, because it is a field of a public event
  rather than a dev diagnostic. Duplicating it to keep the old one strippable
  would buy a few hundred bytes and guarantee the two texts drift.
- **Negative.** `MatcherView.retained` is a *required* property, so anyone
  hand-writing a `MatcherView` test double must now supply it. Accepted: making
  it optional would weaken the guarantee for real consumers, who would have to
  handle `undefined`, in order to protect hypothetical mock authors.
- **Risk — the codes, not the plumbing.** The reason strings are the
  irreversible part (ADR-022 line 2) and nothing in the type system stops a
  rename. **The mechanical check is `pnpm check:api-report`**: the codes appear
  verbatim in `etc/colada-db.api.md`, so a rename fails the diff and must be
  argued for in the same commit. That check is what makes this an invariant
  rather than a principle.
- **Watch for.** New degradation paths added later that report through
  `console` only. The lint cannot see this — it bans unguarded `process`, not
  unobservable degradation — so it is a review question until a path count is
  asserted somewhere.
