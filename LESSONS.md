# LESSONS.md — colada-db

Append-only failure log. Every recurring mistake gets encoded so the next
agent never makes it again. Strongest-encoding rule: lint > test > skill >
LESSONS entry (the entry then explains *why* the stronger encoding exists).

## [2026-07-23] — `set -e` is IGNORED for `!`-negated commands, so `! grep -q ...` is a shell assertion that cannot fail

**Mistake:** the DAN-658 CI workflow cross-checked the publish surface with the
obvious spelling of an absence assertion:

```bash
set -euo pipefail
! grep -q "pinia-colada-plugin-normalizer" dist/index.d.mts dist/index.mjs
grep -q "process\.env\.NODE_ENV" dist/index.mjs
! grep -q "process\.env?\.NODE_ENV" dist/index.mjs
! grep -q "@vue/reactivity" dist/index.d.mts
```

Three of those four lines were **no-ops**. POSIX: *"The shell shall not exit if
the command that fails ... has its return value inverted with `!`."* `set -e`
is explicitly disabled for `!`-negated commands, so a `! grep` line reads as an
assertion and behaves as a comment. Measured on the real artifact: injecting the
forbidden plugin branding produced **exit 0**; injecting
`process.env?.NODE_ENV` — the exact DAN-649 regression the line existed to
catch — also produced **exit 0**. Only the bare (non-negated) `grep -q` actually
gated, and the final `! grep` appeared to work purely by accident of being the
script's last command, where its status becomes the script's exit code.

**Why it happened:** the spelling is idiomatic, reads correctly in English, and
was carried in verbatim from the ticket. It was never run against a violating
artifact — the workflow was observed passing on a clean tree and on a red run
where an earlier step failed first, so the cross-check step never once executed
against input it was supposed to reject. A gate whose *failure* path has never
executed is not a gate; it is decoration that suppresses suspicion.

**Fix:** `scripts/cross-check-publish-surface.sh` — explicit `if ... ; then
exit 1; fi` helpers (`assert_absent` / `assert_present`), which have no
interaction with `set -e` whatsoever, plus a **self-test that runs both helpers
against poisoned fixtures before any real assertion** and aborts if either fails
to fire. All four invariants were then re-verified by corrupting `dist/` four
different ways and confirming exit 1 each time.

**For future agents:** never write `! cmd` and expect `set -e` to catch it —
use `if cmd; then exit 1; fi`. More generally, this is the same family as
DAN-657 (`grep -c` exits 1 on zero matches, so an "expect zero" check reads a
PASS as a FAIL): **in shell, an assertion's exit code frequently does not mean
what it looks like it means.** The only reliable defense is the one this repo
already applies to its lint rules — make every gate demonstrate that it can
FAIL, against a fixture engineered to trip it, before trusting that it passed.
Copying an assertion from a ticket, an ADR, or a code review does not transfer
that proof; run it red yourself.

## [2026-07-23] — an environment guard can be runtime-CORRECT and build-time WRONG, and no semantic test can tell

**Mistake:** the guard shipped for the `process` fix was
`typeof process !== "undefined" && process.env?.NODE_ENV !== "production"`. It is
safe. It never throws. It returns exactly the right boolean in every runtime. All
30 tests written to police it passed — and it silently broke dead-code
elimination for *literal-substitution* definers. `@rollup/plugin-replace`
substitutes the **literal** member expression `process.env.NODE_ENV`; a `?.`
between `env` and `NODE_ENV` leaves no literal to find. Measured on the
canonical Rollup chain: the branch stopped folding, +1,106 bytes minified /
+400 gzipped, and all five internal dev-warning strings leaked into consumers'
production bundles. The shipped `dist/index.mjs` contained
`process.env?.NODE_ENV` 5× and `process.env.NODE_ENV` **0×** — a literal
definer had nothing to replace.

