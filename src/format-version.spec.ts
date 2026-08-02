/**
 * DAN-654 / ADR-018 — persisted-format contract regression.
 *
 * Two things this suite pins, because both are on-disk/wire contracts a
 * published database commits to forever:
 *
 * 1. The durable identifiers speak `cdb`, not the extracted-from-plugin `pcn`
 *    heritage: the entity-ref wire key is `__cdb_ref`, the default IDB db name
 *    is `cdb_entities`. Asserted at the BYTES the engine holds — a rename that
 *    only touched constants but not what lands on disk would pass a grep and
 *    fail here.
 * 2. `CDB_FORMAT_VERSION` is written into the manifest index row and read back
 *    on boot, with the ADR-018 policy: absent → treat as v1 silently; equal →
 *    normal; higher → warn once, never crash, still hydrate.
 *
 * Round-trip = write with the new format → boot a FRESH store off the same
 * durable bytes → every entity + manifest hydrates. Covered on the memory
 * engine (bytes inspected via snapshot()) AND the IDB path (bytes inspected by
 * opening the raw object store through fake-indexeddb).
 */
import "fake-indexeddb/auto";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createEntityStore } from "./store";
import { enablePersistence, CDB_FORMAT_VERSION } from "./persist";
import { memoryEngine } from "./engines/memory";
import { ENTITY_REF_MARKER } from "./types";
import type { EntityKey, EntityRef } from "./types";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// The one row the coordinator owns and stamps the version into (ADR-018).
const INDEX_KEY = "__cdb_manifest__:__index__" as EntityKey;

/** A Symbol-marked EntityRef, as normalize would produce. */
const ref = (entityType: string, id: string): EntityRef => ({
  [ENTITY_REF_MARKER]: true,
  entityType,
  id,
  key: `${entityType}:${id}` as EntityRef["key"],
});

const IDB_DBS = ["cdb_entities", "cdb-idb-rt"];
beforeEach(() =>
  Promise.all(
    IDB_DBS.map(
      (name) =>
        new Promise<void>((resolve) => {
          const req = indexedDB.deleteDatabase(name);
          req.onsuccess = () => resolve();
          req.onerror = () => resolve();
        }),
    ),
  ),
);

describe("DAN-654 — memory-engine format round-trip", () => {
  it("writes cdb-named wire identifiers + formatVersion, then a fresh store hydrates all of it", async () => {
    const engine = memoryEngine();

    // ── Session 1: write entities (one carrying a ref) + a manifest ──
    const store1 = createEntityStore();
    const h1 = enablePersistence(store1, { engine, writeDebounce: 0 });
    await h1.ready;
    store1.set("contact", "1", { id: "1", name: "Alice" });
    store1.set("post", "p1", { id: "p1", title: "hi", author: ref("contact", "1") });
    h1.setManifest("feed", ["contact:1", "post:p1"]);
    await h1.flush();

    // ── Assert the DURABLE BYTES, not just the in-memory constants ──
    const snap = engine.snapshot();

    // Entity ref serialized under the cdb wire key only — the heritage key is
    // gone (asserted by the exact key set, so this test never itself spells the
    // retired identifier and trips the rename gate). The Symbol marker did not
    // survive (it never can).
    const postData = snap.get("post:p1" as EntityKey)!.data as Record<string, unknown>;
    const author = postData.author as Record<string, unknown>;
    expect(author.__cdb_ref).toBe(true);
    expect(Object.keys(author).sort()).toEqual(["__cdb_ref", "entityType", "id", "key"]);
    expect(author.entityType).toBe("contact");
    expect(author.key).toBe("contact:1");

    // formatVersion present in the index row and equal to the constant.
    const indexRow = snap.get(INDEX_KEY)!.data as { formatVersion?: number; scopes: string[] };
    expect(indexRow.formatVersion).toBe(CDB_FORMAT_VERSION);
    expect(indexRow.formatVersion).toBe(1);
    expect(indexRow.scopes).toContain("feed");

    h1.dispose();
    await tick();

    // ── Session 2: a fresh store boots off the same durable bytes ──
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store2 = createEntityStore();
    const h2 = enablePersistence(store2, { engine, writeDebounce: 0 });
    await h2.ready;

    expect(store2.has("contact", "1")).toBe(true);
    expect(store2.has("post", "p1")).toBe(true);
    // The ref decoded back into a Symbol-marked EntityRef.
    const hydratedPost = store2.get("post", "p1").value as Record<string | symbol, unknown>;
    const hydratedAuthor = hydratedPost.author as Record<string | symbol, unknown>;
    expect(hydratedAuthor[ENTITY_REF_MARKER]).toBe(true);
    expect(hydratedAuthor.key).toBe("contact:1");
    // Equal version → no warning.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    h2.dispose();
  });

  it("manifest-mode boot hydrates the scope set and reads formatVersion back", async () => {
    const engine = memoryEngine();
    const s1 = createEntityStore();
    const h1 = enablePersistence(s1, { engine, writeDebounce: 0 });
    await h1.ready;
    s1.set("contact", "1", { id: "1", name: "A" });
    s1.set("contact", "2", { id: "2", name: "B" });
    h1.setManifest("inbox", ["contact:1", "contact:2"]);
    await h1.flush();
    h1.dispose();
    await tick();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s2 = createEntityStore();
    const h2 = enablePersistence(s2, { engine, hydration: "manifest", writeDebounce: 0 });
    await h2.ready;
    expect(s2.has("contact", "1")).toBe(true);
    expect(s2.has("contact", "2")).toBe(true);
    expect(warn).not.toHaveBeenCalled(); // equal version, manifest path
    warn.mockRestore();
    h2.dispose();
  });
});

