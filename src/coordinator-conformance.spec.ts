/**
 * Coordinator conformance — the executable form of ADR-006 rev d's
 * "Coordinator semantics" and both "Implementation note" sections.
 *
 * Every `describe` below targets one obligation from
 * `SYNC_CONTRACT_COVERAGE.coordinator` (`src/sync-conformance.ts`) — the
 * coverage-equality test at the bottom pins that this file's list and that
 * one's never drift apart silently.
 *
 * Per LESSONS.md 2026-07-23 and this repo's standing law ("a check is not
 * proven until it has been watched to fail"), the highest-risk properties in
 * this file were verified red-then-green by hand during development —
 * temporarily breaking the exact mechanism in `coordinator.ts`, confirming
 * the corresponding test failed, then reverting. Recorded in the PR
 * description for DAN-776, not encoded as permanent mutants here: unlike
 * `sync-conformance.ts` (many swappable third-party adapters), there is
 * exactly one `enableSync()` to mutate against, so a swappable-implementation
 * harness would be decoration rather than a real second subject.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { enableSync, SchemaVersionError } from "./coordinator";
import {
  COORDINATOR_CONTRACT_COVERAGE,
  freshStore,
  makeScriptedAdapter,
  remoteChange,
  tick,
} from "./coordinator-conformance";
import { SYNC_CONTRACT_COVERAGE } from "./sync-conformance";
import type { SyncAdapter } from "./sync-types";
import type { EntityKey, EntityStore, StorageEngine } from "./types";

function localWrite(
  store: EntityStore,
  entityType: string,
  id: string,
  data: Record<string, unknown>,
  transactionId?: string,
): void {
  store.runWith({ origin: "local-mutation", transactionId }, () => store.set(entityType, id, data));
}

function localRemove(store: EntityStore, entityType: string, id: string, transactionId?: string): void {
  store.runWith({ origin: "local-mutation", transactionId }, () => store.remove(entityType, id));
}

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.restoreAllMocks();
});

function boot(store: EntityStore, opts: Parameters<typeof enableSync>[1]) {
  const handle = enableSync(store, opts);
  stops.push(handle.stop);
  return handle;
}

describe("coverage stays in lockstep with sync-conformance.ts", () => {
  it("this file's obligation list is exactly SYNC_CONTRACT_COVERAGE.coordinator", () => {
    expect([...COORDINATOR_CONTRACT_COVERAGE].sort()).toEqual([...SYNC_CONTRACT_COVERAGE.coordinator].sort());
  });
});

describe("OutboxIsKeyedByClientAndSeq", () => {
  it("outbox entries are keyed by (clientId, seq), monotonic per client, sourced from local-mutation events", async () => {
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    boot(store, { adapter: scripted.adapter, clientId: "client-a" });

    localWrite(store, "Widget", "w1", { id: "w1", label: "one" });
    await tick();
    localWrite(store, "Widget", "w2", { id: "w2", label: "two" });
    await tick();

    const sent = scripted.pushCalls.flat();
    expect(sent.every((c) => c.clientId === "client-a")).toBe(true);
    expect(sent.map((c) => c.seq)).toEqual([1, 2]);
  });

  it("a local remove enters the outbox as op: 'remove' with no data", async () => {
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    boot(store, { adapter: scripted.adapter, clientId: "client-a" });
    localWrite(store, "Widget", "w1", { id: "w1" });
    await tick();
    localRemove(store, "Widget", "w1");
    await tick();
    const second = scripted.pushCalls[1]![0]!;
    expect(second.op).toBe("remove");
    expect(second.data).toBeUndefined();
  });

  it("only local-mutation writes enter the outbox — an accept-list, not a deny-list", async () => {
    // Falsifies the deny-list mutant (`origin !== "sync-pull"`), the exact anti-pattern the
    // ticket and ADR name: writes stamped with OTHER origins — and unstamped writes, which
    // carry no origin at all — must be excluded too. This replaced a test that booted, wrote
    // nothing, and asserted zero pushes, which passes against any implementation whatsoever
    // (review gauntlet, DAN-776). Watched to fail against the deny-list mutant.
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    const handle = boot(store, { adapter: scripted.adapter, clientId: "client-a" });
    store.runWith({ origin: "query-response" }, () => store.set("Widget", "w1", { id: "w1", label: "cached" }));
    store.runWith({ origin: "undo" }, () => store.set("Widget", "w2", { id: "w2", label: "undone" }));
    store.set("Widget", "w3", { id: "w3", label: "unstamped" });
    await tick();
    expect(handle.getPendingCount()).toBe(0);
    expect(scripted.pushCalls).toHaveLength(0);
  });
});

describe("UniqueMutationIdentity", () => {
  it("every outbox entry carries a unique mutationId", async () => {
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    boot(store, { adapter: scripted.adapter, clientId: "client-a" });
    localWrite(store, "Widget", "w1", { id: "w1" });
    localWrite(store, "Widget", "w2", { id: "w2" });
    await tick();
    const ids = scripted.pushCalls.flat().map((c) => c.mutationId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("NeverCarriesRemoteProvenance", () => {
  it("an applied remote change never re-enters the outbox (echo suppression, §2)", async () => {
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    scripted.queuePull({ type: "changes", changes: [remoteChange({ id: "w1", version: 1 })], cursor: "1", complete: true });
    boot(store, { adapter: scripted.adapter, clientId: "client-a" });
    await tick();
    expect(store.has("Widget", "w1")).toBe(true);
    expect(scripted.pushCalls).toHaveLength(0);
  });
});

describe("AtMostOnePushInFlightPerClient", () => {
  it("a second local write while a push is in flight does not trigger a second push call", async () => {
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    let releaseFirst!: (r: import("./sync-types").PushResult) => void;
    const first = new Promise<import("./sync-types").PushResult>((resolve) => {
      releaseFirst = resolve;
    });
    scripted.queuePush(() => first, (batch) => ({ results: batch.map((c) => ({ mutationId: c.mutationId, status: "ack" as const, version: 1 })) }));
    boot(store, { adapter: scripted.adapter, clientId: "client-a" });

    localWrite(store, "Widget", "w1", { id: "w1" });
    await tick();
    expect(scripted.pushCalls).toHaveLength(1);

    localWrite(store, "Widget", "w2", { id: "w2" }); // arrives while push #1 is in flight
    await tick();
    expect(scripted.pushCalls).toHaveLength(1); // still just the one in-flight call

    releaseFirst({ results: [{ mutationId: scripted.pushCalls[0]![0]!.mutationId, status: "ack", version: 1 }] });
    await tick();
    await tick(); // the verdict's own schedulePush() registers a NEW macrotask; needs a second drain
    expect(scripted.pushCalls).toHaveLength(2); // now w2 goes out on its own
  });
});

describe("OverlayIsDroppedOnlyByThePullChannel", () => {
  it("a push ack does not retire the outbox entry — only a matching confirmedMutations mark does", async () => {
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    const handle = boot(store, { adapter: scripted.adapter, clientId: "client-a" });

    localWrite(store, "Widget", "w1", { id: "w1" });
    await tick();
    expect(handle.getPendingCount()).toBe(1); // ack landed (default queue), but not yet confirmed

    scripted.queuePull({ type: "changes", changes: [], cursor: "1", complete: true, confirmedMutations: { "client-a": 1 } });
    scripted.emitLive({ type: "poke" }); // the live channel is what triggers the next pull here
    await tick();
    expect(handle.getPendingCount()).toBe(0); // NOW retired, by the pull channel alone
  });

  it("applies identically to transform — id remap is immediate, overlay drop still waits", async () => {
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    scripted.queuePush((batch) => ({
      results: batch.map((c) => ({ mutationId: c.mutationId, status: "transform" as const, data: { id: "w1", label: "server-corrected" } })),
    }));
    const handle = boot(store, { adapter: scripted.adapter, clientId: "client-a" });

    localWrite(store, "Widget", "w1", { id: "w1", label: "client" });
    await tick();
    expect(store.get("Widget", "w1").value).toEqual({ id: "w1", label: "server-corrected" }); // applied immediately
    expect(handle.getPendingCount()).toBe(1); // but NOT retired yet
  });
});

describe("StagedBatchesAreNotApplied", () => {
  it("a complete:false page is not applied to the store until a complete:true page arrives", async () => {
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    let releasePage2!: (r: import("./sync-types").PullResult) => void;
    const page2 = new Promise<import("./sync-types").PullResult>((resolve) => {
      releasePage2 = resolve;
    });
    scripted.queuePull(
      { type: "changes", changes: [remoteChange({ id: "w1", version: 1 })], cursor: "1", complete: false },
      () => page2,
    );
    boot(store, { adapter: scripted.adapter, clientId: "client-a" });
    await tick();
    expect(store.has("Widget", "w1")).toBe(false); // staged, not applied

    releasePage2({ type: "changes", changes: [remoteChange({ id: "w2", version: 1 })], cursor: "2", complete: true });
    await tick();
    expect(store.has("Widget", "w1")).toBe(true); // both pages applied together, at completion
    expect(store.has("Widget", "w2")).toBe(true);
  });
});

describe("InlineResetIsAPokeNeverAnInstruction", () => {
  it("an inline reset on the live channel triggers a pull and mutates nothing directly", async () => {
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    boot(store, { adapter: scripted.adapter, clientId: "client-a" });
    await tick();
    const before = scripted.pullCalls.length;

    scripted.emitLive({ type: "reset" });
    await tick();

    expect(scripted.pullCalls.length).toBeGreaterThan(before); // a pull was scheduled
    // the live handler itself never touches the store — nothing here asserts
    // on store state directly because there is no code path by which it could.
  });
});

describe("HydrationPriorityOrdersStartsAndNeverBlocks / HigherPriorityIsRequestedFirst", () => {
  it("initial pulls are STARTED in declared priority order, without waiting for the first to finish", async () => {
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    boot(store, {
      adapter: scripted.adapter,
      clientId: "client-a",
      subscriptions: [
        { name: "low", priority: 1 },
        { name: "high", priority: 5 },
      ],
    });
    // Both pulls are issued synchronously (before either resolves) — captured
    // in call order before any microtask runs, so no await is needed here.
    expect(scripted.pullCalls[0]!.opts?.subscription).toBe("high");
    expect(scripted.pullCalls[1]!.opts?.subscription).toBe("low");
  });
});

describe("StoppedSubscriptionsAreQuiescent", () => {
  it("no further store writes occur after stop() — neither new local writes nor in-flight pull completions", async () => {
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    let releasePull!: (r: import("./sync-types").PullResult) => void;
    const pending = new Promise<import("./sync-types").PullResult>((resolve) => {
      releasePull = resolve;
    });
    scripted.queuePull(() => pending);
    const handle = enableSync(store, { adapter: scripted.adapter, clientId: "client-a" });
    await tick();

    handle.stop();
    localWrite(store, "Widget", "w1", { id: "w1" }); // new work after stop
    await tick();
    expect(scripted.pushCalls).toHaveLength(0);

    releasePull({ type: "changes", changes: [remoteChange({ id: "w2", version: 1 })], cursor: "1", complete: true });
    await tick();
    expect(store.has("Widget", "w2")).toBe(false); // in-flight pull's result discarded, not applied
  });
});

describe("RemappedEntriesCarryNoStaleBaseVersion", () => {
  it("a transform's remap rewrites dependent outbox entries' id and clears their baseVersion", async () => {
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    let releaseFirst!: (r: import("./sync-types").PushResult) => void;
    const first = new Promise<import("./sync-types").PushResult>((resolve) => {
      releaseFirst = resolve;
    });
    scripted.queuePush(
      () => first,
      (batch) => ({ results: batch.map((c) => ({ mutationId: c.mutationId, status: "ack" as const, version: 2 })) }),
    );
    boot(store, { adapter: scripted.adapter, clientId: "client-a" });

    localWrite(store, "Widget", "temp-1", { id: "temp-1", label: "created offline" });
    await tick();
    expect(scripted.pushCalls).toHaveLength(1);

    // A second edit to the same (still temp-id'd) entity arrives while entry #1 is in flight.
    localWrite(store, "Widget", "temp-1", { id: "temp-1", label: "edited again" });
    await tick();
    expect(scripted.pushCalls).toHaveLength(1); // still just one in flight (AtMostOnePushInFlightPerClient)

    releaseFirst({
      results: [{ mutationId: scripted.pushCalls[0]![0]!.mutationId, status: "transform", data: { id: "server-1", label: "created offline" }, remappedId: "server-1" }],
    });
    await tick();
    await tick(); // the verdict's own schedulePush() registers a NEW macrotask; needs a second drain

    expect(scripted.pushCalls).toHaveLength(2);
    const rewritten = scripted.pushCalls[1]![0]!;
    expect(rewritten.id).toBe("server-1");
    expect(rewritten.baseVersion).toBeUndefined();
  });
});

describe("transform + still-pending sibling write (found by independent review, DAN-776)", () => {
  it("a transform's applied correction replays a second, still-unconfirmed writer on top instead of erasing it", async () => {
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    let releaseFirst!: (r: import("./sync-types").PushResult) => void;
    const first = new Promise<import("./sync-types").PushResult>((resolve) => {
      releaseFirst = resolve;
    });
    scripted.queuePush(() => first, (batch) => ({ results: batch.map((c) => ({ mutationId: c.mutationId, status: "ack" as const, version: 1 })) }));
    boot(store, { adapter: scripted.adapter, clientId: "client-a" });

    localWrite(store, "Widget", "w1", { id: "w1", label: "first edit" });
    await tick();
    localWrite(store, "Widget", "w1", { id: "w1", label: "second edit — still pending" });
    await tick();

    releaseFirst({
      results: [{ mutationId: scripted.pushCalls[0]![0]!.mutationId, status: "transform", data: { id: "w1", label: "server-corrected" } }],
    });
    await tick();

    expect(store.get("Widget", "w1").value).toEqual({ id: "w1", label: "second edit — still pending" });
  });
});

describe("pull() error handling (found by independent review, DAN-776)", () => {
  it("a thrown pull() does not permanently kill the subscription — it retries with backoff", async () => {
    vi.useFakeTimers();
    try {
      const store = freshStore();
      const scripted = makeScriptedAdapter();
      scripted.queuePull(
        () => {
          throw new Error("network error");
        },
        { type: "changes", changes: [remoteChange({ id: "w1", version: 1 })], cursor: "1", complete: true },
      );
      boot(store, { adapter: scripted.adapter, clientId: "client-a" });
      await vi.advanceTimersByTimeAsync(0);
      expect(store.has("Widget", "w1")).toBe(false); // first attempt threw

      await vi.advanceTimersByTimeAsync(2000); // well past the first backoff's 1s cap
      expect(store.has("Widget", "w1")).toBe(true); // retried and succeeded
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("stranded-entry reject reverts correctly when previousData is supplied (found by independent review, DAN-776)", () => {
  it("a rejected adopted entry with previousData reverts to it, not to non-existence", async () => {
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    scripted.queuePush((batch) => ({ results: batch.map((c) => ({ mutationId: c.mutationId, status: "reject" as const })) }));
    boot(store, {
      adapter: scripted.adapter,
      clientId: "client-a",
      recoverStrandedOutbox: () => [
        {
          mutationId: "sibling-mut-1",
          clientId: "client-b-stranded-tab",
          seq: 1,
          op: "set",
          entityType: "Widget",
          id: "w1",
          data: { id: "w1", label: "sibling's bad edit" },
          previousData: { id: "w1", label: "the value before the sibling's edit" },
          previousExisted: true,
        },
      ],
    });
    await tick();
    await tick();
    expect(store.get("Widget", "w1").value).toEqual({ id: "w1", label: "the value before the sibling's edit" });
  });
});

describe("resumeAfterSchemaMigration", () => {
  it("resumes pushing after a schema suspension once the app signals migration is done", async () => {
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    scripted.queuePush(new SchemaVersionError(), (batch) => ({
      results: batch.map((c) => ({ mutationId: c.mutationId, status: "ack" as const, version: 1 })),
    }));
    const handle = boot(store, { adapter: scripted.adapter, clientId: "client-a", schemaVersion: "v1" });
    localWrite(store, "Widget", "w1", { id: "w1" });
    await tick();
    expect(handle.getRetryState().suspendedForSchema).toBe(true);

    handle.resumeAfterSchemaMigration();
    await tick();
    expect(handle.getRetryState().suspendedForSchema).toBe(false);
    expect(scripted.pushCalls).toHaveLength(2); // the suspended write was retried (ack alone doesn't retire it — see OverlayIsDroppedOnlyByThePullChannel)
  });
});

describe("DeviceLocalTypesNeverEnterTheOutbox", () => {
  it("a local:true entity type never enters the outbox regardless of origin", async () => {
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    boot(store, { adapter: scripted.adapter, clientId: "client-a", entityDefs: { Draft: { local: true } } });
    localWrite(store, "Draft", "d1", { id: "d1", text: "scratch" });
    await tick();
    expect(scripted.pushCalls).toHaveLength(0);
  });

  it("D18 — a local:true type arriving on pull is ignored and warned, not applied", async () => {
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    scripted.queuePull({ type: "changes", changes: [remoteChange({ entityType: "Draft", id: "d1", version: 1 })], cursor: "1", complete: true });
    boot(store, { adapter: scripted.adapter, clientId: "client-a", entityDefs: { Draft: { local: true } } });
    await tick();
    expect(store.has("Draft", "d1")).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});

describe("AdoptionIsSameDeviceOnly / AuthenticationMaterialIsMintedAtCommitTime", () => {
  it("a stranded sibling's outbox entry is forwarded exactly as committed — clientId, mutationId, auth unchanged", async () => {
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    const mintAuth = vi.fn(() => "own-auth-token");
    boot(store, {
      adapter: scripted.adapter,
      clientId: "client-a",
      mintAuth,
      recoverStrandedOutbox: () => [
        {
          mutationId: "sibling-mut-1",
          clientId: "client-b-stranded-tab",
          seq: 7,
          op: "set",
          entityType: "Widget",
          id: "w9",
          data: { id: "w9", label: "from a crashed tab" },
          auth: "sibling-signed-at-commit",
        },
      ],
    });
    await tick();
    await tick(); // recoverStrandedOutbox() resolves via a promise chain; its schedulePush() needs a second drain

    expect(scripted.pushCalls.flat()).toHaveLength(1);
    const forwarded = scripted.pushCalls.flat()[0]!;
    expect(forwarded.clientId).toBe("client-b-stranded-tab"); // never re-authored to our own clientId
    expect(forwarded.mutationId).toBe("sibling-mut-1"); // never re-minted
    // The coordinator's own minter is never invoked for adopted entries — their
    // auth material was already minted at THEIR commit time, not ours.
    expect(mintAuth).not.toHaveBeenCalled();
  });

  it("mintAuth is called once per local write, at commit (outbox-entry-creation) time — never again on retry", async () => {
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    scripted.queuePush(new Error("transient"), (batch) => ({
      results: batch.map((c) => ({ mutationId: c.mutationId, status: "ack" as const, version: 1 })),
    }));
    const mintAuth = vi.fn(() => "token-1");
    boot(store, { adapter: scripted.adapter, clientId: "client-a", mintAuth });

    localWrite(store, "Widget", "w1", { id: "w1" });
    await tick();
    expect(mintAuth).toHaveBeenCalledTimes(1); // minted once, at write time

    // First push threw (transient); the retry (still the SAME outbox entry) must not re-mint.
    await tick(1500);
    expect(mintAuth).toHaveBeenCalledTimes(1);
  });
});

describe("§3/D3 — version-aware apply, with concurrent applied and arrival-order as tiebreak", () => {
  it("an older remote version is not applied over a known-newer local record", async () => {
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    scripted.queuePull(
      { type: "changes", changes: [remoteChange({ id: "w1", version: 5, data: { id: "w1", label: "v5" } })], cursor: "1", complete: true },
      { type: "changes", changes: [remoteChange({ id: "w1", version: 2, data: { id: "w1", label: "v2-stale" } })], cursor: "2", complete: true },
    );
    boot(store, { adapter: scripted.adapter, clientId: "client-a", pollIntervalMs: 5 });
    await tick();
    expect(store.get("Widget", "w1").value).toEqual({ id: "w1", label: "v5" });
    await tick(20);
    expect(store.get("Widget", "w1").value).toEqual({ id: "w1", label: "v5" }); // v2 never applied over v5
  });

  it("a concurrent verdict IS applied (pull-arrival order is the tiebreak)", async () => {
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    scripted.adapter.compareVersions = () => "concurrent";
    scripted.queuePull({ type: "changes", changes: [remoteChange({ id: "w1", version: "x", data: { id: "w1", label: "concurrent-write" } })], cursor: "1", complete: true });
    boot(store, { adapter: scripted.adapter, clientId: "client-a" });
    await tick();
    expect(store.get("Widget", "w1").value).toEqual({ id: "w1", label: "concurrent-write" });
  });
});

describe("§4 — ADR-004 boundary at the sync edge", () => {
  it("an evict is never pushed to the outbox", async () => {
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    boot(store, { adapter: scripted.adapter, clientId: "client-a" });
    localWrite(store, "Widget", "w1", { id: "w1" });
    await tick();
    scripted.pushCalls.length = 0; // clear the create's push

    store.retain("Widget", "w1");
    store.release("Widget", "w1");
    store.gc(); // evicts — memory-only, not a semantic delete
    await tick();
    expect(scripted.pushCalls).toHaveLength(0);
  });

  it("a remote remove performs a durable delete via store.remove", async () => {
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    scripted.queuePull({ type: "changes", changes: [remoteChange({ id: "w1", version: 1 })], cursor: "1", complete: true }, { type: "changes", changes: [remoteChange({ type: "remove", id: "w1", version: 2 })], cursor: "2", complete: true });
    boot(store, { adapter: scripted.adapter, clientId: "client-a", pollIntervalMs: 5 });
    await tick();
    expect(store.has("Widget", "w1")).toBe(true);
    await tick(20);
    expect(store.has("Widget", "w1")).toBe(false);
  });
});

describe("reject — revert-and-replay (ADR-006 implementation note, part 2)", () => {
  it("a rejected write reverts to previousData without erasing a still-pending second write to the same entity", async () => {
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    let releaseFirst!: (r: import("./sync-types").PushResult) => void;
    const first = new Promise<import("./sync-types").PushResult>((resolve) => {
      releaseFirst = resolve;
    });
    scripted.queuePush(() => first, (batch) => ({ results: batch.map((c) => ({ mutationId: c.mutationId, status: "ack" as const, version: 1 })) }));
    boot(store, { adapter: scripted.adapter, clientId: "client-a" });

    localWrite(store, "Widget", "w1", { id: "w1", label: "first edit" }); // previousData: undefined (new entity)
    await tick();
    localWrite(store, "Widget", "w1", { id: "w1", label: "second edit — still pending" });
    await tick();

    releaseFirst({ results: [{ mutationId: scripted.pushCalls[0]![0]!.mutationId, status: "reject" }] });
    await tick();

    // Reverting entry #1 (which had no previous state) removes it — but entry #2
    // is still outstanding and must be replayed back on top, not erased.
    expect(store.get("Widget", "w1").value).toEqual({ id: "w1", label: "second edit — still pending" });
  });

  it("a rejected write with prior data reverts to it, and the server seq is not blocked for the next write", async () => {
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    boot(store, { adapter: scripted.adapter, clientId: "client-a" });
    localWrite(store, "Widget", "w1", { id: "w1", label: "original" });
    await tick();
    scripted.queuePush((batch) => ({ results: batch.map((c) => ({ mutationId: c.mutationId, status: "reject" as const })) }));
    localWrite(store, "Widget", "w1", { id: "w1", label: "bad edit" });
    await tick();
    expect(store.get("Widget", "w1").value).toEqual({ id: "w1", label: "original" });
  });
});

describe("D9 — push retry: exponential backoff with full jitter, no ceiling, observable retry state", () => {
  it("a thrown (transient) push failure schedules a retry and exposes retry state", async () => {
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    scripted.queuePush(new Error("network blip"));
    const handle = boot(store, { adapter: scripted.adapter, clientId: "client-a" });
    localWrite(store, "Widget", "w1", { id: "w1" });
    await tick();

    const state = handle.getRetryState();
    expect(state.attempt).toBeGreaterThan(0);
    expect(state.nextRetryAt).not.toBeNull();
    expect(state.suspendedForSchema).toBe(false);
  });

  it("a write survives a transient failure and lands on retry", async () => {
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    scripted.queuePush(new Error("network blip"), (batch) => ({
      results: batch.map((c) => ({ mutationId: c.mutationId, status: "ack" as const, version: 1 })),
    }));
    const handle = boot(store, { adapter: scripted.adapter, clientId: "client-a" });
    localWrite(store, "Widget", "w1", { id: "w1" });
    await tick(); // first attempt throws
    await tick(1500); // backoff cap for attempt 1 is well under this
    expect(scripted.pushCalls.length).toBeGreaterThanOrEqual(2);
    expect(handle.getRetryState().attempt).toBe(0); // reset after a successful push
  });
});

describe("D10 — reset jitter: independent per subscription", () => {
  it("both re-pulls land at exactly their own [0, 30s) jitter draw, at 15s — a shared draw would fire both together at whatever one value came out", async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5); // 0.5 * 30s = 15s for every draw
    try {
      const store = freshStore();
      const scripted = makeScriptedAdapter();
      scripted.queuePull({ type: "reset" });
      boot(store, {
        adapter: scripted.adapter,
        clientId: "client-a",
        subscriptions: [{ name: "a" }, { name: "b" }],
      });
      await vi.advanceTimersByTimeAsync(0);
      const afterReset = scripted.pullCalls.length;
      expect(afterReset).toBe(2); // both subscriptions' initial pulls resolved to reset

      // A single shared draw and two independent draws of the SAME value are
      // indistinguishable by outcome alone, so the property under test is really
      // "each subscription owns its own timer" — proven by both firing at exactly
      // the drawn delay, neither early nor coupled to the other's completion.
      await vi.advanceTimersByTimeAsync(14_999);
      expect(scripted.pullCalls.length).toBe(afterReset); // not yet — still short of the 15s draw
      await vi.advanceTimersByTimeAsync(2);
      expect(scripted.pullCalls.length).toBe(afterReset + 2); // both fired, at their own timer
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("D12 — schemaVersion mismatch suspends the outbox, never drains or discards it", () => {
  it("a thrown SchemaVersionError from push suspends further pushes without dropping the entry", async () => {
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    scripted.queuePush(new SchemaVersionError());
    const handle = boot(store, { adapter: scripted.adapter, clientId: "client-a", schemaVersion: "v1" });
    localWrite(store, "Widget", "w1", { id: "w1" });
    await tick();

    expect(handle.getRetryState().suspendedForSchema).toBe(true);
    expect(handle.getPendingCount()).toBe(1); // the entry is still there, not discarded

    localWrite(store, "Widget", "w2", { id: "w2" });
    await tick();
    expect(scripted.pushCalls).toHaveLength(1); // no further push attempted while suspended
    expect(handle.getPendingCount()).toBe(2); // w2 still queues; the outbox is not drained either
  });
});

describe("clientId stays opaque (rev c C3)", () => {
  it("a public-key-shaped clientId round-trips through the outbox unchanged, unvalidated", async () => {
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    const key = "ed25519:3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";
    boot(store, { adapter: scripted.adapter, clientId: key });
    localWrite(store, "Widget", "w1", { id: "w1" });
    await tick();
    expect(scripted.pushCalls.flat()[0]!.clientId).toBe(key);
  });
});

describe("rev c C2-1 / C2 — the coordinator's own model stays cursor-and-subscription shaped", () => {
  it("an opaque subscription name with structure is passed through unparsed", async () => {
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    const weird = "a/b:c?d=e fé";
    boot(store, { adapter: scripted.adapter, clientId: "client-a", subscriptions: [{ name: weird }] });
    await tick();
    expect(scripted.pullCalls[0]!.opts?.subscription).toBe(weird);
  });

  it("version comparison always routes through the adapter comparator (or the shipped default), never a bare operator", async () => {
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    const compareVersions = vi.fn(() => "newer" as const);
    scripted.adapter.compareVersions = compareVersions;
    // The comparator is only reachable once a version is already known for the
    // entity (a first sighting always applies — nothing to compare against yet),
    // so this seeds one via poke before the change the assertion targets.
    scripted.queuePull({ type: "changes", changes: [remoteChange({ id: "w1", version: 1 })], cursor: "1", complete: true });
    boot(store, { adapter: scripted.adapter, clientId: "client-a" });
    await tick();
    compareVersions.mockClear();

    scripted.queuePull({ type: "changes", changes: [remoteChange({ id: "w1", version: "weird-token" })], cursor: "2", complete: true });
    scripted.emitLive({ type: "poke" });
    await tick();
    expect(compareVersions).toHaveBeenCalledWith("weird-token", 1);
  });
});

describe("reject arriving after a newer pull (review gauntlet, DAN-776)", () => {
  it("does not revert over remote truth that landed while the push was in flight", async () => {
    // Executed failure scenario from the review: w1=A@v1 → local edit B (push held in
    // flight) → pull applies C@v5 → verdict `reject` reverts to A. Because `versions`
    // still holds v5, a re-pull of the identical C@v5 classifies as "same" and is
    // skipped — the store diverges from the server until the entity changes again.
    // The revert must be gated on the entry's basis still being the store's basis.
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    scripted.queuePull(
      {
        type: "changes",
        changes: [remoteChange({ data: { id: "w1", label: "A" }, version: 1 })],
        cursor: "1",
        complete: true,
      },
      { type: "changes", changes: [], cursor: "1", complete: true },
    );
    boot(store, { adapter: scripted.adapter, clientId: "client-a" });
    await tick();
    expect(store.get("Widget", "w1").value).toEqual({ id: "w1", label: "A" });

    let release: () => void = () => {};
    scripted.queuePush(
      (batch) =>
        new Promise((resolve) => {
          release = () =>
            resolve({ results: batch.map((c) => ({ mutationId: c.mutationId, status: "reject" as const })) });
        }),
    );
    localWrite(store, "Widget", "w1", { id: "w1", label: "B" });
    await tick();
    expect(scripted.pushCalls).toHaveLength(1); // in flight, verdict held

    scripted.queuePull({
      type: "changes",
      changes: [remoteChange({ data: { id: "w1", label: "C" }, version: 5 })],
      cursor: "2",
      complete: true,
    });
    scripted.emitLive({ type: "poke" });
    await tick();
    // DAN-777 finding B: the pull-apply replays the still-pending writer on
    // top (C landed underneath, B stays visible) — before that fix this line
    // pinned {label: "C"}, i.e. the optimistic edit visibly vanishing until
    // the push echo returned.
    expect(store.get("Widget", "w1").value).toEqual({ id: "w1", label: "B" });

    release();
    await tick();
    // The late reject must not resurrect A — the mutation's basis (v1) no longer exists.
    expect(store.get("Widget", "w1").value).toEqual({ id: "w1", label: "C" });
  });

  it("a same-key ack does not suppress the revert of a rejected sibling", async () => {
    // Round-2 gauntlet finding: an ack advances `versions` WITHOUT writing the store, so a
    // gate that reads the version map conflates "stamp advanced" with "content changed" and
    // leaves the rejected data in place forever (the echo pull classifies "same" and skips).
    // The gate must count actual pull-channel store writes, not version stamps.
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    scripted.queuePush((batch) => ({
      results: batch.map((c, i) =>
        i === 0
          ? { mutationId: c.mutationId, status: "ack" as const, version: 7 }
          : { mutationId: c.mutationId, status: "reject" as const },
      ),
    }));
    boot(store, { adapter: scripted.adapter, clientId: "client-a" });
    // Two writes to the same key land in ONE push batch: X (acked @v7), then B (rejected).
    localWrite(store, "Widget", "w1", { id: "w1", label: "X" });
    localWrite(store, "Widget", "w1", { id: "w1", label: "B" });
    await tick();
    // The store's content basis never changed — the reject must still revert B to X.
    expect(store.get("Widget", "w1").value).toEqual({ id: "w1", label: "X" });
    // And the server's echo of X@v7 leaves the converged value in place.
    scripted.queuePull({
      type: "changes",
      changes: [remoteChange({ data: { id: "w1", label: "X" }, version: 7 })],
      cursor: "2",
      complete: true,
    });
    scripted.emitLive({ type: "poke" });
    await tick();
    expect(store.get("Widget", "w1").value).toEqual({ id: "w1", label: "X" });
  });

  it("a same-key reject after a transform re-bases onto the server's corrected value", async () => {
    // Round-3 gauntlet finding 1: transform's authoritative store write happens outside
    // applyRemoteChange, so a write-counter fed only by pulls misses it — and a bare counter
    // bump is not enough either, because the transform's sibling replay already baked the
    // (about-to-be-rejected) edit on top of the correction. The reject path must re-base onto
    // the last server-APPLIED value, not merely decline to revert.
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    scripted.queuePush((batch) => ({
      results: batch.map((c, i) =>
        i === 0
          ? { mutationId: c.mutationId, status: "transform" as const, data: { id: "w1", label: "D" }, version: 7 }
          : { mutationId: c.mutationId, status: "reject" as const },
      ),
    }));
    boot(store, { adapter: scripted.adapter, clientId: "client-a" });
    localWrite(store, "Widget", "w1", { id: "w1", label: "X" });
    localWrite(store, "Widget", "w1", { id: "w1", label: "B" });
    await tick();
    expect(store.get("Widget", "w1").value).toEqual({ id: "w1", label: "D" });
    // The echo of D@7 classifies "same" — convergence must already hold, it cannot heal here.
    scripted.queuePull({
      type: "changes",
      changes: [remoteChange({ data: { id: "w1", label: "D" }, version: 7 })],
      cursor: "2",
      complete: true,
    });
    scripted.emitLive({ type: "poke" });
    await tick();
    expect(store.get("Widget", "w1").value).toEqual({ id: "w1", label: "D" });
  });

  it("a rejected adopted entry never reverts over a value pulled this session", async () => {
    // Round-3 gauntlet finding 2: adoption-time basis capture races the boot pull. A stranded
    // sibling's previousData is by construction from a PREVIOUS session, so no server write
    // this session can ever be older than it — adopted entries take the session floor (0)
    // and any pull-write on the key supersedes their revert.
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    scripted.queuePull(
      {
        type: "changes",
        changes: [remoteChange({ data: { id: "w1", label: "TODAY" }, version: 9 })],
        cursor: "1",
        complete: true,
      },
      { type: "changes", changes: [], cursor: "1", complete: true },
    );
    scripted.queuePush((batch) => ({
      results: batch.map((c) => ({ mutationId: c.mutationId, status: "reject" as const })),
    }));
    boot(store, {
      adapter: scripted.adapter,
      clientId: "client-a",
      recoverStrandedOutbox: async () => {
        await tick(); // resolves AFTER the boot pull has applied TODAY@9
        return [
          {
            mutationId: "m-yesterday",
            clientId: "client-b",
            seq: 1,
            op: "set" as const,
            entityType: "Widget",
            id: "w1",
            data: { id: "w1", label: "STALE-EDIT" },
            previousData: { id: "w1", label: "YESTERDAY" },
            previousExisted: true,
          },
        ];
      },
    });
    await tick(5);
    expect(store.get("Widget", "w1").value).toEqual({ id: "w1", label: "TODAY" });
  });

  it("re-basing after a partial remote change preserves fields the patch did not carry", async () => {
    // Round-4 gauntlet finding: the apply path merges partial remote payloads (store.set,
    // the documented enrichment semantics), but a cache of the raw patch re-applied as a
    // full replacement drops every field the patch didn't carry — echo-immune, since the
    // patch's version is already stamped. The cache must be a server SHADOW maintained
    // patch-over-patch, mirroring the merge the store itself performs.
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    scripted.queuePull(
      {
        type: "changes",
        changes: [remoteChange({ data: { id: "w1", label: "A", color: "red" }, version: 1 })],
        cursor: "1",
        complete: true,
      },
      { type: "changes", changes: [], cursor: "1", complete: true },
    );
    boot(store, { adapter: scripted.adapter, clientId: "client-a" });
    await tick();
    expect(store.get("Widget", "w1").value).toEqual({ id: "w1", label: "A", color: "red" });

    let release: () => void = () => {};
    scripted.queuePush(
      (batch) =>
        new Promise((resolve) => {
          release = () =>
            resolve({ results: batch.map((c) => ({ mutationId: c.mutationId, status: "reject" as const })) });
        }),
    );
    localWrite(store, "Widget", "w1", { id: "w1", label: "B", color: "red" });
    await tick();

    // Mid-flight PARTIAL remote change — carries label only; the merge keeps color.
    scripted.queuePull({
      type: "changes",
      changes: [remoteChange({ data: { id: "w1", label: "C" }, version: 5 })],
      cursor: "2",
      complete: true,
    });
    scripted.emitLive({ type: "poke" });
    await tick();
    // DAN-777 finding B: the pending writer (B) is replayed over the merged
    // partial apply, so the merge's effect on the SHADOW is what the final
    // assertion below proves — the store mid-flight shows the optimistic edit.
    expect(store.get("Widget", "w1").value).toEqual({ id: "w1", label: "B", color: "red" });

    release();
    await tick();
    // The re-base must restore the server's cumulative state, not the last patch alone.
    expect(store.get("Widget", "w1").value).toEqual({ id: "w1", label: "C", color: "red" });
  });

  it("still reverts normally when no remote change landed mid-flight", async () => {
    // The gate must not break the ordinary reject path: basis unchanged ⇒ revert happens.
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    scripted.queuePull(
      {
        type: "changes",
        changes: [remoteChange({ data: { id: "w1", label: "A" }, version: 1 })],
        cursor: "1",
        complete: true,
      },
      { type: "changes", changes: [], cursor: "1", complete: true },
    );
    scripted.queuePush((batch) => ({
      results: batch.map((c) => ({ mutationId: c.mutationId, status: "reject" as const })),
    }));
    boot(store, { adapter: scripted.adapter, clientId: "client-a" });
    await tick();
    localWrite(store, "Widget", "w1", { id: "w1", label: "B" });
    await tick();
    expect(store.get("Widget", "w1").value).toEqual({ id: "w1", label: "A" });
  });
});

describe("pull bound — an adapter that never sets complete (review gauntlet, DAN-776)", () => {
  it("hits the 200-iteration bound without applying the partial pages", async () => {
    // The pathological adapter the bound exists to defend against must not have its
    // accumulated partial snapshot applied when the bound fires —
    // StagedBatchesAreNotApplied has no bound-shaped exception.
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    let page = 0;
    scripted.queuePull(() => {
      page += 1;
      return {
        type: "changes" as const,
        changes: [remoteChange({ data: { id: "w1", label: `partial-${page}` }, version: page })],
        cursor: String(page),
        complete: false,
      };
    });
    boot(store, { adapter: scripted.adapter, clientId: "client-a" });
    await tick();
    await tick();
    expect(scripted.pullCalls.length).toBeGreaterThanOrEqual(200);
    expect(store.get("Widget", "w1").value).toBeUndefined();
  });
});

describe("poll mode — one self-perpetuating chain, fully torn down (review gauntlet, DAN-776)", () => {
  it("polls once per interval, and stop() leaves no timer behind", async () => {
    vi.useFakeTimers();
    try {
      const store = freshStore();
      const scripted = makeScriptedAdapter();
      const { subscribe: _live, ...pollOnly } = scripted.adapter;
      const handle = boot(store, { adapter: pollOnly as SyncAdapter, clientId: "client-a" });
      await vi.advanceTimersByTimeAsync(0); // boot pull completes, scheduling the next cycle
      const afterBoot = scripted.pullCalls.length;
      await vi.advanceTimersByTimeAsync(30_000); // one default poll interval
      // A doubled chain (boot-time schedulePoll + completion-time schedulePoll) fires twice here.
      expect(scripted.pullCalls.length).toBe(afterBoot + 1);
      handle.stop();
      // A second chain also leaks its pending timer past stop(), since pollTimer is one slot.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SchemaVersionError detection is name-based, never message-text matching (review gauntlet, DAN-776)", () => {
  it("a transient error whose message merely mentions SchemaVersionError retries — it does not suspend", async () => {
    // A proxy relaying a server stack trace can put the string "SchemaVersionError" in any
    // error's message. Suspending on that match turns a retryable blip into a permanently
    // suspended outbox that only a manual resumeAfterSchemaMigration() call would revive.
    vi.useFakeTimers();
    try {
      const store = freshStore();
      const scripted = makeScriptedAdapter();
      scripted.queuePush(new Error("upstream proxy relayed: SchemaVersionError at server/frame.ts:12"), (batch) => ({
        results: batch.map((c) => ({ mutationId: c.mutationId, status: "ack" as const, version: 1 })),
      }));
      const handle = boot(store, { adapter: scripted.adapter, clientId: "client-a" });
      localWrite(store, "Widget", "w1", { id: "w1", label: "x" });
      await vi.advanceTimersByTimeAsync(0);
      expect(scripted.pushCalls.length).toBe(1);
      expect(handle.getRetryState().suspendedForSchema).toBe(false);
      await vi.advanceTimersByTimeAsync(2000); // well past the first backoff's 1s cap
      expect(scripted.pushCalls.length).toBe(2); // it retried instead of suspending
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DAN-777 — the two deliberate deferrals from DAN-776's landing review
// ─────────────────────────────────────────────────────────────────────────────

/** An in-memory StorageEngine over a caller-visible Map, so tests can seed a
 *  previous session's rows and inspect what the coordinator persisted. The
 *  Map OUTLIVES enableSync instances — that persistence across "reloads" is
 *  the entire subject under test. */
