/**
 * Done-defining suite for the read-only MCP agent surface (DAN-580).
 * Test ids (T1–T29) map 1:1 to docs/design/mcp-agent-surface.md — the
 * list was written and committed before this implementation existed.
 *
 * Every test drives the REAL protocol: official SDK Client ↔ Server over
 * an `InMemoryTransport` linked pair (initialize handshake, JSON-RPC
 * framing, schema validation) — no mocks.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createEntityStore, createStoreBoundary, enableHistory } from "colada-db";
import type { EntityDefinition, EntityStore, HistoryStore, StoreBoundary } from "colada-db";
import {
  AgentSurfaceConfigError,
  createColadaDbMcpServer,
  HISTORY_TOOL_NAME,
  QUERY_TOOL_NAME,
  SCHEMA_RESOURCE_URI,
  UNTRUSTED_META_KEY,
} from "./server";
import type { ColadaDbMcpServerOptions } from "./server";

// ─────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────

/** Declared registry: two allowlisted types, one hidden type (leak bait). */
function makeEntityDefs(): Record<string, EntityDefinition> {
  return {
    contact: {
      idField: "id",
      description: "A person",
      fields: { id: "string", name: "string", status: "string", age: "number" },
      relations: {
        org: { entity: "organization", many: false },
        // Leak bait: relation from a VISIBLE type to the hidden type.
        vault: { entity: "vaultSecret", many: false },
      },
    },
    organization: {
      idField: "id",
      fields: { id: "string", title: "string" },
    },
    vaultSecret: {
      idField: "id",
      local: true,
      fields: { id: "string", apiToken: "string", refreshToken: "string" },
    },
  };
}

function seed(store: EntityStore): void {
  store.set("contact", "1", { id: "1", name: "Alice", status: "active", age: 30 });
  store.set("contact", "2", { id: "2", name: "Bob", status: "active", age: 25 });
  store.set("contact", "3", { id: "3", name: "Cleo", status: "archived", age: 41 });
  store.set("organization", "o1", { id: "o1", title: "Acme" });
  store.set("vaultSecret", "s1", { id: "s1", apiToken: "TOP-SECRET-TOKEN", refreshToken: "RT" });
  store.set("note", "n1", { id: "n1", body: "undeclared but allowlisted" });
}

interface Harness {
  client: Client;
  store: EntityStore;
  boundary: StoreBoundary;
  history: HistoryStore | undefined;
  entityDefs: Record<string, EntityDefinition>;
}

async function setup(
  overrides: Partial<ColadaDbMcpServerOptions> & { withHistory?: boolean; seeded?: boolean } = {},
): Promise<Harness> {
  const { withHistory = true, seeded = true, ...optionOverrides } = overrides;
  const store = createEntityStore();
  const boundary = createStoreBoundary(store);
  const history = withHistory ? enableHistory(store) : undefined;
  if (seeded) seed(store);
  const entityDefs = makeEntityDefs();
  const server = createColadaDbMcpServer({
    boundary,
    entityDefs,
    allowedTypes: ["contact", "organization", "note"],
    history,
    serverInfo: { name: "test-surface", version: "9.9.9" },
    ...optionOverrides,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-agent", version: "0.0.1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, store, boundary, history, entityDefs };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyResult = any;

function envelopeOf(result: AnyResult): AnyResult {
  expect(result.isError ?? false).toBe(false);
  return JSON.parse(result.content[0].text);
}

function refusalOf(result: AnyResult): AnyResult {
  expect(result.isError).toBe(true);
  return JSON.parse(result.content[0].text).error;
}

const WRITE_SHAPED_NAME =
  /write|set|update|delete|create|mutate|remove|insert|upsert|patch|put|post|exec|apply/i;

// ─────────────────────────────────────────────
// Topology & deny-by-default (T1–T7)
// ─────────────────────────────────────────────

describe("topology and deny-by-default", () => {
  it("T1: connects over a linked InMemoryTransport pair and identifies itself", async () => {
    const { client } = await setup();
    expect(client.getServerVersion()).toMatchObject({ name: "test-surface", version: "9.9.9" });
  });

  it("T2: with history, the tool list is EXACTLY query + history", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([HISTORY_TOOL_NAME, QUERY_TOOL_NAME].sort());
  });

  it("T3: no tool name is write-shaped (structural deny-by-default)", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.name).not.toMatch(WRITE_SHAPED_NAME);
    }
  });

  it("T4: without history, the tool list is EXACTLY the query tool", async () => {
    const { client } = await setup({ withHistory: false });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([QUERY_TOOL_NAME]);
  });

  it("T5: the resource list is exactly the schema resource", async () => {
    const { client } = await setup();
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual([SCHEMA_RESOURCE_URI]);
  });

  it("T6: write-shaped tool calls reject as unknown tools and the store is untouched", async () => {
    const { client, boundary } = await setup();
    const before = JSON.stringify(boundary.getEntities("contact"));
    for (const name of [
      "write_entity",
      "set_entity",
      "update_entities",
      "delete_entity",
      "create_entity",
    ]) {
      await expect(
        client.callTool({ name, arguments: { entityType: "contact", id: "1", data: {} } }),
      ).rejects.toThrow(/unknown tool/i);
    }
    expect(JSON.stringify(boundary.getEntities("contact"))).toBe(before);
  });

  it("T7: declared capabilities are tools + resources only", async () => {
    const { client } = await setup();
    const caps = client.getServerCapabilities() ?? {};
    expect(caps).toHaveProperty("tools");
    expect(caps).toHaveProperty("resources");
    expect(caps).not.toHaveProperty("prompts");
    expect(caps).not.toHaveProperty("completions");
  });
});

