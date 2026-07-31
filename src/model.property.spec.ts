/**
 * DAN-653 Part A — L3 stateful property-based model testing.
 *
 * Every other durability test in this repo is example-based: a human wrote
 * down an interleaving they had already thought of. That finds the bugs we
 * anticipated and, by construction, nothing else — and the entire ADR-012–016
 * family plus DAN-647 lived in orderings nobody wrote down. This suite
 * SEARCHES the schedule space instead of guessing at it.
 *
 * The leverage is that colada-db's intended meaning is small enough to state
 * in one line: **a Map that survives reloads.** That makes a reference model
 * nearly free, and a free oracle is what makes property testing worth doing.
 *
 * ## The oracle (read this before trusting a green run)
 *
 * The model is THREE plain Maps and nothing else:
 *
 *   mem   — what memory should hold
 *   disk  — what should still be there after a reload
 *   refs  — retain/release counts
 *
 * Its simplicity is the whole point, and it is a REVIEWER OBLIGATION to keep
 * it that way (DAN-653's stated non-mechanical constraint). If this model ever
 * has to import from `store.ts` / `persist.ts`, or starts reimplementing their
 * branching to stay green, the oracle has been compromised: two copies of the
 * same logic agree with each other even when both are wrong. The model may
 * only encode the CONTRACT (ADR-004's evict-vs-remove split, write-behind
 * durability, optimistic writes not reaching disk until commit) — never the
 * implementation.
 *
 * ## What is deliberately NOT modelled, and why
 *
 * - **Concurrent transactions.** At most one transaction is open at a time.
 *   Predicting concurrent optimistic replay would require a second copy of
 *   `transactions.ts`'s snapshot/replay algorithm inside the oracle, which is
 *   exactly the compromise described above. Multi-actor concurrency is L5 in
 *   `TESTING-STRATEGY.md` and gets its own harness.
 * - **Manifest-mode retention.** The coordinator calls `store.retain/release`
 *   itself under scope manifests (`persist.ts` `retainUnder`/`releaseScope`),
 *   which would make `refs` a shared counter with two writers. These runs use
 *   `hydration: "all"` and never touch `setManifest`/`removeManifest`, so
 *   refcounts have exactly one author: the generated commands.
 * - **Plain writes onto a key an open transaction already touched.** Guarded
 *   by each command's `check()`. That interleaving has genuine semantics
 *   (the plain write is non-transactional and reaches disk immediately, on
 *   top of optimistic data) but modelling it correctly needs the replay
 *   algorithm. Left to L5 rather than approximated.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEntityStore } from "./store";
import { enablePersistence, type PersistenceHandle } from "./persist";
import { memoryEngine, type MemoryEngine } from "./engines/memory";
import { createOptimisticUpdates, type OptimisticTransaction } from "./transactions";
import type { EntityRecord, EntityStore, StorageEngine } from "./types";

// ─────────────────────────────────────────────
// Universe — deliberately tiny so collisions happen
// ─────────────────────────────────────────────
//
// A large key space makes for pretty logs and terrible searches: random ops
// over 10k ids almost never touch the same entity twice, so merge, evict,
// resurrect and rollback interactions are never exercised. Six keys means
// nearly every command collides with an earlier one.

const TYPES = ["contact", "order"] as const;
const IDS = ["1", "2", "3"] as const;

type EntityAddr = { entityType: string; id: string };

const addrArb: fc.Arbitrary<EntityAddr> = fc
  .tuple(fc.constantFrom(...TYPES), fc.constantFrom(...IDS))
  .map(([entityType, id]) => ({ entityType, id }));

/** Two optional fields so shallow-merge is observable (`set` merges, ADR: store.set). */
const dataArb: fc.Arbitrary<EntityRecord> = fc
  .record({ a: fc.integer({ min: 0, max: 3 }), b: fc.integer({ min: 0, max: 3 }) }, {
    requiredKeys: [],
  })
  .map((fields) => fields as EntityRecord);

function keyOf(addr: EntityAddr): string {
  return `${addr.entityType}:${addr.id}`;
}

