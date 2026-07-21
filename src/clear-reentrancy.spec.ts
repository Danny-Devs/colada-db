/**
 * clear() reentrancy suite (DAN-620, ADR-012).
 *
 * The DAN-606 land gauntlet executed the collision this suite pins: a
 * listener that WRITES during the clear() drain (the exact pattern the
 * H5 queue exists to support) had its write applied and evented — then
 * silently erased by the trailing `typeMap.clear()`, with no event for
 * the erasure. `refCounts.clear()` additionally wiped retention
 * bookkeeping wholesale.
 *
 * ADR-012 semantics, done-defined here:
 * - clear() removes exactly its entry snapshot (atomic, all types, at
 *   call time) — no trailing bulk wipe of maps or refcounts.
 * - Reentrant writes during the drain are ordinary writes: they apply,
 *   they emit, they survive.
 * - Retention cleanup is keyed deletion per snapshotted id, performed
 *   before that id's remove emission — drain-time retains and pins on
 *   memory-absent (durable-but-cold) keys survive.
 * - The event stream stays replayable through any interleaving
 *   (event-stream honesty: NO state transition without its event).
 */
import { describe, expect, it, vi } from "vitest";
import type { EntityEvent, EntityRecord } from "./types";
import { createEntityStore } from "./store";
import { createStoreBoundary } from "./boundary";
import { createMatcherView } from "./matcher-view";
import { M } from "./matcher";

const microtask = () => Promise.resolve();

/** The event-ordering.spec.ts replay loop — replaying the stream onto a
 * fresh store must reproduce identical state. */
function replay(stream: EntityEvent[]) {
  const replica = createEntityStore();
  for (const e of stream) {
    if (e.type === "set" && e.data) replica.replace(e.entityType, e.id, e.data as EntityRecord);
    else if (e.type === "remove") replica.remove(e.entityType, e.id);
    else if (e.type === "evict") replica.evict(e.entityType, e.id);
  }
  return replica;
}