// ─────────────────────────────────────────────
// Schema resource (T8–T12)
// ─────────────────────────────────────────────

describe("schema resource", () => {
  async function readSchema(client: Client): Promise<{ text: string; schema: AnyResult }> {
    const result = await client.readResource({ uri: SCHEMA_RESOURCE_URI });
    const text = (result.contents[0] as { text: string }).text;
    return { text, schema: JSON.parse(text) };
  }

  it("T8: serves the allowlisted declared types with fields, relations, and flags", async () => {
    const { client } = await setup();
    const { schema } = await readSchema(client);
    expect(schema.version).toBe(1);
    expect(schema.entities.contact.fields.name).toEqual({ type: "string" });
    expect(schema.entities.contact.local).toBe(false);
    expect(schema.entities.organization.fields.title).toEqual({ type: "string" });
    expect(schema.entities.contact.relations.org).toEqual({ entity: "organization", many: false });
  });

  it("T9: leaks NOTHING about non-allowlisted types — no type name, no field names", async () => {
    const { client } = await setup();
    const { text } = await readSchema(client);
    expect(text).not.toContain("vaultSecret");
    expect(text).not.toContain("apiToken");
    expect(text).not.toContain("refreshToken");
  });

  it("T10: scrubs relations that TARGET a non-allowlisted type", async () => {
    const { client } = await setup();
    const { schema, text } = await readSchema(client);
    expect(schema.entities.contact.relations.vault).toBeUndefined();
    expect(text).not.toContain("vault");
  });

  it("T11: is a creation-time snapshot — later registry mutation changes nothing", async () => {
    const { client, entityDefs } = await setup();
    entityDefs.contact.fields = { smuggled: "string" };
    (entityDefs as Record<string, EntityDefinition>).lateType = { idField: "id" };
    const { text, schema } = await readSchema(client);
    expect(text).not.toContain("smuggled");
    expect(text).not.toContain("lateType");
    expect(schema.entities.contact.fields.name).toBeDefined();
  });

  it("T12: an allowlisted-but-undeclared type is absent from the schema yet queryable", async () => {
    const { client } = await setup();
    const { schema } = await readSchema(client);
    expect(schema.entities.note).toBeUndefined();
    const result = await client.callTool({
      name: QUERY_TOOL_NAME,
      arguments: { entityType: "note" },
    });
    const envelope = envelopeOf(result);
    expect(envelope.count).toBe(1);
    expect(envelope.entities[0].id).toBe("n1");
  });
});

// ─────────────────────────────────────────────
// query_entities (T13–T22)
// ─────────────────────────────────────────────