// ─────────────────────────────────────────────
// The reference model — three Maps. That is all.
// ─────────────────────────────────────────────

interface Model {
  mem: Map<string, EntityRecord>;
  disk: Map<string, EntityRecord>;
  refs: Map<string, number>;
  /** At most one open transaction; holds pre-transaction truth for rollback. */
  tx: { snapshot: Map<string, EntityRecord | undefined> } | null;
}

function freshModel(): Model {
  return { mem: new Map(), disk: new Map(), refs: new Map(), tx: null };
}

/** `set` semantics: shallow-merge onto an existing value, else insert. */
function mergedInto(prev: EntityRecord | undefined, data: EntityRecord): EntityRecord {
  return prev ? { ...prev, ...data } : { ...data };
}

/** True when an open transaction has already touched this key. */
function txHolds(m: Model, key: string): boolean {
  return m.tx !== null && m.tx.snapshot.has(key);
}

// ─────────────────────────────────────────────
// The system under test
// ─────────────────────────────────────────────

/**
 * Gates the engine's WRITE side so IO completion order becomes a generated
 * dimension rather than an accident of the runtime. Reads pass straight
 * through — the same split as `inflight-overlay.spec.ts`'s `gateWrites`,
 * which this deliberately mirrors.
 *
 * `awaitNextClose()` exists because `dispose()` returns `void` and fires its
 * final flush without handing back a promise (`persist.ts` ~976:
 * `void finalFlush.catch(...).then(() => engine.close())`). The engine's own
 * `close()` is therefore the only observable end-of-teardown signal, so the
 * reboot command latches it before disposing.
 */
interface IoGate {
  engine: StorageEngine;
  hold(): void;
  auto(): void;
  releaseOne(index: number): void;
  releaseAll(): void;
  pending(): number;
  awaitNextClose(): Promise<void>;
}

function gateIo(inner: MemoryEngine, onPut?: (key: string) => boolean): IoGate {
  const waiting: Array<() => void> = [];
  let holding = false;
  let closeSignal: (() => void) | null = null;

  const engine: StorageEngine = {
    ...inner,
    async writeBatch(puts, deletes) {
      if (holding) await new Promise<void>((resolve) => waiting.push(resolve));
      // Fault-injection hook for the negative control below. Undefined in
      // every ordinary run, so the honest path is the default path.
      const kept = onPut ? puts.filter((p) => onPut(p.key)) : puts;
      return inner.writeBatch(kept, deletes);
    },
    close() {
      inner.close();
      closeSignal?.();
      closeSignal = null;
    },
  };

  return {
    engine,
    hold() {
      holding = true;
    },
    auto() {
      holding = false;
    },
    releaseOne(index) {
      if (waiting.length === 0) return;
      const [resolve] = waiting.splice(index % waiting.length, 1);
      resolve();
    },
    releaseAll() {
      while (waiting.length > 0) waiting.shift()!();
    },
    pending: () => waiting.length,
    awaitNextClose() {
      return new Promise<void>((resolve) => {
        closeSignal = resolve;
      });
    },
  };
}

interface Real {
  inner: MemoryEngine;
  gate: IoGate;
  store: EntityStore;
  handle: PersistenceHandle;
  tx: OptimisticTransaction | null;
  /** Flushes started but not awaited — drained at every reboot and at teardown. */
  inflight: Promise<unknown>[];
}

/** Debounce far beyond any run: nothing flushes unless a command says so. */
const HELD = 60_000;

async function boot(inner: MemoryEngine, gate: IoGate): Promise<Real> {
  const store = createEntityStore();
  const handle = enablePersistence(store, {
    engine: gate.engine,
    writeDebounce: HELD,
    hydration: "all",
  });
  await handle.ready;
  return { inner, gate, store, handle, tx: null, inflight: [] };
}