describe("clear() reentrancy (ADR-012)", () => {
  it("reentrant set of a snapshotted id (re-add after its remove) survives clear()", () => {
    const store = createEntityStore();
    store.set("contact", "1", { id: "1", name: "Alice" });
    store.set("contact", "2", { id: "2", name: "Bob" });

    store.subscribe((e) => {
      // Reactive re-add: the DAN-606 finding-1 listener shape.
      if (e.type === "remove" && e.key === "contact:1" && e.previousData) {
        store.set("contact", "1", e.previousData);
      }
    });

    store.clear();

    // The re-added entity is store truth — not silently wiped.
    expect(store.has("contact", "1")).toBe(true);
    expect(store.get("contact", "1").value?.name).toBe("Alice");
    // The snapshotted-only entity is gone.
    expect(store.has("contact", "2")).toBe(false);
    expect(store.getByType("contact").value).toEqual([{ id: "1", name: "Alice" }]);
  });

  it("reentrant set of a NOVEL id (same and different type) survives clear()", () => {
    const store = createEntityStore();
    store.set("contact", "1", { id: "1" });

    store.subscribe((e) => {
      if (e.type === "remove" && e.key === "contact:1") {
        store.set("contact", "99", { id: "99", from: "drain" }); // novel id, same type
        store.set("audit", "log-1", { id: "log-1", about: "contact:1" }); // novel type
      }
    });

    store.clear();

    expect(store.has("contact", "99")).toBe(true);
    expect(store.has("audit", "log-1")).toBe(true);
    expect(store.has("contact", "1")).toBe(false);
  });

  it("a reentrant write to a not-yet-drained snapshotted id is still cleared — honestly", () => {
    const store = createEntityStore();
    store.set("contact", "1", { id: "1" });
    store.set("contact", "2", { id: "2", v: "original" });

    const events: Array<{ type: string; key: string; previousData?: EntityRecord }> = [];
    store.subscribe((e) => {
      events.push({ type: e.type, key: e.key, previousData: e.previousData });
      // During contact:1's removal, touch contact:2 — present at clear()
      // time, so it belongs to the snapshot and must still be removed.
      if (e.type === "remove" && e.key === "contact:1") {
        store.set("contact", "2", { id: "2", v: "reentrant" });
      }
    });

    store.clear();

    expect(store.has("contact", "2")).toBe(false);
    // Its removal was evented, carrying the reentrant value as previousData
    // — the stream never lies about what was destroyed.
    const removal = events.filter((e) => e.type === "remove" && e.key === "contact:2");
    expect(removal).toHaveLength(1);
    expect(removal[0]!.previousData).toEqual({ id: "2", v: "reentrant" });
  });

  it("reentrant retain during the drain survives; gc() honors it", () => {
    const store = createEntityStore();
    store.set("contact", "1", { id: "1", name: "Alice" });
    store.set("contact", "2", { id: "2", name: "Bob" });

    store.subscribe((e) => {
      if (e.type === "remove" && e.key === "contact:1" && e.previousData) {
        store.set("contact", "1", e.previousData);
        store.retain("contact", "1"); // re-established pin
      }
      if (e.type === "remove" && e.key === "contact:2") {
        store.retain("contact", "2"); // pin WITHOUT re-add (memory-absent pin)
      }
    });

    store.clear();

    // Both drain-time pins survived — refCounts was not bulk-wiped.
    expect(store.getRefCount("contact", "1")).toBe(1);
    expect(store.getRefCount("contact", "2")).toBe(1);
    // gc() must not collect the pinned, re-added entity.
    expect(store.gc()).toEqual([]);
    expect(store.has("contact", "1")).toBe(true);
  });

  it("pins on memory-absent keys (coordinator cold-row shape) survive clear()", () => {
    const store = createEntityStore();
    store.set("contact", "resident", { id: "resident" });
    // The persist.ts manifest-coordinator pattern: a durable-but-cold row
    // is retained while absent from the memory projection.
    store.retain("contact", "cold-row");

    store.clear();

    expect(store.getRefCount("contact", "cold-row")).toBe(1);
    // The snapshotted resident's retention entry is gone with the entity.
    expect(store.getRefCount("contact", "resident")).toBeUndefined();
  });

  it("the event stream stays replayable through a reentrant-write clear()", () => {
    const source = createEntityStore();
    source.set("contact", "1", { id: "1", name: "Alice" });
    source.set("contact", "2", { id: "2", name: "Bob" });
    source.set("order", "5", { id: "5", total: 10 });

    const stream: EntityEvent[] = [];
    source.subscribe((e) => stream.push(e));
    source.subscribe((e) => {
      if (e.type === "remove" && e.key === "contact:1" && e.previousData) {
        source.set("contact", "1", e.previousData); // re-add snapshotted id
        source.set("order", "9", { id: "9", total: 99 }); // novel id mid-drain
      }
    });

    source.clear();

    // NO state transition without its event: applying the emitted stream
    // to a fresh store reproduces the source exactly.
    expect(replay(stream).toJSON()).toEqual(source.toJSON());
    expect(Object.keys(source.toJSON()).sort()).toEqual(["contact:1", "order:9"]);
  });

  it("DAN-606 finding 1: a live matcher view whose subscriber re-adds a member during clear() equals store truth afterward, refcounts intact", async () => {
    const store = createEntityStore();
    const boundary = createStoreBoundary(store);
    store.set("contact", "1", { id: "1", kind: "member" });
    store.set("contact", "2", { id: "2", kind: "member" });

    const onDivergence = vi.fn();
    const view = createMatcherView(boundary, "contact", M.eq("kind", "member"), {
      verifyIntegrity: true,
      onDivergence,
    });
    expect(view.tier).toBe("encodable");
    expect([...view.getMembers()].sort()).toEqual(["1", "2"]);

    // The reactive re-add — a subscriber that refuses to let contact:1 die.
    store.subscribe((e) => {
      if (e.type === "remove" && e.key === "contact:1" && e.previousData) {
        store.set("contact", "1", e.previousData);
      }
    });

    store.clear();
    await microtask(); // settle the deferred integrity re-scan

    // View === store truth: contact:1 survived (re-added, evented),
    // contact:2 cleared.
    expect([...view.getMembers()]).toEqual(["1"]);
    expect(store.has("contact", "1")).toBe(true);
    expect(store.has("contact", "2")).toBe(false);
    // The delta tier never diverged from re-scan truth — no silent lie
    // for the guard to heal.
    expect(onDivergence).not.toHaveBeenCalled();
    // Retention intact: exactly the view's pin on its one live member.
    expect(store.getRefCount("contact", "1")).toBe(1);
    expect(store.getRefCount("contact", "2")).toBeUndefined();

    view.dispose();
    expect(store.getRefCount("contact", "1")).toBe(0);
  });

  it("a phantom ref minted during the drain survives clear() (subscribe-before-data)", () => {
    const store = createEntityStore();
    store.set("contact", "1", { id: "1" });

    let phantom: ReturnType<typeof store.get> | undefined;
    store.subscribe((e) => {
      if (e.type === "remove" && e.key === "contact:1") {
        phantom = store.get("contact", "7"); // miss → phantom ref
      }
    });

    store.clear();

    // The handed-out ref must still be live — a later arrival populates it.
    store.set("contact", "7", { id: "7", name: "late" });
    expect(phantom!.value?.name).toBe("late");
  });

  it("nested clear() from inside a listener is safe and stays replayable", () => {
    const store = createEntityStore();
    store.set("contact", "1", { id: "1" });
    store.set("contact", "2", { id: "2" });
    store.set("order", "5", { id: "5" });

    const stream: EntityEvent[] = [];
    store.subscribe((e) => stream.push(e));
    let cleared = false;
    store.subscribe((e) => {
      if (e.type === "remove" && !cleared) {
        cleared = true;
        store.clear(); // clear() during clear()'s own drain
      }
    });

    expect(() => store.clear()).not.toThrow();
    expect(store.toJSON()).toEqual({});
    expect(replay(stream).toJSON()).toEqual({});
  });

  it("with no writing listeners, clear() still empties the store completely", () => {
    const store = createEntityStore();
    store.set("contact", "1", { id: "1" });
    store.set("order", "5", { id: "5" });
    store.retain("contact", "1");

    store.clear();

    expect(store.toJSON()).toEqual({});
    expect(store.getByType("contact").value).toEqual([]);
    expect(store.getRefCount("contact", "1")).toBeUndefined();
  });
});