**Measured blast radius — record it honestly, it is narrower than it first
looked.** Five real production toolchains were built and grepped during the
review, not reasoned about: `@rollup/plugin-replace` + terser **leaked** the
warning strings; esbuild, Vite 8 app-mode, webpack 5 `mode:"production"`, and
Terser `global_defs` all **stripped correctly**, because their `define` is
AST-aware and folds the `?.` form. So most consumers — including this library's
Vite-first audience — were never affected. Do not restate this as "every
bundler"; the specific claim that survives measurement is *literal/regex
substituters break, AST-aware definers cope*. (An earlier draft of this entry
also named Vite and webpack as victims. They were measured clean. Corrected
here rather than left to mislead a future agent — an unverified victim list in
a knowledge base is worse than no list, because it gets trusted.)

**Why it happened:** every test we had was a SEMANTIC test — evaluate the
expression, assert the value. `process.env?.NODE_ENV` and
`process.env && process.env.NODE_ENV` are runtime-identical, so a semantic suite
is *structurally incapable* of distinguishing them. The difference lives one
layer down, in what a build tool can see in the source text, and nothing in the
repo looked at that layer. The optional chaining also *reads* like the more
careful choice, which is what got it past review.

**Fix:** the vB shape at all five sites —
`typeof process !== "undefined" && process.env && process.env.NODE_ENV !== "production"`
— which strips cleanly under a literal definer AND still tolerates a `process`
shim with no `.env` (the plain conjunct evaluates falsy instead of throwing).
The durable encoding is the **strippability pin** in
`src/process-guard.spec.ts`: every guard extracted from shipped source must
contain the literal substring `process.env.NODE_ENV`, plus a tree-wide check
that nothing optional-chains between `process.env` and `NODE_ENV`, plus a
positive control proving the detector fires on the broken shape. The lint's
suggested-fix message — which had been prescribing the broken shape, steering
every future fix into the same hole — now teaches the strippable form and states
why in one sentence.

**For future agents:** when a value only exists because a build tool substitutes
it, correctness has TWO axes — what it evaluates to, and what a definer can
recognise. Semantic tests only cover the first. If a code shape exists to
cooperate with a toolchain, pin the SHAPE, not just the behaviour: assert the
literal text a `define`/`replace` pass keys on. And write to the strictest
definer in the ecosystem, not the smartest — esbuild folds the `?.` form
happily, which is exactly why measuring against esbuild alone would have
concluded "no problem".

*Correction to the entry below (append-only, so stated here): it names Deno among
the crashing runtimes. That is wrong — Deno 2.7.9 exposes `process` via Node
compatibility (`typeof process === "object"`), verified 2026-07-23; it never
threw, before or after. The real beneficiaries are browsers / CDN /
`<script type=module>`, which WERE observed crashing pre-fix and degrading
cleanly post-fix in real Chrome 149.*

## [2026-07-23] — a lint that tests CONTAINMENT instead of DOMINANCE is worse than no lint

**Mistake:** `no-unguarded-process-env` decided a read was safe by asking "does a
`typeof process` check appear ANYWHERE in the left subtree of this `&&`". It
does not follow that the check controlled the read.
`(typeof window !== "undefined" || typeof process !== "undefined") && process.env…`
passed the lint, passed the companion regression, and still throws
`ReferenceError` in a real browser realm — executed under `node:vm` with `window`
present and `process` genuinely undeclared. Two green gates over code that
crashes is strictly worse than no gate: the next author trusts the tick.

Two sibling defects came from the same "close enough" posture. The rule exempted
every identifier in a name position, which swallowed `globalThis.process` — the
single most likely workaround, because the rule's OWN error message ("`process`
is a Node global") is what invites it, and it fails identically with a
`TypeError`. And the rule rejected both of this repo's house idioms for ambient
globals (the inverted early return in `persist.ts`, the hoisted boolean in
`engines/idb.ts`) while offering no suppression mechanism at all — so the only
escape from a false positive was deleting the rule from `package.json`.

**Why it happened:** containment is the easy AST query and dominance is the
correct one, and the fixtures written alongside the rule only exercised shapes
the author already had in mind. A rule authored and tested by the same pass
inherits that pass's blind spots wholesale.

