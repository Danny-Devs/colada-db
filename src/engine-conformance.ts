/**
 * DAN-653 Part B — the StorageEngine conformance kit (L2).
 *
 * ONE contract suite, run against EVERY engine. That is the whole idea: if
 * `memoryEngine` passes a property and `idbEngine` fails it, the divergence
 * IS the bug — and it is caught mechanically instead of being discovered in
 * production six months after the mock told us everything was fine.
 *
 * `TESTING-STRATEGY.md` states the principle this implements: for a
 * local-first database the mock is the enemy, because the synchronous
 * in-memory engine resolves every write in one microtask and is therefore a
 * lie by omission about every async-gap bug. The engines can only be trusted
 * relative to each other if they are held to a single written contract.
 *
 * ## This doubles as the executable spec
 *
 * A third-party `StorageEngine` author should be able to call
 * `runStorageEngineContract()` against their implementation and know whether
 * it is a valid engine. That is why the kit lives here rather than inline in
 * a spec file — it is documentation that cannot go stale, because it runs.
 *
 * NOTE ON PUBLISH SURFACE: this module is deliberately NOT re-exported from
 * `src/index.ts`, so it does not appear in the packed tarball and the
 * `check:pack-manifest` allowlist is unchanged. Promoting it to a published
 * entry point is a separate, deliberate act (it would add a permanent
 * compatibility promise) — see the follow-up ticket referenced in CHANGELOG.
 *
 * ## What this kit deliberately does NOT assert
 *
 * `undefined`-valued fields. The engines genuinely diverge here and the
 * divergence is DOCUMENTED on the `StorageEngine` contract in `types.ts`:
 * structured clone (IndexedDB) preserves an `undefined` property, while
 * JSON-based storage (SQLite) drops the key entirely. Asserting either
 * behaviour would make the kit lie about one engine or the other, so the
 * contract stays silent and callers stay inside the documented envelope.
 */
import { describe, expect, it } from "vitest";
import type { EntityKey, StorageEngine } from "./types";

export interface EngineContractOptions {
  /**
   * Optional second handle onto the SAME durable store, used for the reload
   * property — write, drop the handle, open a fresh one, and require the data
   * to still be there. Engines with no cross-instance durability (notably
   * `memoryEngine`, whose rows live in a per-call closure) omit this and the
   * reload block is skipped rather than faked.
   *
   * An engine that omits this is NOT claiming to be durable, and the kit
   * records that distinction instead of papering over it.
   */
  reopen?: (engine: StorageEngine) => StorageEngine;
  /**
   * Whether this engine populates the OPTIONAL per-row `version` counter
   * (ADR-005's arbitration slot; `version?: number` in the `StorageEngine`
   * contract, so omitting it is legal).
   *
   * Declared rather than inferred, and then checked in BOTH directions: an
   * engine that claims versioning must actually increment, and one that
   * disclaims it must genuinely return `undefined`. A half-implemented
   * counter is worse than none — downstream arbitration would silently treat
   * "no version" as "not newer".
   *
   * This flag exists because the kit found the asymmetry on its first run
   * (2026-07-30): `memoryEngine` and the SQLite core both increment, while
   * `idbEngine` — the DEFAULT engine — does not track a version at all. The
   * hazard runs opposite to the usual one: code developed against the mock
   * reads a number, ships, and receives `undefined` from IndexedDB with no
   * error anywhere.
   */
  versioned?: boolean;
}

const k = (s: string): EntityKey => s as EntityKey;

/**
 * Run the full `StorageEngine` contract against one implementation.
 *
 * @param name  Display name for the suite.
 * @param makeEngine  Factory producing a FRESH, empty engine per call —
 *   isolation between properties is the caller's responsibility.
 */