/** Memory truth as the model sees it — value-bearing entries only. */
function memoryOf(store: EntityStore): Map<string, EntityRecord> {
  const out = new Map<string, EntityRecord>();
  for (const entityType of TYPES) {
    for (const { id, data } of store.getEntriesByType(entityType)) {
      out.set(`${entityType}:${id}`, data);
    }
  }
  return out;
}

function assertMemoryAgrees(m: Model, r: Real, where: string): void {
  const actual = memoryOf(r.store);
  // Compared as plain objects: `toEqual` is key-order-insensitive, and sorting
  // entry pairs would coerce the record values to primitives.
  expect(
    Object.fromEntries(actual),
    `memory diverged from the model after ${where}`,
  ).toEqual(Object.fromEntries(m.mem));
}

/** Refcounts are only observable through the store's own accessor. */
function assertRefsAgree(m: Model, r: Real, where: string): void {
  for (const entityType of TYPES) {
    for (const id of IDS) {
      const key = `${entityType}:${id}`;
      expect(r.store.getRefCount(entityType, id), `refcount of ${key} after ${where}`).toBe(
        m.refs.get(key),
      );
    }
  }
}

/**
 * Drain everything in flight, tear the session down, and boot a fresh store
 * over the SAME engine — a simulated reload. This is the assertion the whole
 * suite exists for: what survives process death.
 */
async function rebootAndCompare(m: Model, r: Real, where: string): Promise<Real> {
  const closed = r.gate.awaitNextClose();
  r.handle.dispose();
  r.gate.auto();
  r.gate.releaseAll();
  await closed;
  await Promise.allSettled(r.inflight);

  const next = await boot(r.inner, r.gate);

  // Reload semantics: memory becomes exactly what was durable. Uncommitted
  // optimistic state dies with the session by design (persist.ts dispose:
  // "buffered entries of UNCOMMITTED transactions are deliberately NOT
  // flushed"), and a fresh store carries no refcounts.
  m.mem = new Map(m.disk);
  m.refs.clear();
  m.tx = null;

  assertMemoryAgrees(m, next, `${where} (post-reload durable state)`);
  return next;
}

// ─────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────

type Cmd = fc.AsyncCommand<Model, Real>;

/**
 * Liveness channel for the search itself.
 *
 * A property suite reports the same green whether it explored ten thousand
 * schedules or zero — `numRuns` is what was REQUESTED, not what ran, and a
 * generator that silently produces empty command lists is indistinguishable
 * from a thorough one by exit code alone. So the run counts what it actually
 * executed and asserts a floor. Without this, the suite could rot into a
 * decoration and every CI run would still say PASS.
 */
const executed = { commands: 0 };

class SetCmd implements Cmd {
  constructor(
    readonly addr: EntityAddr,
    readonly data: EntityRecord,
  ) {}
  check(m: Model): boolean {
    return !txHolds(m, keyOf(this.addr));
  }
  async run(m: Model, r: Real): Promise<void> {
    executed.commands++;
    const key = keyOf(this.addr);
    r.store.set(this.addr.entityType, this.addr.id, this.data);
    const next = mergedInto(m.mem.get(key), this.data);
    m.mem.set(key, next);
    m.disk.set(key, next);
    assertMemoryAgrees(m, r, this.toString());
  }
  toString(): string {
    return `set(${keyOf(this.addr)}, ${JSON.stringify(this.data)})`;
  }
}

class SetManyCmd implements Cmd {
  constructor(readonly writes: Array<{ addr: EntityAddr; data: EntityRecord }>) {}
  check(m: Model): boolean {
    return this.writes.every((w) => !txHolds(m, keyOf(w.addr)));
  }
  async run(m: Model, r: Real): Promise<void> {
    executed.commands++;
    r.store.setMany(
      this.writes.map((w) => ({ entityType: w.addr.entityType, id: w.addr.id, data: w.data })),
    );
    for (const w of this.writes) {
      const key = keyOf(w.addr);
      const next = mergedInto(m.mem.get(key), w.data);
      m.mem.set(key, next);
      m.disk.set(key, next);
    }
    assertMemoryAgrees(m, r, this.toString());
  }
  toString(): string {
    return `setMany(${this.writes.map((w) => keyOf(w.addr)).join(",")})`;
  }
}