describe("DAN-654 — IDB path format round-trip (fake-indexeddb)", () => {
  it("default db name is cdb_entities and the ref lands under __cdb_ref on disk", async () => {
    const store = createEntityStore();
    const h = enablePersistence(store, { writeDebounce: 0 }); // default idbEngine, default name
    await h.ready;
    store.set("post", "p1", { id: "p1", author: ref("contact", "7") });
    await h.flush();
    h.dispose();
    await tick();

    // Open the DEFAULT database raw — its existence proves the default name.
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("cdb_entities");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const onDisk = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const tx = raw.transaction("entities", "readonly");
      const g = tx.objectStore("entities").get("post:p1");
      g.onsuccess = () => resolve(g.result as Record<string, unknown>);
      g.onerror = () => reject(g.error);
    });
    raw.close();
    const author = onDisk.author as Record<string, unknown>;
    expect(author.__cdb_ref).toBe(true);
    // Exact key set proves no heritage wire key rode along (without naming it).
    expect(Object.keys(author).sort()).toEqual(["__cdb_ref", "entityType", "id", "key"]);
  });

  it("round-trips entities + manifest + formatVersion through a real IDB db name", async () => {
    // Session 1
    const s1 = createEntityStore();
    const h1 = enablePersistence(s1, { dbName: "cdb-idb-rt", writeDebounce: 0 });
    await h1.ready;
    s1.set("contact", "1", { id: "1", name: "Alice" });
    h1.setManifest("feed", ["contact:1"]);
    await h1.flush();
    h1.dispose();
    await tick();

    // Assert the index row on disk carries the version.
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("cdb-idb-rt");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const indexRow = await new Promise<{ formatVersion?: number }>((resolve, reject) => {
      const tx = raw.transaction("entities", "readonly");
      const g = tx.objectStore("entities").get(INDEX_KEY);
      g.onsuccess = () => resolve(g.result as { formatVersion?: number });
      g.onerror = () => reject(g.error);
    });
    raw.close();
    expect(indexRow.formatVersion).toBe(CDB_FORMAT_VERSION);

    // Session 2: fresh store hydrates.
    const s2 = createEntityStore();
    const h2 = enablePersistence(s2, { dbName: "cdb-idb-rt", writeDebounce: 0 });
    await h2.ready;
    expect(s2.has("contact", "1")).toBe(true);
    h2.dispose();
  });
});

describe("DAN-654 / ADR-018 — formatVersion boot policy", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("absent formatVersion (pre-versioned index row) → treated as v1, no warning", async () => {
    const engine = memoryEngine();
    // Seed an index row the OLD way — no formatVersion field.
    await engine.writeBatch(
      [{ key: INDEX_KEY, value: { v: 1, scopes: ["s"] } }],
      [],
    );
    const store = createEntityStore();
    const h = enablePersistence(store, { engine, writeDebounce: 0 });
    await h.ready; // must not crash
    expect(warn).not.toHaveBeenCalled();
    h.dispose();
  });

  it("manifest-free db (no index row at all) → boots fine, no warning", async () => {
    const engine = memoryEngine();
    await engine.writeBatch(
      [{ key: "contact:1" as EntityKey, value: { id: "1", name: "A" } }],
      [],
    );
    const store = createEntityStore();
    const h = enablePersistence(store, { engine, writeDebounce: 0 });
    await h.ready;
    expect(store.has("contact", "1")).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    h.dispose();
  });

  it("higher formatVersion → warns exactly once, does NOT crash, still hydrates", async () => {
    const engine = memoryEngine();
    await engine.writeBatch(
      [
        { key: INDEX_KEY, value: { v: 1, formatVersion: CDB_FORMAT_VERSION + 42, scopes: [] } },
        { key: "contact:9" as EntityKey, value: { id: "9", name: "Future" } },
      ],
      [],
    );
    const store = createEntityStore();
    const h = enablePersistence(store, { engine, writeDebounce: 0 });
    await h.ready; // forward-tolerant: no throw
    expect(store.has("contact", "9")).toBe(true); // still hydrated
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("newer than this build");
    h.dispose();
  });
});