export function runStorageEngineContract(
  name: string,
  makeEngine: () => StorageEngine,
  options: EngineContractOptions = {},
): void {
  describe(`StorageEngine contract: ${name}`, () => {
    it("reports support and opens", async () => {
      const engine = makeEngine();
      expect(engine.isSupported()).toBe(true);
      await engine.open();
      engine.close();
    });

    it("loadAll on a fresh database is empty", async () => {
      const engine = makeEngine();
      await engine.open();
      expect(await engine.loadAll()).toEqual([]);
      engine.close();
    });

    it("round-trips puts through loadAll", async () => {
      const engine = makeEngine();
      await engine.open();
      await engine.writeBatch(
        [
          { key: k("contact:1"), value: { id: "1", name: "Alice" } },
          { key: k("order:5"), value: { id: "5", total: 100 } },
        ],
        [],
      );
      const byKey = new Map((await engine.loadAll()).map((r) => [r.key, r.data]));
      expect(byKey.get(k("contact:1"))).toEqual({ id: "1", name: "Alice" });
      expect(byKey.get(k("order:5"))).toEqual({ id: "5", total: 100 });
      engine.close();
    });

    it("loadMany: subset load, missing keys omitted, empty input resolves []", async () => {
      const engine = makeEngine();
      await engine.open();
      await engine.writeBatch(
        [
          { key: k("contact:1"), value: { id: "1" } },
          { key: k("contact:2"), value: { id: "2" } },
          { key: k("order:9"), value: { id: "9" } },
        ],
        [],
      );

      const rows = await engine.loadMany([k("contact:2"), k("contact:missing"), k("order:9")]);
      expect(rows.map((r) => r.key).sort()).toEqual(["contact:2", "order:9"]);
      expect(rows.find((r) => r.key === "contact:2")?.data).toEqual({ id: "2" });
      // Missing keys are OMITTED, never an error (types.ts StorageEngine).
      expect(await engine.loadMany([])).toEqual([]);
      engine.close();
    });

    it("applies deletes and last-write-wins puts in one batch", async () => {
      const engine = makeEngine();
      await engine.open();
      await engine.writeBatch([{ key: k("contact:1"), value: { v: 1 } }], []);
      await engine.writeBatch(
        [{ key: k("contact:1"), value: { v: 2 } }],
        [k("order:missing")], // deleting a nonexistent key must not throw
      );
      expect((await engine.loadAll()).find((r) => r.key === "contact:1")?.data).toEqual({ v: 2 });

      await engine.writeBatch([], [k("contact:1")]);
      expect(await engine.loadAll()).toHaveLength(0);
      engine.close();
    });

    it("a put REPLACES the stored row — engines never merge", async () => {
      // Merge is the STORE's semantic (store.set shallow-merges). An engine
      // that merged too would double-apply it, and a field removed by the
      // coordinator would silently survive on disk forever.
      const engine = makeEngine();
      await engine.open();
      await engine.writeBatch([{ key: k("contact:1"), value: { a: 1, b: 2 } }], []);
      await engine.writeBatch([{ key: k("contact:1"), value: { a: 9 } }], []);
      expect((await engine.loadAll())[0].data).toEqual({ a: 9 });
      engine.close();
    });

    it(
      options.versioned
        ? "increments a per-row version on every write (ADR-005 slot)"
        : "returns no per-row version, consistently (ADR-005 slot not implemented)",
      async () => {
        const engine = makeEngine();
        await engine.open();
        await engine.writeBatch([{ key: k("contact:1"), value: { v: 1 } }], []);
        await engine.writeBatch([{ key: k("contact:1"), value: { v: 2 } }], []);
        const [row] = await engine.loadAll();
        if (options.versioned) {
          expect(row.version).toBe(2);
        } else {
          // Pinned in the negative direction too: a partial counter would let
          // consumers believe arbitration works when it silently does not.
          expect(row.version).toBeUndefined();
        }
        engine.close();
      },
    );

    it("handles a batch larger than any statement-variable limit", async () => {
      // The SQLite engine chunks loadMany at 500 binds; every historic build
      // caps variables at 999. A 1200-row batch crosses both, and an engine
      // that silently truncates instead of chunking loses data with no error.
      const engine = makeEngine();
      await engine.open();
      const puts = Array.from({ length: 1200 }, (_, i) => ({
        key: k(`bulk:${i}`),
        value: { id: String(i), n: i },
      }));
      await engine.writeBatch(puts, []);

      const requested = [...puts.map((p) => p.key), k("bulk:missing")];
      const rows = await engine.loadMany(requested);
      expect(rows).toHaveLength(1200);
      expect(rows.find((r) => r.key === "bulk:777")?.data).toEqual({ id: "777", n: 777 });
      engine.close();
    });

    it("preserves keys containing separators and non-ASCII ids", async () => {
      // Entity keys are `${entityType}:${id}` and ids are user data — they can
      // contain colons and unicode. A key-splitting engine would corrupt these.
      const engine = makeEngine();
      await engine.open();
      const tricky = [
        k("contact:a:b:c"),
        k("contact:キー"),
        k("contact:with space"),
        k("contact:emoji-🔑"),
      ];
      await engine.writeBatch(
        tricky.map((key) => ({ key, value: { key } })),
        [],
      );
      const rows = await engine.loadMany(tricky);
      expect(rows.map((r) => r.key).sort()).toEqual([...tricky].sort());
      engine.close();
    });

    it("nested objects and arrays survive the round trip", async () => {
      const engine = makeEngine();
      await engine.open();
      const value = {
        id: "1",
        tags: ["a", "b"],
        nested: { deep: { n: 1 }, list: [{ x: 1 }, { x: 2 }] },
        flag: false,
        count: 0,
        nothing: null,
      };
      await engine.writeBatch([{ key: k("contact:1"), value }], []);
      expect((await engine.loadAll())[0].data).toEqual(value);
      engine.close();
    });

    const { reopen } = options;
    // The defining local-first property, and the ONE the in-memory mock
    // cannot satisfy — which is exactly why it is a capability rather than a
    // universal assertion. `describe.skipIf` records the engine's honest
    // answer instead of quietly passing.
    describe.skipIf(!reopen)("durability across a reopen (process-death proxy)", () => {
      it("written rows are still there after the handle is dropped and reopened", async () => {
        const engine = makeEngine();
        await engine.open();
        await engine.writeBatch(
          [
            { key: k("contact:1"), value: { id: "1", name: "Alice" } },
            { key: k("contact:2"), value: { id: "2", name: "Bob" } },
          ],
          [],
        );
        engine.close();

        const revived = reopen!(engine);
        await revived.open();
        const byKey = new Map((await revived.loadAll()).map((r) => [r.key, r.data]));
        expect(byKey.get(k("contact:1"))).toEqual({ id: "1", name: "Alice" });
        expect(byKey.get(k("contact:2"))).toEqual({ id: "2", name: "Bob" });
        revived.close();
      });

      it("a delete is durable too — a reopen must not resurrect it", async () => {
        // The mirror image, and the one people forget: a reload that restores
        // deleted rows is a zombie-resurrection bug (ADR-004 / arch review C1).
        const engine = makeEngine();
        await engine.open();
        await engine.writeBatch([{ key: k("contact:1"), value: { id: "1" } }], []);
        await engine.writeBatch([], [k("contact:1")]);
        engine.close();

        const revived = reopen!(engine);
        await revived.open();
        expect(await revived.loadAll()).toEqual([]);
        revived.close();
      });
    });
  });
}