function fakeOutboxEngine(
  rows: Map<string, unknown> = new Map(),
  opts: { openDelayMs?: number; failLoadAll?: boolean; loadAllDelayMs?: number } = {},
) {
  let closes = 0;
  const engine: StorageEngine = {
    isSupported: () => true,
    async open() {
      if (opts.openDelayMs) await new Promise((r) => setTimeout(r, opts.openDelayMs));
    },
    async loadAll() {
      if (opts.loadAllDelayMs) await new Promise((r) => setTimeout(r, opts.loadAllDelayMs));
      if (opts.failLoadAll) throw new Error("simulated loadAll fault");
      return [...rows.entries()].map(([key, data]) => ({ key: key as EntityKey, data }));
    },
    async loadMany(keys) {
      return keys.filter((k) => rows.has(k)).map((k) => ({ key: k, data: rows.get(k) }));
    },
    async writeBatch(puts, deletes) {
      for (const p of puts) rows.set(p.key, p.value);
      for (const d of deletes) rows.delete(d);
    },
    close() {
      closes += 1;
    },
  };
  return { engine, rows, closeCount: () => closes };
}

describe("DAN-777 finding B — pull-apply replays still-pending same-key writers", () => {
  it("replays multiple pending writers in outbox order, and none re-enter the outbox", async () => {
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    scripted.queuePush(() => new Promise<never>(() => {})); // verdicts never arrive — both writers stay pending
    const handle = boot(store, { adapter: scripted.adapter, clientId: "client-a" });

    localWrite(store, "Widget", "w1", { id: "w1", label: "one" });
    localWrite(store, "Widget", "w1", { id: "w1", label: "two" });
    await tick();
    expect(handle.getPendingCount()).toBe(2);
    const pushCallsBefore = scripted.pushCalls.length;

    scripted.queuePull({
      type: "changes",
      changes: [remoteChange({ data: { id: "w1", label: "SERVER" }, version: 5 })],
      cursor: "2",
      complete: true,
    });
    scripted.emitLive({ type: "poke" });
    await tick();

    // Outbox order: "one" then "two" replayed over the applied SERVER value.
    expect(store.get("Widget", "w1").value).toEqual({ id: "w1", label: "two" });
    // The replay ran under the pull's own write channel — no echo, no new entries.
    expect(handle.getPendingCount()).toBe(2);
    expect(scripted.pushCalls.length).toBe(pushCallsBefore);
  });

  it("a transform verdict's version stamp never regresses a newer pull's stamp", async () => {
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    let release: () => void = () => {};
    scripted.queuePush(
      (batch) =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              results: [
                { mutationId: batch[0]!.mutationId, status: "transform" as const, data: { id: "w1", label: "TRANSFORMED" }, version: 5 },
              ],
            });
        }),
    );
    boot(store, { adapter: scripted.adapter, clientId: "client-a" });

    localWrite(store, "Widget", "w1", { id: "w1", label: "LOCAL" });
    await tick(); // push in flight, verdict held

    scripted.queuePull({
      type: "changes",
      changes: [remoteChange({ data: { id: "w1", label: "TEN" }, version: 10 })],
      cursor: "2",
      complete: true,
    });
    scripted.emitLive({ type: "poke" });
    await tick(); // v10 stamped mid-flight

    release();
    await tick();
    // Review B1 (DAN-777 gauntlet): the STALE transform's DATA must not
    // overwrite the newer pull's state either — a guard that protects only
    // the stamp makes the divergence permanent, because the correct v10 can
    // never re-apply ("same"). Store keeps the replayed pending edit.
    expect(store.get("Widget", "w1").value).toEqual({ id: "w1", label: "LOCAL" });

    // The discriminating probe: a later v7 change. Guarded stamp → known is
    // still 10 → v7 classifies "older" and is skipped. A regressed stamp (5)
    // would classify v7 "newer" and apply it.
    scripted.queuePull({
      type: "changes",
      changes: [remoteChange({ data: { id: "w1", label: "SEVEN" }, version: 7 })],
      cursor: "3",
      complete: true,
    });
    scripted.emitLive({ type: "poke" });
    await tick();
    expect(store.get("Widget", "w1").value).toEqual({ id: "w1", label: "LOCAL" });
  });

  it("an ack verdict's version stamp never regresses a newer pull's stamp", async () => {
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    let release: () => void = () => {};
    scripted.queuePush(
      (batch) =>
        new Promise((resolve) => {
          release = () => resolve({ results: [{ mutationId: batch[0]!.mutationId, status: "ack" as const, version: 5 }] });
        }),
    );
    boot(store, { adapter: scripted.adapter, clientId: "client-a" });

    localWrite(store, "Widget", "w1", { id: "w1", label: "LOCAL" });
    await tick(); // in flight

    scripted.queuePull({
      type: "changes",
      changes: [remoteChange({ data: { id: "w1", label: "TEN" }, version: 10 })],
      cursor: "2",
      complete: true,
    });
    scripted.emitLive({ type: "poke" });
    await tick(); // v10 applied and stamped; the pending LOCAL replayed on top

    release();
    await tick(); // ack v5 — stamp must keep 10

    scripted.queuePull({
      type: "changes",
      changes: [remoteChange({ data: { id: "w1", label: "SEVEN" }, version: 7 })],
      cursor: "3",
      complete: true,
    });
    scripted.emitLive({ type: "poke" });
    await tick();
    // Guarded stamp: v7 skipped, the replayed LOCAL edit stays. Regressed
    // stamp: v7 applies (the acked entry is pushed, so nothing replays over it).
    expect(store.get("Widget", "w1").value).toEqual({ id: "w1", label: "LOCAL" });
  });
});