**Fix:** real dominance — recurse through `&&` only for positive guards and `||`
only for negative ones (the exact dual: `a && b` truthy proves either conjunct;
`a || b` falsy proves both disjuncts), never through the opposite connective, a
ternary, a call, or a parenthesized disjunction. Plus early-exit dominance,
same-file const propagation, `globalThis`/`self`/`window`/`global` member reads,
and a mandatory-reason `// lint-ok: <rule> — <reason>` escape hatch. Every new
capability carries a fixture AND a firing proof: the old rule and the new rule
were run side by side over 13 shapes, 8 of which the new rule decides
DIFFERENTLY.

**For future agents:** a guard licenses a read only when *reaching* that read
proves the guard held. When writing any static check, state the dominance
question explicitly and recurse only through connectives that preserve it. Two
further rules earned here: (1) prove each capability by showing the verdict
CHANGE — red before, green after — because a capability with no firing proof is
not encoded, it is only claimed; (2) give every required gate an auditable
escape hatch with a mandatory reason, because a gate that cannot be satisfied
gets deleted, and a comment in the diff is reviewable where a `package.json`
edit is not.

## [2026-07-23] — a global your toolchain polyfills away is invisible until it reaches the one user who has no toolchain

**Mistake:** five dev-warning branches read `process.env.NODE_ENV` bare
(`matcher-view.ts`, `engines/sqlite.ts`, `persist.ts` ×3). `process` is a Node
global that does not exist in a browser loading `dist/index.mjs` from a CDN, in
Deno, or in a plain `<script type="module">`. Every one of those reads sat on a
DEGRADATION path — IndexedDB open failure, writeBatch failure, OPFS
unavailable, foreign StoreBoundary — so a bundler-less consumer worked
perfectly until persistence failed, at which point the graceful fallback threw
`ReferenceError: process is not defined` instead. The crash landed exactly
where the recovery code was supposed to run, and only for the framework-free
audience the ADR-008 §4/§5 pillars specifically target (DAN-649/A1).

**Why it happened:** the entire development toolchain hides this defect.
Vite/webpack/esbuild statically replace `process.env.NODE_ENV` at build time,
so the identifier is gone before the code ever runs; tests run under Node,
where `process` is real. Every environment the library is *developed and
tested* in provides the global, and the one environment that doesn't is the one
nobody was executing. Compounding it, the placement was maximally quiet: the
happy path never touches `process`, so no smoke test, demo, or playground
session could surface it — only an actual storage failure in an actual
bundler-less page.

**Fix:** the guard `typeof process !== "undefined" && process.env?.NODE_ENV
!== "production"` at all five sites (it still folds to `false` under a
bundler's static replacement, so dead-code elimination of the warnings
survives). The durable encoding is a LINT — `no-unguarded-process-env`
(`scripts/no-unguarded-process-env.mjs`, wired into `pnpm lint`), AST-based, which
bans any reference to the global `process` in shipped source unless dominated by
a `typeof` guard, and whose error message states the *reason* rather than the
rule name. Plus `src/process-guard.spec.ts` (30), which extracts the real guard
expressions from source and evaluates them with `process` bound to `undefined`
— asserting no throw, and (the anti-cheat) that the guard still returns `true`
in Node/bundler dev, so "fix" can never mean "delete the warning". Verified
failing pre-fix at both rungs, and the shipped `dist/index.mjs` was executed
with the global deleted across three degradation paths.

**For future agents:** when a value only exists because a bundler injects it,
your tests can never see its absence — the toolchain is the thing hiding the
bug. Any ambient global (`process`, `global`, `__dirname`, `Buffer`,
`require`) referenced in shipped library code needs a `typeof` guard AND a lint,
because the failing runtime is by definition the one you are not running.
Assume it doubly when the reference sits on an error path: degradation code is
the least-exercised code you ship, so a crash there converts a graceful
fallback into a hard failure precisely when the user was already in trouble.

## [2026-07-22] — rebuilding an object key-by-key must never use `obj[key] = v` for `__proto__`

**Mistake:** `encodeEntityRefs` / `decodeEntityRefs` rebuilt objects with
`result[key] = value` in a loop. When the source carried an OWN enumerable
`__proto__` key (JSON.parse and structured-clone both produce such keys from
persisted data) alongside a sibling `EntityRef` forcing the rebuild path, the
assignment invoked the `__proto__` *setter* on the fresh `{}` — silently
dropping the field AND reassigning the rebuilt object's prototype to the
supplied payload (prototype-pollution-adjacent). Symmetric bug in both codecs;
undetected because the common no-ref path short-circuits with an identity
return and never rebuilds.

