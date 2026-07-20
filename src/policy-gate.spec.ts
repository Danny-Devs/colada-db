/**
 * Policy gate suite (DAN-577 scope item 2 / ADR-007 §2 / audit blocker #4):
 * the pre-apply veto runs BEFORE a transactional write touches the live
 * store; the commit-time willCommit is last-chance validation whose veto
 * invokes the real rollback machinery. Both fail visibly (PolicyVetoError).
 */
import { describe, expect, it } from "vitest";
import type { EntityEvent, EntityKey, StorageEngine } from "./types";
import { createEntityStore } from "./store";
import { enablePersistence } from "./persist";
import { createOptimisticUpdates, PolicyVetoError } from "./transactions";

function fastEngine() {
  const written = new Map<string, unknown>();
  const engine: StorageEngine = {
    isSupported: () => true,
    open: async () => {},
    loadAll: async () => [],
    async writeBatch(puts, deletes) {
      for (const { key, value } of puts) written.set(key, value);
      for (const key of deletes) written.delete(key);
    },
    close() {},
  };
  return { engine, written };
}

describe("pre-apply veto (willApply)", () => {
  it("a vetoed write leaves store, subscribers, and persistence untouched", async () => {
    const { engine, written } = fastEngine();
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, writeDebounce: 1 });
    await handle.ready;

    const events: EntityEvent[] = [];
    store.subscribe((e) => events.push(e));

    const opt = createOptimisticUpdates(store);
    opt.useGate({ willApply: () => "spend limit exceeded" });

    const tx = opt.transaction();
    expect(() => tx.set("order", "1", { id: "1", amount: 999 })).toThrowError(PolicyVetoError);

    expect(store.has("order", "1")).toBe(false); // store untouched
    expect(events).toHaveLength(0); // no event emitted
    tx.commit();
    await handle.flush();
    expect(written.has("order:1" as EntityKey)).toBe(false); // disk untouched
    handle.dispose();
  });

  it("a vetoed write is NOT in the replay log — later rollbacks cannot resurrect it", () => {
    const store = createEntityStore();
    const opt = createOptimisticUpdates(store);
    const off = opt.useGate({
      willApply: (change) => (change.entityType === "forbidden" ? false : true),
    });

    const txA = opt.transaction();
    txA.set("contact", "1", { id: "1", name: "A" });
    const txB = opt.transaction();
    expect(() => txB.set("forbidden", "x", { id: "x" })).toThrowError(PolicyVetoError);
    txB.set("contact", "2", { id: "2", name: "B" });

    // A's rollback replays B — the vetoed write must not reappear
    txA.rollback();
    expect(store.has("forbidden", "x")).toBe(false);
    expect(store.get("contact", "2").value).toMatchObject({ name: "B" });
    txB.rollback();
    off();
  });

  it("veto carries the gate's reason; the transaction remains usable for allowed writes", () => {
    const store = createEntityStore();
    const opt = createOptimisticUpdates(store);
    const off = opt.useGate({
      willApply: (change) => (change.type === "remove" ? "removes are not allowed" : true),
    });

    const tx = opt.transaction();
    tx.set("contact", "1", { id: "1" }); // allowed
    try {
      tx.remove("contact", "1");
      expect.unreachable("remove should have been vetoed");
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyVetoError);
      expect((err as PolicyVetoError).reason).toBe("removes are not allowed");
      expect((err as PolicyVetoError).phase).toBe("apply");
    }
    expect(store.has("contact", "1")).toBe(true); // earlier allowed write intact
    tx.rollback();
    off();
  });

  it("a vetoed apply() self-settles — no orphaned active transaction pollutes later rollbacks", () => {
    const store = createEntityStore();
    const opt = createOptimisticUpdates(store);
    const off = opt.useGate({
      willApply: (change) => (change.entityType === "forbidden" ? false : true),
    });
    const outcomes: string[] = [];
    const offSettled = opt.onSettled((e) => outcomes.push(`${e.transactionId}:${e.outcome}`));

    // apply() throws before the caller ever gets a handle — it must settle itself
    expect(() => opt.apply("forbidden", "1", { id: "1" })).toThrow(PolicyVetoError);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatch(/:rollback$/);

    // The orphan is gone: a later unrelated rollback replays cleanly
    const tx = opt.transaction();
    tx.set("contact", "1", { id: "1" });
    tx.rollback();
    expect(store.has("contact", "1")).toBe(false);
    off();
    offSettled();
  });

  it("gates see the previous value; unregistering a gate stops enforcement", () => {
    const store = createEntityStore();
    store.set("account", "1", { id: "1", balance: 100 });
    const opt = createOptimisticUpdates(store);

    const seen: Array<{ prev: unknown; next: unknown }> = [];
    const off = opt.useGate({
      willApply: (change) => {
        seen.push({ prev: change.previous, next: change.data });
        return false;
      },
    });

    const tx = opt.transaction();
    expect(() => tx.set("account", "1", { id: "1", balance: 0 })).toThrow(PolicyVetoError);
    expect(seen[0].prev).toMatchObject({ balance: 100 });
    expect(seen[0].next).toMatchObject({ balance: 0 });

    off(); // gate removed — same write now passes
    tx.set("account", "1", { id: "1", balance: 0 });
    expect(store.get("account", "1").value).toMatchObject({ balance: 0 });
    tx.rollback();
  });
});

