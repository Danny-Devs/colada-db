/**
 * Schema export suite (DAN-577 scope item 4 / ADR-007 §4): a sample
 * registry's declared relations + flags appear in the export; the result
 * is JSON-pure; functions surface as capability flags only.
 */
import { describe, expect, it } from "vitest";
import { defineEntity } from "./types";
import { exportSchema } from "./schema";

describe("exportSchema", () => {
  const registry = {
    contact: defineEntity({
      idField: "contactId",
      description: "A person in the address book",
      fields: {
        contactId: "string",
        name: { type: "string", description: "Display name" },
        age: "number",
      },
      relations: {
        company: { entity: "company", description: "Employer" },
        friends: { entity: "contact", many: true },
      },
    }),
    draft: defineEntity({
      idField: "id",
      local: true, // never syncs
      merge: (existing, incoming) => ({ ...existing, ...incoming }),
    }),
    session: defineEntity({
      getId: (e) => (e.token == null ? undefined : String(e.token)),
    }),
    bare: defineEntity({}),
  };

  it("declared fields, relations, and flags appear in the export", () => {
    const schema = exportSchema(registry);

    const contact = schema.entities.contact;
    expect(contact.idField).toBe("contactId");
    expect(contact.description).toBe("A person in the address book");
    expect(contact.fields.name).toEqual({ type: "string", description: "Display name" });
    expect(contact.fields.age).toEqual({ type: "number" });
    expect(contact.relations.company).toEqual({ entity: "company", many: false, description: "Employer" });
    expect(contact.relations.friends).toEqual({ entity: "contact", many: true });

    expect(schema.entities.draft.local).toBe(true);
    expect(schema.entities.contact.local).toBe(false);
  });

  it("functions export as capability flags, never as values", () => {
    const schema = exportSchema(registry);
    expect(schema.entities.draft.customMerge).toBe(true);
    expect(schema.entities.session.computedId).toBe(true);
    expect(schema.entities.session.idField).toBeNull(); // computed — no static field
    expect(JSON.stringify(schema)).not.toContain("=>"); // no function leakage
  });

  it("undeclared types export a minimal valid entry; convention default is echoed", () => {
    const schema = exportSchema(registry, { defaultIdField: "uuid" });
    expect(schema.defaultIdField).toBe("uuid");
    expect(schema.entities.bare).toEqual({
      idField: null,
      computedId: false,
      customMerge: false,
      local: false,
      fields: {},
      relations: {},
    });
  });

  it("the export is JSON-pure — survives a stringify round-trip unchanged", () => {
    const schema = exportSchema(registry);
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
  });
});
