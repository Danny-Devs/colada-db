import { describe, expect, it } from "vitest";
import { normalize, denormalize } from "./normalize";
import { defineEntity, ENTITY_REF_MARKER } from "./types";
import { createEntityStore } from "./store";

describe("normalize", () => {
  describe("with explicit entity definitions", () => {
    const entityDefs = {
      contact: defineEntity({ idField: "contactId" }),
      order: defineEntity({ idField: "orderId" }),
    };

    it("extracts a single entity and replaces with reference", () => {
      const data = { contactId: "42", name: "Alice", email: "alice@test.com" };
      const result = normalize(data, entityDefs, "id");

      expect(result.entities).toHaveLength(1);
      expect(result.entities[0]).toEqual({
        entityType: "contact",
        id: "42",
        data: { contactId: "42", name: "Alice", email: "alice@test.com" },
      });
      expect(result.normalized).toEqual({
        [ENTITY_REF_MARKER]: true,
        entityType: "contact",
        id: "42",
        key: "contact:42",
      });
    });

    it("extracts entities from an array", () => {
      const data = [
        { contactId: "1", name: "Alice" },
        { contactId: "2", name: "Bob" },
      ];
      const result = normalize(data, entityDefs, "id");

      expect(result.entities).toHaveLength(2);
      expect(result.entities[0].id).toBe("1");
      expect(result.entities[1].id).toBe("2");
      expect(result.normalized).toEqual([
        { [ENTITY_REF_MARKER]: true, entityType: "contact", id: "1", key: "contact:1" },
        { [ENTITY_REF_MARKER]: true, entityType: "contact", id: "2", key: "contact:2" },
      ]);
    });

    it("extracts nested entities within other entities", () => {
      const data = {
        orderId: "order-1",
        total: 100,
        customer: { contactId: "42", name: "Alice" },
      };
      const result = normalize(data, entityDefs, "id");

      expect(result.entities).toHaveLength(2);
      // Contact extracted first (inner), then order (outer)
      const contactEntity = result.entities.find((e) => e.entityType === "contact");
      const orderEntity = result.entities.find((e) => e.entityType === "order");
      expect(contactEntity).toBeDefined();
      expect(orderEntity).toBeDefined();
      // Order's customer field should be a reference
      expect((orderEntity!.data as any).customer).toEqual({
        [ENTITY_REF_MARKER]: true,
        entityType: "contact",
        id: "42",
        key: "contact:42",
      });
    });

    it("leaves non-entity objects untouched", () => {
      const data = {
        contactId: "42",
        name: "Alice",
        address: { street: "123 Main", city: "Portland" },
      };
      const result = normalize(data, entityDefs, "id");

      expect(result.entities).toHaveLength(1);
      // Address has no entity definition match, stays inline in the entity
      expect(result.entities[0].data).toEqual({
        contactId: "42",
        name: "Alice",
        address: { street: "123 Main", city: "Portland" },
      });
    });

    it("handles mixed data with entities and non-entities", () => {
      const data = {
        contacts: [
          { contactId: "1", name: "Alice" },
          { contactId: "2", name: "Bob" },
        ],
        pagination: { page: 1, total: 10 },
      };
      const result = normalize(data, entityDefs, "id");

      expect(result.entities).toHaveLength(2);
      // pagination stays as-is (no matching entity def)
      expect((result.normalized as any).pagination).toEqual({ page: 1, total: 10 });
    });
  });

  describe("with convention-based detection (__typename)", () => {
    it("auto-detects entities with __typename + id", () => {
      const data = { __typename: "User", id: "1", name: "Alice" };
      const result = normalize(data, {}, "id");

      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].entityType).toBe("User");
      expect(result.entities[0].id).toBe("1");
    });

    it("does NOT auto-detect entities with just id (no __typename)", () => {
      // This is the Issue #7/#11 fix — no generic 'entity' fallback
      const data = { id: "1", name: "Alice" };
      const result = normalize(data, {}, "id");

      expect(result.entities).toHaveLength(0);
      // Data is returned as-is, not normalized
      expect(result.normalized).toEqual({ id: "1", name: "Alice" });
    });
  });

  describe("with getId function", () => {
    it("supports custom ID extraction", () => {
      const entityDefs = {
        member: defineEntity({
          getId: (entity) => `${entity.orgId}-${entity.userId}`,
        }),
      };
      const data = { orgId: "acme", userId: "42", name: "Alice" };
      const result = normalize(data, entityDefs, "id");

      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].id).toBe("acme-42");
      expect(result.entities[0].entityType).toBe("member");
    });
  });

  describe("edge cases", () => {
    it("handles null data", () => {
      const result = normalize(null, {}, "id");
      expect(result.entities).toHaveLength(0);
      expect(result.normalized).toBeNull();
    });

    it("handles undefined data", () => {
      const result = normalize(undefined, {}, "id");
      expect(result.entities).toHaveLength(0);
      expect(result.normalized).toBeUndefined();
    });

    it("handles primitive data", () => {
      expect(normalize(42, {}, "id").normalized).toBe(42);
      expect(normalize("hello", {}, "id").normalized).toBe("hello");
      expect(normalize(true, {}, "id").normalized).toBe(true);
    });

    it("handles empty arrays", () => {
      const result = normalize([], {}, "id");
      expect(result.entities).toHaveLength(0);
      expect(result.normalized).toEqual([]);
    });

    it("handles empty objects", () => {
      const result = normalize({}, {}, "id");
      expect(result.entities).toHaveLength(0);
      expect(result.normalized).toEqual({});
    });

    it("handles circular references without infinite loop", () => {
      const _entityDefs = {
        user: defineEntity({ idField: "id" }),
      };
      // Can't use defineEntity auto-detect here since 'id' needs __typename
      // But test the circular ref protection with __typename
      const user: any = { __typename: "user", id: "1", name: "Alice" };
      user.self = user; // circular reference

      const result = normalize(user, {}, "id");
      // Should not throw or infinite loop
      expect(result.entities.length).toBeGreaterThanOrEqual(1);
    });

    it("handles deeply nested structures", () => {
      const entityDefs = {
        item: defineEntity({ idField: "itemId" }),
      };
      const data = {
        level1: {
          level2: {
            level3: {
              items: [{ itemId: "1", name: "deep item" }],
            },
          },
        },
      };
      const result = normalize(data, entityDefs, "id");
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].entityType).toBe("item");
    });

    it("uses Symbol marker for EntityRef (not string property)", () => {
      const entityDefs = {
        contact: defineEntity({ idField: "contactId" }),
      };
      const data = { contactId: "1", name: "Alice" };
      const result = normalize(data, entityDefs, "id");

      const ref = result.normalized as any;
      // Symbol marker exists
      expect(ref[ENTITY_REF_MARKER]).toBe(true);
      // No string __entityRef property (old pattern)
      expect(ref.__entityRef).toBeUndefined();
    });

    it("does not confuse API data that has __entityRef with entity refs", () => {
      // Issue #13 — API data with __entityRef: true should NOT be treated as a ref
      const data = { __entityRef: true, someField: "value" };
      const result = normalize(data, {}, "id");

      // Should pass through as-is (no Symbol marker)
      expect(result.normalized).toEqual(data);
      expect(result.entities).toHaveLength(0);
    });
  });
});

