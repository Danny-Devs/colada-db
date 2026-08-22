/**
 * Scar-tissue regression suite: IDB transaction ABORT wedges the pipeline
 * (DAN-651 P3).
 *
 * An IndexedDB transaction has THREE terminal events — `complete`, `error`
 * and `abort` — and `abort` is not always preceded by `error`. A request
 * level failure (QuotaExceeded, a constraint violation) bubbles to `error`,
 * which the engine already handled. But a commit-phase failure, a bfcache
 * freeze, or an explicit `tx.abort()` fires ONLY `abort`.
 *
 * Wired to two of the three, the returned Promise never settles. That is not
 * a lost write — it is a LIVENESS wedge, and it escapes into shutdown:
 * `flushing` stays true, every later `flush()` awaits the same pending
 * promise, and `dispose()`'s final flush hangs with them.
 *
 * The second trap is in the fix. On an abort with no request error,
 * `tx.error` is **null** — so copying the neighbouring `reject(tx.error)`
 * idiom would reject with `null`, a rejection carrying no diagnosis. Each
 * handler therefore falls back to a named Error.
 */
import { describe, expect, it } from "vitest";
import { idbEngine } from "./engines/idb";

/** Resolves to the HUNG sentinel if `p` has not settled within `ms`. */
const HUNG = Symbol("hung");
function settlesWithin(p: Promise<unknown>, ms = 100) {
  return Promise.race([
    p.then(
      () => "resolved" as const,
      (e: unknown) => e,
    ),
    new Promise((r) => setTimeout(() => r(HUNG), ms)),
  ]);
}

/**
 * An IDBFactory that opens successfully, then hands out transactions which
 * fire ONLY `abort` — never `complete`, never `error`. The real shapes this
 * stands in for are a commit-phase failure and a bfcache freeze.
 */
function abortingIndexedDB(txError: DOMException | null = null): IDBFactory {
  const store = {
    getAllKeys: () => ({}) as IDBRequest,
    getAll: () => ({}) as IDBRequest,
    get: () => ({}) as IDBRequest,
    put: () => ({}) as IDBRequest,
    delete: () => ({}) as IDBRequest,
  };

  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => store,
    close: () => {},
    onversionchange: null,
    transaction() {
      const tx: Record<string, unknown> = {
        error: txError,
        objectStore: () => store,
      };
      // Abort on a later turn, after the engine has wired its handlers.
      setTimeout(() => (tx.onabort as (() => void) | undefined)?.(), 0);
      return tx as unknown as IDBTransaction;
    },
  };

  return {
    open() {
      const request: Record<string, unknown> = { result: db, error: null };
      setTimeout(() => (request.onsuccess as (() => void) | undefined)?.(), 0);
      return request as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}

async function openEngineOn(factory: IDBFactory) {
  const engine = idbEngine({ dbName: "cdb_abort_spec" });
  const original = globalThis.indexedDB;
  Object.defineProperty(globalThis, "indexedDB", { value: factory, configurable: true });
  try {
    await engine.open();
  } finally {
    Object.defineProperty(globalThis, "indexedDB", { value: original, configurable: true });
  }
  return engine;
}

describe("P3 — a transaction that aborts with no request error must not wedge the pipeline", () => {
  it("loadAll rejects instead of hanging forever", async () => {
    const engine = await openEngineOn(abortingIndexedDB());
    const outcome = await settlesWithin(engine.loadAll());
    expect(outcome).not.toBe(HUNG);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/aborted during loadAll/);
  });

  it("loadMany rejects instead of hanging forever", async () => {
    const engine = await openEngineOn(abortingIndexedDB());
    const outcome = await settlesWithin(engine.loadMany(["user:1" as never]));
    expect(outcome).not.toBe(HUNG);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/aborted during loadMany/);
  });

  it("writeBatch rejects instead of hanging forever — the flush path that wedges dispose()", async () => {
    const engine = await openEngineOn(abortingIndexedDB());
    const outcome = await settlesWithin(
      engine.writeBatch([{ key: "user:1" as never, value: { id: 1 } }], []),
    );
    expect(outcome).not.toBe(HUNG);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/aborted during writeBatch/);
  });

  it("a SECOND flush after an abort also settles — the wedge does not persist across calls", async () => {
    const engine = await openEngineOn(abortingIndexedDB());
    await settlesWithin(engine.writeBatch([], ["user:1" as never]));
    const second = await settlesWithin(engine.writeBatch([], ["user:2" as never]));
    expect(second).not.toBe(HUNG);
    expect(second).toBeInstanceOf(Error);
  });

  it("when the abort DOES carry a request error, that error propagates rather than the fallback", async () => {
    const real = new DOMException("QuotaExceededError", "QuotaExceededError");
    const engine = await openEngineOn(abortingIndexedDB(real));
    const outcome = await settlesWithin(engine.writeBatch([], []));
    expect(outcome).toBe(real);
  });
});