/**
 * ADR-018 / ADR-022 line 1 — the format stamp must reach EVERY database.
 *
 * Found by the pre-publish review 2026-08-01. `formatVersion` lives in the
 * manifest index row and nowhere else, and that row used to be written only
 * when `setManifest`/`removeManifest` had been called. So the default
 * `hydration: "all"` path — precisely what the README quickstart teaches —
 * persisted a database with NO version marker anywhere on disk, leaving the
 * format's only escape hatch absent from the common case.
 *
 * The read side was never the gap: both boot paths already parse and skip the
 * index row. Only the write side was conditional.
 */
describe("ADR-018 — the format stamp is unconditional", () => {
  it("stamps a default-path db that never calls setManifest", async () => {
    const engine = memoryEngine();
    const store = createEntityStore();
    const h = enablePersistence(store, { engine, writeDebounce: 0 });
    await h.ready;

    // Exactly the README quickstart: set, flush. No manifest API touched.
    store.set("contact", "1", { id: "1", name: "Ada" });
    await h.flush();

    const row = engine.snapshot().get(INDEX_KEY);
    expect(row, "default-path db must carry the ADR-018 format stamp").toBeDefined();
    const indexRow = row!.data as { v: number; formatVersion?: number; scopes: string[] };
    expect(indexRow.formatVersion).toBe(CDB_FORMAT_VERSION);
    // Honest empty: this coordinator has no manifests, which is not the same
    // as having none recorded.
    expect(indexRow.scopes).toEqual([]);
    h.dispose();
  });

  it("writes no index row when the coordinator persists nothing", async () => {
    const engine = memoryEngine();
    const store = createEntityStore();
    const h = enablePersistence(store, { engine, writeDebounce: 0 });
    await h.ready;
    await h.flush(); // nothing dirty

    expect(engine.snapshot().size, "an untouched db stays empty").toBe(0);
    h.dispose();
  });

  it("stamps an unstamped legacy db on its next write, and only once", async () => {
    const engine = memoryEngine();
    // A database written by a build that stamped only manifest users.
    await engine.writeBatch([{ key: "contact:1" as EntityKey, value: { id: "1", name: "A" } }], []);
    expect(engine.snapshot().has(INDEX_KEY)).toBe(false);

    const store = createEntityStore();
    const h = enablePersistence(store, { engine, writeDebounce: 0 });
    await h.ready;
    expect(store.has("contact", "1")).toBe(true);
    // Boot alone must not write — an app that only reads stays read-only.
    expect(engine.snapshot().has(INDEX_KEY)).toBe(false);

    store.set("contact", "2", { id: "2", name: "B" });
    await h.flush();
    const stamped = engine.snapshot().get(INDEX_KEY)!;
    expect((stamped.data as { formatVersion?: number }).formatVersion).toBe(CDB_FORMAT_VERSION);

    // Second flush must not rewrite the row — version 1 means written once.
    store.set("contact", "3", { id: "3", name: "C" });
    await h.flush();
    expect(engine.snapshot().get(INDEX_KEY)!.version).toBe(stamped.version);
    h.dispose();
  });

  it("a stamped db is not rewritten on a later session's first write", async () => {
    const engine = memoryEngine();
    const s1 = createEntityStore();
    const h1 = enablePersistence(s1, { engine, writeDebounce: 0 });
    await h1.ready;
    s1.set("contact", "1", { id: "1", name: "A" });
    await h1.flush();
    const firstWrite = engine.snapshot().get(INDEX_KEY)!.version;
    h1.dispose();
    await tick();

    const s2 = createEntityStore();
    const h2 = enablePersistence(s2, { engine, writeDebounce: 0 });
    await h2.ready; // boot sees the row → indexPersisted
    s2.set("contact", "2", { id: "2", name: "B" });
    await h2.flush();

    expect(engine.snapshot().get(INDEX_KEY)!.version).toBe(firstWrite);
    h2.dispose();
  });
});
