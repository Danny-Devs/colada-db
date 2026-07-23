# LESSONS.md — colada-db

Append-only failure log. Every recurring mistake gets encoded so the next
agent never makes it again. Strongest-encoding rule: lint > test > skill >
LESSONS entry (the entry then explains *why* the stronger encoding exists).

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
