/**
 * DAN-659 — every degradation path is observable in EVERY runtime.
 *
 * ## What these tests have to prove, and why the obvious test does not
 *
 * Two degradation paths used to speak only through `console.warn`, behind the
 * DAN-649 `process.env.NODE_ENV` guard: a persisted format version newer than
 * this build, and a matcher view over a foreign `StoreBoundary`. Where
 * `process` is absent the guard evaluates false and both went completely
 * silent — in exactly the CDN / `<script type="module">` runtime DAN-649
 * exists to protect.
 *
 * So "the handler fires" is NOT the assertion that matters. That passes
 * against the broken code too, because the test runner always has a `process`
 * and a `console`. The assertion that matters is that it fires with **both of
 * those globals removed**, which is why every test below deletes
 * `globalThis.process` (and blinds `console`) around the code under test, and
 * why each one carries a positive control proving the harness really did
 * remove them. A no-throw assertion under a harness that quietly failed to
 * delete anything is a green tick for the wrong target.
 *
 * The removal windows are kept as narrow as the code allows — vitest's own
 * machinery lives on `process` — and every one restores in a `finally`.
 */
import { describe, expect, it, vi } from "vitest";
import { createEntityStore } from "./store";
import { createStoreBoundary } from "./boundary";
import { createMatcherView } from "./matcher-view";
import { enablePersistence, CDB_FORMAT_VERSION } from "./persist";
import { memoryEngine } from "./engines/memory";
import { M } from "./matcher";
import type { StoreBoundary } from "./boundary";
import type { DegradationEvent } from "./degradation";
import type { EntityKey } from "./types";

/** The one row the coordinator stamps the format version into (ADR-018). */
const INDEX_KEY = "__cdb_manifest__:__index__" as EntityKey;

/**
 * Run `fn` in a realm with no `process` and no `console`.
 *
 * `delete globalThis.process` is the real thing, not a shadow: `typeof
 * process` genuinely evaluates to `"undefined"` inside, the same as in a
 * browser module. `console` is replaced rather than deleted because a bare
 * `console.x` on a deleted binding throws a ReferenceError that would be
 * indistinguishable from the defect under test — the point here is that the
 * channel needs neither, so a `console` that records nothing proves it.
 *
 * Both are restored unconditionally; a leak would poison every later test file
 * in the worker.
 */
async function withoutProcessOrConsole<T>(
  fn: (probe: { sawProcess: boolean; consoleCalls: number }) => T | Promise<T>,
): Promise<T> {
  const realProcess = globalThis.process;
  const realConsole = globalThis.console;
  const probe = { sawProcess: true, consoleCalls: 0 };
  const blind = new Proxy(
    {},
    {
      get:
        () =>
        (..._args: unknown[]) => {
          probe.consoleCalls++;
        },
    },
  ) as Console;

  // @ts-expect-error — deliberately removing a Node global, which is the
  // entire condition under test.
  delete globalThis.process;
  globalThis.console = blind;
  try {
    probe.sawProcess = typeof globalThis.process !== "undefined";
    return await fn(probe);
  } finally {
    globalThis.process = realProcess;
    globalThis.console = realConsole;
  }
}

/**
 * A foreign `StoreBoundary`: every method delegates to a real one, but the
 * object identity is different, so the internal WeakMap lookup that resolves a
 * boundary back to its store misses. This is exactly the shape a third-party
 * adapter or a decorating wrapper produces — not a contrived stub.
 */
function foreignBoundary(inner: StoreBoundary): StoreBoundary {
  return {
    subscribe: (l) => inner.subscribe(l),
    subscribeEntity: (t, id, l) => inner.subscribeEntity(t, id, l),
    subscribeType: (t, l) => inner.subscribeType(t, l),
    subscribeEvents: (l) => inner.subscribeEvents(l),
    getVersion: () => inner.getVersion(),
    getEntity: (t, id) => inner.getEntity(t, id),
    getEntities: (t) => inner.getEntities(t),
    dispose: () => inner.dispose(),
  };
}