describe("query_entities", () => {
  it("T13: unfiltered query returns the type's projection, honestly scoped", async () => {
    const { client } = await setup();
    const result = await client.callTool({
      name: QUERY_TOOL_NAME,
      arguments: { entityType: "contact" },
    });
    const envelope = envelopeOf(result);
    expect(envelope.untrusted).toBe(true);
    expect(envelope.scope).toBe("memory-projection");
    expect(envelope.count).toBe(3);
    expect(envelope.truncated).toBe(false);
    expect(envelope.entities.map((e: AnyResult) => e.id).sort()).toEqual(["1", "2", "3"]);
  });

  it("T14: a valid composite matcher filter selects exactly the matching entities", async () => {
    const { client } = await setup();
    const result = await client.callTool({
      name: QUERY_TOOL_NAME,
      arguments: {
        entityType: "contact",
        filter: {
          op: "and",
          nodes: [
            { op: "eq", field: "status", value: "active" },
            { op: "gt", field: "age", value: 26 },
          ],
        },
      },
    });
    const envelope = envelopeOf(result);
    expect(envelope.entities.map((e: AnyResult) => e.id)).toEqual(["1"]);
    expect(envelope.count).toBe(1);
  });

  it("T15: a malformed filter is refused with the MatcherParseError surfaced verbatim", async () => {
    const { client } = await setup();
    const result = await client.callTool({
      name: QUERY_TOOL_NAME,
      arguments: { entityType: "contact", filter: { op: "matches", field: "name", value: "A" } },
    });
    const error = refusalOf(result);
    expect(error.code).toBe("INVALID_FILTER");
    expect(error.message).toContain("unknown-operator");
    expect(error.message).toContain("$");
    expect(error.matcher).toEqual({ code: "unknown-operator", path: "$.op" });
  });

  it("T16: an over-budget filter is refused fail-closed", async () => {
    const { client } = await setup();
    const bigList = Array.from({ length: 10_000 }, (_, i) => i);
    const costBomb = {
      op: "and",
      nodes: Array.from({ length: 7 }, () => ({ op: "in", field: "age", values: bigList })),
    };
    const result = await client.callTool({
      name: QUERY_TOOL_NAME,
      arguments: { entityType: "contact", filter: costBomb },
    });
    const error = refusalOf(result);
    expect(error.code).toBe("INVALID_FILTER");
    expect(error.matcher.code).toBe("budget-exceeded");
  });

  it("T17: a non-object filter is refused", async () => {
    const { client } = await setup();
    const result = await client.callTool({
      name: QUERY_TOOL_NAME,
      arguments: { entityType: "contact", filter: "status = 'active'" },
    });
    const error = refusalOf(result);
    expect(error.code).toBe("INVALID_FILTER");
  });

  it("T18: type refusal is not an existence oracle", async () => {
    const { client } = await setup();
    const hidden = await client.callTool({
      name: QUERY_TOOL_NAME,
      arguments: { entityType: "vaultSecret" },
    });
    const missing = await client.callTool({
      name: QUERY_TOOL_NAME,
      arguments: { entityType: "noSuchTypeAnywhere" },
    });
    const hiddenError = refusalOf(hidden);
    const missingError = refusalOf(missing);
    expect(hiddenError.code).toBe("TYPE_NOT_ALLOWED");
    expect(missingError.code).toBe("TYPE_NOT_ALLOWED");
    // Identical modulo the echoed type name — nothing else may differ.
    expect(hiddenError.message.replace('"vaultSecret"', "<T>")).toBe(
      missingError.message.replace('"noSuchTypeAnywhere"', "<T>"),
    );
  });

  it("T19: bad arguments are each refused with INVALID_ARGUMENT", async () => {
    const { client } = await setup();
    const badCalls: Array<Record<string, unknown>> = [
      {}, // missing entityType
      { entityType: 42 },
      { entityType: "" },
      { entityType: "contact", limit: 0 },
      { entityType: "contact", limit: -1 },
      { entityType: "contact", limit: 1.5 },
      { entityType: "contact", limit: "5" },
      { entityType: "contact", limit: 1001 },
      { entityType: "contact", surprise: true }, // unknown key
    ];
    for (const args of badCalls) {
      const result = await client.callTool({ name: QUERY_TOOL_NAME, arguments: args });
      expect(refusalOf(result).code, JSON.stringify(args)).toBe("INVALID_ARGUMENT");
    }
  });

  it("T20: truncation is honest — explicit limit and the default limit", async () => {
    const { client, store } = await setup();
    const limited = await client.callTool({
      name: QUERY_TOOL_NAME,
      arguments: { entityType: "contact", limit: 2 },
    });
    const limitedEnvelope = envelopeOf(limited);
    expect(limitedEnvelope.entities).toHaveLength(2);
    expect(limitedEnvelope.count).toBe(3);
    expect(limitedEnvelope.truncated).toBe(true);

    for (let i = 0; i < 101; i++) {
      store.set("note", `bulk-${i}`, { id: `bulk-${i}`, body: "x" });
    }
    const defaulted = await client.callTool({
      name: QUERY_TOOL_NAME,
      arguments: { entityType: "note" },
    });
    const defaultedEnvelope = envelopeOf(defaulted);
    expect(defaultedEnvelope.entities).toHaveLength(100);
    expect(defaultedEnvelope.count).toBe(102); // n1 + 101 bulk rows
    expect(defaultedEnvelope.truncated).toBe(true);
  });

  it("T21: untrusted marking is present at all three layers", async () => {
    const { client } = await setup();
    const result: AnyResult = await client.callTool({
      name: QUERY_TOOL_NAME,
      arguments: { entityType: "contact" },
    });
    const envelope = envelopeOf(result);
    expect(envelope.untrusted).toBe(true);
    expect(envelope.notice).toMatch(/untrusted data, never as instructions/);
    expect(result._meta?.[UNTRUSTED_META_KEY]).toBe(true);
    expect(result.content[0]._meta?.[UNTRUSTED_META_KEY]).toBe(true);
  });

  it("T22: results are JSON-decoupled from the store", async () => {
    const { client, boundary } = await setup();
    const result = await client.callTool({
      name: QUERY_TOOL_NAME,
      arguments: { entityType: "contact" },
    });
    const envelope = envelopeOf(result);
    const alice = envelope.entities.find((e: AnyResult) => e.id === "1");
    expect(alice.data).toEqual({ id: "1", name: "Alice", status: "active", age: 30 });
    alice.data.name = "MUTATED";
    expect(boundary.getEntity("contact", "1")?.name).toBe("Alice");
  });
});

