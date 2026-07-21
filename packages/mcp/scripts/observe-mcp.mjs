/**
 * Observe-it-run for DAN-580 (the DAN-605 pattern): drive the BUILT
 * packages end-to-end — an official SDK Client against the built
 * colada-db-mcp dist over a real InMemoryTransport pair, with core
 * resolved through the workspace link to its built dist.
 *
 * Run AFTER `pnpm -r build`:  cd packages/mcp && pnpm observe
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
// Built core via the workspace link (dist), NOT source:
import { createEntityStore, createStoreBoundary, enableHistory } from "colada-db";
// Built mcp dist, explicitly:
import {
  createColadaDbMcpServer,
  HISTORY_TOOL_NAME,
  QUERY_TOOL_NAME,
  SCHEMA_RESOURCE_URI,
} from "../dist/index.mjs";

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push([name, true, ""]);
  } catch (err) {
    checks.push([name, false, String(err && err.message ? err.message : err)]);
  }
}

// ── Fixture: store + boundary + history over the BUILT core ──
const store = createEntityStore();
const boundary = createStoreBoundary(store);
const history = enableHistory(store);

store.set("contact", "1", { id: "1", name: "Alice", status: "active", age: 30 });
store.set("contact", "2", { id: "2", name: "Bob", status: "active", age: 25 });
store.set("contact", "3", { id: "3", name: "Cleo", status: "archived", age: 41 });
store.set("vaultSecret", "s1", { id: "s1", apiToken: "TOP-SECRET" });
store.remove("contact", "2"); // exercise history purge

const server = createColadaDbMcpServer({
  boundary,
  entityDefs: {
    contact: {
      idField: "id",
      fields: { id: "string", name: "string", status: "string", age: "number" },
      relations: { vault: { entity: "vaultSecret", many: false } },
    },
    vaultSecret: { idField: "id", local: true, fields: { id: "string", apiToken: "string" } },
  },
  allowedTypes: ["contact"],
  history,
  serverInfo: { name: "observe-run", version: "0.0.0" },
});

// ── 1. connect (real protocol handshake) ──
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "observe-agent", version: "0.0.0" });
await server.connect(serverTransport);
await client.connect(clientTransport);
check("connect: handshake over InMemoryTransport, server identifies", () => {
  assert.deepEqual(client.getServerVersion().name, "observe-run");
});

// ── 2. tool list: zero write tools ──
const { tools } = await client.listTools();
check("tools: exactly query + history, zero write-shaped entries", () => {
  assert.deepEqual(tools.map((t) => t.name).sort(), [HISTORY_TOOL_NAME, QUERY_TOOL_NAME].sort());
  const writeShaped = /write|set|update|delete|create|mutate|remove|insert|upsert|patch|put|post|exec|apply/i;
  for (const t of tools) assert.ok(!writeShaped.test(t.name), `write-shaped tool leaked: ${t.name}`);
});

// ── 3. schema resource honors the allowlist ──
const resource = await client.readResource({ uri: SCHEMA_RESOURCE_URI });
const schemaText = resource.contents[0].text;
check("schema: allowlisted type present, hidden type + fields + relation absent", () => {
  const schema = JSON.parse(schemaText);
  assert.ok(schema.entities.contact);
  assert.ok(!schemaText.includes("vaultSecret"));
  assert.ok(!schemaText.includes("apiToken"));
  assert.ok(!schemaText.includes("vault"));
});

// ── 4. matcher-filtered query ──
const filtered = await client.callTool({
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
check("query: matcher filter selects exactly the matching entity, untrusted-marked", () => {
  const envelope = JSON.parse(filtered.content[0].text);
  assert.equal(envelope.untrusted, true);
  assert.equal(envelope.scope, "memory-projection");
  assert.deepEqual(envelope.entities.map((e) => e.id), ["1"]);
});

// ── 5. malformed filter refused with typed error ──
const malformed = await client.callTool({
  name: QUERY_TOOL_NAME,
  arguments: { entityType: "contact", filter: { op: "regex", field: "name", value: ".*" } },
});
check("query: malformed filter refused, parse error surfaced verbatim", () => {
  assert.equal(malformed.isError, true);
  const { error } = JSON.parse(malformed.content[0].text);
  assert.equal(error.code, "INVALID_FILTER");
  assert.ok(error.message.includes("unknown-operator"));
});

// ── 6. non-allowlisted type refused ──
const hidden = await client.callTool({
  name: QUERY_TOOL_NAME,
  arguments: { entityType: "vaultSecret" },
});
check("query: non-allowlisted type refused with TYPE_NOT_ALLOWED", () => {
  assert.equal(hidden.isError, true);
  assert.equal(JSON.parse(hidden.content[0].text).error.code, "TYPE_NOT_ALLOWED");
});

// ── 7. write attempt fails structurally ──
let writeRejected = false;
try {
  await client.callTool({
    name: "write_entity",
    arguments: { entityType: "contact", id: "1", data: { name: "EVIL" } },
  });
} catch {
  writeRejected = true;
}
check("write attempt: unknown tool (structural), store untouched", () => {
  assert.equal(writeRejected, true);
  assert.equal(boundary.getEntity("contact", "1").name, "Alice");
});

// ── 8. history query: rows + purged entity stays data-free ──
const historyResult = await client.callTool({
  name: HISTORY_TOOL_NAME,
  arguments: { entityType: "contact" },
});
check("history: field-level rows present; removed entity's rows are data-free markers", () => {
  const envelope = JSON.parse(historyResult.content[0].text);
  assert.equal(envelope.untrusted, true);
  assert.ok(envelope.rows.some((r) => r.field === "name" && r.new === "Alice"));
  const bobRows = envelope.rows.filter((r) => r.id === "2");
  assert.equal(bobRows.length, 1);
  assert.equal(bobRows[0].type, "remove");
  assert.ok(!JSON.stringify(envelope).includes("Bob"));
});

await client.close();

// ── Report ──
let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