// ─────────────────────────────────────────────
// Harness sanity — before trusting anything below
// ─────────────────────────────────────────────

describe("harness: the realm really loses `process` and `console`", () => {
  it("removes both inside the window and restores both after", async () => {
    const seen = await withoutProcessOrConsole((probe) => {
      // Positive control. Without this, every "the handler still fired"
      // assertion below could be vacuously true because the harness never
      // actually deleted anything.
      expect(probe.sawProcess).toBe(false);
      // The pre-fix guard shape throws here — which is the whole reason
      // DAN-649 installed the `typeof` check these paths still carry.
      expect(() => new Function(`return process.env.NODE_ENV;`)()).toThrow();
      console.warn("swallowed by the blind console");
      return probe.consoleCalls;
    });
    expect(seen).toBe(1);
    expect(typeof process).toBe("object");
    expect(globalThis.console.warn).toBeTypeOf("function");
  });
});

// ─────────────────────────────────────────────
// format-version-newer
// ─────────────────────────────────────────────

describe("format-version-newer reaches a runtime with no process/console", () => {
  /** A memory engine holding a database written by a NEWER build. */
  async function futureDatabase() {
    const engine = memoryEngine();
    await engine.writeBatch(
      [
        { key: INDEX_KEY, value: { v: 1, formatVersion: CDB_FORMAT_VERSION + 42, scopes: [] } },
        { key: "contact:9" as EntityKey, value: { id: "9", name: "Future" } },
      ],
      [],
    );
    return engine;
  }

  it("fires onDegraded with the machine-readable reason, and still hydrates", async () => {
    const engine = await futureDatabase();
    const events: DegradationEvent[] = [];

    const { store, handle } = await withoutProcessOrConsole(async (probe) => {
      const store = createEntityStore();
      const handle = enablePersistence(store, {
        engine,
        writeDebounce: 0,
        onDegraded: (e) => events.push(e),
      });
      await handle.ready; // forward-tolerant (ADR-018): must not throw
      expect(probe.sawProcess).toBe(false);
      // The console channel is genuinely dead in this realm — whatever it was
      // handed went nowhere a program could read.
      return { store, handle };
    });

    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("format-version-newer");
    expect(events[0].detail).toEqual({
      found: CDB_FORMAT_VERSION + 42,
      supported: CDB_FORMAT_VERSION,
    });
    expect(events[0].message).toContain("newer than this build");
    // Degradation, not failure: the data is still there.
    expect(store.has("contact", "9")).toBe(true);
    handle.dispose();
  });

  it("reports at most once, however many index reads happen", async () => {
    const engine = await futureDatabase();
    const events: DegradationEvent[] = [];
    const store = createEntityStore();
    const handle = enablePersistence(store, {
      engine,
      writeDebounce: 0,
      onDegraded: (e) => events.push(e),
    });
    await handle.ready;
    store.set("contact", "10", { id: "10", name: "B" });
    await handle.flush();
    expect(events).toHaveLength(1);
    handle.dispose();
  });

  it("is silent on a same-version database (the channel is not just always-on)", async () => {
    // Negative control. A callback that fires on every boot would satisfy the
    // test above while telling a consumer nothing.
    const engine = memoryEngine();
    await engine.writeBatch(
      [{ key: INDEX_KEY, value: { v: 1, formatVersion: CDB_FORMAT_VERSION, scopes: [] } }],
      [],
    );
    const events: DegradationEvent[] = [];
    const handle = enablePersistence(createEntityStore(), {
      engine,
      writeDebounce: 0,
      onDegraded: (e) => events.push(e),
    });
    await handle.ready;
    expect(events).toEqual([]);
    handle.dispose();
  });

  it("keeps the dev console.warn as well — DAN-659 adds a channel, it does not move one", async () => {
    const engine = await futureDatabase();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const handle = enablePersistence(createEntityStore(), { engine, writeDebounce: 0 });
      await handle.ready;
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("newer than this build");
      handle.dispose();
    } finally {
      warn.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────
// matcher-view-foreign-boundary
// ─────────────────────────────────────────────

describe("matcher-view-foreign-boundary reaches a runtime with no process/console", () => {
  it("fires onDegraded and reports retained=false, with the view still correct", async () => {
    const store = createEntityStore();
    store.set("contact", "1", { id: "1", status: "active" });
    store.set("contact", "2", { id: "2", status: "inactive" });
    const inner = createStoreBoundary(store);
    const events: DegradationEvent[] = [];

    const view = await withoutProcessOrConsole((probe) => {
      const v = createMatcherView(foreignBoundary(inner), "contact", M.eq("status", "active"), {
        onDegraded: (e) => events.push(e),
      });
      expect(probe.sawProcess).toBe(false);
      return v;
    });

    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("matcher-view-foreign-boundary");
    expect(events[0].detail).toEqual({ entityType: "contact" });
    // Degradation, not failure: what is lost is gc pinning, not correctness.
    expect(view.retained).toBe(false);
    expect(view.getMembers()).toEqual(["1"]);
    view.dispose();
  });

  it("a real boundary degrades nothing and reports retained=true", async () => {
    // Negative control for both halves of the channel.
    const store = createEntityStore();
    store.set("contact", "1", { id: "1", status: "active" });
    const events: DegradationEvent[] = [];
    const view = createMatcherView(
      createStoreBoundary(store),
      "contact",
      M.eq("status", "active"),
      { onDegraded: (e) => events.push(e) },
    );
    expect(events).toEqual([]);
    expect(view.retained).toBe(true);
    view.dispose();
  });

  it("fires synchronously, before createMatcherView returns", async () => {
    // This is what makes `retained` the right primitive here rather than a
    // consolation prize: the condition is settled at construction, so there is
    // no window in which a consumer holding the view could have missed it.
    const store = createEntityStore();
    const inner = createStoreBoundary(store);
    let firedBeforeReturn = false;
    const view = createMatcherView(foreignBoundary(inner), "contact", M.eq("status", "active"), {
      onDegraded: () => {
        firedBeforeReturn = true;
      },
    });
    expect(firedBeforeReturn).toBe(true);
    expect(view.retained).toBe(false);
    view.dispose();
  });
});

// ─────────────────────────────────────────────
// The channel's own invariant
// ─────────────────────────────────────────────

describe("a degradation report never breaks the path it reports on", () => {
  it("swallows a throwing handler during persistence boot", async () => {
    const engine = memoryEngine();
    await engine.writeBatch(
      [
        { key: INDEX_KEY, value: { v: 1, formatVersion: CDB_FORMAT_VERSION + 1, scopes: [] } },
        { key: "contact:9" as EntityKey, value: { id: "9", name: "Future" } },
      ],
      [],
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const store = createEntityStore();
      const handle = enablePersistence(store, {
        engine,
        writeDebounce: 0,
        onDegraded: () => {
          throw new Error("consumer reporter is down");
        },
      });
      // Boot survives — the degradation was already survivable, and a broken
      // reporter must not convert it into a failure.
      await expect(handle.ready).resolves.not.toThrow();
      expect(store.has("contact", "9")).toBe(true);
      expect(String(error.mock.calls[0]?.[0])).toContain("format-version-newer");
      handle.dispose();
    } finally {
      error.mockRestore();
    }
  });

  it("swallows a throwing handler during matcher-view creation", () => {
    const store = createEntityStore();
    store.set("contact", "1", { id: "1", status: "active" });
    const inner = createStoreBoundary(store);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const view = createMatcherView(foreignBoundary(inner), "contact", M.eq("status", "active"), {
        onDegraded: () => {
          throw new Error("consumer reporter is down");
        },
      });
      expect(view.getMembers()).toEqual(["1"]);
      expect(view.retained).toBe(false);
      view.dispose();
    } finally {
      error.mockRestore();
    }
  });
});
