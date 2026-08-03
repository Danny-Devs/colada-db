/**
 * restAdapter — proven, not definitionally, conformant.
 *
 * Three layers, because the kit alone cannot see HTTP:
 *
 * 1. `runSyncAdapterContract` (src/sync-conformance.ts) drives the REAL
 *    `restAdapter` against a minimally conformant in-memory v1 server, with
 *    EVERY optional hook supplied — a skipped block here would be an unchecked
 *    property of the reference adapter.
 * 2. Wire-mapping tests assert the HTTP layer the kit is blind to: paths,
 *    bodies, the §8 status table, malformed-response loudness, §3 tolerance.
 * 3. One integration test wires `enableSync` → `restAdapter` → stub server:
 *    the first time Stage 3 speaks HTTP end to end.
 *
 * ## The stub server is a TEST FIXTURE
 *
 * Not the server conformance kit (ADR-023 artifact 2) and not the reference
 * server (artifact 3) — it implements exactly the §13 checklist plus the
 * failure switches the kit's hooks need, and must not grow beyond that here.
 * Transport is an injected fetch-handler returning real `Response` objects
 * with real JSON bodies and real status codes (so status classification and
 * serialization are genuinely exercised) rather than a socket — chosen for
 * determinism and because nothing under test lives below `fetch`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { enableSync, SchemaVersionError } from "./coordinator";
import { freshStore } from "./coordinator-conformance";
import { restAdapter, RestAdapterHttpError, type RestAdapterOptions } from "./rest-adapter";
import { runSyncAdapterContract, SYNC_CONTRACT_COVERAGE } from "./sync-conformance";
import type { LocalChange, PushVerdict, RemoteChange, SyncAdapter, SyncEntityRecord } from "./sync-types";
import type { EntityEvent, EntityStore } from "./types";
import { WIRE_PULL_PATH, WIRE_PUSH_PATH } from "./wire-protocol";

// ────────────────────────────────────────────────────────────────────────────
// The stub v1 server — §13's checklist, nothing more
// ────────────────────────────────────────────────────────────────────────────

const REFUSED_SCHEMA_VERSION = "vREFUSED";

interface LogEntry {
  pos: number;
  change: RemoteChange;
  /** Present when a client authored this entry — what `confirmedMutations` is computed from. */
  author?: { clientId: string; seq: number };
}

interface StubServer {
  fetch: typeof globalThis.fetch;
  /** Server-side write bypassing push() — the kit's `seedRemote`. */
  seed(entityType: string, id: string, data: SyncEntityRecord): void;
  /** Server-side soft delete → an explicit `remove` tombstone in the feed. */
  removeEntity(entityType: string, id: string): void;
  /** One-shot: the next push responds with this status and no verdict body. */
  failNextPushWith(status: number): void;
}

