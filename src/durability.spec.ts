/**
 * Durability-seam regression suite (arch review C2, 2026-07-19):
 * `await flush()` must mean "everything dirty as of this call is durable
 * when I resolve", and dispose() must not drop acknowledged writes.
 */
import { describe, expect, it } from "vitest";
import type { EntityKey, StorageEngine } from "./types";
import { createEntityStore } from "./store";
import { enablePersistence } from "./persist";

/** Controllable engine: each writeBatch blocks until released, FIFO; records all writes. */
function slowEngine() {
  const written = new Map<string, unknown>();
  const releases: Array<() => void> = [];
  const engine: StorageEngine = {
    isSupported: () => true,
    open: async () => {},
    loadAll: async () => [],
    async writeBatch(puts, deletes) {
      await new Promise<void>((r) => releases.push(r));
      for (const { key, value } of puts) written.set(key, value);
      for (const key of deletes) written.delete(key);
    },
    close() {},
  };
  return {
    engine,
    written,
    releaseOne: () => releases.shift()?.(),
    blocked: () => releases.length,
  };
}

/** Poll until cond() is true (bounded) — sequences the async flush chain deterministically. */
async function waitUntil(cond: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Immediate engine: resolves writes synchronously; records them. */
function fastEngine() {
  const written = new Map<string, unknown>();
  let closed = false;
  const engine: StorageEngine = {
    isSupported: () => true,
    open: async () => {},
    loadAll: async () => [],
    async writeBatch(puts, deletes) {
      if (closed) throw new Error("write after close");
      for (const { key, value } of puts) written.set(key, value);
      for (const key of deletes) written.delete(key);
    },
    close() {
      closed = true;
    },
  };
  return { engine, written, isClosed: () => closed };
}

describe("C2 — flush concurrency contract", () => {
  it("await flush() during an in-flight flush still lands writes that arrived mid-flight", async () => {
    const { engine, written, releaseOne, blocked } = slowEngine();
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, writeDebounce: 1 });
    await handle.ready;

    store.set("contact", "1", { id: "1", name: "first" });
    const firstFlush = handle.flush(); // starts, blocks in engine
    await waitUntil(() => blocked() === 1); // batch 1 is in the engine

    // A write arrives while the first flush is in flight
    store.set("contact", "2", { id: "2", name: "second" });
    // A caller awaiting flush() NOW must see BOTH writes durable on resolve
    const secondFlush = handle.flush();

    releaseOne(); // batch 1 completes
    await waitUntil(() => blocked() === 1); // second flush re-ran → batch 2 in the engine
    releaseOne(); // batch 2 completes

    await firstFlush;
    await secondFlush;
    expect(written.has("contact:1" as EntityKey)).toBe(true);
    expect(written.has("contact:2" as EntityKey)).toBe(true);
    handle.dispose();
  });

  it("dispose() performs a final flush — a debounce-window of writes is not dropped", async () => {
    const { engine, written } = fastEngine();
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, writeDebounce: 10_000 }); // huge debounce
    await handle.ready;

    store.set("contact", "1", { id: "1", name: "Alice" });
    // Debounce timer is 10s out — dispose immediately
    handle.dispose();
    // Final flush is async; give it a tick
    await new Promise((r) => setTimeout(r, 0));

    expect(written.has("contact:1" as EntityKey)).toBe(true);
  });

  it("dispose() closes the engine only after the final flush settles", async () => {
    const { engine, written, isClosed } = fastEngine();
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine, writeDebounce: 10_000 });
    await handle.ready;

    store.set("contact", "1", { id: "1" });
    handle.dispose();
    await new Promise((r) => setTimeout(r, 0));

    expect(written.has("contact:1" as EntityKey)).toBe(true); // flushed BEFORE close
    expect(isClosed()).toBe(true); // and then closed
  });

  it("dispose() is idempotent", async () => {
    const { engine } = fastEngine();
    const store = createEntityStore();
    const handle = enablePersistence(store, { engine });
    await handle.ready;
    handle.dispose();
    handle.dispose(); // second call must not throw or double-close
    await new Promise((r) => setTimeout(r, 0));
  });
});
