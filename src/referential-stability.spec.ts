/**
 * Scar-tissue regression suite: referential stability (Track A1,
 * HARDENING-2026-07).
 *
 * The bug class that bit Dexie 4's cache middleware in production
 * (dexie/Dexie.js #2034 — "useLiveQuery losing items reference": unchanged
 * rows came back as NEW object instances after unrelated in-transaction
 * updates, breaking === downstream and re-rendering everything).
 *
 * colada-db's contract: an entity object a consumer holds stays `===`
 * unless THAT entity semantically changed. This suite pins the contract
 * at the store and denormalize layers. The optimistic-transaction
 * rollback leg (Dexie #2058 class) joins when chip 2.5 moves the
 * transaction system into the core.
 */
import { describe, expect, it } from "vitest";
import { createEntityStore } from "./store";
import { normalize, denormalize } from "./normalize";
import { defineEntity } from "./types";

describe("referential stability (scar-tissue: Dexie #2034 class)", () => {
  it("an entity's data object stays === across writes to OTHER entities", () => {
    const store = createEntityStore();
    store.set("contact", "1", { id: "1", name: "Alice" });
    const before = store.get("contact", "1").value;

    store.set("contact", "2", { id: "2", name: "Bob" });
    store.set("order", "9", { id: "9", total: 100 });
    store.remove("order", "9");

    expect(store.get("contact", "1").value).toBe(before);
  });

  it("a no-op write (identical data) preserves identity AND emits no event", () => {
    const store = createEntityStore();
    store.set("contact", "1", { id: "1", name: "Alice" });
    const before = store.get("contact", "1").value;

    let events = 0;
    const off = store.subscribe(() => events++);
    store.set("contact", "1", { id: "1", name: "Alice" });
    off();

    expect(store.get("contact", "1").value).toBe(before);
    expect(events).toBe(0);
  });

  it("a real change to one entity does NOT reissue identities of its neighbors", () => {
    const store = createEntityStore();
    store.set("contact", "1", { id: "1", name: "Alice" });
    store.set("contact", "2", { id: "2", name: "Bob" });
    const bobBefore = store.get("contact", "2").value;

    store.set("contact", "1", { id: "1", name: "Alicia" });

    expect(store.get("contact", "2").value).toBe(bobBefore);
    expect(store.get("contact", "1").value?.name).toBe("Alicia");
  });

  it("denormalize with a structural-sharing cache returns the SAME result object for unchanged entities", () => {
    const store = createEntityStore();
    const defs = { contact: defineEntity({ idField: "id" }) };
    const { normalized, entities } = normalize(
      { data: [{ id: "1", name: "Alice", __typename: "contact" }] },
      defs,
      "id",
    );
    for (const e of entities) store.set(e.entityType, e.id, e.data);

    const cache = new Map();
    const first = denormalize(normalized, store, cache);
    // Unrelated write — Alice untouched
    store.set("order", "9", { id: "9", total: 100 });
    const second = denormalize(normalized, store, cache);

    expect((second as { data: unknown[] }).data[0]).toBe(
      (first as { data: unknown[] }).data[0],
    );
  });

  it("denormalize re-materializes ONLY the changed entity, neighbors keep identity", () => {
    const store = createEntityStore();
    const defs = { contact: defineEntity({ idField: "id" }) };
    const { normalized, entities } = normalize(
      {
        data: [
          { id: "1", name: "Alice", __typename: "contact" },
          { id: "2", name: "Bob", __typename: "contact" },
        ],
      },
      defs,
      "id",
    );
    for (const e of entities) store.set(e.entityType, e.id, e.data);

    const cache = new Map();
    const first = denormalize(normalized, store, cache) as { data: Array<{ name: string }> };

    store.set("contact", "1", { id: "1", name: "Alicia" });
    const second = denormalize(normalized, store, cache) as { data: Array<{ name: string }> };

    expect(second.data[0].name).toBe("Alicia");
    expect(second.data[0]).not.toBe(first.data[0]); // changed → new object
    expect(second.data[1]).toBe(first.data[1]); // untouched neighbor → SAME object
  });

  it("evict empties live holders (no stale ghosts); revival is the computed-re-read pattern's job", async () => {
    const { computed } = await import("@vue/reactivity");
    const store = createEntityStore();
    store.set("contact", "1", { id: "1", name: "Alice" });

    // The layered contract: a RAW ref from get() sees the eviction and is
    // then done — evict frees the ref (that's the point of eviction).
    const raw = store.get("contact", "1");
    // Consumers that must survive evict/re-add re-read through get() each
    // evaluation (the useEntityRef shape) — that view revives.
    const view = computed(() => store.get("contact", "1").value);
    expect(view.value?.name).toBe("Alice");

    store.evict("contact", "1"); // cache trim, not deletion (ADR-004)
    expect(raw.value).toBeUndefined(); // holder SEES the eviction — no stale ghost
    expect(view.value).toBeUndefined();

    store.set("contact", "1", { id: "1", name: "Alice" });
    expect(raw.value).toBeUndefined(); // raw ref stays dead — by design
    expect(view.value?.name).toBe("Alice"); // re-reading view revives
  });
});
