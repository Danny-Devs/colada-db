/**
 * Optimistic transactions — grouped writes that commit or roll back
 * atomically, with correct behavior under CONCURRENT transactions.
 *
 * Architecture (TanStack DB's "clear and replay" model, 3 layers):
 * - Server truth is snapshotted before the first optimistic mutation
 *   touches each entity.
 * - Optimistic writes go directly to the entity store (reactivity
 *   propagates immediately).
 * - On rollback: restore server truth for affected entities, then replay
 *   the remaining active transactions in order.
 * - On commit: drop the transaction; if other live transactions still
 *   touch the same entity, fold this transaction's mutations into the
 *   stored server truth so a later rollback can't revert confirmed data.
 *
 * Extracted from pinia-colada-plugin-normalizer's composables.ts
 * (chip 2.5, 2026-07-19); logic unchanged. The plugin's
 * `useOptimisticUpdate(pinia)` becomes a thin wrapper over
 * `createOptimisticUpdates(store)`.
 *
 * This is the substrate the Stage-2 policy gate (`willCommit`, ADR-007)
 * wraps: the pre-apply veto runs before `tx.set()` touches the store.
 */
import type { EntityRecord, EntityStore } from "./types";
import { splitEntityKey } from "./normalize";

/** Mutation recorded within an optimistic transaction. */
interface OptimisticMutation {
  entityType: string;
  id: string;
  type: "set" | "remove";
  data?: EntityRecord;
}

/**
 * An optimistic transaction — a group of mutations that can be
 * committed (on success) or rolled back (on failure) atomically.
 */
export interface OptimisticTransaction {
  /** Apply an optimistic entity update within this transaction. */
  set(entityType: string, id: string, data: EntityRecord): void;
  /** Optimistically remove an entity within this transaction. */
  remove(entityType: string, id: string): void;
  /** Commit — server data has arrived, drop optimistic state. */
  commit(): void;
  /** Rollback — mutation failed, restore server truth + replay remaining transactions. */
  rollback(): void;
}

export interface OptimisticUpdates {
  /**
   * Simple single-mutation convenience: one `set`, returns
   * `{ commit, rollback }`. BOTH paths must be called — an unsettled
   * transaction stays active: its stale optimistic data is replayed by
   * every later rollback and its snapshots accumulate for the lifetime
   * of this handle.
   */
  apply(
    entityType: string,
    id: string,
    data: EntityRecord,
  ): Pick<OptimisticTransaction, "commit" | "rollback">;
  /** Create a multi-mutation transaction. */
  transaction(): OptimisticTransaction;
}

/**
 * Create an optimistic-update handle over a store. All transactions from
 * one handle share the snapshot/replay bookkeeping — create ONE handle
 * per store (concurrent transactions must see each other to interleave
 * correctly).
 */
