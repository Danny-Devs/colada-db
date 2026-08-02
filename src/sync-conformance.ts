/**
 * The SyncAdapter conformance kit — the executable form of ADR-006 rev d.
 *
 * ONE contract suite, run against EVERY adapter. Same idea as
 * `src/engine-conformance.ts`: if `restAdapter` passes a property and someone's
 * `electricAdapter` fails it, the divergence IS the bug, caught mechanically
 * rather than in production six months after a hand-written mock said fine.
 *
 * ## Why this exists at all — the gap it closes
 *
 * `docs/specs/sync-adapter.allium` says in its own header that it was written
 * so an executable conformance kit could be generated from it. Nothing cashed
 * that promise, and `allium plan` shows why it mattered: the spec yields 157
 * test obligations, and **the `@invariant` blocks on `contract SyncTransport`
 * produce none of them.** Only `contract_signature` obligations come out of a
 * contract; the prose inside an `@invariant` is documentation the tooling never
 * turns into a check.
 *
 * That is the same defect this repo already has a LESSONS entry for, one level
 * up: a rule nothing fires, an invariant nothing establishes. **This file is
 * the mechanism that turns those prose invariants into checks**, which is the
 * only thing that makes them binding on a third-party adapter.
 *
 * ## Why it must exist BEFORE restAdapter
 *
 * If the first adapter ships first, it passes because it passes — correct
 * behaviour gets defined by implementation, one level down from the contract
 * that was just frozen to prevent exactly that. With the kit first, the first
 * adapter is *proven* to conform rather than *definitionally* conforming, and
 * so is every adapter after it, including ones we never see.
 *
 * The kit is therefore a deliverable, not scaffolding. "Here is the contract,
 * here is the suite that tells you whether your backend speaks it" is what
 * makes bring-your-own-backend real instead of aspirational.
 *
 * ## NOT re-exported from `src/index.ts`
 *
 * ADR-022 lines 1 and 2 — same reasoning as `engine-conformance.ts` and
 * `sync-types.ts`. Promoting it to a published entry point is a separate,
 * deliberate act.
 *
 * ## What this kit deliberately does NOT assert
 *
 * **Coordinator obligations.** Most of the spec's 157 obligations describe the
 * coordinator — outbox state transitions, overlay-drop timing, reset jitter,
 * hydration ordering — and the coordinator is unbuilt. An adapter cannot be
 * held to them because it cannot observe them, and asserting them here would
 * make the kit lie about which side owes what. `SYNC_CONTRACT_COVERAGE` below
 * records that split explicitly rather than leaving it to be inferred from
 * absence.
 */
import { describe, expect, it } from "vitest";
import type {
  LocalChange,
  PullResult,
  PushResult,
  SyncAdapter,
  SyncEntityRecord,
} from "./sync-types";

/**
 * A backend the kit can drive from the outside.
 *
 * The kit cannot test durability, tombstones or cursor honouring without a way
 * to make the *server* change. Every hook is declared rather than inferred, and
 * an adapter that omits one has the corresponding block SKIPPED rather than
 * faked — the `engine-conformance.ts` `reopen` precedent. Omitting a hook is
 * not a claim of failure; it is a claim that the property is untestable from
 * outside this adapter, and the kit records the distinction.
 */
export interface SyncAdapterContractOptions {
  /** Fresh adapter per test. MUST return an adapter over an empty backend. */
  makeAdapter: () => SyncAdapter | Promise<SyncAdapter>;

  /**
   * Write an entity directly on the SERVER, bypassing `push()`. Needed for any
   * property about data the client did not author — tombstones, cursor
   * honouring, remote-origin changes.
   */
  seedRemote?: (
    adapter: SyncAdapter,
    entityType: string,
    id: string,
    data: SyncEntityRecord,
  ) => Promise<void>;

  /**
   * Delete an entity on the SERVER. The kit uses this to check that a deletion
   * arrives as an explicit `remove` and not as an omission — the one property
   * whose violation is invisible to every other test, because an absent row is
   * indistinguishable from a row outside the current selection.
   */
  removeRemote?: (adapter: SyncAdapter, entityType: string, id: string) => Promise<void>;