**Why it happened:** `result[key] = value` reads as an obviously-correct own
-property write. It is — for every key EXCEPT `__proto__`, the one string key
that is an accessor on `Object.prototype`. The hazard only surfaces with
attacker-or-persisted data that has an own `__proto__` key AND a sibling ref,
so ordinary tests (object literals, ref-free data) never hit it.

**Fix:** `assignOwn(target, key, value)` — `Object.defineProperty` with a data
descriptor for `key === "__proto__"`, plain assignment otherwise. Regression:
`src/encode-decode-integrity.spec.ts` (M1 cases incl. nested, array, and a
constructor/prototype control proving those keys are already safe).

**For future agents:** any loop that rebuilds a plain object from untrusted or
persisted key/value pairs (`result[k] = v`) is a `__proto__` trap — route the
assignment through a helper that special-cases `__proto__` with
`Object.defineProperty`. `constructor`/`prototype` are data properties and need
no guard; `__proto__` is the sole accessor and the sole hazard.

## [2026-07-23] — a rename gate that greps for the retired token trips on tests asserting its absence

**Mistake:** DAN-654's DoD gate is `! grep -rn "__pcn_ref\|pcn_entities" src/`
(prove no wire/disk position still emits the old identifier). The new round-trip
test asserted the rename with `expect(author).not.toHaveProperty("__pcn_ref")`
and an explanatory comment — both of which contain the literal retired token, so
the gate flagged the test file even though the test is the *opposite* of a
regression (it proves the old key is gone).

**Why it happened:** a plain `grep` can't tell an emitting occurrence (a wire
constant, a db name) from a *negative assertion* about that same string. The
gate's intent is "no code writes the old name"; a test proving the old name is
absent has to name it.

**Fix:** assert the retired key's absence WITHOUT spelling it — pin the exact
key set instead: `expect(Object.keys(author).sort()).toEqual(["__cdb_ref",
"entityType", "id", "key"])`. Same guarantee (no stray heritage key rode along),
zero literal occurrences of the retired token.

**For future agents:** when a rename ticket ships a `! grep "<old>"` gate, write
the regression's absence-assertions structurally (exact key set, snapshot shape)
rather than `not.toHaveProperty("<old>")` — otherwise the test that proves you
did the rename is what fails the gate that checks the rename.

## [2026-07-23] — `grep -c` as a pass/fail gate inverts its exit code exactly when it passes

**Mistake:** DAN-656's DoD assertion is `grep -c "@vue/reactivity"
dist/index.d.mts   # must be 0`. It works — but "0 matches" is `grep`'s
*failure* exit (1). Chained after the other gates with `&&`, the whole DoD
command aborts at the very moment the ticket succeeds, and the run reads as a
red build. The inverse trap is worse: `grep -c … && echo PASS` reports PASS only
when the leak IS present.

**Why it happened:** `grep -c` prints a count to stdout but still exits on
match/no-match semantics, so the human-readable output (`0`) and the shell's
verdict (failure) disagree. A gate whose success condition is "no output" has to
either be negated (`! grep -q …`) or be a script that owns its own exit code.

**Fix:** encoded a rung up the ladder — `scripts/check-public-types.mjs`, wired
into `pnpm build`, reads the emitted declarations, prints a specific diagnostic
with file:line on a leak, and exits 1 **only** on violation. `pnpm -r build` now
carries the assertion, so it composes correctly with every other gate and can't
be forgotten. It also covers what the one-liner can't: leaks arriving through a
*different* barrel-exported type, in a file nobody edited. Verified by executed
negative control in both directions (fires on a reintroduced leak, silent when
clean).

**For future agents:** never put a bare `grep`/`grep -c` in a `&&`-chained DoD
command as an *absence* assertion. Use `! grep -q "<token>" <file>` if it must
stay a one-liner, and promote it to a script wired into `build`/`test` the
moment the artifact it checks is a publish surface — the exit code is then
yours, and so is the error message.