class RemoveCmd implements Cmd {
  constructor(readonly addr: EntityAddr) {}
  check(m: Model): boolean {
    return !txHolds(m, keyOf(this.addr));
  }
  async run(m: Model, r: Real): Promise<void> {
    executed.commands++;
    const key = keyOf(this.addr);
    r.store.remove(this.addr.entityType, this.addr.id);
    // remove is an INSTRUCTION, not a memory operation: it deletes the durable
    // row even when the entity is absent from memory (ADR-004 / the C1
    // zombie-resurrection fix). Modelling it as a memory-only delete is the
    // single easiest way to get this oracle wrong.
    m.mem.delete(key);
    m.disk.delete(key);
    assertMemoryAgrees(m, r, this.toString());
  }
  toString(): string {
    return `remove(${keyOf(this.addr)})`;
  }
}

class EvictCmd implements Cmd {
  constructor(readonly addr: EntityAddr) {}
  check(m: Model): boolean {
    return !txHolds(m, keyOf(this.addr));
  }
  async run(m: Model, r: Real): Promise<void> {
    executed.commands++;
    const key = keyOf(this.addr);
    r.store.evict(this.addr.entityType, this.addr.id);
    // evict is cache trimming — the durable row SURVIVES and pages back in on
    // reload. This asymmetry with remove is the core of ADR-004.
    m.mem.delete(key);
    assertMemoryAgrees(m, r, this.toString());
  }
  toString(): string {
    return `evict(${keyOf(this.addr)})`;
  }
}

class RetainCmd implements Cmd {
  constructor(readonly addr: EntityAddr) {}
  check(): boolean {
    return true;
  }
  async run(m: Model, r: Real): Promise<void> {
    executed.commands++;
    const key = keyOf(this.addr);
    r.store.retain(this.addr.entityType, this.addr.id);
    m.refs.set(key, (m.refs.get(key) ?? 0) + 1);
    assertRefsAgree(m, r, this.toString());
  }
  toString(): string {
    return `retain(${keyOf(this.addr)})`;
  }
}

class ReleaseCmd implements Cmd {
  constructor(readonly addr: EntityAddr) {}
  check(): boolean {
    return true;
  }
  async run(m: Model, r: Real): Promise<void> {
    executed.commands++;
    const key = keyOf(this.addr);
    r.store.release(this.addr.entityType, this.addr.id);
    // Floors at zero, and never CREATES an entry — releasing something never
    // retained is a no-op, not a -1.
    const current = m.refs.get(key);
    if (current != null && current > 0) m.refs.set(key, current - 1);
    assertRefsAgree(m, r, this.toString());
  }
  toString(): string {
    return `release(${keyOf(this.addr)})`;
  }
}

class GcCmd implements Cmd {
  check(): boolean {
    return true;
  }
  async run(m: Model, r: Real): Promise<void> {
    executed.commands++;
    r.store.gc();
    // Everything at or below zero is dropped from the refcount table and
    // EVICTED (not removed) if resident — GC must never look like a deletion
    // to the sync layer (ADR-004).
    // Deleting the CURRENT entry during Map iteration is well-defined — the
    // same idiom `persist.ts` relies on when it releases scope retentions.
    for (const [key, count] of m.refs) {
      if (count <= 0) {
        m.refs.delete(key);
        m.mem.delete(key);
      }
    }
    assertMemoryAgrees(m, r, this.toString());
    assertRefsAgree(m, r, this.toString());
  }
  toString(): string {
    return "gc()";
  }
}