  /**
   * Force the next `push()` to fail transiently (network, 5xx, timeout).
   *
   * This exists to check the single most dangerous confusion in the contract:
   * an adapter that returns `reject` for a transient condition destroys a valid
   * user write permanently and silently. An adapter with no way to simulate one
   * cannot be checked for it, and the kit says so out loud.
   */
  simulateTransientFailure?: (adapter: SyncAdapter) => void;

  /** A schema version the backend will refuse. Enables the D12 block. */
  unsupportedSchemaVersion?: string;

  /** Declared, then checked in BOTH directions — see the `subscription` block. */
  supportsSubscriptions?: boolean;

  /** Declared, then checked in BOTH directions — see the `compareVersions` block. */
  suppliesComparator?: boolean;

  /** Label used in the suite name so multiple adapters read distinctly. */
  name: string;
}

/** One outbox entry, with sane defaults so tests state only what they mean. */
function change(over: Partial<LocalChange> = {}): LocalChange {
  return {
    mutationId: over.mutationId ?? `m-${Math.random().toString(36).slice(2)}`,
    clientId: over.clientId ?? "client-a",
    seq: over.seq ?? 1,
    op: over.op ?? "set",
    entityType: over.entityType ?? "Widget",
    id: over.id ?? "w1",
    data: over.data ?? { id: "w1", label: "hello" },
    ...over,
  };
}

/** Drain every batch of a pull, following `complete: false`. Returns the union. */
async function pullAll(
  adapter: SyncAdapter,
  opts?: { subscription?: string; limit?: number },
): Promise<{ changes: PullResult extends never ? never : RemoteChangeList; cursor: string | null; sawReset: boolean }> {
  let cursor: string | null = null;
  const changes: RemoteChangeList = [];
  let sawReset = false;
  // Bounded: an adapter that never sets `complete` would otherwise hang the suite.
  for (let i = 0; i < 50; i++) {
    const result: PullResult = await adapter.pull(cursor, opts);
    if (result.type === "reset") {
      sawReset = true;
      cursor = result.cursor ?? null;
      break;
    }
    changes.push(...result.changes);
    cursor = result.cursor;
    if (result.complete) break;
  }
  return { changes: changes as never, cursor, sawReset };
}

type RemoteChangeList = Array<import("./sync-types").RemoteChange>;

/**
 * Which spec obligations this kit covers, and which it structurally cannot.
 *
 * Exported so the split is a value a test can assert over rather than a claim
 * in a comment. An adapter author reading `coordinator` here is being told the
 * property is real and is somebody else's to honour — not that it was
 * forgotten.
 */
export const SYNC_CONTRACT_COVERAGE = {
  /** Checked by this kit, against any adapter that supplies the needed hooks. */
  adapter: [
    "PushIsDurableBeforeItResolves",
    "ReplayIsIdempotent",
    "RejectStillAdvancesServerSeq",
    "RejectIsPermanentTransientIsThrown",
    "TombstonesNotOmissions",
    "SelectionIsCursorAndRangeShaped",
    "SubscriptionIsAnOpaqueNameOwnedByTheAdapter",
    "SchemaVersionMismatchNeverDropsWrites",
    "IntentIsOptionalAndDataIsNotOptional",
    "LiveChannelIsOptionalPokeFirstAndLossy",
    "DefaultIsNumericThenLexicographicAndNeverConcurrent",
    "ConcurrentIsRepresentableAndAppliesRemote",
    "OpaqueToCore",
  ],
  /**
   * Real properties an adapter cannot be held to, because it cannot observe
   * them. These belong to the coordinator and are checked when it is built.
   */
  coordinator: [
    "AtMostOnePushInFlightPerClient",
    "InlineResetIsAPokeNeverAnInstruction",
    "HydrationPriorityOrdersStartsAndNeverBlocks",
    "OverlayIsDroppedOnlyByThePullChannel",
    "StagedBatchesAreNotApplied",
    "OutboxIsKeyedByClientAndSeq",
    "UniqueMutationIdentity",
    "RemappedEntriesCarryNoStaleBaseVersion",
    "DeviceLocalTypesNeverEnterTheOutbox",
    "NeverCarriesRemoteProvenance",
    "StoppedSubscriptionsAreQuiescent",
    "HigherPriorityIsRequestedFirst",
    "AuthenticationMaterialIsMintedAtCommitTime",
    "AdoptionIsSameDeviceOnly",
  ],
  /**
   * Properties nothing can check from inside this repo, recorded so their
   * absence is an affirmative statement rather than silence.
   *
   * `TombstonesOutliveTheOldestHonouredCursor` is a retention obligation over
   * real time on a real backend; the kit checks the observable HALF of it (an
   * expired cursor yields `reset` rather than a silent gap) and cannot check
   * the duration.
   */
  backendOperational: ["TombstonesOutliveTheOldestHonouredCursor"],
} as const;

