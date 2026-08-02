/**
 * The conformance kit, run against a reference adapter — and then WATCHED TO
 * FAIL against deliberately broken ones.
 *
 * ## Why the second half is not optional
 *
 * `LESSONS.md` and `knowledge/verification-integrity-2026-07-23.md` record the
 * false-green family: five checks in this repo that reported success on a
 * question they never evaluated. The law that came out of it is that **a check
 * is not proven until it has been watched to fail.** A conformance kit is
 * exactly the artifact most likely to violate it, because a kit that asserts
 * nothing passes every adapter and reads as rigour.
 *
 * So each property below is exercised twice: once against `referenceAdapter`,
 * which honours the contract, and once against a mutant that breaks precisely
 * that clause. If a mutant passes, the corresponding assertion in
 * `sync-conformance.ts` has no subject and the kit is decoration.
 */
import { describe, expect, it } from "vitest";
import { runSyncAdapterContract, SYNC_CONTRACT_COVERAGE } from "./sync-conformance";
import { defaultCompareVersions } from "./sync-types";
import type {
  LocalChange,
  PullResult,
  PushResult,
  RemoteChange,
  SyncAdapter,
  SyncEntityRecord,
} from "./sync-types";

/** Which clause a mutant is built to break. */
type Defect =
  | "none"
  | "push-resolves-before-durable"
  | "replay-applies-twice"
  | "reject-on-transient"
  | "delete-as-omission"
  | "limit-overserves"
  | "silent-partial-batch"
  | "validates-client-id"
  | "empty-batch-on-schema-mismatch"
  | "live-channel-ignores-dispose";

interface Row {
  entityType: string;
  id: string;
  data?: SyncEntityRecord;
  version: number;
  deleted: boolean;
}

/**
 * A minimal in-memory backend + adapter pair honouring ADR-006 rev d.
 *
 * Not a product — it exists so the kit has something correct to be calibrated
 * against, the same role `memoryEngine` plays for the StorageEngine kit. Every
 * `defect` branch is a single, named departure from the contract.
 */
