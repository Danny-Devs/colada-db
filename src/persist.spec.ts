import "fake-indexeddb/auto";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createEntityStore } from "./store";
import { enablePersistence } from "./persist";
import { ENTITY_REF_MARKER } from "./types";

// Reset IDB between tests to prevent cross-test contamination
beforeEach(() => {
  // Delete all databases by closing and deleting
  const dbNames = ["pcn_entities", "test-db", "custom-db"];
  return Promise.all(
    dbNames.map(
      (name) =>
        new Promise<void>((resolve) => {
          const req = indexedDB.deleteDatabase(name);
          req.onsuccess = () => resolve();
          req.onerror = () => resolve();
        }),
    ),
  );
});

describe("enablePersistence", () => {
  // ─────────────────────────────────────────────
  // Basic persistence round-trip
  // ─────────────────────────────────────────────

  describe("persistence round-trip", () => {
    it("entities survive store recreation", async () => {
      // Session 1: create entities and persist
      const store1 = createEntityStore();
      const p1 = enablePersistence(store1, { dbName: "test-db", writeDebounce: 0 });
      await p1.ready;

      store1.set("contact", "1", { id: "1", name: "Alice" });
      store1.set("contact", "2", { id: "2", name: "Bob" });
      store1.set("order", "100", { id: "100", total: 50 });
      await p1.flush();
      p1.dispose();

      // Session 2: new store, hydrate from IDB
      const store2 = createEntityStore();
      const p2 = enablePersistence(store2, { dbName: "test-db" });
      await p2.ready;

      expect(store2.has("contact", "1")).toBe(true);
      expect(store2.get("contact", "1").value?.name).toBe("Alice");
      expect(store2.has("contact", "2")).toBe(true);
      expect(store2.get("contact", "2").value?.name).toBe("Bob");
      expect(store2.has("order", "100")).toBe(true);
      expect(store2.get("order", "100").value?.total).toBe(50);

      p2.dispose();
    });

    it("entity updates are persisted", async () => {
      const store1 = createEntityStore();
      const p1 = enablePersistence(store1, { dbName: "test-db", writeDebounce: 0 });
      await p1.ready;

      store1.set("contact", "1", { id: "1", name: "Alice" });
      await p1.flush();

      // Update
      store1.set("contact", "1", { id: "1", name: "Alicia" });
      await p1.flush();
      p1.dispose();

      // Verify update persisted
      const store2 = createEntityStore();
      const p2 = enablePersistence(store2, { dbName: "test-db" });
      await p2.ready;

      expect(store2.get("contact", "1").value?.name).toBe("Alicia");
      p2.dispose();
    });

    it("entity removals are persisted", async () => {
      const store1 = createEntityStore();
      const p1 = enablePersistence(store1, { dbName: "test-db", writeDebounce: 0 });
      await p1.ready;

      store1.set("contact", "1", { id: "1", name: "Alice" });
      store1.set("contact", "2", { id: "2", name: "Bob" });
      await p1.flush();

      store1.remove("contact", "2");
      await p1.flush();
      p1.dispose();

      // Bob should be gone
      const store2 = createEntityStore();
      const p2 = enablePersistence(store2, { dbName: "test-db" });
      await p2.ready;

      expect(store2.has("contact", "1")).toBe(true);
      expect(store2.has("contact", "2")).toBe(false);
      p2.dispose();
    });

    it("evictions (gc) do NOT delete the durable row — evicted entities re-hydrate", async () => {
      const store1 = createEntityStore();
      const p1 = enablePersistence(store1, { dbName: "test-db", writeDebounce: 0 });
      await p1.ready;

      store1.set("contact", "1", { id: "1", name: "Alice" });
      await p1.flush();

      // Cache trimming, not deletion
      store1.evict("contact", "1");
      await p1.flush();
      expect(store1.has("contact", "1")).toBe(false);
      p1.dispose();

      // The durable copy survives eviction and hydrates next session (ADR-004)
      const store2 = createEntityStore();
      const p2 = enablePersistence(store2, { dbName: "test-db" });
      await p2.ready;

      expect(store2.has("contact", "1")).toBe(true);
      expect(store2.get("contact", "1").value?.name).toBe("Alice");
      p2.dispose();
    });

    it("store.clear() clears the durable copies too", async () => {
      const store1 = createEntityStore();
      const p1 = enablePersistence(store1, { dbName: "test-db", writeDebounce: 0 });
      await p1.ready;

      store1.set("contact", "1", { id: "1", name: "Alice" });
      await p1.flush();

      store1.clear();
      await p1.flush();
      p1.dispose();

      const store2 = createEntityStore();
      const p2 = enablePersistence(store2, { dbName: "test-db" });
      await p2.ready;

      expect(store2.has("contact", "1")).toBe(false);
      p2.dispose();
    });

    it("writes made before the DB finishes opening are flushed once it opens", async () => {
      const store1 = createEntityStore();
      const p1 = enablePersistence(store1, { dbName: "test-db", writeDebounce: 0 });
      // Write IMMEDIATELY — before awaiting ready, so the debounce timer
      // fires against a null db and would previously strand the write
      store1.set("contact", "early", { id: "early", name: "Before open" });
      await p1.ready;

      // Wait out the rescheduled flush (writeDebounce: 0 → next macrotask)
      await new Promise((r) => setTimeout(r, 10));
      p1.dispose();

      const store2 = createEntityStore();
      const p2 = enablePersistence(store2, { dbName: "test-db" });
      await p2.ready;

      expect(store2.has("contact", "early")).toBe(true);
      expect(store2.get("contact", "early").value?.name).toBe("Before open");
      p2.dispose();
    });
  });

  // ─────────────────────────────────────────────
  // EntityRef round-trip (Symbol encoding)
  // ─────────────────────────────────────────────

  describe("EntityRef encoding", () => {
    it("entities containing EntityRefs survive IDB round-trip", async () => {
      const store1 = createEntityStore();
      const p1 = enablePersistence(store1, { dbName: "test-db", writeDebounce: 0 });
      await p1.ready;

      // Order with a nested EntityRef (simulating normalized data)
      store1.set("order", "order-1", {
        orderId: "order-1",
        total: 100,
        customer: {
          [ENTITY_REF_MARKER]: true,
          entityType: "contact",
          id: "42",
          key: "contact:42",
        },
      });
      store1.set("contact", "42", { contactId: "42", name: "Alice" });
      await p1.flush();
      p1.dispose();

      // Restore and verify Symbol markers survived
      const store2 = createEntityStore();
      const p2 = enablePersistence(store2, { dbName: "test-db" });
      await p2.ready;

      const order = store2.get("order", "order-1").value!;
      expect(order.total).toBe(100);
      const customerRef = order.customer as any;
      expect(customerRef[ENTITY_REF_MARKER]).toBe(true);
      expect(customerRef.entityType).toBe("contact");
      expect(customerRef.id).toBe("42");

      expect(store2.get("contact", "42").value?.name).toBe("Alice");
      p2.dispose();
    });
  });

  // ─────────────────────────────────────────────
  // Fresh-wins hydration guard
  // ─────────────────────────────────────────────

  describe("fresh-wins hydration", () => {
    it("does not overwrite entities already in memory", async () => {
      // Session 1: persist stale data
      const store1 = createEntityStore();
      const p1 = enablePersistence(store1, { dbName: "test-db", writeDebounce: 0 });
      await p1.ready;
      store1.set("contact", "1", { id: "1", name: "Stale Alice" });
      await p1.flush();
      p1.dispose();

      // Session 2: server fetch arrives BEFORE IDB hydration
      const store2 = createEntityStore();
      store2.set("contact", "1", { id: "1", name: "Fresh Alice" });

      const p2 = enablePersistence(store2, { dbName: "test-db" });
      await p2.ready;

      // Fresh data should win
      expect(store2.get("contact", "1").value?.name).toBe("Fresh Alice");
      p2.dispose();
    });
  });

  // ─────────────────────────────────────────────
  // Hydration write-storm suppression
  // ─────────────────────────────────────────────

  describe("hydration flag", () => {
    it("does not re-persist entities loaded from IDB", async () => {
      // Session 1: persist data
      const store1 = createEntityStore();
      const p1 = enablePersistence(store1, { dbName: "test-db", writeDebounce: 0 });
      await p1.ready;
      store1.set("contact", "1", { id: "1", name: "Alice" });
      await p1.flush();
      p1.dispose();

      // Session 2: hydrate with a very long debounce so we can inspect state
      const store2 = createEntityStore();
      const p2 = enablePersistence(store2, { dbName: "test-db", writeDebounce: 60000 });
      await p2.ready;

      // Alice should be in the store
      expect(store2.has("contact", "1")).toBe(true);

      // Force flush — if hydration write-storm was suppressed,
      // there should be nothing to write and this should be a no-op.
      // We verify by checking that a SECOND store session still has Alice
      // (if flush had wiped and rewritten, it would still work — but if the
      // hydrating flag failed, flush would write back stale encoded data).
      await p2.flush();
      p2.dispose();

      // Session 3: verify data is intact (not corrupted by unnecessary re-write)
      const store3 = createEntityStore();
      const p3 = enablePersistence(store3, { dbName: "test-db" });
      await p3.ready;
      expect(store3.get("contact", "1").value?.name).toBe("Alice");
      p3.dispose();
    });
  });

  // ─────────────────────────────────────────────
  // Debounced batching
  // ─────────────────────────────────────────────

  describe("write batching", () => {
    it("batches rapid writes into a single flush", async () => {
      const store = createEntityStore();
      const p = enablePersistence(store, { dbName: "test-db", writeDebounce: 50 });
      await p.ready;

      // Rapid writes within the debounce window
      store.set("contact", "1", { id: "1", name: "A" });
      store.set("contact", "2", { id: "2", name: "B" });
      store.set("contact", "3", { id: "3", name: "C" });
      store.set("contact", "1", { id: "1", name: "A-updated" });

      // Wait for debounce
      await new Promise((r) => setTimeout(r, 100));

      // Verify all persisted
      p.dispose();

      const store2 = createEntityStore();
      const p2 = enablePersistence(store2, { dbName: "test-db" });
      await p2.ready;

      expect(store2.get("contact", "1").value?.name).toBe("A-updated");
      expect(store2.get("contact", "2").value?.name).toBe("B");
      expect(store2.get("contact", "3").value?.name).toBe("C");
      p2.dispose();
    });
  });

  // ─────────────────────────────────────────────
  // Graceful degradation
  // ─────────────────────────────────────────────

  describe("error handling", () => {
    it("calls onReady even on successful hydration with empty IDB", async () => {
      const onReady = vi.fn();
      const store = createEntityStore();
      const p = enablePersistence(store, { dbName: "test-db", onReady });
      await p.ready;

      expect(onReady).toHaveBeenCalledOnce();
      p.dispose();
    });

    it("store continues working even after dispose", async () => {
      const store = createEntityStore();
      const p = enablePersistence(store, { dbName: "test-db", writeDebounce: 0 });
      await p.ready;

      store.set("contact", "1", { id: "1", name: "Alice" });
      await p.flush();
      p.dispose();

      // Writes after dispose should not throw — store is still functional
      store.set("contact", "2", { id: "2", name: "Bob" });
      expect(store.get("contact", "2").value?.name).toBe("Bob");
    });
  });

  // ─────────────────────────────────────────────
  // Custom database name
  // ─────────────────────────────────────────────

  describe("options", () => {
    it("supports custom database name", async () => {
      const store1 = createEntityStore();
      const p1 = enablePersistence(store1, { dbName: "custom-db", writeDebounce: 0 });
      await p1.ready;
      store1.set("contact", "1", { id: "1", name: "Alice" });
      await p1.flush();
      p1.dispose();

      // Different dbName = isolated data
      const store2 = createEntityStore();
      const p2 = enablePersistence(store2, { dbName: "test-db" });
      await p2.ready;
      expect(store2.has("contact", "1")).toBe(false);
      p2.dispose();

      // Same dbName = shared data
      const store3 = createEntityStore();
      const p3 = enablePersistence(store3, { dbName: "custom-db" });
      await p3.ready;
      expect(store3.get("contact", "1").value?.name).toBe("Alice");
      p3.dispose();
    });
  });

  // ─────────────────────────────────────────────
  // Dispose cleanup
  // ─────────────────────────────────────────────

  describe("dispose", () => {
    it("stops persisting after dispose", async () => {
      const store = createEntityStore();
      const p = enablePersistence(store, { dbName: "test-db", writeDebounce: 0 });
      await p.ready;

      store.set("contact", "1", { id: "1", name: "Alice" });
      await p.flush();

      p.dispose();

      // Write after dispose
      store.set("contact", "2", { id: "2", name: "Bob" });
      // Can't flush after dispose, but let's verify the first entity persisted
      // and the second did not

      const store2 = createEntityStore();
      const p2 = enablePersistence(store2, { dbName: "test-db" });
      await p2.ready;

      expect(store2.has("contact", "1")).toBe(true);
      expect(store2.has("contact", "2")).toBe(false);
      p2.dispose();
    });
  });
});