## [2026-07-22] — a Symbol in-memory marker with a plain-string wire key reopens the collision the Symbol closed

**Mistake:** `EntityRef` uses a `Symbol` marker specifically to avoid colliding
with user data (Issue #13), but the wire codec serializes it to the plain string
key `__pcn_ref` and the decode guard accepted ANY `{__pcn_ref:true, entityType,
key}`-shaped object as a ref — without requiring `id` or checking field types.
Ordinary persisted data shaped that way (or malformed collisions like
`entityType:123`) hydrated into broken / dangling `EntityRef`s.

**Why it happened:** the Symbol's collision-proofness lives only in memory; the
moment you cross a JSON/structured-clone boundary you're back to a string key
that user data can imitate, and the guard trusted the marker alone.

**Fix:** validate the FULL ref shape with correct types
(`entityType`/`id`/`key` all `string`) on decode; non-conforming data passes
through as plain data. The residual exact-shape-and-type collision is inherent
to a string wire marker and is bounded honestly in a code comment rather than
papered over.

**For future agents:** whenever an in-memory Symbol/branded marker is projected
to a serializable string key, the decode side must re-validate the FULL
structural shape+types — a string marker is a hint, never proof, and the
collision the Symbol closed is wide open on the wire.

## [2026-07-21] — snapshot-then-bulk-clear is never reentrant-safe when listeners can write

**Mistake:** `clear()` drained per-entity `remove` events (listeners run
synchronously inside each emission — the H5 contract *invites* them to
write) and then ran a trailing `typeMap.clear()` + `refCounts.clear()`.
Any write or `retain()` a listener made during the drain was applied,
evented... and silently erased by the bulk wipe, with no event for the
erasure. Every event consumer (live views, history, persistence
dirty-sets) permanently diverged from store truth (DAN-620; executed
repro in the DAN-606 land gauntlet).

**Why it happened:** the bulk wipe read as a harmless belt-and-suspenders
finish ("the loop already removed everything"). It wasn't redundant — it
was a second, *unevented* mutation path racing everything the listeners
did. The tell was already in the codebase: `gc()` handles the identical
problem correctly with per-item `refCounts.delete(key)` **before** each
evict emission, so drain-time retains survive. `clear()` just didn't
follow its own sibling's pattern.

**Fix:** ADR-012 (semantics: clear() removes exactly its entry snapshot;
reentrant writes survive) + `src/clear-reentrancy.spec.ts` (10 regression
tests, 7 verified failing pre-fix — the strongest available encoding) +
this entry.

**For future agents:** in any drain-that-delivers-events, every mutation
must go through the evented per-item path — a trailing bulk `.clear()`
(or any unevented cleanup) after a listener-visible loop is a silent
divergence bug by construction; snapshot what you intend to destroy at
entry and destroy exactly that, item by item.

## [2026-07-21] — a cache-layer event must never cancel a truth-layer correction

**Mistake:** the persistence subscriber's `evict` branch dropped any
pending save ("the last flushed value stands", ADR-004). After
remove→set within one debounce window, that pending save was the ONLY
thing correcting a durable row the remove had already invalidated —
cancelling it resurrected the pre-remove value on next boot (DAN-621;
found by the DAN-620 land gauntlet's adjacent-hole sweep).

**Why it happened:** the drop clause read as a harmless write-economy
("we'd only re-write what's already durable"). It carried a hidden
soundness assumption nobody wrote down: dropping a queued write is valid
only while the flushed state it falls back to is a *prior confirmed value
of a surviving entity*. An intervening `remove` breaks the lineage — the
fallback row is then dead state, and the queued write is a correction,
not a redundancy. Cancellation-as-optimization in a write-behind pipeline
is only safe when the cancelled write is provably redundant with flushed
truth under EVERY event interleaving, not just the common one.

**Fix:** ADR-013 (eviction has no authority over the durability pipeline
— evict never mutates the dirty sets; hydration honors the pending-truth
overlay) + `src/evict-resurrection.spec.ts` (9 regression tests, 6
verified failing pre-fix — the strongest available encoding) + this
entry.

**For future agents:** memory-projection events (evict, gc) may never
cancel, reorder, or suppress queued confirmed writes — the durability
pipeline must stay monotone in confirmed store truth; if an optimization
drops a queued write, prove the fallback state is a surviving lineage
first, and encode that proof as a test.

## [2026-07-21] — an exclusion window keyed to a phase flag is a span bug waiting to happen

**Mistake:** the persistence subscriber excluded hydration-origin writes via
a coordinator phase flag (`isHydrating`), and boot held that flag across
every `engine.loadAll()`/`loadMany()` await. The exclusion of ONE write
channel (hydration) thereby became the exclusion of ALL writes for the
duration of engine I/O — an app `set`/`remove` racing boot was applied to
memory, evented, and silently dropped from the durability pipeline
(DAN-630; flagged by DAN-621's self-review, executed here).

**Why it happened:** the flag conflated two different claims — "this write
IS hydration" (a property of the write) with "hydration is HAPPENING" (a
property of time). The temporal claim is only correct while every edit
preserves the exact span; boot's span had quietly widened to cover awaits.
The tell was in the codebase twice over: `hydrateScope` scoped the same
flag tightly around only its synchronous loop, and `hydrateRow` already
stamped every hydration write `origin: "hydration"` through the privileged
`runWith` channel — the exact per-event fact the flag was approximating.

**Fix:** ADR-014 (hydration exclusion by provenance: the subscriber skips
exactly `origin === "hydration"` events; the flag is deleted; debounce/gc
timers defer during boot so the ADR-013 overlay stays authoritative) +
`src/boot-hydration-writes.spec.ts` (8 regression tests, 6 verified
failing pre-fix — the strongest available encoding) + this entry.

**For future agents:** when excluding a write CHANNEL from a pipeline, key
the exclusion to per-event provenance (origin stamps), never to a
coordinator phase flag — any flag held across an `await` excludes
everything that races the await, and the failure is silent by
construction. If a phase flag and a provenance stamp both exist for the
same concept, the flag is the redundant, drift-prone one: delete it.

## [2026-07-21] — a residency-dependent guard is not a mask: eviction is exactly the case it can't cover

**Mistake:** ADR-015 gave optimistic DELETEs a hydration mask but gave
optimistic PUTs none, on the premise "while the optimistic value stays
resident, fresh-wins (`store.has`) blocks hydration." Eviction removes the
resident value — so after `tx.set(c1,"kept")` → `evict(c1)` mid-tx, a
`hydrateScope` paged the stale pre-tx engine row `v1` over the optimistic
projection. Worst of all it SURVIVED settlement: commit graduated "kept" to
disk while memory kept `v1` (DAN-635 flavor A; verified pre-existing at
`71fdf82`).

**Why it happened:** the argument "fresh-wins already blocks the put" quietly
narrowed "the optimistic projection is protected" to "the optimistic VALUE is
in memory." Those differ exactly when the key is evicted — a memory-only
event that is a first-class part of this store (ADR-004). A guard that
depends on a value being RESIDENT cannot protect the key's projection across
an eviction; only a mask keyed to the tx BUFFER (which outlives residency)
can. ADR-015 itself flagged the hole and filed it — the lesson is that a
"fresh-wins covers this" hand-wave is a residency assumption in disguise, and
residency is the one thing eviction breaks.

**Fix:** ADR-016 (the mask covers any buffered op — `buffer.get(key)?.op ===
"delete"` becomes `buffer.has(key)`, so a PUT vetoes hydration of its evicted
key just as a DELETE vetoes un-deletion) + `src/tx-foreign-interference.spec.ts`
(5 regression tests, 2 verified failing pre-fix — the strongest available
encoding) + this entry. The mask stays mask-first ON PURPOSE: yielding to a
foreign confirmed write would diverge at commit (encoded as the flavor-B
commit-leg pin), and the residual foreign-write hazard is bounded to the
sync-rebase seam (ADR-006 §6).

**For future agents:** when you protect an optimistic projection, key the
protection to the transaction BUFFER, not to the value's presence in memory —
a residency check (`store.has`, fresh-wins) silently stops covering the
projection the moment the key is evicted, and eviction is a first-class
memory event here. "Fresh-wins already handles it" is a residency assumption;
name it and test the evicted case before you rely on it.

## [2026-07-21] — a drain before an await hides truth from every observer for the flight

**Mistake:** `flush()` drained the dirty sets into local arrays before
`await engine.writeBatch` — correct for the write path, but the dirty
sets were ALSO the pending-truth overlay that `hydrateRow` and
`readManifestRow` consult. For the batch's whole flight (and, worse,
after an ack that a stale load snapshot straddled), confirmed truth was
invisible: removed entities resurrected into memory, evicted keys paged
back stale, and boot's lifecycle-listener flush walked straight into the
window (DAN-629; flavors executed across the DAN-621/DAN-630 gauntlets).

**Why it happened:** the drain read as a private handoff to the engine
("these are the batch's inputs now"). It wasn't private — the dirty sets
were doing double duty as the readable record of un-durable truth, and
the drain silently ended that duty a full await earlier than the
durability it was standing in for. The tell: ADR-013 had just promoted
the dirty sets from "write queue" to "overlay", and nobody re-audited
who else depended on their lifetime.

**Fix:** ADR-015 (drain is a MOVE into `inflightPuts`/`inflightDeletes`;
clearing is quiescence-gated — batch acked AND boot settled AND no
hydration bracket open) + `src/inflight-overlay.spec.ts` (11 regression
tests, 9 verified failing pre-fix — the strongest available encoding) +
this entry.

**For future agents:** when a queue is both a work buffer AND a truth
overlay, consuming it for one role must not blind the other — drain by
moving entries to a visible in-flight stage, and retire that stage only
at quiescence (acknowledged AND no reader that might predate the ack
still running), never at hand-off. If you find yourself clearing shared
state right before an `await`, list every reader of that state first.

## [2026-07-22] — a teardown flag that stops NEW work must not also stop the in-flight work's own completion

**Mistake:** `dispose()` set `disposed = true` right after kicking off its
final `flush()`. That flush, racing a prior batch still parked in
`await engine.writeBatch`, took the re-entrant `await inflightFlush;
return flush()` path — and the re-entrant `flush()` then bailed on the
`disposed` guard that had flipped true in the meantime. The in-flight
batch's own tail recovery (`if (dirtySaves.size>0) scheduleFlush()`) was
defeated by the SAME flag. A `set(Y)`/`remove(Y)` that entered the dirty
sets after the first drain parked was silently non-durable — the exact
data-loss `dispose()`'s final flush exists to prevent (DAN-647; only real
async engines expose it — a sync engine resolves the batch before dispose
runs).

