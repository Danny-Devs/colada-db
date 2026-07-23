/**
 * IndexedDB storage engine — the default durability substrate.
 *
 * Extracted from the original enablePersistence internals (0.1.6). Raw IDB
 * API, zero dependencies, graceful multi-tab behavior via onblocked /
 * onversionchange.
 */

import type { EntityKey, StorageEngine } from "../types";

const STORE_NAME = "entities";

export interface IdbEngineOptions {
  /** IndexedDB database name. @default 'cdb_entities' */
  dbName?: string;
  /**
   * Deadline for a single indexedDB.open() attempt, in ms. Safari/WebKit
   * (bug 226547) can leave open() hanging forever with no callback at all;
   * without a deadline the whole persistence boot hangs with it.
   * @default 4000
   */
  openTimeoutMs?: number;
  /** Total open() attempts before giving up (deadline applies per attempt). @default 2 */
  openAttempts?: number;
}

export function idbEngine(options: IdbEngineOptions = {}): StorageEngine {
  const { dbName = "cdb_entities", openTimeoutMs = 4000, openAttempts = 2 } = options;
  let db: IDBDatabase | null = null;

  function openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        // The request can't be canceled — abandon it. If it ever succeeds
        // late, close the connection so it doesn't leak or block upgrades.
        reject(new Error(`IDB open timed out after ${openTimeoutMs}ms (WebKit 226547 class)`));
      }, openTimeoutMs);
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => {
        clearTimeout(timer);
        if (timedOut) {
          request.result.close();
          return;
        }
        resolve(request.result);
      };
      request.onerror = () => {
        clearTimeout(timer);
        reject(request.error);
      };
      // If another tab holds a connection and we need to upgrade, open hangs
      // indefinitely without this handler. Reject so the ready promise settles.
      request.onblocked = () => {
        clearTimeout(timer);
        reject(new Error("IDB open blocked by another connection"));
      };
    });
  }

  return {
    isSupported() {
      return typeof indexedDB !== "undefined";
    },

    async open() {
      let lastError: unknown;
      for (let attempt = 1; attempt <= openAttempts; attempt++) {
        try {
          db = await openDatabase();
          lastError = undefined;
          break;
        } catch (err) {
          lastError = err;
          // Brief backoff before retrying — a hung/blocked first attempt
          // often succeeds immediately on retry (Safari), and a blocked
          // upgrade may have been released.
          if (attempt < openAttempts) {
            await new Promise((r) => setTimeout(r, 250));
          }
        }
      }
      if (lastError !== undefined) throw lastError;
      // If another tab opens this DB with a higher version, close gracefully
      // to unblock the other tab's upgrade. The next writeBatch rejects,
      // which tells the coordinator to disable persistence for this tab.
      db!.onversionchange = () => {
        db?.close();
        db = null;
      };
    },

    loadAll() {
      return new Promise((resolve, reject) => {
        if (!db) return reject(new Error("IDB engine not open"));
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const keysReq = store.getAllKeys();
        const valsReq = store.getAll();
        tx.oncomplete = () => {
          const rows: Array<{ key: EntityKey; data: unknown }> = [];
          const keys = keysReq.result;
          const values = valsReq.result;
          for (let i = 0; i < keys.length; i++) {
            rows.push({ key: keys[i] as EntityKey, data: values[i] });
          }
          resolve(rows);
        };
        tx.onerror = () => reject(tx.error);
      });
    },

    loadMany(keys) {
      if (keys.length === 0) return Promise.resolve([]);
      return new Promise((resolve, reject) => {
        if (!db) return reject(new Error("IDB engine not open"));
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const rows: Array<{ key: EntityKey; data: unknown }> = [];
        for (const key of keys) {
          const req = store.get(key);
          req.onsuccess = () => {
            // Missing keys resolve undefined — omitted per the contract.
            if (req.result !== undefined) rows.push({ key, data: req.result });
          };
        }
        tx.oncomplete = () => resolve(rows);
        tx.onerror = () => reject(tx.error);
      });
    },

    writeBatch(puts, deletes) {
      return new Promise((resolve, reject) => {
        if (!db) {
          // Closed by versionchange (another tab upgraded) or never opened —
          // reject so the coordinator degrades instead of silently dropping.
          return reject(new Error("IDB connection closed"));
        }
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        for (const { key, value } of puts) {
          store.put(value, key);
        }
        for (const key of deletes) {
          store.delete(key);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },

    close() {
      db?.close();
      db = null;
    },
  };
}