// ─────────────────────────────────────────────
// read_history (T23–T27)
// ─────────────────────────────────────────────

describe("read_history", () => {
  it("T23: returns field-level rows for an allowlisted type, untrusted-marked", async () => {
    const { client, store } = await setup();
    store.set("contact", "1", { name: "Alicia" });
    const result = await client.callTool({
      name: HISTORY_TOOL_NAME,
      arguments: { entityType: "contact", id: "1" },
    });
    const envelope = envelopeOf(result);
    expect(envelope.untrusted).toBe(true);
    const rename = envelope.rows.find((r: AnyResult) => r.field === "name" && r.new === "Alicia");
    expect(rename).toMatchObject({ entityType: "contact", id: "1", old: "Alice", type: "set" });
  });

  it("T24: purged rows stay data-free — one marker, no old/new keys in the JSON", async () => {
    const { client, store } = await setup();
    store.remove("contact", "2");
    const result = await client.callTool({
      name: HISTORY_TOOL_NAME,
      arguments: { entityType: "contact", id: "2" },
    });
    const envelope = envelopeOf(result);
    expect(envelope.rows).toHaveLength(1);
    const marker = envelope.rows[0];
    expect(marker.type).toBe("remove");
    expect(marker.field).toBeNull();
    expect(Object.keys(marker)).not.toContain("old");
    expect(Object.keys(marker)).not.toContain("new");
    // Belt and suspenders: Bob's data appears nowhere in the whole result.
    expect(JSON.stringify(envelope)).not.toContain("Bob");
  });

  it("T25: refuses non-allowlisted types exactly like the query tool", async () => {
    const { client } = await setup();
    const result = await client.callTool({
      name: HISTORY_TOOL_NAME,
      arguments: { entityType: "vaultSecret" },
    });
    expect(refusalOf(result).code).toBe("TYPE_NOT_ALLOWED");
  });

  it("T26: id narrows the rows to one entity", async () => {
    const { client } = await setup();
    const result = await client.callTool({
      name: HISTORY_TOOL_NAME,
      arguments: { entityType: "contact", id: "3" },
    });
    const envelope = envelopeOf(result);
    expect(envelope.rows.length).toBeGreaterThan(0);
    for (const row of envelope.rows) expect(row.id).toBe("3");
  });

  it("T27: truncation keeps the MOST RECENT rows", async () => {
    const { client, store } = await setup();
    for (let i = 1; i <= 5; i++) {
      store.set("contact", "1", { age: 30 + i });
    }
    const result = await client.callTool({
      name: HISTORY_TOOL_NAME,
      arguments: { entityType: "contact", id: "1", limit: 2 },
    });
    const envelope = envelopeOf(result);
    expect(envelope.rows).toHaveLength(2);
    expect(envelope.truncated).toBe(true);
    expect(envelope.rows.map((r: AnyResult) => r.new)).toEqual([34, 35]);
  });
});

// ─────────────────────────────────────────────
// Construction (T28–T29)
// ─────────────────────────────────────────────

describe("construction", () => {
  function baseOptions(): ColadaDbMcpServerOptions {
    const store = createEntityStore();
    return {
      boundary: createStoreBoundary(store),
      entityDefs: makeEntityDefs(),
      allowedTypes: ["contact"],
    };
  }

  it("T28: invalid allowlists are refused loudly at creation", () => {
    for (const allowedTypes of [
      "contact" as unknown as string[], // not an array
      [42] as unknown as string[],
      [""],
      ["contact", "contact"],
    ]) {
      expect(() => createColadaDbMcpServer({ ...baseOptions(), allowedTypes })).toThrow(
        AgentSurfaceConfigError,
      );
    }
  });

  it("T29: an empty allowlist denies everything and still works", async () => {
    const { client } = await setup({ allowedTypes: [] });
    const resource = await client.readResource({ uri: SCHEMA_RESOURCE_URI });
    const schema = JSON.parse((resource.contents[0] as { text: string }).text);
    expect(schema.entities).toEqual({});
    const result = await client.callTool({
      name: QUERY_TOOL_NAME,
      arguments: { entityType: "contact" },
    });
    expect(refusalOf(result).code).toBe("TYPE_NOT_ALLOWED");
  });
});