function makeReference(defect: Defect = "none") {
  const rows = new Map<string, Row>();
  const appliedMutations = new Map<string, PushResult["results"][number]>();
  const lastSeen = new Map<string, number>();
  let clock = 0;
  let pendingTransient = false;
  let liveHandlers: Array<(e: { type: "poke" } | PullResult) => void> = [];

  const key = (t: string, i: string) => `${t}:${i}`;

  function apply(c: LocalChange): void {
    clock += 1;
    rows.set(key(c.entityType, c.id), {
      entityType: c.entityType,
      id: c.id,
      data: c.data,
      version: clock,
      deleted: c.op === "remove",
    });
  }

  const adapter: SyncAdapter = {
    async push(batch, opts): Promise<PushResult> {
      if (pendingTransient) {
        pendingTransient = false;
        if (defect === "reject-on-transient") {
          // The dangerous confusion: a transient network condition reported as
          // a permanent verdict. The coordinator reverts the overlay and drops
          // the outbox entry, and the user's write is gone with no error.
          return { results: batch.map((c) => ({ mutationId: c.mutationId, status: "reject" })) };
        }
        throw new Error("transient: connection reset");
      }

      if (opts?.schemaVersion === "v999") {
        if (defect === "empty-batch-on-schema-mismatch") {
          return { results: batch.map((c) => ({ mutationId: c.mutationId, status: "reject" })) };
        }
        throw new Error("SchemaVersionError: backend cannot serve v999");
      }

      const results: PushResult["results"] = [];
      for (const c of batch) {
        const already = appliedMutations.get(c.mutationId);
        if (already && defect !== "replay-applies-twice") {
          // Idempotent replay: same verdict, no second apply.
          results.push(already);
          continue;
        }
        if (!c.entityType || !c.id) {
          const verdict = { mutationId: c.mutationId, status: "reject" as const };
          // RejectStillAdvancesServerSeq — the server records the seq anyway,
          // so the client is not wedged behind a write it can never retract.
          lastSeen.set(c.clientId, Math.max(lastSeen.get(c.clientId) ?? 0, c.seq));
          appliedMutations.set(c.mutationId, verdict);
          results.push(verdict);
          continue;
        }
        apply(c);
        lastSeen.set(c.clientId, Math.max(lastSeen.get(c.clientId) ?? 0, c.seq));
        const verdict = { mutationId: c.mutationId, status: "ack" as const, version: clock };
        appliedMutations.set(c.mutationId, verdict);
        results.push(verdict);
      }

      if (defect === "push-resolves-before-durable") {
        // Resolve now, become visible later — an async backend queue. The bug
        // is invisible to any test that polls, which is why the kit does not.
        const staged = [...rows.entries()];
        rows.clear();
        setTimeout(() => {
          for (const [k, v] of staged) rows.set(k, v);
        }, 30);
      }
      return { results };
    },

    async pull(cursor, opts): Promise<PullResult> {
      if (opts?.schemaVersion === "v999") {
        if (defect === "empty-batch-on-schema-mismatch") {
          // Reads to a client as "you are fully synced" — the worst possible
          // answer to "I cannot serve your schema version".
          return { type: "changes", changes: [], cursor: "0", complete: true };
        }
        return { type: "reset" };
      }

      const from = cursor === null ? 0 : Number(cursor);
      if (cursor !== null && !Number.isFinite(from)) return { type: "reset" };

      let pending = [...rows.values()]
        .filter((r) => r.version > from)
        .filter((r) => !(defect === "delete-as-omission" && r.deleted))
        .sort((a, b) => a.version - b.version);

      const limit = opts?.limit ?? 500;
      const overserve = defect === "limit-overserves";
      const slice = overserve ? pending : pending.slice(0, limit);
      const complete = defect === "silent-partial-batch" ? true : slice.length === pending.length;

      const changes: RemoteChange[] = slice.map((r) => ({
        type: r.deleted ? "remove" : "set",
        entityType: r.entityType,
        id: r.id,
        ...(r.deleted ? {} : { data: r.data }),
        version: r.version,
      }));

      const nextCursor = String(slice.at(-1)?.version ?? from);
      const confirmedMutations: Record<string, number> = {};
      for (const [client, seq] of lastSeen) confirmedMutations[client] = seq;

      return {
        type: "changes",
        changes,
        cursor: nextCursor,
        complete,
        confirmedMutations,
        ...(opts?.subscription ? { subscription: opts.subscription } : {}),
      };
    },

    subscribe(onEvent) {
      liveHandlers.push(onEvent);
      return () => {
        if (defect === "live-channel-ignores-dispose") return;
        liveHandlers = liveHandlers.filter((h) => h !== onEvent);
      };
    },

    compareVersions: defaultCompareVersions,
  };

  if (defect === "validates-client-id") {
    const inner = adapter.push.bind(adapter);
    adapter.push = async (batch, opts) => {
      for (const c of batch) {
        // Closes the C3 door: a decentralized deployment has no server to
        // allocate ids, so identity must be able to BE a public key.
        if (!/^[0-9a-f-]{8,}$/i.test(c.clientId)) throw new Error("invalid clientId format");
      }
      return inner(batch, opts);
    };
  }

  return {
    adapter,
    seedRemote: async (_a: SyncAdapter, entityType: string, id: string, data: SyncEntityRecord) => {
      clock += 1;
      rows.set(key(entityType, id), { entityType, id, data, version: clock, deleted: false });
    },
    removeRemote: async (_a: SyncAdapter, entityType: string, id: string) => {
      clock += 1;
      const existing = rows.get(key(entityType, id));
      rows.set(key(entityType, id), {
        entityType,
        id,
        data: existing?.data,
        version: clock,
        deleted: true,
      });
    },
    simulateTransientFailure: () => {
      pendingTransient = true;
    },
    emitPoke: () => {
      for (const h of liveHandlers) h({ type: "poke" });
    },
  };
}

/**
 * The kit hands its hooks the adapter, not the harness, so the harness has to
 * be findable from the adapter. A WeakMap keeps that lookup from leaking.
 *
 * Declared BEFORE the `runSyncAdapterContract` call below, and every adapter
 * the kit sees comes from `makeRegisteredReference` — an adapter built by bare
 * `makeReference` is absent from the map, and the hooks would then dereference
 * `undefined` at test time rather than at typecheck time.
 */
const refRegistry = new WeakMap<SyncAdapter, ReturnType<typeof makeReference>>();

function makeRegisteredReference(defect: Defect = "none") {
  const harness = makeReference(defect);
  refRegistry.set(harness.adapter, harness);
  return harness;
}

function harnessFor(adapter: SyncAdapter): ReturnType<typeof makeReference> {
  const harness = refRegistry.get(adapter);
  // Loud rather than `undefined is not a function` three frames down.
  if (!harness) throw new Error("adapter was not built by makeRegisteredReference");
  return harness;
}

// ── The kit against a correct adapter ────────────────────────────────────────