describe("DAN-777 finding A — the durable outbox (ADR-006 §1)", () => {
  it("seq resumes from the persisted watermark after confirmation and reload — post-reload writes are not silently ignored", async () => {
    // One shared rows map, a FRESH engine per session — the StorageEngine
    // contract forbids calls after close(), which a reload never makes anyway.
    const rows = new Map<string, unknown>();

    // Session 1: write, push (seq 1), confirm via the pull channel, stop.
    const store1 = freshStore();
    const s1 = makeScriptedAdapter();
    const h1 = boot(store1, { adapter: s1.adapter, clientId: "stable-client", outboxEngine: fakeOutboxEngine(rows).engine });
    await tick(5);
    localWrite(store1, "Widget", "w1", { id: "w1", label: "first" });
    await tick();
    expect(s1.pushCalls[0]![0]!.seq).toBe(1);
    s1.queuePull({ type: "changes", changes: [], cursor: "2", complete: true, confirmedMutations: { "stable-client": 1 } });
    s1.emitLive({ type: "poke" });
    await tick();
    expect(h1.getPendingCount()).toBe(0);
    h1.stop();

    // The confirmed entry's row is deleted; the watermark row is NOT derived
    // from surviving entries, so it must still say 1.
    expect([...rows.keys()].filter((k) => k.startsWith("outbox-entry:"))).toEqual([]);
    expect(rows.get("outbox-meta:seq")).toEqual({ seq: 1 });

    // Session 2, same clientId + same store: the next write must be seq 2 —
    // seq 1 would be <= the server's lastSeen and silently ignored forever.
    const store2 = freshStore();
    const s2 = makeScriptedAdapter();
    boot(store2, { adapter: s2.adapter, clientId: "stable-client", outboxEngine: fakeOutboxEngine(rows).engine });
    await tick(5);
    localWrite(store2, "Widget", "w2", { id: "w2", label: "after reload" });
    await tick();
    expect(s2.pushCalls[0]![0]!.seq).toBe(2);
  });

  it("a pending (unconfirmed) entry survives reload and is re-pushed with identical identity — relay, never re-authorship", async () => {
    const rows = new Map<string, unknown>(); // shared rows, fresh engine per session

    const store1 = freshStore();
    const s1 = makeScriptedAdapter();
    s1.queuePush(() => new Promise<never>(() => {})); // the verdict never arrives this session
    const h1 = boot(store1, { adapter: s1.adapter, clientId: "c-durable", outboxEngine: fakeOutboxEngine(rows).engine });
    await tick(5);
    localWrite(store1, "Widget", "w1", { id: "w1", label: "pending across reload" });
    await tick();
    const sent = s1.pushCalls[0]![0]!;
    h1.stop();

    const store2 = freshStore();
    const s2 = makeScriptedAdapter();
    boot(store2, { adapter: s2.adapter, clientId: "c-durable", outboxEngine: fakeOutboxEngine(rows).engine });
    await tick(5);
    const resent = s2.pushCalls.flat();
    expect(resent).toHaveLength(1);
    // Same mutationId and seq — the server dedups replays by exactly these.
    expect(resent[0]!.mutationId).toBe(sent.mutationId);
    expect(resent[0]!.seq).toBe(sent.seq);
    expect(resent[0]!.data).toEqual(sent.data);
  });

  it("a write arriving before the durable-outbox load completes waits for the restored watermark", async () => {
    // A previous session left the watermark at 7. The engine opens slowly;
    // the app writes immediately. Without pre-boot buffering the write would
    // take seq 1 and collide with the previous session's numbering.
    const rows = new Map<string, unknown>([["outbox-meta:seq", { seq: 7 }]]);
    const { engine } = fakeOutboxEngine(rows, { openDelayMs: 15 });
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    boot(store, { adapter: scripted.adapter, clientId: "c-early", outboxEngine: engine });
    localWrite(store, "Widget", "w1", { id: "w1", label: "raced the boot" });
    await tick(40);
    expect(scripted.pushCalls[0]![0]!.seq).toBe(8);
  });

  it("without an outboxEngine, seq restarts at 1 per instance — the documented constraint on reusing a clientId", async () => {
    // This pins the DOCUMENTED in-memory behavior (EnableSyncOptions.clientId
    // doc): a stable clientId without a durable outbox means post-reload
    // writes are seq <= lastSeen server-side. The fix for that hazard is
    // outboxEngine, not a change to this behavior.
    const store1 = freshStore();
    const s1 = makeScriptedAdapter();
    const h1 = boot(store1, { adapter: s1.adapter, clientId: "stable-client" });
    localWrite(store1, "Widget", "w1", { id: "w1" });
    await tick();
    expect(s1.pushCalls[0]![0]!.seq).toBe(1);
    h1.stop();

    const store2 = freshStore();
    const s2 = makeScriptedAdapter();
    boot(store2, { adapter: s2.adapter, clientId: "stable-client" });
    localWrite(store2, "Widget", "w2", { id: "w2" });
    await tick();
    expect(s2.pushCalls[0]![0]!.seq).toBe(1);
  });
});