class TxSetCmd implements Cmd {
  constructor(
    readonly addr: EntityAddr,
    readonly data: EntityRecord,
  ) {}
  check(): boolean {
    return true;
  }
  async run(m: Model, r: Real): Promise<void> {
    executed.commands++;
    const key = keyOf(this.addr);
    if (!r.tx) {
      r.tx = createOptimisticUpdates(r.store).transaction();
      m.tx = { snapshot: new Map() };
    }
    if (!m.tx!.snapshot.has(key)) m.tx!.snapshot.set(key, m.mem.get(key));
    r.tx.set(this.addr.entityType, this.addr.id, this.data);
    // Optimistic writes land in memory immediately and touch NOTHING durable
    // until commit — `disk` is deliberately untouched here.
    m.mem.set(key, mergedInto(m.mem.get(key), this.data));
    assertMemoryAgrees(m, r, this.toString());
  }
  toString(): string {
    return `tx.set(${keyOf(this.addr)}, ${JSON.stringify(this.data)})`;
  }
}

class TxCommitCmd implements Cmd {
  check(m: Model): boolean {
    return m.tx !== null;
  }
  async run(m: Model, r: Real): Promise<void> {
    executed.commands++;
    r.tx!.commit();
    // Commit graduates the transaction's net effect into durable truth.
    for (const key of m.tx!.snapshot.keys()) {
      const live = m.mem.get(key);
      if (live === undefined) m.disk.delete(key);
      else m.disk.set(key, live);
    }
    m.tx = null;
    r.tx = null;
    assertMemoryAgrees(m, r, this.toString());
  }
  toString(): string {
    return "tx.commit()";
  }
}

class TxRollbackCmd implements Cmd {
  check(m: Model): boolean {
    return m.tx !== null;
  }
  async run(m: Model, r: Real): Promise<void> {
    executed.commands++;
    r.tx!.rollback();
    // Restore pre-transaction memory truth; disk was never touched, so it
    // needs no compensation.
    for (const [key, previous] of m.tx!.snapshot) {
      if (previous === undefined) m.mem.delete(key);
      else m.mem.set(key, previous);
    }
    m.tx = null;
    r.tx = null;
    assertMemoryAgrees(m, r, this.toString());
  }
  toString(): string {
    return "tx.rollback()";
  }
}

/** Start a flush WITHOUT awaiting it — this is what opens the in-flight window. */
class FlushCmd implements Cmd {
  check(): boolean {
    return true;
  }
  async run(_m: Model, r: Real): Promise<void> {
    executed.commands++;
    r.inflight.push(r.handle.flush().catch(() => {}));
  }
  toString(): string {
    return "flush() [not awaited]";
  }
}

class HoldIoCmd implements Cmd {
  check(): boolean {
    return true;
  }
  async run(_m: Model, r: Real): Promise<void> {
    executed.commands++;
    r.gate.hold();
  }
  toString(): string {
    return "io.hold()";
  }
}

class ReleaseIoCmd implements Cmd {
  constructor(readonly index: number) {}
  check(): boolean {
    return true;
  }
  async run(_m: Model, r: Real): Promise<void> {
    executed.commands++;
    r.gate.releaseOne(this.index);
    await Promise.resolve();
  }
  toString(): string {
    return `io.release(#${this.index})`;
  }
}

/**
 * dispose() + boot a fresh store over the same engine. THE assertion: does
 * confirmed data survive process death, whatever was in flight at the time.
 */
class RebootCmd implements Cmd {
  check(): boolean {
    return true;
  }
  async run(m: Model, r: Real): Promise<void> {
    executed.commands++;
    const next = await rebootAndCompare(m, r, this.toString());
    Object.assign(r, next);
  }
  toString(): string {
    return "dispose() + reboot";
  }
}

const commandArbs = [
  addrArb.chain((addr) => dataArb.map((data) => new SetCmd(addr, data))),
  fc
    .array(fc.tuple(addrArb, dataArb), { minLength: 1, maxLength: 3 })
    .map((ws) => new SetManyCmd(ws.map(([addr, data]) => ({ addr, data })))),
  addrArb.map((addr) => new RemoveCmd(addr)),
  addrArb.map((addr) => new EvictCmd(addr)),
  addrArb.map((addr) => new RetainCmd(addr)),
  addrArb.map((addr) => new ReleaseCmd(addr)),
  fc.constant(new GcCmd()),
  addrArb.chain((addr) => dataArb.map((data) => new TxSetCmd(addr, data))),
  fc.constant(new TxCommitCmd()),
  fc.constant(new TxRollbackCmd()),
  fc.constant(new FlushCmd()),
  fc.constant(new HoldIoCmd()),
  fc.integer({ min: 0, max: 3 }).map((i) => new ReleaseIoCmd(i)),
  fc.constant(new RebootCmd()),
] as fc.Arbitrary<Cmd>[];

