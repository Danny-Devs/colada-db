/**
 * One pane = one CLIENT: its own `createEntityStore()`, its own durability
 * engine, its own boundary, its own sync coordinator over its own network
 * gate. Two of these in one page, both pointed at the same hub, is the whole
 * demo.
 *
 * Wiring order mirrors what an app would do (and `playground/main.ts`):
 * store → `enablePersistence` (hydrates from the engine) → `enableSync`.
 * Writes go through the optimistic-transaction layer because that is what
 * stamps `origin: "local-mutation"` — the ONLY origin the coordinator's
 * outbox accepts (ADR-006 §1: "the outbox is the existing optimistic
 * transaction system"). A bare `store.set()` carries no origin and would
 * never sync.
 */
import {
  createEntityStore,
  createOptimisticUpdates,
  createStoreBoundary,
  enablePersistence,
  idbEngine,
  memoryEngine,
  sqliteEngine,
} from "colada-db";
import type { EntityStore, OptimisticUpdates, PersistenceHandle, StorageEngine, StoreBoundary } from "colada-db";
import { enableSync } from "@core/coordinator";
import type { SyncCoordinatorHandle } from "@core/coordinator";
import type { SyncAdapter } from "@core/sync-types";
import { createClientAdapter } from "./client-adapter";
import type { NetworkControl } from "./client-adapter";
import { HUB_SCHEMA_VERSION } from "./hub";

export type PaneName = "left" | "right";
export type EngineChoice = "memory" | "idb" | "sqlite-opfs";

/** Labels say what each choice honestly does in THIS scaffold — never a silent no-op. */
export const ENGINE_OPTIONS: ReadonlyArray<{ value: EngineChoice; label: string }> = [
  { value: "memory", label: "memory — in-page only; a reload starts empty and re-pulls from the hub" },
  { value: "idb", label: "idb — IndexedDB via enablePersistence; survives reload" },
  {
    value: "sqlite-opfs",
    label: "sqlite-OPFS — SQLite-WASM in a worker; single-connection, so the second pane to pick it lands on persistent: false",
  },
];

export const TODO_TYPE = "todo";

/** A type alias, not an interface: object-literal types get an implicit index signature and so satisfy `EntityRecord`. */
export type TodoData = {
  id: string;
  title: string;
  createdAt: number;
};

export interface PaneClient {
  pane: PaneName;
  engineChoice: EngineChoice;
  clientId: string;
  store: EntityStore;
  boundary: StoreBoundary;
  sync: SyncCoordinatorHandle;
  network: NetworkControl;
  /** Resolves once hydration from the engine completed. */
  ready: Promise<void>;
  /** `null` until open; `true`/`false` only meaningful for sqlite-OPFS. */
  persistent(): boolean | null;
  addTodo(title: string): void;
  renameTodo(id: string, title: string): void;
  removeTodo(id: string): void;
  dispose(): void;
}

let idCounter = 0;

function makeEngine(choice: EngineChoice, pane: PaneName): StorageEngine {
  switch (choice) {
    case "memory":
      return memoryEngine();
    case "idb":
      // Distinct database per pane — two clients sharing one IndexedDB would
      // "sync" through the disk and prove nothing about the hub.
      return idbEngine({ dbName: `cdb_sync_demo_${pane}` });
    case "sqlite-opfs":
      return sqliteEngine({
        dbName: `cdb_sync_demo_${pane}.sqlite3`,
        worker: () => new Worker(new URL("./sqlite.worker.ts", import.meta.url), { type: "module" }),
      });
  }
}

export function createPaneClient(opts: {
  pane: PaneName;
  engine: EngineChoice;
  hub: SyncAdapter;
  online: boolean;
}): PaneClient {
  const { pane, engine: engineChoice, hub, online } = opts;
  const store = createEntityStore();
  const engine = makeEngine(engineChoice, pane);
  const boundary = createStoreBoundary(store);
  const optimistic: OptimisticUpdates = createOptimisticUpdates(store);
  const { adapter, network } = createClientAdapter(hub, { online });

  // Without `outboxEngine`, the clientId MUST be fresh per coordinator
  // instance — the in-memory outbox restarts `seq` at 1, and the hub ignores
  // `seq <= lastSeen` for a clientId it has seen (see EnableSyncOptions.clientId).
  // An engine switch rebuilds the client, so it mints a new id here.
  idCounter += 1;
  const clientId = `${pane}-${engineChoice}-${Date.now().toString(36)}-${idCounter}`;

  const persistence: PersistenceHandle = enablePersistence(store, { engine, writeDebounce: 50 });
  const sync = enableSync(store, { adapter, clientId, schemaVersion: HUB_SCHEMA_VERSION });

  function commit(fn: (tx: ReturnType<OptimisticUpdates["transaction"]>) => void): void {
    const tx = optimistic.transaction();
    fn(tx);
    tx.commit();
  }

  return {
    pane,
    engineChoice,
    clientId,
    store,
    boundary,
    sync,
    network,
    ready: persistence.ready,
    persistent() {
      return "persistent" in engine ? ((engine as { persistent: boolean | null }).persistent ?? null) : null;
    },
    addTodo(title) {
      const id = `${pane}-${Date.now().toString(36)}-${++idCounter}`;
      const data: TodoData = { id, title, createdAt: Date.now() };
      commit((tx) => tx.set(TODO_TYPE, id, data));
    },
    renameTodo(id, title) {
      // `set` merges — only `title` changes, `createdAt` is kept.
      commit((tx) => tx.set(TODO_TYPE, id, { title }));
    },
    removeTodo(id) {
      commit((tx) => tx.remove(TODO_TYPE, id));
    },
    dispose() {
      sync.stop(); // no new pushes/pulls; in-flight verdicts still apply (coordinator contract)
      network.dispose(); // parked requests reject as transient; the stopped coordinator ignores them
      persistence.dispose(); // final flush, engine closed — releases the OPFS lock for the next opener
      boundary.dispose();
    },
  };
}