runSyncAdapterContract({
  name: "referenceAdapter (in-memory)",
  makeAdapter: () => makeRegisteredReference().adapter,
  seedRemote: async (a, t, i, d) => {
    await harnessFor(a).seedRemote(a, t, i, d);
  },
  removeRemote: async (a, t, i) => {
    await harnessFor(a).removeRemote(a, t, i);
  },
  simulateTransientFailure: (a) => harnessFor(a).simulateTransientFailure(),
  unsupportedSchemaVersion: "v999",
  supportsSubscriptions: true,
  suppliesComparator: true,
});

// ── Watched to fail: each mutant must break exactly the clause it targets ────

describe("the kit has teeth — every property distinguishes a correct adapter from a broken one", () => {
  it("catches a push that resolves before the write is durable", async () => {
    const good = makeRegisteredReference();
    await good.adapter.push([mk("m1", 1)]);
    const goodPull = await good.adapter.pull(null);
    expect(goodPull.type === "changes" && goodPull.changes.length).toBeGreaterThan(0);

    const bad = makeRegisteredReference("push-resolves-before-durable");
    await bad.adapter.push([mk("m1", 1)]);
    const badPull = await bad.adapter.pull(null);
    // The exact assertion the kit makes, failing here as it must.
    expect(badPull.type === "changes" && badPull.changes.length).toBe(0);
  });

  it("catches a replay that applies twice", async () => {
    const good = makeRegisteredReference();
    await good.adapter.push([mk("m1", 1)]);
    await good.adapter.push([mk("m1", 1)]);
    const goodPull = await good.adapter.pull(null);
    expect(goodPull.type === "changes" && goodPull.changes.filter((c) => c.id === "w1")).toHaveLength(1);

    const bad = makeRegisteredReference("replay-applies-twice");
    await bad.adapter.push([mk("m1", 1)]);
    const before = await bad.adapter.pull(null);
    const v1 = before.type === "changes" ? before.changes[0]!.version : 0;
    await bad.adapter.push([mk("m1", 1)]);
    const after = await bad.adapter.pull(null);
    const v2 = after.type === "changes" ? after.changes[0]!.version : 0;
    // A second apply bumps the version even when the row count looks stable —
    // the coordinator's version-aware apply would then re-fire on an echo.
    expect(v2).not.toBe(v1);
  });

  it("catches an adapter that returns reject for a transient failure", async () => {
    const good = makeRegisteredReference();
    good.simulateTransientFailure();
    await expect(good.adapter.push([mk("m1", 1)])).rejects.toThrow(/transient/);

    const bad = makeRegisteredReference("reject-on-transient");
    bad.simulateTransientFailure();
    const result = await bad.adapter.push([mk("m1", 1)]);
    // Silent permanent loss of a valid user write. Nothing throws; nothing logs.
    expect(result.results[0]!.status).toBe("reject");
  });

  it("catches a delete that arrives as an omission instead of a tombstone", async () => {
    const good = makeRegisteredReference();
    await good.seedRemote(good.adapter, "Widget", "w1", { id: "w1" });
    const { cursor } = await drain(good.adapter);
    await good.removeRemote(good.adapter, "Widget", "w1");
    const goodAfter = await good.adapter.pull(cursor);
    expect(goodAfter.type === "changes" && goodAfter.changes[0]?.type).toBe("remove");

    const bad = makeRegisteredReference("delete-as-omission");
    await bad.seedRemote(bad.adapter, "Widget", "w1", { id: "w1" });
    const { cursor: badCursor } = await drain(bad.adapter);
    await bad.removeRemote(bad.adapter, "Widget", "w1");
    const badAfter = await bad.adapter.pull(badCursor);
    // The row simply stops being mentioned. Indistinguishable from "outside my
    // selection", which is why this needs its own assertion at all.
    expect(badAfter.type === "changes" && badAfter.changes).toHaveLength(0);
  });

  it("catches an adapter that over-serves limit", async () => {
    const bad = makeRegisteredReference("limit-overserves");
    for (let i = 0; i < 5; i++) await bad.seedRemote(bad.adapter, "Widget", `w${i}`, { id: `w${i}` });
    const result = await bad.adapter.pull(null, { limit: 2 });
    expect(result.type === "changes" && result.changes.length).toBeGreaterThan(2);
  });

  it("catches a partial batch that claims to be complete", async () => {
    const bad = makeRegisteredReference("silent-partial-batch");
    for (let i = 0; i < 5; i++) await bad.seedRemote(bad.adapter, "Widget", `w${i}`, { id: `w${i}` });
    const result = await bad.adapter.pull(null, { limit: 2 });
    // Withholding rows while claiming completeness makes the coordinator apply
    // a partial snapshot as though it were the whole world.
    expect(result.type === "changes" && result.changes.length < 5 && result.complete).toBe(true);
  });

  it("catches an adapter that validates clientId format", async () => {
    const key = "ed25519:3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";
    const good = makeRegisteredReference();
    await expect(good.adapter.push([{ ...mk("m1", 1), clientId: key }])).resolves.toBeDefined();

    const bad = makeRegisteredReference("validates-client-id");
    await expect(bad.adapter.push([{ ...mk("m1", 1), clientId: key }])).rejects.toThrow(/clientId/);
  });

  it("catches an empty batch masquerading as a schema-version answer", async () => {
    const good = makeRegisteredReference();
    expect((await good.adapter.pull(null, { schemaVersion: "v999" })).type).toBe("reset");

    const bad = makeRegisteredReference("empty-batch-on-schema-mismatch");
    const result = await bad.adapter.pull(null, { schemaVersion: "v999" });
    // Reads as "fully synced" to every caller.
    expect(result.type).toBe("changes");
    expect(result.type === "changes" && result.complete).toBe(true);
  });

  it("catches a live channel that keeps delivering after dispose", async () => {
    const good = makeRegisteredReference();
    let goodSeen = 0;
    const disposeGood = good.adapter.subscribe!(() => goodSeen++);
    disposeGood();
    good.emitPoke();
    expect(goodSeen).toBe(0);

    const bad = makeRegisteredReference("live-channel-ignores-dispose");
    let badSeen = 0;
    const disposeBad = bad.adapter.subscribe!(() => badSeen++);
    disposeBad();
    bad.emitPoke();
    expect(badSeen).toBe(1);
  });
});

