/**
 * The demo's transport is PROVEN, not assumed: the real ADR-006 conformance
 * kit runs against the hub with every hook supplied, so no block is skipped.
 * Then two hub-specific properties the kit does not own — the poke-first
 * live channel actually pokes, and the server-authoritative posture is
 * last-arrival-wins — because the demo's story depends on both.
 */
import { describe, expect, it } from "vitest";
import { runSyncAdapterContract } from "@core/sync-conformance";
import type { LocalChange, SyncAdapter } from "@core/sync-types";
import { createSyncHub, HUB_SCHEMA_VERSION } from "./hub";
import type { SyncHub } from "./hub";

// The kit hands hooks the ADAPTER; the hub behind it is found here.
const hubOf = new WeakMap<SyncAdapter, SyncHub>();
function makeHub(): SyncHub {
  const hub = createSyncHub();
  hubOf.set(hub.adapter, hub);
  return hub;
}
function behind(adapter: SyncAdapter): SyncHub {
  const hub = hubOf.get(adapter);
  if (!hub) throw new Error("adapter was not built by makeHub");
  return hub;
}

runSyncAdapterContract({
  name: "sync-demo in-page hub",
  makeAdapter: () => makeHub().adapter,
  seedRemote: async (a, t, i, d) => behind(a).seedRemote(t, i, d),
  removeRemote: async (a, t, i) => behind(a).removeRemote(t, i),
  simulateTransientFailure: (a) => behind(a).simulateTransientFailure(),
  unsupportedSchemaVersion: "v999",
  supportsSubscriptions: true,
  suppliesComparator: false,
});

function change(over: Partial<LocalChange> & { mutationId: string; seq: number }): LocalChange {
  return {
    clientId: "left",
    op: "set",
    entityType: "todo",
    id: "t1",
    data: { id: "t1", title: "hello" },
    ...over,
  };
}

describe("hub-specific properties the kit does not own", () => {
  it("pokes every live subscriber after a push applies (poke-first, D16)", async () => {
    const hub = makeHub();
    const seen: unknown[] = [];
    hub.adapter.subscribe!((e) => seen.push(e));
    await hub.adapter.push([change({ mutationId: "m1", seq: 1 })]);
    await new Promise((r) => queueMicrotask(() => r(undefined)));
    expect(seen).toEqual([{ type: "poke" }]);
  });

  it("does not poke on an idempotent replay — nothing changed", async () => {
    const hub = makeHub();
    await hub.adapter.push([change({ mutationId: "m1", seq: 1 })]);
    const seen: unknown[] = [];
    hub.adapter.subscribe!((e) => seen.push(e));
    await hub.adapter.push([change({ mutationId: "m1", seq: 1 })]);
    await new Promise((r) => queueMicrotask(() => r(undefined)));
    expect(seen).toEqual([]);
  });

  it("is server-authoritative by arrival order: the last push to a key wins, and both are acked", async () => {
    const hub = makeHub();
    const left = await hub.adapter.push([
      change({ mutationId: "L1", seq: 1, clientId: "left", data: { id: "t1", title: "from left" } }),
    ]);
    const right = await hub.adapter.push([
      change({ mutationId: "R1", seq: 1, clientId: "right", data: { id: "t1", title: "from right" } }),
    ]);
    expect(left.results[0]!.status).toBe("ack");
    expect(right.results[0]!.status).toBe("ack");

    const pulled = await hub.adapter.pull(null);
    expect(pulled.type).toBe("changes");
    if (pulled.type !== "changes") return;
    expect(pulled.changes).toHaveLength(1);
    expect(pulled.changes[0]!.data).toEqual({ id: "t1", title: "from right" });
    // Both clients are confirmed on the pull channel (D1).
    expect(pulled.confirmedMutations).toEqual({ left: 1, right: 1 });
  });

  it("serves its own schema version and refuses others with reset / a named SchemaVersionError", async () => {
    const hub = makeHub();
    const ok = await hub.adapter.pull(null, { schemaVersion: HUB_SCHEMA_VERSION });
    expect(ok.type).toBe("changes");
    await expect(
      hub.adapter.push([change({ mutationId: "m1", seq: 1 })], { schemaVersion: "v999" }),
    ).rejects.toMatchObject({ name: "SchemaVersionError" });
  });

  it("reports what the UI shows: live rows, tombstones, clock, clients", async () => {
    const hub = makeHub();
    await hub.adapter.push([change({ mutationId: "m1", seq: 1, id: "a" })]);
    await hub.adapter.push([change({ mutationId: "m2", seq: 2, id: "b" })]);
    await hub.adapter.push([change({ mutationId: "m3", seq: 3, id: "a", op: "remove", data: undefined })]);
    expect(hub.stats()).toEqual({ live: 1, tombstones: 1, clock: 3, clients: 1 });
  });
});