export function createOptimisticUpdates(store: EntityStore): OptimisticUpdates {
  // Server truth snapshots — captured before optimistic mutations modify an entity.
  const serverTruth = new Map<string, { existed: boolean; data?: EntityRecord }>();

  // Active transactions — maintained in order for deterministic replay
  const activeTransactions: Array<{ mutations: OptimisticMutation[] }> = [];

  // Transaction identity for event attribution (write-channel, ADR-007 §1).
  // Monotonic per handle; the Stage-3 LocalChange upgrades this to an
  // HLC-style mutationId (ADR-006).
  let txCounter = 0;

  function entityKey(entityType: string, id: string): string {
    return `${entityType}:${id}`;
  }

  /**
   * Snapshot server truth for an entity if not already snapshotted.
   * Only captures on first optimistic touch — subsequent mutations
   * to the same entity reuse the original snapshot.
   */
  function snapshotIfNeeded(entityType: string, id: string): void {
    const key = entityKey(entityType, id);
    if (!serverTruth.has(key)) {
      const existed = store.has(entityType, id);
      serverTruth.set(key, {
        existed,
        data: existed ? { ...store.get(entityType, id).value! } : undefined,
      });
    }
  }

  /**
   * Restore server truth for entities, then replay all active transactions.
   * This is TanStack DB's "clear and replay" approach.
   */
  function recompute(affectedKeys: Set<string>): void {
    // Step 1: Restore server truth for affected entities
    for (const key of affectedKeys) {
      const truth = serverTruth.get(key);
      if (!truth) continue;

      const [entityType, id] = splitEntityKey(key);

      // Check if any remaining active transaction references this entity
      const stillReferenced = activeTransactions.some((tx) =>
        tx.mutations.some((m) => entityKey(m.entityType, m.id) === key),
      );

      if (!stillReferenced) {
        // No active transaction references this entity — restore and clean up
        if (truth.existed && truth.data) {
          store.replace(entityType, id, truth.data);
        } else if (!truth.existed) {
          store.remove(entityType, id);
        }
        serverTruth.delete(key);
      } else {
        // Still referenced — restore server truth, then replay will re-apply
        if (truth.existed && truth.data) {
          store.replace(entityType, id, truth.data);
        } else if (!truth.existed && store.has(entityType, id)) {
          store.remove(entityType, id);
        }
      }
    }

    // Step 2: Replay all active transactions in order
    for (const tx of activeTransactions) {
      for (const mutation of tx.mutations) {
        if (mutation.type === "set" && mutation.data) {
          store.set(mutation.entityType, mutation.id, mutation.data);
        } else if (mutation.type === "remove") {
          store.remove(mutation.entityType, mutation.id);
        }
      }
    }
  }

  /** Rollback restoration + replay runs under its own origin so consumers
   *  (undo stacks, history, persistence) can tell compensating writes from
   *  fresh user intent. */
  function recomputeAttributed(affectedKeys: Set<string>): void {
    store.runWith({ origin: "rollback-replay" }, () => recompute(affectedKeys));
  }

  function transaction(): OptimisticTransaction {
    const mutations: OptimisticMutation[] = [];
    const txEntry = { mutations };
    activeTransactions.push(txEntry);
    const transactionId = `tx-${++txCounter}`;
    const meta = { origin: "local-mutation", transactionId };

    return {
      set(entityType: string, id: string, data: EntityRecord) {
        snapshotIfNeeded(entityType, id);
        mutations.push({ entityType, id, type: "set", data });
        store.runWith(meta, () => store.set(entityType, id, data));
      },

      remove(entityType: string, id: string) {
        snapshotIfNeeded(entityType, id);
        mutations.push({ entityType, id, type: "remove" });
        store.runWith(meta, () => store.remove(entityType, id));
      },

      commit() {
        const idx = activeTransactions.indexOf(txEntry);
        if (idx === -1) return; // already committed/rolled back

        // Collect affected keys
        const affectedKeys = new Set(mutations.map((m) => entityKey(m.entityType, m.id)));

        // Remove this transaction
        activeTransactions.splice(idx, 1);

        // Clean up or update server truth for affected entities
        for (const key of affectedKeys) {
          const stillReferenced = activeTransactions.some((tx) =>
            tx.mutations.some((m) => entityKey(m.entityType, m.id) === key),
          );
          if (!stillReferenced) {
            serverTruth.delete(key);
          } else {
            // Update server truth by applying this transaction's mutations on top
            // of the OLD server truth. We can't use the current store value because
            // it includes other transactions' optimistic mutations.
            const truth = serverTruth.get(key);
            if (truth) {
              let newData = truth.data ? { ...truth.data } : undefined;
              for (const m of mutations) {
                if (entityKey(m.entityType, m.id) === key) {
                  if (m.type === "set" && m.data) {
                    newData = newData ? { ...newData, ...m.data } : { ...m.data };
                  } else if (m.type === "remove") {
                    newData = undefined;
                  }
                }
              }
              serverTruth.set(key, {
                existed: newData != null,
                data: newData,
              });
            }
          }
        }
      },

      rollback() {
        const idx = activeTransactions.indexOf(txEntry);
        if (idx === -1) return; // already committed/rolled back

        // Collect affected keys before removing
        const affectedKeys = new Set(mutations.map((m) => entityKey(m.entityType, m.id)));

        // Remove this transaction
        activeTransactions.splice(idx, 1);

        // Restore server truth + replay remaining transactions
        recomputeAttributed(affectedKeys);
      },
    };
  }

  function apply(
    entityType: string,
    id: string,
    data: EntityRecord,
  ): Pick<OptimisticTransaction, "commit" | "rollback"> {
    const tx = transaction();
    tx.set(entityType, id, data);
    return { commit: () => tx.commit(), rollback: () => tx.rollback() };
  }

  return { apply, transaction };
}