**Why it happened:** `disposed` conflated two jobs — "reject NEW work"
(new subscriber events, new timers, new external flushes) and "this
coordinator is torn down" — and the final flush is neither: it is the
in-flight completion of work already acknowledged BEFORE teardown. A flag
raised to stop the future also stopped the present from finishing. The
tell was the async gap: the flag was read once at the flush's synchronous
entry (false) and again at its post-`await` continuation (true), the same
"state shifted across the await" shape as ADR-012–016.

**Fix:** ADR-017 (the final flush gets a single unforgeable exemption from
the `disposed` guard via an internal `final` param threaded through the
re-entrancy; `disposed` stays SYNCHRONOUS so the boot/hydration post-await
guards keep firing; the public `flush` wrapper hides `final` so external
callers still no-op post-dispose) + `src/dispose-flush.spec.ts` (4 tests,
3 verified failing pre-fix — the single-write test's residue is dropped by the
same bug so it doubles as a failing repro; only the post-dispose-sneak-in test
is a pure pin — the strongest available encoding) + this entry. Deferring the
flag instead was rejected: it reopens the boot guards
that stop retention/hydration from outliving the coordinator.

**For future agents:** a lifecycle flag that means "stop accepting new
work" must never gate the completion of work already in flight. When a
teardown/pause flag guards a code path, ask whether that path is starting
NEW work or finishing ALREADY-ACCEPTED work — exempt the latter (thread an
explicit `final`/`draining` token through it), and never solve it by
deferring the flag, which un-guards everything else the flag protects.