describe("commit-time veto (willCommit, last-chance)", () => {
  it("veto triggers real rollback: prior state restored, settles as rollback, disk untouched, commit throws", async () => {
    const { engine, written } = fastEngine();
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, writeDebounce: 1 });
    await handle.ready;

    store.set("account", "1", { id: "1", balance: 100 });
    await handle.flush();

    const opt = createOptimisticUpdates(store);
    const outcomes: string[] = [];
    opt.onSettled((e) => outcomes.push(e.outcome));
    const off = opt.useGate({
      willCommit: (changeSet) =>
        changeSet.some((c) => (c.data as { balance?: number })?.balance === 0)
          ? "zero balance forbidden"
          : true,
    });

    const tx = opt.transaction();
    tx.set("account", "1", { id: "1", balance: 0 }); // optimistic (allowed at apply)
    expect(store.get("account", "1").value).toMatchObject({ balance: 0 });

    expect(() => tx.commit()).toThrowError(PolicyVetoError);

    expect(store.get("account", "1").value).toMatchObject({ balance: 100 }); // restored
    expect(outcomes).toEqual(["rollback"]); // settled as rollback
    await handle.flush();
    expect(written.get("account:1" as EntityKey)).toMatchObject({ balance: 100 }); // disk = truth
    off();
    handle.dispose();
  });

  it("willCommit sees the pre-transaction value as previous (net old → new)", () => {
    const store = createEntityStore();
    store.set("account", "1", { id: "1", balance: 100 });
    const opt = createOptimisticUpdates(store);

    const seen: Array<{ prev: unknown; next: unknown }> = [];
    const off = opt.useGate({
      willCommit: (changeSet) => {
        for (const c of changeSet) seen.push({ prev: c.previous, next: c.data });
        return true;
      },
    });

    const tx = opt.transaction();
    tx.set("account", "1", { id: "1", balance: 50 });
    tx.set("account", "1", { id: "1", balance: 25 }); // second write, same tx
    tx.commit();

    // previous = pre-transaction snapshot, not the intermediate 50
    expect(seen.at(-1)).toMatchObject({
      prev: { balance: 100 },
      next: { balance: 25 },
    });
    off();
  });

  it("multiple gates: deny wins regardless of order; allow-all passes", () => {
    const store = createEntityStore();
    const opt = createOptimisticUpdates(store);
    const offA = opt.useGate({ willCommit: () => true });
    const offB = opt.useGate({ willCommit: () => false });

    const tx = opt.transaction();
    tx.set("contact", "1", { id: "1" });
    expect(() => tx.commit()).toThrow(PolicyVetoError);

    offB(); // only the allowing gate remains
    const tx2 = opt.transaction();
    tx2.set("contact", "2", { id: "2" });
    tx2.commit();
    expect(store.has("contact", "2")).toBe(true);
    offA();
  });
});