function makeStubServer(): StubServer {
  const log: LogEntry[] = [];
  const entities = new Map<string, SyncEntityRecord>();
  const lastSeen = new Map<string, number>(); // per-clientId seq watermark (§7)
  const verdicts = new Map<string, PushVerdict>(); // mutationId → recorded verdict (idempotency)
  let versionCounter = 0;
  let failNextPush: number | null = null;

  function append(
    type: "set" | "remove",
    entityType: string,
    id: string,
    data: SyncEntityRecord | undefined,
    author?: { clientId: string; seq: number },
  ): number {
    versionCounter += 1;
    const key = `${entityType}:${id}`;
    if (type === "set") entities.set(key, data ?? {});
    else entities.delete(key);
    const change: RemoteChange =
      type === "set"
        ? { type, entityType, id, data, version: versionCounter }
        : { type, entityType, id, version: versionCounter }; // tombstone — never an omission (§5)
    log.push({ pos: log.length + 1, change, author });
    return versionCounter;
  }

  function json200(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }

  function handlePull(body: Record<string, unknown>): Response {
    // §7: a schema version we cannot serve answers with reset — NEVER an empty batch.
    if (body.schemaVersion === REFUSED_SCHEMA_VERSION) {
      return json200({ type: "reset", cursor: null, subscription: body.subscription });
    }
    let from = 0;
    if (typeof body.cursor === "string") {
      const match = /^c(\d+)$/.exec(body.cursor);
      // A cursor this server never issued (or no longer honours) → reset, not a silent gap (§12).
      if (!match) return json200({ type: "reset", cursor: null, subscription: body.subscription });
      from = Number(match[1]);
    }
    const remaining = log.filter((e) => e.pos > from);
    const limit = typeof body.limit === "number" ? body.limit : remaining.length;
    const page = remaining.slice(0, Math.max(0, limit));
    const servedThrough = page.length > 0 ? page[page.length - 1]!.pos : from;
    // §6: highest seq per client already contained in this snapshot — on EVERY pull response.
    const confirmedMutations: Record<string, number> = {};
    for (const entry of log) {
      if (entry.pos <= servedThrough && entry.author) {
        const prev = confirmedMutations[entry.author.clientId] ?? 0;
        confirmedMutations[entry.author.clientId] = Math.max(prev, entry.author.seq);
      }
    }
    return json200({
      type: "changes",
      changes: page.map((e) => e.change),
      cursor: `c${servedThrough}`,
      complete: page.length === remaining.length, // withheld rows MUST be declared (§7)
      confirmedMutations,
      ...(typeof body.subscription === "string" ? { subscription: body.subscription } : {}),
    });
  }

  function handlePush(body: Record<string, unknown>): Response {
    if (failNextPush !== null) {
      const status = failNextPush;
      failNextPush = null;
      return new Response(null, { status });
    }
    // §8: schema mismatch on push is the 409 transport channel, never a reject verdict.
    if (body.schemaVersion === REFUSED_SCHEMA_VERSION) {
      return new Response(JSON.stringify({ error: "unsupported schemaVersion" }), { status: 409 });
    }
    const changes = Array.isArray(body.changes) ? (body.changes as LocalChange[]) : [];
    const results: PushVerdict[] = [];
    for (const change of changes) {
      const recorded = verdicts.get(change.mutationId);
      if (recorded) {
        results.push(recorded); // §7 idempotency: same verdict, no second apply
        continue;
      }
      const seen = lastSeen.get(change.clientId) ?? 0;
      if (change.seq <= seen) {
        // A replay we have no record of is still a replay — never a reject (§7).
        results.push({ mutationId: change.mutationId, status: "ack" });
        continue;
      }
      if (change.seq > seen + 1) {
        // A gap is a transport-level refusal of the batch (§7) — applied out of order is worse.
        return new Response(JSON.stringify({ error: "seq gap" }), { status: 409 });
      }
      lastSeen.set(change.clientId, change.seq); // advanced even when the verdict below is reject (§7)
      let verdict: PushVerdict;
      if (change.entityType === "" || change.id === "") {
        verdict = { mutationId: change.mutationId, status: "reject" };
      } else if (change.op === "remove") {
        const version = append("remove", change.entityType, change.id, undefined, {
          clientId: change.clientId,
          seq: change.seq,
        });
        verdict = { mutationId: change.mutationId, status: "ack", version };
      } else {
        // §5: data is PATCH-style dirty fields — merge over what the server holds.
        const merged = { ...entities.get(`${change.entityType}:${change.id}`), ...change.data };
        const version = append("set", change.entityType, change.id, merged, {
          clientId: change.clientId,
          seq: change.seq,
        });
        verdict = { mutationId: change.mutationId, status: "ack", version };
      }
      verdicts.set(change.mutationId, verdict);
      results.push(verdict);
    }
    // Writes are durable-before-respond trivially: the log IS the read model. (§7 durability)
    return json200({ results });
  }

  const fetchHandler = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if ((init?.method ?? "GET") !== "POST") return new Response("method not allowed", { status: 404 });
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (url.pathname === WIRE_PULL_PATH) return handlePull(body);
    if (url.pathname === WIRE_PUSH_PATH) return handlePush(body);
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;

  return {
    fetch: fetchHandler,
    seed(entityType, id, data) {
      append("set", entityType, id, data);
    },
    removeEntity(entityType, id) {
      append("remove", entityType, id, undefined);
    },
    failNextPushWith(status) {
      failNextPush = status;
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 1. The conformance kit, against the real adapter — every hook supplied
// ────────────────────────────────────────────────────────────────────────────

// The kit's hooks receive the adapter, not the server — this map routes each
// hook call back to the stub behind that particular adapter instance.
const serverFor = new WeakMap<SyncAdapter, StubServer>();

runSyncAdapterContract({
  name: "restAdapter ↔ stub wire-protocol-v1 server",
  makeAdapter: () => {
    const server = makeStubServer();
    const adapter = restAdapter({ baseUrl: "https://stub.test", fetch: server.fetch });
    serverFor.set(adapter, server);
    return adapter;
  },
  seedRemote: async (adapter, entityType, id, data) => {
    serverFor.get(adapter)!.seed(entityType, id, data);
  },
  removeRemote: async (adapter, entityType, id) => {
    serverFor.get(adapter)!.removeEntity(entityType, id);
  },
  simulateTransientFailure: (adapter) => {
    serverFor.get(adapter)!.failNextPushWith(503);
  },
  unsupportedSchemaVersion: REFUSED_SCHEMA_VERSION,
  supportsSubscriptions: true,
  suppliesComparator: false,
});

describe("coverage bookkeeping", () => {
  it("the adapter obligation list this file answers to is the kit's, verbatim", () => {
    // Pins the intent: all 13 adapter obligations run above with zero skipped
    // blocks, because every hook that gates a block is supplied. If the kit
    // grows an obligation (and possibly a new hook), this count moves and this
    // file must answer for it.
    expect(SYNC_CONTRACT_COVERAGE.adapter).toHaveLength(13);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Wire mapping — the HTTP layer the kit cannot see
// ────────────────────────────────────────────────────────────────────────────

interface CapturedCall {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A fetch stub that records every request and answers from a script. */
function captureFetch(respond?: (path: string, body: Record<string, unknown>) => { status?: number; body?: unknown }) {
  const calls: CapturedCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url, method: init?.method, headers: (init?.headers ?? {}) as Record<string, string>, body });
    const path = new URL(url).pathname;
    const scripted = respond?.(path, body) ?? {};
    const status = scripted.status ?? 200;
    const payload =
      scripted.body !== undefined
        ? scripted.body
        : path === WIRE_PUSH_PATH
          ? { results: [] }
          : { type: "changes", changes: [], cursor: "c0", complete: true, confirmedMutations: {} };
    if (status === 200) {
      return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    }
    return new Response(null, { status });
  }) as typeof globalThis.fetch;
  return { calls, impl };
}

function pushChange(over: Partial<LocalChange> = {}): LocalChange {
  return {
    mutationId: "m1",
    clientId: "client-a",
    seq: 1,
    op: "set",
    entityType: "Widget",
    id: "w1",
    data: { id: "w1", label: "hello" },
    ...over,
  };
}

describe("wire shape — §2/§7: POST, JSON, cursor in the body and never the URL", () => {
  it("pull POSTs the §7 body to WIRE_PULL_PATH with content-type json", async () => {
    const { calls, impl } = captureFetch();
    const adapter = restAdapter({ baseUrl: "https://api.example.test", fetch: impl, schemaVersion: "3" });
    await adapter.pull(null);
    await adapter.pull("eyJvIjoxNzJ9==/weird bytes é", { limit: 2, subscription: "gates" });

    expect(calls[0]!.url).toBe(`https://api.example.test${WIRE_PULL_PATH}`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(calls[0]!.body).toEqual({ cursor: null, schemaVersion: "3" });

    // The cursor travels as opaque bytes in the body; the URL carries no query
    // string, ever — a cursor in a URL is a logging leak and a cache key (§2).
    expect(calls[1]!.url).not.toContain("?");
    expect(calls[1]!.body.cursor).toBe("eyJvIjoxNzJ9==/weird bytes é");
    // §7 is the whole vocabulary — nothing predicate-shaped can ride along.
    expect(Object.keys(calls[1]!.body).sort()).toEqual(["cursor", "limit", "schemaVersion", "subscription"]);
  });

  it("push POSTs the batch verbatim — transactionId, baseVersion, intent, clientId untouched", async () => {
    const { calls, impl } = captureFetch();
    const adapter = restAdapter({ baseUrl: "https://api.example.test", fetch: impl });
    const change = pushChange({
      clientId: "ed25519:3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29",
      transactionId: "tx-88",
      baseVersion: 41,
      intent: { name: "renameWidget", args: { id: "w1" } },
    });
    await adapter.push([change], { schemaVersion: "3" });

    expect(calls[0]!.url).toBe(`https://api.example.test${WIRE_PUSH_PATH}`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ changes: [change], schemaVersion: "3" });
    expect(Object.keys(calls[0]!.body).sort()).toEqual(["changes", "schemaVersion"]);
  });

  it("per-call schemaVersion overrides the adapter-level default", async () => {
    const { calls, impl } = captureFetch();
    const adapter = restAdapter({ baseUrl: "https://x.test", fetch: impl, schemaVersion: "3" });
    await adapter.pull(null, { schemaVersion: "4" });
    expect(calls[0]!.body.schemaVersion).toBe("4");
  });

  it("headers: a static record and an async callback both reach the request", async () => {
    const { calls, impl } = captureFetch();
    const staticAdapter = restAdapter({ baseUrl: "https://x.test", fetch: impl, headers: { authorization: "Bearer t1" } });
    await staticAdapter.pull(null);
    const callbackAdapter = restAdapter({
      baseUrl: "https://x.test",
      fetch: impl,
      headers: async () => ({ authorization: "Bearer t2" }),
    });
    await callbackAdapter.pull(null);
    expect(calls[0]!.headers.authorization).toBe("Bearer t1");
    expect(calls[1]!.headers.authorization).toBe("Bearer t2");
  });
});

describe("status mapping — §8, routed through classifyWireStatus", () => {
  const transientStatuses = [408, 429, 500, 502, 503];
  for (const status of transientStatuses) {
    it(`${status} throws a transient error (the coordinator retries; the write survives)`, async () => {
      const { impl } = captureFetch(() => ({ status }));
      const adapter = restAdapter({ baseUrl: "https://x.test", fetch: impl });
      const err = await adapter.push([pushChange()]).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(RestAdapterHttpError);
      expect((err as RestAdapterHttpError).outcome).toBe("transient");
      // Never the schema class: suspending the outbox on a 503 would freeze
      // sync on exactly the failures that heal themselves.
      expect(err).not.toBeInstanceOf(SchemaVersionError);
    });
  }

  const permanentStatuses = [400, 401, 403, 404];
  for (const status of permanentStatuses) {
    it(`${status} throws a permanent error and says so`, async () => {
      const { impl } = captureFetch(() => ({ status }));
      const adapter = restAdapter({ baseUrl: "https://x.test", fetch: impl });
      const err = await adapter.pull(null).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(RestAdapterHttpError);
      expect((err as RestAdapterHttpError).outcome).toBe("permanent");
      expect((err as RestAdapterHttpError).status).toBe(status);
    });
  }

  it("409 throws the coordinator's own SchemaVersionError — detected exactly as the coordinator detects it", async () => {
    const { impl } = captureFetch(() => ({ status: 409 }));
    const adapter = restAdapter({ baseUrl: "https://x.test", fetch: impl });
    const err = await adapter.push([pushChange()]).then(
      () => undefined,
      (e: unknown) => e,
    );
    // Mirror src/coordinator.ts:409 verbatim — this is the seam D12 hangs on.
    const detected =
      err instanceof SchemaVersionError || (err instanceof Error && err.name === "SchemaVersionError");
    expect(detected).toBe(true);
  });

  it("a 2xx verdict body is returned, not thrown", async () => {
    const { impl } = captureFetch((path) =>
      path === WIRE_PUSH_PATH ? { body: { results: [{ mutationId: "m1", status: "ack", version: 7 }] } } : {},
    );
    const adapter = restAdapter({ baseUrl: "https://x.test", fetch: impl });
    const result = await adapter.push([pushChange()]);
    expect(result.results).toEqual([{ mutationId: "m1", status: "ack", version: 7 }]);
  });
});

describe("malformed 200s fail loudly — never undefined into the cursor map", () => {
  const cases: Array<{ name: string; body: unknown; endpoint: "pull" | "push" }> = [
    { name: "'changes' without a cursor", body: { type: "changes", changes: [], complete: true }, endpoint: "pull" },
    { name: "'changes' without complete", body: { type: "changes", changes: [], cursor: "c1" }, endpoint: "pull" },
    { name: "'changes' without a changes array", body: { type: "changes", cursor: "c1", complete: true }, endpoint: "pull" },
    { name: "a change missing entityType", body: { type: "changes", cursor: "c1", complete: true, changes: [{ type: "set", id: "w1", version: 1 }] }, endpoint: "pull" },
    { name: "a change missing its version token", body: { type: "changes", cursor: "c1", complete: true, changes: [{ type: "set", entityType: "Widget", id: "w1", data: {} }] }, endpoint: "pull" },
    { name: "an unknown pull result type", body: { type: "snapshot" }, endpoint: "pull" },
    { name: "push results not an array", body: { results: { m1: "ack" } }, endpoint: "push" },
    { name: "a verdict with an unknown status", body: { results: [{ mutationId: "m1", status: "maybe" }] }, endpoint: "push" },
  ];
  for (const c of cases) {
    it(`rejects: ${c.name}`, async () => {
      const { impl } = captureFetch(() => ({ body: c.body }));
      const adapter = restAdapter({ baseUrl: "https://x.test", fetch: impl });
      const call = c.endpoint === "pull" ? adapter.pull(null) : adapter.push([pushChange()]);
      await expect(call).rejects.toThrow(/malformed/);
    });
  }
});

describe("additive tolerance — §3: unknown fields ignored, known ones untouched", () => {
  it("a pull response's extra fields survive to the returned PullResult verbatim", async () => {
    const { impl } = captureFetch(() => ({
      body: {
        type: "changes",
        changes: [{ type: "set", entityType: "Widget", id: "w1", data: { id: "w1" }, version: "0042" }],
        cursor: "c9",
        complete: true,
        confirmedMutations: { "c-a": 17 },
        subscription: "gates",
        checksum: "sha256:abc",
        retentionSeconds: 2592000,
        futureField: { nested: true },
      },
    }));
    const adapter = restAdapter({ baseUrl: "https://x.test", fetch: impl });
    const result = await adapter.pull(null, { subscription: "gates" });
    expect(result.type).toBe("changes");
    if (result.type !== "changes") return;
    expect(result.cursor).toBe("c9");
    expect(result.confirmedMutations).toEqual({ "c-a": 17 });
    expect(result.subscription).toBe("gates");
    // The version token is bytes — "0042" arrives exactly as sent, unparsed (§9).
    expect(result.changes[0]!.version).toBe("0042");
    // Unknown fields ride along rather than being stripped or faulted (§3).
    expect(result).toMatchObject({ checksum: "sha256:abc", retentionSeconds: 2592000, futureField: { nested: true } });
  });

  it("a reset with a null cursor and extra fields is accepted", async () => {
    const { impl } = captureFetch(() => ({ body: { type: "reset", cursor: null, subscription: "gates", hint: "compaction" } }));
    const adapter = restAdapter({ baseUrl: "https://x.test", fetch: impl });
    const result = await adapter.pull("c1", { subscription: "gates" });
    expect(result.type).toBe("reset");
  });

  it("unknown fields on a push response are ignored", async () => {
    const { impl } = captureFetch(() => ({
      body: { results: [{ mutationId: "m1", status: "ack", version: 1, serverHint: "x" }], tookMs: 3 },
    }));
    const adapter = restAdapter({ baseUrl: "https://x.test", fetch: impl });
    const result = await adapter.push([pushChange()]);
    expect(result.results[0]!.status).toBe("ack");
  });
});

describe("DAN-676 door-keeping constraints, checked for THIS adapter", () => {
  it("constraint 1 — the options type has no predicate surface (compile-time)", () => {
    // Excess-property checking makes each literal below a type error. If a
    // predicate slot is ever added to RestAdapterOptions, the corresponding
    // expect-error directive stops erroring and `pnpm typecheck` fails — the
    // door stays closed mechanically, not by review vigilance.
    // @ts-expect-error — a `where` predicate must not exist (C2-1: E2EE one-way door)
    const a: RestAdapterOptions = { baseUrl: "https://x.test", where: "status = 'open'" };
    // @ts-expect-error — a `filter` must not exist
    const b: RestAdapterOptions = { baseUrl: "https://x.test", filter: { status: "open" } };
    // @ts-expect-error — a `query` must not exist
    const c: RestAdapterOptions = { baseUrl: "https://x.test", query: "SELECT * FROM widgets" };
    expect([a, b, c].every((o) => o.baseUrl.length > 0)).toBe(true);
  });

  it("constraint 2 — no comparator: version ordering stays the contract default", () => {
    const adapter = restAdapter({ baseUrl: "https://x.test", fetch: captureFetch().impl });
    expect(adapter.compareVersions).toBeUndefined();
  });

  it("constraint 3 — a public-key-shaped clientId round-trips through the push body unchanged", async () => {
    const { calls, impl } = captureFetch();
    const adapter = restAdapter({ baseUrl: "https://x.test", fetch: impl });
    const key = "ed25519:3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";
    await adapter.push([pushChange({ clientId: key })]);
    const sent = (calls[0]!.body.changes as LocalChange[])[0]!;
    expect(sent.clientId).toBe(key);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. Integration — enableSync ↔ restAdapter ↔ stub server, end to end
// ────────────────────────────────────────────────────────────────────────────

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function localWrite(store: EntityStore, entityType: string, id: string, data: Record<string, unknown>): void {
  store.runWith({ origin: "local-mutation" }, () => store.set(entityType, id, data));
}

describe("integration — the full Stage-3 stack speaks HTTP", () => {
  it("local write → push over HTTP → pull confirms and drops the overlay; server change → applied under sync-pull", async () => {
    const server = makeStubServer();
    const adapter = restAdapter({ baseUrl: "https://stub.test", fetch: server.fetch });
    const store = freshStore();
    const pulled: EntityEvent[] = [];
    store.subscribe((event) => {
      if (event.origin === "sync-pull") pulled.push(event);
    });

    const handle = enableSync(store, { adapter, clientId: "c-int", pollIntervalMs: 25 });
    stops.push(handle.stop);

    // A committed local write enters the outbox, pushes over HTTP, and is
    // retired ONLY when a later pull's confirmedMutations covers its seq (D1) —
    // pending hitting 0 is the observable for that whole round trip.
    localWrite(store, "Widget", "w1", { id: "w1", label: "local edit" });
    await vi.waitFor(() => expect(handle.getPendingCount()).toBe(0), { timeout: 4000 });
    expect(store.get("Widget", "w1").value).toMatchObject({ id: "w1", label: "local edit" });

    // A server-authored change arrives on the next poll and lands in the store
    // under the sync-pull origin stamp (§2 — echo suppression by construction).
    server.seed("Widget", "w2", { id: "w2", label: "remote truth" });
    await vi.waitFor(
      () => expect(store.get("Widget", "w2").value).toMatchObject({ id: "w2", label: "remote truth" }),
      { timeout: 4000 },
    );
    const w2Events = pulled.filter((e) => e.entityType === "Widget" && e.id === "w2");
    expect(w2Events.length).toBeGreaterThan(0);
    expect(w2Events.every((e) => e.origin === "sync-pull")).toBe(true);

    // And nothing echoed: the server-authored change never re-entered the
    // outbox as a local write to push back.
    expect(handle.getPendingCount()).toBe(0);
  });
});
