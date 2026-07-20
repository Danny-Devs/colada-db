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
  /** IndexedDB database name. @default 'pcn_entities' */
  dbName?: string;
}

export function idbEngine(options: IdbEngineOptions = {}): StorageEngine {
  const { dbName = "pcn_entities" } = options;
  let db: IDBDatabase | null = null;

  function openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      // If another tab holds a connection and we need to upgrade, open hangs
      // indefinitely without this handler. Reject so the ready promise settles.
      request.onblocked = () => reject(new Error("IDB open blocked by another connection"));
    });
  }

  return {
    isSupported() {
      return typeof indexedDB !== "undefined";
    },

    async open() {
      db = await openDatabase();
      // If another tab opens this DB with a higher version, close gracefully
      // to unblock the other tab's upgrade. The next writeBatch rejects,
      // which tells the coordinator to disable persistence for this tab.
      db.onversionchange = () => {
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
