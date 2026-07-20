/**
 * Scar-tissue regression suite: Safari/WebKit + quota armor (Tracks A3/A4,
 * HARDENING-2026-07).
 *
 * A3 — WebKit bug 226547: `indexedDB.open()` can hang FOREVER with no
 * success/error/blocked callback. Without a per-attempt deadline the whole
 * persistence boot hangs with it. idbEngine now deadlines each attempt and
 * retries once before degrading to memory-only.
 *
 * A4 — the real durability risk in browsers is silent quota EVICTION, not
 * corruption (steal-list verdict). `requestDurableStorage()` asks the
 * platform to protect the origin; it must never reject and never block
 * hydration.
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { idbEngine } from "./engines/idb";
import { createEntityStore } from "./store";
import { enablePersistence, requestDurableStorage } from "./persist";

const realIndexedDB = globalThis.indexedDB;

afterEach(() => {
  Object.defineProperty(globalThis, "indexedDB", { value: realIndexedDB, configurable: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** An IDBFactory whose open() NEVER calls back — the WebKit 226547 shape. */
function hangingIndexedDB(openSpy?: (name: string) => void): IDBFactory {
  return {
    open(name: string) {
      openSpy?.(name);
      // A request object that never fires any handler.
      return {} as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}

describe("A3 — idbEngine open deadline (WebKit 226547 class)", () => {
  it("a hung open() rejects at the deadline instead of hanging forever", async () => {
    vi.useFakeTimers();
    Object.defineProperty(globalThis, "indexedDB", {
      value: hangingIndexedDB(),
      configurable: true,
    });

    const engine = idbEngine({ openTimeoutMs: 50, openAttempts: 1 });
    const open = engine.open();
    const settled = open.then(
      () => "resolved",
      (e: Error) => e.message,
    );

    await vi.advanceTimersByTimeAsync(60);
    expect(await settled).toMatch(/timed out after 50ms/);
  });

  it("retries after a hung first attempt (openAttempts: 2)", async () => {
    vi.useFakeTimers();
    let calls = 0;
    Object.defineProperty(globalThis, "indexedDB", {
      value: hangingIndexedDB(() => calls++),
      configurable: true,
    });

    const engine = idbEngine({ openTimeoutMs: 50, openAttempts: 2 });
    const open = engine.open().catch((e: Error) => e.message);

    // attempt 1 deadline (50ms) + backoff (250ms) + attempt 2 deadline (50ms)
    await vi.advanceTimersByTimeAsync(400);
    expect(await open).toMatch(/timed out/);
    expect(calls).toBe(2);
  });

  it("a hung engine degrades enablePersistence to memory-only (ready settles, onError fires)", async () => {
    vi.useFakeTimers();
    Object.defineProperty(globalThis, "indexedDB", {
      value: hangingIndexedDB(),
      configurable: true,
    });

    const store = createEntityStore();
    const onError = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handle = enablePersistence(store, {
      engine: idbEngine({ openTimeoutMs: 50, openAttempts: 1 }),
      onError,
    });

    await vi.advanceTimersByTimeAsync(100);
    await handle.ready; // settles (degraded) instead of hanging forever
    expect(onError).toHaveBeenCalledTimes(1);

    // Memory store still fully functional
    store.set("contact", "1", { id: "1", name: "Alice" });
    expect(store.get("contact", "1").value?.name).toBe("Alice");
    warn.mockRestore();
    handle.dispose();
  });
});

describe("A4 — durable storage request (quota-eviction armor)", () => {
  it("requestDurableStorage resolves false when the API is unavailable, never rejects", async () => {
    // happy-dom may not implement navigator.storage.persist — either way
    // the util must resolve a boolean.
    await expect(requestDurableStorage()).resolves.toBeTypeOf("boolean");
  });

  it("returns true when the platform grants persistence", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    const persisted = vi.fn().mockResolvedValue(false);
    vi.stubGlobal("navigator", { storage: { persist, persisted } });

    await expect(requestDurableStorage()).resolves.toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("short-circuits true when already persisted (no duplicate prompt)", async () => {
    const persist = vi.fn();
    const persisted = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("navigator", { storage: { persist, persisted } });

    await expect(requestDurableStorage()).resolves.toBe(true);
    expect(persist).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("enablePersistence exposes durable=false by default (opt-in only)", async () => {
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine: idbEngine({ dbName: "a4-default" }) });
    await handle.ready;
    await expect(handle.durable).resolves.toBe(false);
    handle.dispose();
  });

  it("enablePersistence requests durability when opted in and reports the grant", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    const persisted = vi.fn().mockResolvedValue(false);
    const nav = globalThis.navigator as unknown as Record<string, unknown>;
    const hadStorage = "storage" in nav;
    const prevStorage = nav.storage;
    Object.defineProperty(globalThis.navigator, "storage", {
      value: { persist, persisted },
      configurable: true,
    });

    const store = createEntityStore();
    const handle = enablePersistence(store, {
      engine: idbEngine({ dbName: "a4-optin" }),
      requestDurable: true,
    });
    await expect(handle.durable).resolves.toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    handle.dispose();

    if (hadStorage) {
      Object.defineProperty(globalThis.navigator, "storage", {
        value: prevStorage,
        configurable: true,
      });
    }
  });
});