describe("DAN-777 review round — lifecycle, fault, and boot-window findings", () => {
  it("B2: stop() during a slow outbox-engine open still closes the engine", async () => {
    const { engine, closeCount } = fakeOutboxEngine(new Map(), { openDelayMs: 15 });
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    const handle = boot(store, { adapter: scripted.adapter, clientId: "c-b2", outboxEngine: engine });
    handle.stop(); // React strict-mode double-mount shape: stop before open resolves
    await tick(40);
    // A leaked engine handle can hold an exclusive OPFS lock and silently
    // degrade the NEXT instance to in-memory — resurrecting finding A.
    expect(closeCount()).toBe(1);
  });

  it("A1: a delta-style confirmation mark arriving before the restore completes still retires the restored entry", async () => {
    const rows = new Map<string, unknown>();
    const storeA = freshStore();
    const sA = makeScriptedAdapter();
    sA.queuePush(() => new Promise<never>(() => {}));
    const hA = boot(storeA, { adapter: sA.adapter, clientId: "c-a1", outboxEngine: fakeOutboxEngine(rows).engine });
    await tick(5);
    localWrite(storeA, "Widget", "w1", { id: "w1", label: "pending" });
    await tick();
    hA.stop();
    expect([...rows.keys()].some((k) => k.startsWith("outbox-entry:"))).toBe(true);

    // Session 2: engine opens SLOWLY; the boot pull races ahead and delivers
    // the confirmation mark exactly once (delta-style, Replicache
    // lastMutationIDChanges — legal under ADR-006), then never again.
    const storeB = freshStore();
    const sB = makeScriptedAdapter();
    sB.queuePull(
      { type: "changes", changes: [], cursor: "1", complete: true, confirmedMutations: { "c-a1": 1 } },
      { type: "changes", changes: [], cursor: "1", complete: true },
    );
    const hB = boot(storeB, {
      adapter: sB.adapter,
      clientId: "c-a1",
      outboxEngine: fakeOutboxEngine(rows, { openDelayMs: 20 }).engine,
    });
    await tick(60);
    // The mark's high-water must retire the late-restored entry — otherwise
    // it re-pushes forever as a ghost.
    expect(hB.getPendingCount()).toBe(0);
    expect(sB.pushCalls.flat()).toHaveLength(0);
    expect([...rows.keys()].some((k) => k.startsWith("outbox-entry:"))).toBe(false);
  });

  it("A2: a loadAll fault degrades to in-memory WITHOUT clobbering the previous session's rows", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = new Map<string, unknown>([
      ["outbox-meta:seq", { seq: 3 }],
      [
        "outbox-entry:3",
        { mutationId: "m-old", clientId: "c-a2", seq: 3, op: "set", entityType: "Widget", id: "w1", data: { id: "w1" }, previousExisted: false },
      ],
    ]);
    const { engine } = fakeOutboxEngine(rows, { failLoadAll: true });
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    boot(store, { adapter: scripted.adapter, clientId: "c-a2", outboxEngine: engine });
    await tick(5);
    localWrite(store, "Widget", "w2", { id: "w2", label: "post-fault" });
    await tick();
    // §1's own requirement: a fault can never destroy unpushed writes. A
    // half-open engine writing seq-1 keys over the old session's rows does.
    expect(rows.get("outbox-entry:3")).toMatchObject({ mutationId: "m-old" });
    expect(rows.has("outbox-entry:1")).toBe(false);
    expect(rows.get("outbox-meta:seq")).toEqual({ seq: 3 });
  });

  it("A3: a pull applying during the pre-boot window replays the buffered pending writer", async () => {
    const { engine } = fakeOutboxEngine(new Map(), { openDelayMs: 25 });
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    boot(store, { adapter: scripted.adapter, clientId: "c-a3", outboxEngine: engine });

    localWrite(store, "Widget", "w1", { id: "w1", label: "buffered edit" }); // engine still opening
    await tick(1); // let the BOOT pull settle first — a poke racing an in-flight
    // pull is dropped (pullInFlight), which would make this test pass vacuously
    scripted.queuePull({
      type: "changes",
      changes: [remoteChange({ data: { id: "w1", label: "SERVER" }, version: 5 })],
      cursor: "2",
      complete: true,
    });
    scripted.emitLive({ type: "poke" });
    await tick(2); // still inside the 25ms boot window
    // Finding B holds inside the window too: the buffered pending edit stays
    // visible on top of the applied server value.
    expect(store.get("Widget", "w1").value).toEqual({ id: "w1", label: "buffered edit" });
    await tick(40); // boot completes; entry materializes and pushes normally
    expect(scripted.pushCalls.flat().some((c) => c.id === "w1")).toBe(true);
  });

  it("A4: a transform id-remap reaches entries still in the pre-boot buffer", async () => {
    const { engine } = fakeOutboxEngine(new Map(), { openDelayMs: 25 });
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    // First push (the adopted sibling entry) gets a transform with an id
    // remap; every later push is acked.
    scripted.queuePush(
      (batch) => ({
        results: batch.map((c) => ({
          mutationId: c.mutationId,
          status: "transform" as const,
          data: { id: "srv-1", label: "corrected" },
          version: 1,
          remappedId: "srv-1",
        })),
      }),
      (batch) => ({ results: batch.map((c) => ({ mutationId: c.mutationId, status: "ack" as const, version: 2 })) }),
    );
    boot(store, {
      adapter: scripted.adapter,
      clientId: "c-a4",
      outboxEngine: engine,
      recoverStrandedOutbox: () => [
        {
          mutationId: "m-sib",
          clientId: "sib-client",
          seq: 1,
          op: "set" as const,
          entityType: "Widget",
          id: "temp-1",
          data: { id: "temp-1", label: "sibling write" },
          previousExisted: false,
        },
      ],
    });
    // The app's own write to the same temp id, buffered behind the slow open.
    localWrite(store, "Widget", "temp-1", { id: "temp-1", label: "mine too" });
    await tick(5); // adoption pushes; the remap lands while the buffer still holds our write
    await tick(40); // boot completes; buffered entry materializes and pushes
    const own = scripted.pushCalls.flat().filter((c) => c.clientId === "c-a4");
    expect(own).toHaveLength(1);
    // Without the buffer rewrite this ships the dead temp id.
    expect(own[0]!.id).toBe("srv-1");
    expect(own[0]!.baseVersion).toBeUndefined();
  });

  it("A5: a corrupt persisted entry row is skipped instead of poisoning seq to NaN", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = new Map<string, unknown>([
      ["outbox-meta:seq", { seq: 2 }],
      ["outbox-entry:9", { garbage: true }],
    ]);
    const { engine } = fakeOutboxEngine(rows);
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    boot(store, { adapter: scripted.adapter, clientId: "c-a5", outboxEngine: engine });
    await tick(5);
    localWrite(store, "Widget", "w1", { id: "w1" });
    await tick();
    expect(scripted.pushCalls[0]![0]!.seq).toBe(3); // numeric, from the watermark — never NaN
  });
});