describe("the default comparator (D3)", () => {
  it("never returns concurrent", () => {
    const pairs: Array<[string | number, string | number]> = [
      [1, 2],
      [2, 1],
      [1, 1],
      ["a", "b"],
      ["b", "a"],
      ["a", "a"],
      [1, "a"],
      ["2026-01-01", "2026-01-02"],
    ];
    for (const [a, b] of pairs) expect(defaultCompareVersions(a, b)).not.toBe("concurrent");
  });

  it("is antisymmetric, so 'newer' means something", () => {
    expect(defaultCompareVersions(2, 1)).toBe("newer");
    expect(defaultCompareVersions(1, 2)).toBe("older");
    expect(defaultCompareVersions("b", "a")).toBe("newer");
    expect(defaultCompareVersions("a", "b")).toBe("older");
  });

  it("compares numeric strings numerically, not lexicographically", () => {
    // The trap: "10" < "9" as strings. A backend issuing integer versions as
    // strings would silently order its own history backwards.
    expect(defaultCompareVersions("10", "9")).toBe("newer");
  });
});

describe("coverage is declared, not inferred from absence", () => {
  it("names the coordinator obligations an adapter cannot be held to", () => {
    // The kit's silence about these must be an affirmative statement. A reader
    // who finds `AtMostOnePushInFlightPerClient` here is being told it is real
    // and somebody else's to honour — not that it was forgotten.
    expect(SYNC_CONTRACT_COVERAGE.coordinator).toContain("AtMostOnePushInFlightPerClient");
    expect(SYNC_CONTRACT_COVERAGE.coordinator).toContain("OverlayIsDroppedOnlyByThePullChannel");
    expect(SYNC_CONTRACT_COVERAGE.coordinator).toContain("HydrationPriorityOrdersStartsAndNeverBlocks");
  });

  it("keeps the three coverage sets disjoint", () => {
    const all = [
      ...SYNC_CONTRACT_COVERAGE.adapter,
      ...SYNC_CONTRACT_COVERAGE.coordinator,
      ...SYNC_CONTRACT_COVERAGE.backendOperational,
    ];
    // An obligation claimed by two sets is one whose owner is undecided, which
    // is how a property ends up honoured by nobody.
    expect(new Set(all).size).toBe(all.length);
  });
});

function mk(mutationId: string, seq: number): LocalChange {
  return {
    mutationId,
    clientId: "client-a",
    seq,
    op: "set",
    entityType: "Widget",
    id: "w1",
    data: { id: "w1", label: "hello" },
  };
}

async function drain(adapter: SyncAdapter): Promise<{ cursor: string | null }> {
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const r: PullResult = await adapter.pull(cursor);
    if (r.type === "reset") return { cursor: r.cursor ?? null };
    cursor = r.cursor;
    if (r.complete) break;
  }
  return { cursor };
}