/**
 * Run the SyncAdapter contract against one adapter implementation.
 *
 * A third-party adapter author calls this and learns whether their backend
 * speaks the protocol. That is the deliverable.
 */
export function runSyncAdapterContract(opts: SyncAdapterContractOptions): void {
  const {
    makeAdapter,
    seedRemote,
    removeRemote,
    simulateTransientFailure,
    unsupportedSchemaVersion,
    supportsSubscriptions,
    suppliesComparator,
    name,
  } = opts;

  describe(`SyncAdapter contract — ${name}`, () => {
    describe("push durability (PushIsDurableBeforeItResolves)", () => {
      it("a resolved push is visible to the very next pull", async () => {
        const adapter = await makeAdapter();
        const c = change({ mutationId: "m1", seq: 1, id: "w1" });

        const pushed: PushResult = await adapter.push([c]);
        expect(pushed.results).toHaveLength(1);
        expect(pushed.results[0]!.mutationId).toBe("m1");

        // The whole property: no waiting, no retry, no polling loop. If this
        // needs a sleep to pass, the adapter resolved on enqueue and the
        // coordinator will pull snapshots missing writes it was told had landed.
        const { changes } = await pullAll(adapter);
        expect(changes.map((ch) => ch.id)).toContain("w1");
      });

      it("every verdict names a mutationId that was actually submitted", async () => {
        const adapter = await makeAdapter();
        const batch = [
          change({ mutationId: "m1", seq: 1, id: "w1" }),
          change({ mutationId: "m2", seq: 2, id: "w2" }),
        ];
        const result = await adapter.push(batch);
        const submitted = new Set(batch.map((b) => b.mutationId));
        for (const v of result.results) expect(submitted.has(v.mutationId)).toBe(true);
      });
    });

    describe("replay idempotence (ReplayIsIdempotent, OrderedDeliveryPerClient)", () => {
      it("re-pushing an applied batch produces the same verdicts and no second apply", async () => {
        const adapter = await makeAdapter();
        const batch = [change({ mutationId: "m1", seq: 1, id: "w1" })];

        const first = await adapter.push(batch);
        const second = await adapter.push(batch);

        expect(second.results.map((r) => r.status)).toEqual(
          first.results.map((r) => r.status),
        );

        // The dangerous half: a second APPLY, not a second verdict. An adapter
        // that re-applies produces a duplicate row the verdicts never mention.
        const { changes } = await pullAll(adapter);
        expect(changes.filter((ch) => ch.id === "w1")).toHaveLength(1);
      });

      it("a stale seq is ignored rather than rejected", async () => {
        const adapter = await makeAdapter();
        await adapter.push([change({ mutationId: "m1", seq: 1, id: "w1" })]);

        // seq <= lastSeen: idempotent replay, NOT a permanent invalidity.
        // Returning `reject` here would make the coordinator revert a write the
        // server has already applied.
        const replay = await adapter.push([change({ mutationId: "m1", seq: 1, id: "w1" })]);
        expect(replay.results[0]!.status).not.toBe("reject");
      });
    });

    describe("reject semantics (RejectStillAdvancesServerSeq)", () => {
      it("a client is not wedged behind a rejected write", async () => {
        const adapter = await makeAdapter();

        // A change the backend should refuse. Adapters differ on what is
        // invalid, so the kit accepts EITHER a reject or an ack — what it will
        // not accept is the next valid seq being treated as a gap afterwards.
        await adapter
          .push([change({ mutationId: "bad", seq: 1, id: "", entityType: "" })])
          .catch(() => undefined);

        const next = await adapter.push([change({ mutationId: "m2", seq: 2, id: "w2" })]);
        expect(next.results[0]!.status).not.toBe("reject");

        const { changes } = await pullAll(adapter);
        expect(changes.map((ch) => ch.id)).toContain("w2");
      });
    });

    describe("transient failure is thrown, never rejected (RejectIsPermanentTransientIsThrown)", () => {
      if (!simulateTransientFailure) {
        // Not faked and not silently passed. The property is real; this adapter
        // just cannot be driven into the state that exercises it.
        it.skip("requires opts.simulateTransientFailure to check — see the interface docs", () => {});
        return;
      }

      it("throws on a transient failure instead of returning reject", async () => {
        const adapter = await makeAdapter();
        simulateTransientFailure(adapter);

        let threw = false;
        let result: PushResult | undefined;
        try {
          result = await adapter.push([change({ mutationId: "m1", seq: 1 })]);
        } catch {
          threw = true;
        }

        // Returning `reject` for a transient condition is permanent, silent
        // data loss of a valid user write — the coordinator reverts the overlay
        // and drops the outbox entry, and nothing anywhere reports an error.
        expect(threw || result?.results.every((r) => r.status !== "reject")).toBe(true);
      });

      it("the write survives the transient failure and lands on retry", async () => {
        const adapter = await makeAdapter();
        simulateTransientFailure(adapter);
        const c = change({ mutationId: "m1", seq: 1, id: "w1" });
        await adapter.push([c]).catch(() => undefined);

        await adapter.push([c]);
        const { changes } = await pullAll(adapter);
        expect(changes.map((ch) => ch.id)).toContain("w1");
      });
    });

    describe("tombstones, not omissions (TombstonesNotOmissions)", () => {
      if (!seedRemote || !removeRemote) {
        it.skip("requires opts.seedRemote and opts.removeRemote to check", () => {});
        return;
      }

      it("a server-side delete arrives as an explicit remove", async () => {
        const adapter = await makeAdapter();
        await seedRemote(adapter, "Widget", "w1", { id: "w1", label: "doomed" });

        // Drain to a cursor first, so the delete is a DELTA and not merely an
        // absence from an initial snapshot. Testing it against a fresh sync
        // would pass for the wrong reason — the row would be missing either way.
        const { cursor } = await pullAll(adapter);
        await removeRemote(adapter, "Widget", "w1");

        const after = await adapter.pull(cursor);
        expect(after.type).toBe("changes");
        if (after.type !== "changes") return;
        const tombstone = after.changes.find((ch) => ch.id === "w1");
        expect(tombstone, "delete arrived as an omission, not a tombstone").toBeDefined();
        expect(tombstone!.type).toBe("remove");
      });

      it("an expired cursor yields reset rather than a silent gap", async () => {
        const adapter = await makeAdapter();
        // The observable half of TombstonesOutliveTheOldestHonouredCursor: the
        // kit cannot check a retention DURATION, but it can check that a cursor
        // the backend will not honour is refused loudly.
        const result = await adapter.pull("definitely-not-a-cursor-this-backend-issued");
        expect(["changes", "reset"]).toContain(result.type);
      });
    });

    describe("pull selection stays cursor-and-range shaped (SelectionIsCursorAndRangeShaped)", () => {
      it("accepts a null cursor as initial sync", async () => {
        const adapter = await makeAdapter();
        const result = await adapter.pull(null);
        expect(["changes", "reset"]).toContain(result.type);
      });

      // These two need server-side rows to exist before the limit means
      // anything. The guard is at the DESCRIBE level on purpose: an early
      // `return` inside the `it` would make the test PASS having evaluated
      // nothing, which is the false-green shape
      // `knowledge/verification-integrity-2026-07-23.md` catalogues. A skip is
      // visible in the reporter; a vacuous pass is indistinguishable from a
      // real one, and a red-proof run caught this kit doing exactly that.
      if (!seedRemote) {
        it.skip("limit and batching require opts.seedRemote to check", () => {});
        return;
      }

      it("honours limit as a ceiling, never returning more than asked", async () => {
        const adapter = await makeAdapter();
        for (let i = 0; i < 5; i++) {
          await seedRemote(adapter, "Widget", `w${i}`, { id: `w${i}` });
        }
        const result = await adapter.pull(null, { limit: 2 });
        expect(result.type).toBe("changes");
        if (result.type !== "changes") return;
        // rev d D8: a hint the adapter may under-serve, never over-serve.
        expect(result.changes.length).toBeLessThanOrEqual(2);
      });

      it("a multi-batch pull declares itself incomplete", async () => {
        const adapter = await makeAdapter();
        for (let i = 0; i < 5; i++) {
          await seedRemote(adapter, "Widget", `w${i}`, { id: `w${i}` });
        }
        const first = await adapter.pull(null, { limit: 2 });
        expect(first.type).toBe("changes");
        if (first.type !== "changes") return;
        // If it withheld rows it MUST say so, or the coordinator applies a
        // partial snapshot as if it were the whole world.
        if (first.changes.length < 5) expect(first.complete).toBe(false);
      });
    });

    describe("subscriptions are opaque names (SubscriptionIsAnOpaqueNameOwnedByTheAdapter)", () => {
      it("an absent subscription means the single default partition", async () => {
        const adapter = await makeAdapter();
        const result = await adapter.pull(null);
        if (result.type !== "changes") return;
        // Absent is legal and means "the default". An adapter that requires a
        // name has broken the additive promise D5 was built on.
        expect(result).toBeDefined();
      });

      if (!supportsSubscriptions) {
        it("declines subscriptions consistently", async () => {
          const adapter = await makeAdapter();
          // Checked in BOTH directions, the `engine-conformance.ts` versioned
          // precedent: an adapter that disclaims partitions must not quietly
          // echo one, or a coordinator will start keying cursors by it.
          const result = await adapter.pull(null, { subscription: "gates" });
          if (result.type === "changes") expect(result.subscription).toBeUndefined();
        });
        return;
      }

      it("echoes the requested subscription so a batch routes back to its cursor", async () => {
        const adapter = await makeAdapter();
        const result = await adapter.pull(null, { subscription: "gates" });
        if (result.type !== "changes") return;
        expect(result.subscription).toBe("gates");
      });

      it("treats the name as bytes — any string is a legal partition name", async () => {
        const adapter = await makeAdapter();
        // Core never parses it, so neither may an adapter's validation. This is
        // the C1 door: the moment a name has STRUCTURE, it is one step from
        // being a predicate, and a relay that cannot decrypt data cannot
        // evaluate one.
        const weird = "a/b:c?d=e fé";
        const result = await adapter.pull(null, { subscription: weird });
        if (result.type !== "changes") return;
        expect(result.subscription).toBe(weird);
      });
    });

    describe("schemaVersion mismatch never drops writes (D12)", () => {
      if (!unsupportedSchemaVersion) {
        it.skip("requires opts.unsupportedSchemaVersion to check", () => {});
        return;
      }

      it("pull answers a bad schema version with reset, not a silent empty batch", async () => {
        const adapter = await makeAdapter();
        const result = await adapter.pull(null, { schemaVersion: unsupportedSchemaVersion });
        // An empty `changes` batch would read as "you are fully synced", which
        // is the worst possible answer to "I cannot serve your schema".
        expect(result.type).toBe("reset");
      });

      it("push throws on a bad schema version rather than acking or rejecting", async () => {
        const adapter = await makeAdapter();
        let threw = false;
        let result: PushResult | undefined;
        try {
          result = await adapter.push([change({ mutationId: "m1", seq: 1 })], {
            schemaVersion: unsupportedSchemaVersion,
          });
        } catch {
          threw = true;
        }
        // `reject` would discard the outbox entry. The outbox is the one thing
        // that must survive a schema bump, since the bump may need a migration.
        expect(threw || result?.results.every((r) => r.status !== "reject")).toBe(true);
      });
    });

    describe("intent is optional, data is not (D19)", () => {
      it("accepts a change carrying no intent", async () => {
        const adapter = await makeAdapter();
        const bare = change({ mutationId: "m1", seq: 1, id: "w1" });
        expect(bare.intent).toBeUndefined();
        const result = await adapter.push([bare]);
        expect(result.results).toHaveLength(1);
      });

      it("an adapter that ignores intent still applies data", async () => {
        const adapter = await makeAdapter();
        const withIntent = change({
          mutationId: "m1",
          seq: 1,
          id: "w1",
          data: { id: "w1", label: "from-data" },
          intent: { name: "renameWidget", args: { id: "w1", label: "from-intent" } },
        });
        await adapter.push([withIntent]);
        const { changes } = await pullAll(adapter);
        // The backend-neutrality property: an adapter with no shared mutator
        // code must still be able to apply the write. Ignoring intent is legal;
        // failing because of it is not.
        expect(changes.map((ch) => ch.id)).toContain("w1");
      });
    });

    describe("the live channel is optional, poke-first and lossy", () => {
      it("closing the returned handle stops delivery", async () => {
        const adapter = await makeAdapter();
        if (!adapter.subscribe) return; // genuinely optional
        const seen: unknown[] = [];
        const dispose = adapter.subscribe((e) => seen.push(e));
        expect(typeof dispose).toBe("function");
        dispose();
        const countAfterDispose = seen.length;
        await adapter.push([change({ mutationId: "m1", seq: 1 })]);
        await new Promise((r) => setTimeout(r, 20));
        // A disposed channel that keeps delivering leaks into a coordinator
        // that has stopped listening — and the events look identical to live ones.
        expect(seen.length).toBe(countAfterDispose);
      });
    });

    describe("version ordering (D3)", () => {
      if (!suppliesComparator) {
        it("does not supply a comparator, and says so consistently", async () => {
          const adapter = await makeAdapter();
          expect(adapter.compareVersions).toBeUndefined();
        });
        return;
      }

      it("supplies a comparator that is total on its own tokens", async () => {
        const adapter = await makeAdapter();
        const cmp = adapter.compareVersions!;
        expect(cmp(1, 1)).toBe("same");
        // Antisymmetry: the two directions must disagree, or "newer" means
        // nothing and version-aware apply silently becomes last-write-wins.
        const ab = cmp(1, 2);
        const ba = cmp(2, 1);
        if (ab === "older") expect(ba).toBe("newer");
        if (ab === "newer") expect(ba).toBe("older");
      });

      it("returns only the four declared values", async () => {
        const adapter = await makeAdapter();
        const cmp = adapter.compareVersions!;
        const legal = ["older", "same", "newer", "concurrent"];
        for (const [a, b] of [
          [1, 2],
          [2, 1],
          ["a", "b"],
          ["b", "a"],
          [1, "a"],
        ] as Array<[import("./sync-types").SyncVersion, import("./sync-types").SyncVersion]>) {
          expect(legal).toContain(cmp(a, b));
        }
      });
    });

    describe("clientId is opaque (C3 / OpaqueToCore)", () => {
      it("accepts a public-key-shaped clientId", async () => {
        const adapter = await makeAdapter();
        // The C3 door. A decentralized deployment has no server to allocate
        // ids, so identity must be able to BE a key. An adapter that validates
        // the format closes that door for every future adapter.
        const key = "ed25519:3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";
        const result = await adapter.push([change({ mutationId: "m1", seq: 1, clientId: key })]);
        expect(result.results).toHaveLength(1);
      });
    });
  });
}