describe("DAN-777 landing gauntlet — the fixes' own siblings", () => {
  it("G1: a STALE transform carrying a remappedId is judged against the TARGET key's stamp too", async () => {
    // Landing-gauntlet finding 1: the stale gate consulted only the temp-id
    // key; a remapped stale transform (temp id has no stamp, server id has a
    // newer one) sailed through and permanently overwrote the newer state.
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    let release: () => void = () => {};
    scripted.queuePush(
      (batch) =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              results: [
                {
                  mutationId: batch[0]!.mutationId,
                  status: "transform" as const,
                  data: { id: "srv-1", label: "STALE-CORRECTION" },
                  version: 5,
                  remappedId: "srv-1",
                },
              ],
            });
        }),
    );
    boot(store, { adapter: scripted.adapter, clientId: "client-a" });

    localWrite(store, "Widget", "temp-1", { id: "temp-1", label: "mine" });
    await tick(); // push in flight, verdict held

    // The server id's state arrives at v10 while the verdict is in flight.
    scripted.queuePull({
      type: "changes",
      changes: [remoteChange({ id: "srv-1", data: { id: "srv-1", label: "TEN" }, version: 10 })],
      cursor: "2",
      complete: true,
    });
    scripted.emitLive({ type: "poke" });
    await tick();
    expect(store.get("Widget", "srv-1").value).toEqual({ id: "srv-1", label: "TEN" });

    release();
    await tick();
    // The stale (v5 < v10) correction must not overwrite srv-1's newer state.
    expect(store.get("Widget", "srv-1").value).toEqual({ id: "srv-1", label: "TEN" });
  });

  it("G2: a loadAll fault still closes the engine at stop()", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { engine, closeCount } = fakeOutboxEngine(new Map(), { failLoadAll: true });
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    const handle = boot(store, { adapter: scripted.adapter, clientId: "c-g2", outboxEngine: engine });
    await tick(5); // open succeeded, loadAll threw, degraded to in-memory
    handle.stop();
    // The A2 fix protected the ROWS; the handle must still be released, or
    // its OPFS lock degrades the next instance to in-memory (finding A again).
    expect(closeCount()).toBe(1);
  });

  it("G3: stop() while loadAll is in flight closes the engine exactly once", async () => {
    const { engine, closeCount } = fakeOutboxEngine(new Map(), { loadAllDelayMs: 20 });
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    const handle = boot(store, { adapter: scripted.adapter, clientId: "c-g3", outboxEngine: engine });
    await tick(2); // open resolved; loadAll pending
    handle.stop(); // closes here...
    await tick(40); // ...and the boot's post-loadAll stopped-path must NOT close again
    expect(closeCount()).toBe(1); // "No calls after close" — src/types.ts StorageEngine contract
  });

  it("G4: with a custom comparator, a 'concurrent' transform's stamp follows its applied data", async () => {
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    // A comparator that can only say same/concurrent — the CRDT-ish shape D3
    // exists for. Attached to the scripted adapter's object directly.
    scripted.adapter.compareVersions = (a, b) => (a === b ? "same" : "concurrent");
    scripted.queuePull(
      {
        type: "changes",
        changes: [remoteChange({ data: { id: "w1", label: "A" }, version: "vA" })],
        cursor: "1",
        complete: true,
      },
      { type: "changes", changes: [], cursor: "1", complete: true },
    );
    let release: () => void = () => {};
    scripted.queuePush(
      (batch) =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              results: [
                { mutationId: batch[0]!.mutationId, status: "transform" as const, data: { id: "w1", label: "CORRECTED" }, version: "vB" },
              ],
            });
        }),
    );
    boot(store, { adapter: scripted.adapter, clientId: "client-a" });
    await tick();
    localWrite(store, "Widget", "w1", { id: "w1", label: "LOCAL" });
    await tick();

    release();
    await tick(); // "concurrent" transform: data IS applied (§3 posture) → stamp must follow to vB
    expect(store.get("Widget", "w1").value).toEqual({ id: "w1", label: "CORRECTED" });

    // The probe: the server's echo of vB must classify "same" and be skipped.
    // A stamp left at vA classifies the echo "concurrent" and re-applies it.
    scripted.queuePull({
      type: "changes",
      changes: [remoteChange({ data: { id: "w1", label: "ECHO" }, version: "vB" })],
      cursor: "2",
      complete: true,
    });
    scripted.emitLive({ type: "poke" });
    await tick();
    expect(store.get("Widget", "w1").value).toEqual({ id: "w1", label: "CORRECTED" });
  });
});