describe("denormalize", () => {
  it("replaces entity references with store data", () => {
    const store = createEntityStore();
    store.set("contact", "42", { contactId: "42", name: "Alice" });

    const normalized = {
      [ENTITY_REF_MARKER]: true,
      entityType: "contact",
      id: "42",
      key: "contact:42",
    };
    const result = denormalize(normalized, store);
    expect(result).toEqual({ contactId: "42", name: "Alice" });
  });

  it("denormalizes arrays of references", () => {
    const store = createEntityStore();
    store.set("contact", "1", { id: "1", name: "Alice" });
    store.set("contact", "2", { id: "2", name: "Bob" });

    const normalized = [
      { [ENTITY_REF_MARKER]: true, entityType: "contact", id: "1", key: "contact:1" },
      { [ENTITY_REF_MARKER]: true, entityType: "contact", id: "2", key: "contact:2" },
    ];
    const result = denormalize(normalized, store) as any[];
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("Alice");
    expect(result[1].name).toBe("Bob");
  });

  it("preserves non-entity data alongside references", () => {
    const store = createEntityStore();
    store.set("contact", "1", { id: "1", name: "Alice" });

    const normalized = {
      contacts: [{ [ENTITY_REF_MARKER]: true, entityType: "contact", id: "1", key: "contact:1" }],
      pagination: { page: 1, total: 10 },
    };
    const result = denormalize(normalized, store) as any;
    expect(result.contacts[0].name).toBe("Alice");
    expect(result.pagination).toEqual({ page: 1, total: 10 });
  });

  it("returns undefined for missing entities", () => {
    const store = createEntityStore();
    const normalized = {
      [ENTITY_REF_MARKER]: true,
      entityType: "contact",
      id: "999",
      key: "contact:999",
    };
    const result = denormalize(normalized, store);
    expect(result).toBeUndefined();
  });

  it("passes through primitives", () => {
    const store = createEntityStore();
    expect(denormalize(null, store)).toBeNull();
    expect(denormalize(42, store)).toBe(42);
    expect(denormalize("hello", store)).toBe("hello");
  });

  it("resolves same entity referenced from multiple paths (no cache)", () => {
    const store = createEntityStore();
    // org:5 has a nested EntityRef (simulating normalized nested data)
    store.set("org", "5", { orgId: "5", name: "Acme Corp" });
    store.set("contact", "1", {
      id: "1",
      name: "Alice",
      org: { [ENTITY_REF_MARKER]: true, entityType: "org", id: "5", key: "org:5" },
    });
    store.set("contact", "2", {
      id: "2",
      name: "Bob",
      org: { [ENTITY_REF_MARKER]: true, entityType: "org", id: "5", key: "org:5" },
    });

    // Two refs to different contacts, each referencing the SAME org entity
    const normalized = [
      { [ENTITY_REF_MARKER]: true, entityType: "contact", id: "1", key: "contact:1" },
      { [ENTITY_REF_MARKER]: true, entityType: "contact", id: "2", key: "contact:2" },
    ];

    // Denormalize WITHOUT cache — the visited set backtracking must allow
    // org:5 to be fully resolved for both contacts
    const result = denormalize(normalized, store) as any[];
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("Alice");
    expect(result[0].org.name).toBe("Acme Corp"); // org resolved for contact 1
    expect(result[1].name).toBe("Bob");
    expect(result[1].org.name).toBe("Acme Corp"); // org also resolved for contact 2
  });

  it("still handles circular references without infinite loop", () => {
    const store = createEntityStore();
    // Create a circular reference: contact references itself via a nested ref
    store.set("contact", "1", {
      id: "1",
      name: "Alice",
      bestFriend: { [ENTITY_REF_MARKER]: true, entityType: "contact", id: "1", key: "contact:1" },
    });

    const normalized = {
      [ENTITY_REF_MARKER]: true,
      entityType: "contact",
      id: "1",
      key: "contact:1",
    };

    // Should not infinite loop — circular ref returns the entity as-is
    const result = denormalize(normalized, store) as any;
    expect(result.name).toBe("Alice");
    // bestFriend is the same entity object (circular) — returned as-is by visited check
  });
});
