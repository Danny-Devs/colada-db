/**
 * Live matcher views (DAN-606) — the done-defining suite from
 * docs/design/live-matcher-views.md.
 *
 * Covers: two-tier maintenance (encodable zero-rerun contract via
 * scan-count spy; opaque coalesced re-scan), reference stability
 * incl. the optimistic-rollback leg (Dexie #2034/#2058 scar class),
 * retention under gc (audit blocker #5 memory half), remove-vs-evict
 * semantics, the dev-mode divergence guard, and the drain-queue race.
 */
import { describe, expect, it, vi } from "vitest";
import { createEntityStore } from "./store";
import { createStoreBoundary } from "./boundary";
import { createMatcherView, MatcherViewError, type MatcherView } from "./matcher-view";
import { M } from "./matcher";
import { createOptimisticUpdates } from "./transactions";
import type { EntityRecord } from "./types";

/** Store + boundary + a scan-count spy on the projection read. */
function harness() {
  const store = createEntityStore();
  const boundary = createStoreBoundary(store);
  const scans = vi.spyOn(boundary, "getEntities");
  return { store, boundary, scans };
}

const active = (id: string) => ({ id, status: "active" });
const inactive = (id: string) => ({ id, status: "inactive" });
const isActive = M.eq("status", "active");

const microtasks = () => Promise.resolve();

