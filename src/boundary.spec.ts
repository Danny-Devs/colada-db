import { describe, expect, it, vi } from "vitest";
import { createEntityStore } from "./store";
import { createStoreBoundary } from "./boundary";

describe("createStoreBoundary", () => {
  it("ticks the version on set / remove / evict, not on no-op writes", () => {
    const store = createEntityStore();
    const b = createStoreBoundary(store);
    expect(b.getVersion()).toBe(0);

    store.set("contact", "1", { id: "1", name: "Alice" });
    expect(b.getVersion()).toBe(1);

    // No-op write: identical data emits no event → no tick (referential stability)
    store.set("contact", "1", { id: "1", name: "Alice" });
    expect(b.getVersion()).toBe(1);

    store.evict("contact", "1");
    expect(b.getVersion()).toBe(2);

    store.set("contact", "1", { id: "1", name: "Alice" });
    store.remove("contact", "1");
    expect(b.getVersion()).toBe(4);
  });

  it("notifies global listeners once per event and honors unsubscribe", () => {
    const store = createEntityStore();
    const b = createStoreBoundary(store);
    const listener = vi.fn();
    const off = b.subscribe(listener);

    store.set("contact", "1", { id: "1" });
    expect(listener).toHaveBeenCalledTimes(1);

    off();
    store.set("contact", "2", { id: "2" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("scopes per-entity listeners to their key", () => {
    const store = createEntityStore();
    const b = createStoreBoundary(store);
    const alice = vi.fn();
    const bob = vi.fn();
    b.subscribeEntity("contact", "1", alice);
    b.subscribeEntity("contact", "2", bob);

    store.set("contact", "1", { id: "1", name: "Alice" });
    expect(alice).toHaveBeenCalledTimes(1);
    expect(bob).not.toHaveBeenCalled();

    store.remove("contact", "1");
    expect(alice).toHaveBeenCalledTimes(2);
    expect(bob).not.toHaveBeenCalled();
  });

  it("scopes per-type listeners to their entity type", () => {
    const store = createEntityStore();
    const b = createStoreBoundary(store);
    const contacts = vi.fn();
    b.subscribeType("contact", contacts);

    store.set("order", "9", { id: "9" });
    expect(contacts).not.toHaveBeenCalled();

    store.set("contact", "1", { id: "1" });
    expect(contacts).toHaveBeenCalledTimes(1);
  });

  it("getEntity reads snapshots and never mints phantom refs on miss", () => {
    const store = createEntityStore();
    const b = createStoreBoundary(store);

    expect(b.getEntity("contact", "missing")).toBeUndefined();
    // A phantom ref (created by store.get on a miss) would be swept by gc().
    // The boundary's has()-guarded read must leave nothing to sweep.
    expect(store.gc()).toEqual([]);

    store.set("contact", "1", { id: "1", name: "Alice" });
    expect(b.getEntity("contact", "1")).toEqual({ id: "1", name: "Alice" });
  });

  it("getEntities returns id+data snapshots for a type", () => {
    const store = createEntityStore();
    const b = createStoreBoundary(store);
    store.set("contact", "1", { id: "1", name: "Alice" });
    store.set("contact", "2", { id: "2", name: "Bob" });
    store.set("order", "9", { id: "9" });

    const entries = b.getEntities("contact");
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.id).sort()).toEqual(["1", "2"]);
  });

  it("isolates a throwing listener so other consumers still run", () => {
    const store = createEntityStore();
    const b = createStoreBoundary(store);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = vi.fn(() => {
      throw new Error("consumer bug");
    });
    const healthy = vi.fn();
    b.subscribe(broken);
    b.subscribe(healthy);

    store.set("contact", "1", { id: "1" });
    expect(broken).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("dispose tears down the store subscription and all listeners", () => {
    const store = createEntityStore();
    const b = createStoreBoundary(store);
    const listener = vi.fn();
    b.subscribe(listener);

    b.dispose();
    store.set("contact", "1", { id: "1" });
    expect(listener).not.toHaveBeenCalled();
    expect(b.getVersion()).toBe(0);
  });

  // ── The event-carrying tier (H4, DAN-606) ──────────────────────────

  it("subscribeEvents delivers full payloads for set / remove / evict", () => {
    const store = createEntityStore();
    const b = createStoreBoundary(store);
    const events: Array<{ type: string; id: string; data: unknown; previousData: unknown }> = [];
    b.subscribeEvents((e) =>
      events.push({ type: e.type, id: e.id, data: e.data, previousData: e.previousData }),
    );

    store.set("contact", "1", { id: "1", name: "Alice" });
    store.set("contact", "1", { id: "1", name: "Alicia" });
    store.remove("contact", "1");
    store.set("contact", "2", { id: "2" });
    store.evict("contact", "2");

    expect(events).toEqual([
      { type: "set", id: "1", data: { id: "1", name: "Alice" }, previousData: undefined },
      {
        type: "set",
        id: "1",
        data: { id: "1", name: "Alicia" },
        previousData: { id: "1", name: "Alice" },
      },
      { type: "remove", id: "1", data: undefined, previousData: { id: "1", name: "Alicia" } },
      { type: "set", id: "2", data: { id: "2" }, previousData: undefined },
      { type: "evict", id: "2", data: undefined, previousData: { id: "2" } },
    ]);
  });

  it("subscribeEvents payload isolation: a mutating listener cannot poison later listeners", () => {
    // Land-review 2026-07-20 finding 2: each listener gets a per-emission
    // shallow copy — event-field mutation must not propagate.
    const store = createEntityStore();
    const b = createStoreBoundary(store);
    const seenTypes: string[] = [];
    b.subscribeEvents((e) => {
      (e as { type: string }).type = "remove"; // hostile/buggy consumer
    });
    b.subscribeEvents((e) => seenTypes.push(e.type));

    store.set("contact", "1", { id: "1" });
    expect(seenTypes).toEqual(["set"]);
  });

  it("subscribeEvents passes through origin/transactionId stamped via runWith", () => {
    const store = createEntityStore();
    const b = createStoreBoundary(store);
    const seen: Array<{ origin?: string; transactionId?: string }> = [];
    b.subscribeEvents((e) => seen.push({ origin: e.origin, transactionId: e.transactionId }));

    store.runWith({ origin: "hydration" }, () => store.set("contact", "1", { id: "1" }));
    store.runWith({ origin: "local-mutation", transactionId: "tx-9" }, () =>
      store.set("contact", "2", { id: "2" }),
    );

    expect(seen).toEqual([
      { origin: "hydration", transactionId: undefined },
      { origin: "local-mutation", transactionId: "tx-9" },
    ]);
  });

  it("isolates a throwing event listener from event AND void tiers; unsubscribe/dispose stop delivery", () => {
    const store = createEntityStore();
    const b = createStoreBoundary(store);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = vi.fn(() => {
      throw new Error("view bug");
    });
    const healthyEvents = vi.fn();
    const healthyVoid = vi.fn();
    b.subscribeEvents(broken);
    const offHealthy = b.subscribeEvents(healthyEvents);
    b.subscribe(healthyVoid);

    store.set("contact", "1", { id: "1" });
    expect(broken).toHaveBeenCalledTimes(1);
    expect(healthyEvents).toHaveBeenCalledTimes(1);
    expect(healthyVoid).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();

    offHealthy();
    store.set("contact", "2", { id: "2" });
    expect(healthyEvents).toHaveBeenCalledTimes(1);

    b.dispose();
    store.set("contact", "3", { id: "3" });
    expect(broken).toHaveBeenCalledTimes(2); // pre-dispose write above
    errSpy.mockRestore();
  });

  // The contract test ADR-008 §3 promises: a vanilla consumer using the
  // external-store pattern (subscribe + version-as-snapshot + re-read)
  // stays consistent with the store without ever touching the signal layer.
  it("supports the useSyncExternalStore-shaped vanilla consumer", () => {
    const store = createEntityStore();
    const b = createStoreBoundary(store);

    // Simulated external-store integration: cache a rendered view,
    // re-render only when the snapshot (version) changes.
    let renderedName: string | undefined;
    let lastSnapshot = -1;
    const render = () => {
      const snap = b.getVersion();
      if (snap === lastSnapshot) return false;
      lastSnapshot = snap;
      renderedName = b.getEntity("contact", "1")?.name as string | undefined;
      return true;
    };
    b.subscribe(render);

    render(); // initial render
    expect(renderedName).toBeUndefined();

    store.set("contact", "1", { id: "1", name: "Alice" });
    expect(renderedName).toBe("Alice");

    store.set("contact", "1", { id: "1", name: "Alicia" });
    expect(renderedName).toBe("Alicia");

    // No-op write: no event, no re-render, view stays stable
    const before = lastSnapshot;
    store.set("contact", "1", { id: "1", name: "Alicia" });
    expect(lastSnapshot).toBe(before);

    store.remove("contact", "1");
    expect(renderedName).toBeUndefined();
  });
});