describe("stateful property model: the store is a Map that survives reloads", () => {
  it("agrees with the reference model after every command and every reload", async () => {
    executed.commands = 0;
    await fc.assert(
      fc.asyncProperty(fc.commands(commandArbs, { maxCommands: 24, size: "max" }), async (cmds) => {
        const inner = memoryEngine();
        const gate = gateIo(inner);
        const model = freshModel();
        let real!: Real;

        await fc.asyncModelRun(async () => {
          real = await boot(inner, gate);
          return { model, real };
        }, cmds);

        // Final reload — the schedule may have ended mid-flight; confirmed
        // writes must still be there afterwards.
        await rebootAndCompare(model, real, "end of run");
      }),
      {
        numRuns: 200,
        // DAN-647 replay, pinned as an always-executed example rather than
        // left to the sampler's luck. This is the exact shape of the
        // dispose-during-in-flight-flush data loss the example suite missed:
        //
        //   set(X) → flush parks on a held writeBatch → set(Y) enters the
        //   dirty set → dispose() → release the gate → is Y durable?
        //
        // Before the ADR-017 fix, Y was silently dropped: dispose() flipped
        // `disposed` while the re-entrant flush was still parked, and BOTH
        // recovery paths short-circuited on that flag.
        examples: [
          [
            [
              new HoldIoCmd(),
              new SetCmd({ entityType: "contact", id: "1" }, { a: 1 } as EntityRecord),
              new FlushCmd(),
              new SetCmd({ entityType: "contact", id: "2" }, { b: 2 } as EntityRecord),
              new RebootCmd(),
            ],
          ],
        ] as never,
      },
    );

    // The search must actually have searched. Measured 2026-07-30: ~2100
    // commands per run of this suite (200 runs x ~10 commands, `size: "max"`
    // against `maxCommands: 24`). The floor sits well below that to absorb
    // seed variance, and well above a generator that has quietly stopped
    // producing work — which is the only failure this can catch, and the one
    // no other assertion in the file can.
    expect(
      executed.commands,
      "the property reported green without executing a meaningful number of commands",
    ).toBeGreaterThan(1000);
  }, 60_000);

  /**
   * Negative control — the assertion that keeps this whole file honest.
   *
   * A property suite that has only ever been observed passing proves nothing:
   * it is indistinguishable from a suite that asserts nothing at all. So we
   * inject the DAN-647 SYMPTOM directly — silently swallow one confirmed put
   * on its way to the engine — and require the oracle to reject.
   *
   * This is the same discipline as the repo's red-negative-control CI proof
   * (DAN-658): a gate is not proven by watching it pass.
   */
  it("negative control: the oracle rejects a silently dropped confirmed write (the DAN-647 symptom)", async () => {
    let swallowed = false;
    const dropOnce = (key: string): boolean => {
      if (!swallowed && key === "contact:1") {
        swallowed = true;
        return false; // this confirmed write never reaches the engine
      }
      return true;
    };

    await expect(
      fc.assert(
        fc.asyncProperty(fc.constant(null), async () => {
          const inner = memoryEngine();
          const gate = gateIo(inner, dropOnce);
          const model = freshModel();
          const real = await boot(inner, gate);

          await new SetCmd({ entityType: "contact", id: "1" }, { a: 1 } as EntityRecord).run(
            model,
            real,
          );
          await rebootAndCompare(model, real, "negative control");
        }),
        { numRuns: 1 },
      ),
    ).rejects.toThrow();

    expect(swallowed, "the fault was never actually injected").toBe(true);
  }, 30_000);
});