describe("createMatcherView — classification & seed", () => {
  it("classifies an AST filter encodable and seeds from the current projection", () => {
    const { store, boundary } = harness();
    store.set("contact", "1", active("1"));
    store.set("contact", "2", inactive("2"));
    store.set("contact", "3", active("3"));

    const view = createMatcherView(boundary, "contact", isActive);
    expect(view.tier).toBe("encodable");
    expect(view.getMembers()).toEqual(["1", "3"]);
    expect(view.has("1")).toBe(true);
    expect(view.has("2")).toBe(false);
  });

  it("accepts plain-JSON AST input (the agent-surface shape) via the fail-closed classifier", () => {
    const { store, boundary } = harness();
    store.set("contact", "1", active("1"));
    const view = createMatcherView(boundary, "contact", {
      op: "eq",
      field: "status",
      value: "active",
    });
    expect(view.tier).toBe("encodable");
    expect(view.getMembers()).toEqual(["1"]);
  });

  it("classifies a closure filter opaque and seeds correctly", () => {
    const { store, boundary } = harness();
    store.set("contact", "1", active("1"));
    store.set("contact", "2", inactive("2"));

    const view = createMatcherView(boundary, "contact", (e: EntityRecord) => e.status === "active");
    expect(view.tier).toBe("opaque");
    expect(view.getMembers()).toEqual(["1"]);
  });

  it("refuses a malformed non-callable filter LOUDLY (fail-visible, never match-nothing)", () => {
    const { boundary } = harness();
    let thrown: unknown;
    try {
      createMatcherView(boundary, "contact", { op: "like", field: "name", value: "%a%" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MatcherViewError);
    expect((thrown as MatcherViewError).code).toBe("unusable-filter");
    expect((thrown as MatcherViewError).reason).toBeTruthy();
  });
});

describe("encodable tier — membership from event payloads (ZERO re-scans)", () => {
  it("maintains add / remove / noop purely from events: scan count stays at the seed's 1", () => {
    const { store, boundary, scans } = harness();
    store.set("contact", "1", active("1"));
    const view = createMatcherView(boundary, "contact", isActive);
    expect(scans).toHaveBeenCalledTimes(1); // the seed

    store.set("contact", "2", active("2")); // non-member, matches → add
    expect(view.getMembers()).toEqual(["1", "2"]);

    store.set("contact", "1", inactive("1")); // member, stops matching → remove
    expect(view.getMembers()).toEqual(["2"]);

    const stable = view.getMembers();
    store.set("contact", "2", { id: "2", status: "active", name: "Bob" }); // member edit, still matches → noop
    expect(view.getMembers()).toBe(stable);

    store.set("contact", "3", inactive("3")); // non-member, no match → noop
    expect(view.getMembers()).toBe(stable);

    expect(scans).toHaveBeenCalledTimes(1); // STILL only the seed
  });

  it("drops membership on remove AND on evict (honest projection scope) — still zero re-scans", () => {
    const { store, boundary, scans } = harness();
    store.set("contact", "1", active("1"));
    store.set("contact", "2", active("2"));
    const view = createMatcherView(boundary, "contact", isActive);

    store.remove("contact", "1"); // semantic delete → member exits
    expect(view.getMembers()).toEqual(["2"]);

    store.evict("contact", "2"); // direct evict → left the projection → member exits
    expect(view.getMembers()).toEqual([]);

    store.set("contact", "2", active("2")); // re-entry after evict re-adds
    expect(view.getMembers()).toEqual(["2"]);

    expect(scans).toHaveBeenCalledTimes(1);
  });

  it("ignores events for other entity types: no change, no notification, no scan", () => {
    const { store, boundary, scans } = harness();
    store.set("contact", "1", active("1"));
    const view = createMatcherView(boundary, "contact", isActive);
    const listener = vi.fn();
    view.subscribe(listener);
    const stable = view.getMembers();

    store.set("order", "9", { id: "9", status: "active" });
    store.remove("order", "9");

    expect(view.getMembers()).toBe(stable);
    expect(listener).not.toHaveBeenCalled();
    expect(scans).toHaveBeenCalledTimes(1);
  });
});

describe("opaque tier — coalesced re-scan fallback", () => {
  it("a synchronous burst of writes costs exactly ONE re-scan, with correct membership", async () => {
    const { store, boundary, scans } = harness();
    store.set("contact", "1", active("1"));
    const view = createMatcherView(boundary, "contact", (e: EntityRecord) => e.status === "active");
    expect(scans).toHaveBeenCalledTimes(1); // seed

    store.set("contact", "2", active("2"));
    store.set("contact", "3", inactive("3"));
    store.set("contact", "1", inactive("1"));
    expect(view.getMembers()).toEqual(["1"]); // not yet converged (microtask boundary)

    await microtasks();
    expect(view.getMembers()).toEqual(["2"]);
    expect(scans).toHaveBeenCalledTimes(2); // seed + ONE coalesced re-scan
  });

  it("drops members on remove/evict and re-enters on re-add", async () => {
    const { store, boundary } = harness();
    store.set("contact", "1", active("1"));
    store.set("contact", "2", active("2"));
    const view = createMatcherView(boundary, "contact", (e: EntityRecord) => e.status === "active");

    store.remove("contact", "1");
    store.evict("contact", "2");
    await microtasks();
    expect(view.getMembers()).toEqual([]);

    store.set("contact", "2", active("2"));
    await microtasks();
    expect(view.getMembers()).toEqual(["2"]);
  });

  it("keeps the SAME array instance when a re-scan finds membership unchanged", async () => {
    const { store, boundary } = harness();
    store.set("contact", "1", active("1"));
    const view = createMatcherView(boundary, "contact", (e: EntityRecord) => e.status === "active");
    const stable = view.getMembers();

    store.set("contact", "1", { id: "1", status: "active", name: "Alice" }); // edit, still member
    store.set("contact", "2", inactive("2")); // never a member
    await microtasks();

    expect(view.getMembers()).toBe(stable);
  });

  it("treats a throwing predicate as non-match (isolated, reported once) instead of crashing", async () => {
    const { store, boundary } = harness();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    store.set("contact", "1", active("1"));
    store.set("contact", "2", { id: "2" }); // no status → predicate throws

    const view = createMatcherView(boundary, "contact", (e: EntityRecord) => {
      return (e.status as string).startsWith("act");
    });
    expect(view.getMembers()).toEqual(["1"]);
    expect(errSpy).toHaveBeenCalledTimes(1); // reported once, not per entity/scan

    store.set("contact", "3", { id: "3" }); // another thrower
    await microtasks();
    expect(view.getMembers()).toEqual(["1"]);
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});

describe("reference stability (Dexie #2034/#2058 scar class, steal-list #2)", () => {
  it("same array instance across unrelated writes; a membership change mints exactly one new array", () => {
    const { store, boundary } = harness();
    store.set("contact", "1", active("1"));
    const view = createMatcherView(boundary, "contact", isActive);
    const before = view.getMembers();

    store.set("order", "9", { id: "9", total: 100 }); // other type
    store.set("contact", "2", inactive("2")); // same type, never matches
    store.set("contact", "1", { id: "1", status: "active", name: "Alice" }); // member edit
    expect(view.getMembers()).toBe(before);

    store.set("contact", "2", active("2")); // membership change
    const after = view.getMembers();
    expect(after).not.toBe(before);
    expect(after).toEqual(["1", "2"]);

    store.set("contact", "2", { id: "2", status: "active", note: "hi" }); // edit again → stable again
    expect(view.getMembers()).toBe(after);
  });

  it("stays === through a rolled-back optimistic transaction on non-member entities (the rollback leg)", () => {
    const { store, boundary } = harness();
    store.set("contact", "1", active("1"));
    const view = createMatcherView(boundary, "contact", isActive);
    const opt = createOptimisticUpdates(store);
    const before = view.getMembers();

    const { rollback } = opt.apply("contact", "2", inactive("2"));
    expect(view.getMembers()).toBe(before); // optimistic write of a non-match → untouched
    rollback(); // compensating tombstone for a never-matching entity → untouched
    expect(view.getMembers()).toBe(before);
  });

  it("a transaction that transiently flips membership converges back on rollback", () => {
    const { store, boundary } = harness();
    store.set("contact", "1", active("1"));
    const view = createMatcherView(boundary, "contact", isActive);
    const opt = createOptimisticUpdates(store);

    const { rollback } = opt.apply("contact", "3", active("3"));
    expect(view.getMembers()).toEqual(["1", "3"]); // optimistic add is visible (live view honesty)

    rollback(); // entity had no pre-tx truth → compensating remove
    expect(view.getMembers()).toEqual(["1"]);
    expect(view.has("3")).toBe(false);
  });
});

describe("retention — a view is a retaining scope (gc pinning)", () => {
  it("a live member survives gc() even when its external refcount drops to zero", () => {
    const { store, boundary } = harness();
    store.set("contact", "1", active("1")); // member
    store.set("contact", "2", inactive("2")); // control: not a member
    createMatcherView(boundary, "contact", isActive);

    // Simulate a query retaining then releasing both entities.
    for (const id of ["1", "2"]) {
      store.retain("contact", id);
      store.release("contact", id);
    }

    const evicted = store.gc();
    expect(store.has("contact", "1")).toBe(true); // pinned by the view
    expect(store.has("contact", "2")).toBe(false); // control evicted
    expect(evicted).toEqual(["contact:2"]);
  });

  it("membership exit releases the pin: the ex-member becomes evictable at the next sweep", () => {
    const { store, boundary } = harness();
    store.set("contact", "1", active("1"));
    const view = createMatcherView(boundary, "contact", isActive);
    expect(store.getRefCount("contact", "1")).toBe(1); // the view's pin

    store.set("contact", "1", inactive("1")); // exits membership
    expect(view.getMembers()).toEqual([]);
    expect(store.getRefCount("contact", "1")).toBe(0);

    store.gc();
    expect(store.has("contact", "1")).toBe(false); // residency ratchet: displayed ≠ immortal
  });

  it("dispose() releases every pin, tears down the subscription, and empties the view", () => {
    const { store, boundary } = harness();
    store.set("contact", "1", active("1"));
    store.set("contact", "2", active("2"));
    const view = createMatcherView(boundary, "contact", isActive);
    const listener = vi.fn();
    view.subscribe(listener);

    view.dispose();
    expect(view.getMembers()).toEqual([]);

    store.set("contact", "3", active("3")); // post-dispose write: no updates, no notify
    expect(view.getMembers()).toEqual([]);
    expect(listener).not.toHaveBeenCalled();

    store.gc();
    expect(store.has("contact", "1")).toBe(false); // pins released → swept
    expect(store.has("contact", "2")).toBe(false);

    view.dispose(); // idempotent
  });

  it("repeated enter/exit cycles leave no refcount drift (no leak)", () => {
    const { store, boundary } = harness();
    store.set("contact", "1", inactive("1"));
    createMatcherView(boundary, "contact", isActive);

    for (let i = 0; i < 3; i++) {
      store.set("contact", "1", active("1"));
      expect(store.getRefCount("contact", "1")).toBe(1);
      store.set("contact", "1", inactive("1"));
      expect(store.getRefCount("contact", "1")).toBe(0);
    }
  });
});

describe("notifications", () => {
  it("fires exactly once per membership change, never on noop; unsubscribe works; errors isolated", () => {
    const { store, boundary } = harness();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    store.set("contact", "1", active("1"));
    const view = createMatcherView(boundary, "contact", isActive);
    const broken = vi.fn(() => {
      throw new Error("subscriber bug");
    });
    const healthy = vi.fn();
    view.subscribe(broken);
    const off = view.subscribe(healthy);

    store.set("contact", "2", active("2")); // add → 1 notification
    store.set("contact", "2", { id: "2", status: "active", note: "x" }); // noop → none
    store.set("contact", "2", inactive("2")); // remove → 1 notification

    expect(broken).toHaveBeenCalledTimes(2);
    expect(healthy).toHaveBeenCalledTimes(2); // isolated from the thrower

    off();
    store.set("contact", "2", active("2"));
    expect(healthy).toHaveBeenCalledTimes(2);
    expect(broken).toHaveBeenCalledTimes(3);
    errSpy.mockRestore();
  });
});

describe("dev-mode divergence guard (verifyIntegrity)", () => {
  it("detects in-place mutation drift, reports it, and self-heals to scan truth", () => {
    const { store, boundary } = harness();
    store.set("contact", "1", inactive("1"));
    const onDivergence = vi.fn();
    const view = createMatcherView(boundary, "contact", isActive, {
      verifyIntegrity: true,
      onDivergence,
    });
    expect(view.getMembers()).toEqual([]);

    // The real-world divergence class: an entity mutated in place,
    // outside store writes — no event, the delta tier can't see it.
    const held = store.get("contact", "1").value as { status: string };
    held.status = "active";

    // Any same-type event triggers the guard's re-scan compare.
    store.set("contact", "2", inactive("2"));

    expect(onDivergence).toHaveBeenCalledTimes(1);
    expect(onDivergence).toHaveBeenCalledWith({ entityType: "contact", missing: ["1"], extra: [] });
    expect(view.getMembers()).toEqual(["1"]); // self-healed
    expect(store.getRefCount("contact", "1")).toBe(1); // healed member is pinned too
  });

  it("stays silent while the delta tier agrees with re-scan truth", () => {
    const { store, boundary } = harness();
    store.set("contact", "1", active("1"));
    const onDivergence = vi.fn();
    createMatcherView(boundary, "contact", isActive, { verifyIntegrity: true, onDivergence });

    store.set("contact", "2", active("2"));
    store.set("contact", "1", inactive("1"));
    store.remove("contact", "2");
    store.set("contact", "3", inactive("3"));

    expect(onDivergence).not.toHaveBeenCalled();
  });
});

describe("drain-queue race (arch review H5 adjacency)", () => {
  it("a view created inside a store listener mid-burst converges by the end of the burst", () => {
    const { store, boundary } = harness();
    let view: MatcherView | undefined;
    store.subscribe(() => {
      // First delivered event of the burst: state is fully settled
      // (H5 uniform rule), remaining events are still queued.
      view ??= createMatcherView(boundary, "contact", isActive);
    });

    store.setMany([
      { entityType: "contact", id: "1", data: active("1") },
      { entityType: "contact", id: "2", data: inactive("2") },
      { entityType: "contact", id: "3", data: active("3") },
    ]);

    expect(view).toBeDefined();
    expect(view!.getMembers()).toEqual(["1", "3"]);
  });
});