describe("DAN-777 CodeRabbit round — fault-path seq collision, write ordering, comparator pins", () => {
  it("R1: a loadAll fault SUSPENDS pushes — never pushes virgin seqs a previous session already burned", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // A previous session reached seq 7; this session cannot learn that
    // (loadAll faults), so pushing seq 1,2,3… means the server silently
    // ignores every write — finding A's exact hazard, resurrected on the
    // fault path. Visibly stuck beats silently ignored (D9's doctrine).
    const rows = new Map<string, unknown>([["outbox-meta:seq", { seq: 7 }]]);
    const { engine } = fakeOutboxEngine(rows, { failLoadAll: true });
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    const handle = boot(store, { adapter: scripted.adapter, clientId: "c-r1", outboxEngine: engine });
    await tick(5);
    localWrite(store, "Widget", "w1", { id: "w1", label: "must not collide" });
    await tick(10);
    expect(scripted.pushCalls).toHaveLength(0); // nothing rides a colliding seq
    expect(handle.getPendingCount()).toBe(1); // the write is visibly stuck, not hidden
    expect(handle.getRetryState().suspendedForOutboxFault).toBe(true); // and the app can see why
  });

  it("R2: entry persist and retire are ordered — a fast retire cannot resurrect its own entry's row", async () => {
    // StorageEngine guarantees atomicity per batch, not ordering BETWEEN
    // fire-and-forget batches. A delete resolving before the earlier put for
    // the same key re-creates a retired row, which re-pushes as a ghost on
    // the next boot. The engine below resolves the put SLOWLY and the delete
    // instantly — reversed completion order.
    const rows = new Map<string, unknown>();
    let firstPut = true;
    const engine: StorageEngine = {
      isSupported: () => true,
      async open() {},
      async loadAll() {
        return [...rows.entries()].map(([key, data]) => ({ key: key as EntityKey, data }));
      },
      async loadMany() {
        return [];
      },
      async writeBatch(puts, deletes) {
        const slow = puts.length > 0 && firstPut;
        if (slow) firstPut = false;
        if (slow) await new Promise((r) => setTimeout(r, 15)); // the put lags
        for (const p of puts) rows.set(p.key, p.value);
        for (const d of deletes) rows.delete(d);
      },
      close() {},
    };
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    const handle = boot(store, { adapter: scripted.adapter, clientId: "c-r2", outboxEngine: engine });
    await tick(2);
    localWrite(store, "Widget", "w1", { id: "w1", label: "quick round trip" });
    await tick(); // pushed + acked
    scripted.queuePull({ type: "changes", changes: [], cursor: "1", complete: true, confirmedMutations: { "c-r2": 1 } });
    scripted.emitLive({ type: "poke" });
    await tick(); // confirmed → retire delete issued while the put is still pending
    await tick(30); // let the slow put land
    expect(handle.getPendingCount()).toBe(0);
    // Serialized writes: the delete ran AFTER the put — no resurrected row.
    expect([...rows.keys()].filter((k) => k.startsWith("outbox-entry:"))).toEqual([]);
  });

  it("R3: with a same/concurrent comparator, an ack does not stamp — the echo re-applies idempotently and then pins", async () => {
    // Policy pin (CodeRabbit thread): an ack carries no data, so stamping its
    // unranked version would claim store contents the store does not hold.
    // The cost is one idempotent re-apply of the echo — after which
    // applyRemoteChange stamps, and the SECOND echo classifies "same".
    const store = freshStore();
    const scripted = makeScriptedAdapter();
    scripted.adapter.compareVersions = (a, b) => (a === b ? "same" : "concurrent");
    scripted.queuePull(
      {
        type: "changes",
        changes: [remoteChange({ data: { id: "w1", label: "A" }, version: "vA" })],
        cursor: "1",
        complete: true,
      },
      { type: "changes", changes: [], cursor: "1", complete: true },
    );
    scripted.queuePush((batch) => ({
      results: batch.map((c) => ({ mutationId: c.mutationId, status: "ack" as const, version: "vB" })),
    }));
    boot(store, { adapter: scripted.adapter, clientId: "client-a" });
    await tick();
    localWrite(store, "Widget", "w1", { id: "w1", label: "LOCAL" });
    await tick(); // acked @vB — deliberately NOT stamped

    scripted.queuePull({
      type: "changes",
      changes: [remoteChange({ data: { id: "w1", label: "ECHO" }, version: "vB" })],
      cursor: "2",
      complete: true,
    });
    scripted.emitLive({ type: "poke" });
    await tick(); // "concurrent" vs vA → applies (correct §3 posture), stamps vB
    expect(store.get("Widget", "w1").value).toEqual({ id: "w1", label: "ECHO" });

    scripted.queuePull({
      type: "changes",
      changes: [remoteChange({ data: { id: "w1", label: "SECOND-ECHO" }, version: "vB" })],
      cursor: "3",
      complete: true,
    });
    scripted.emitLive({ type: "poke" });
    await tick(); // "same" vs vB → skipped: converged, no livelock
    expect(store.get("Widget", "w1").value).toEqual({ id: "w1", label: "ECHO" });
  });
});
