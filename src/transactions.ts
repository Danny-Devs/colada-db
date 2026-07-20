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
 * A single proposed write, as presented to policy gates. `previous` is the
 * live store value at proposal time (undefined if the entity doesn't exist
 * in memory) so predicates can compare old → new without a store reference.
 */
export interface ProposedWrite {
  entityType: string;
  id: string;
  type: "set" | "remove";
  /** The incoming data (undefined for removes). */
  data?: EntityRecord;
  /** The current in-memory value being overwritten (undefined if absent). */
  previous?: EntityRecord;
}

/**
 * A gate's answer: `true` allows; `false` vetoes; a string vetoes with that
 * reason (ADR-007: `willCommit(changeSet) => boolean | reason`).
 */
export type GateVerdict = boolean | string;

/**
 * A policy gate — THE enforcement point where a trust/policy layer binds
 * to the data layer (ADR-007 §2) without the core knowing what a
 * "mandate" is. Both hooks are SYNCHRONOUS: async authority checks must
 * resolve to a capability before apply, never inside the gate.
 *
 * - `willApply` runs BEFORE a transactional write touches the live store
 *   (audit blocker #4: `tx.set` writes immediately; commit-time is too
 *   late). A veto means the write never happened — store, subscribers,
 *   persistence, and the transaction's replay log are all untouched.
 * - `willCommit` runs at commit time over the transaction's full change
 *   set as last-chance validation. A veto invokes the existing rollback
 *   machinery (the transaction settles as a rollback; disk is untouched
 *   by roadmap 0.3's guarantee).
 *
 * Gates only see TRANSACTIONAL writes — the ordinary store API bypasses
 * transactions entirely and is not policed here.
 *
 * Rollback REPLAY does not re-run `willApply`: replayed mutations already
 * passed the gate at proposal time, and vetoing mid-restore (from an
 * unrelated transaction's rollback) would have no coherent recovery path.
 * The owning transaction's own `willCommit` still gates it at settlement.
 */
export interface PolicyGate {
  willApply?(change: ProposedWrite, ctx: { transactionId: string }): GateVerdict;
  willCommit?(changeSet: ProposedWrite[], ctx: { transactionId: string }): GateVerdict;
}

/**
 * Thrown when a policy gate vetoes a write (pre-apply) or a commit
 * (last-chance). Fail-visible by design: a refused write must never look
 * like a successful one.
 */
export class PolicyVetoError extends Error {
  readonly phase: "apply" | "commit";
  readonly reason?: string;
  readonly transactionId: string;

  constructor(phase: "apply" | "commit", transactionId: string, reason?: string) {
    super(
      `Policy gate vetoed ${phase === "apply" ? "a write" : "the commit"}` +
        ` in ${transactionId}${reason ? `: ${reason}` : ""}`,
    );
    this.name = "PolicyVetoError";
    this.phase = phase;
    this.reason = reason;
    this.transactionId = transactionId;
  }
}

/**
 * Settlement notification — how downstream layers (persistence, the
 * proto-outbox) learn that "transaction N is confirmed" or "transaction N
 * never happened". Commit emits no entity events (re-applying identical
 * data is no-op-suppressed), so confirmation needs its own channel.
 */
export interface TransactionSettledEvent {
  transactionId: string;
  outcome: "commit" | "rollback";
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
  /**
   * Subscribe to transaction settlement (commit/rollback). Fires AFTER the
   * settling transaction's store effects — on rollback, the compensating
   * events have already been emitted when the listener runs, so a buffer
   * keyed by transactionId can be discarded wholesale.
   * @returns Unsubscribe function
   */
  onSettled(listener: (event: TransactionSettledEvent) => void): () => void;
  /**
   * Register a policy gate. All gates must allow; the first veto wins
   * (evaluation in registration order). A pre-apply veto makes `tx.set` /
   * `tx.remove` throw {@link PolicyVetoError}; a commit-time veto rolls
   * the transaction back and makes `commit()` throw.
   *
   * A vetoed WRITE does not settle the transaction — earlier allowed
   * writes stay applied and the caller must still commit or roll back
   * (the usual contract). `apply()` handles this internally: a veto there
   * rolls back before rethrowing, since the caller never gets the handle.
   * @returns Unregister function
   */
  useGate(gate: PolicyGate): () => void;
}

/**
 * One optimistic-updates handle per store, enforced structurally (arch
 * review H3): concurrent transactions MUST share snapshot/replay
 * bookkeeping — two independent handles would capture each other's
 * optimistic state as "server truth" and corrupt on rollback.
 */
const handleByStore = new WeakMap<EntityStore, OptimisticUpdates>();

/**
 * Create (or retrieve) THE optimistic-update handle for a store. All
 * transactions on one store share the snapshot/replay bookkeeping;
 * repeated calls return the same handle — the one-handle-per-store
 * invariant is structural, not a documentation plea.
 */
export function createOptimisticUpdates(store: EntityStore): OptimisticUpdates {
  const existing = handleByStore.get(store);
  if (existing) return existing;
  const created = buildOptimisticUpdates(store);
  handleByStore.set(store, created);
  return created;
}

function buildOptimisticUpdates(store: EntityStore): OptimisticUpdates {
  // Server truth snapshots — captured before optimistic mutations modify an entity.
  const serverTruth = new Map<string, { existed: boolean; data?: EntityRecord }>();

  // Active transactions — maintained in order for deterministic replay.
  // Each entry carries its transactionId so replay can run under the
  // owner's identity (docs/design/optimistic-durability.md, resolution (a)).
  const activeTransactions: Array<{ transactionId: string; mutations: OptimisticMutation[] }> = [];

  // Settlement listeners (persistence's commit signal).
  const settledListeners = new Set<(event: TransactionSettledEvent) => void>();

  function notifySettled(transactionId: string, outcome: "commit" | "rollback"): void {
    for (const listener of settledListeners) {
      listener({ transactionId, outcome });
    }
  }

  // Policy gates (ADR-007 §2) — evaluated in registration order, first
  // veto wins. Empty set = zero-cost pass-through.
  const gates = new Set<PolicyGate>();

  /** Throws PolicyVetoError on the first gate that vetoes. */
  function checkApply(change: ProposedWrite, transactionId: string): void {
    for (const gate of gates) {
      if (!gate.willApply) continue;
      const verdict = gate.willApply(change, { transactionId });
      if (verdict !== true) {
        throw new PolicyVetoError(
          "apply",
          transactionId,
          typeof verdict === "string" ? verdict : undefined,
        );
      }
    }
  }

  /** Returns the vetoing verdict (or null if all gates allow). */
  function checkCommit(
    changeSet: ProposedWrite[],
    transactionId: string,
  ): { reason?: string } | null {
    for (const gate of gates) {
      if (!gate.willCommit) continue;
      const verdict = gate.willCommit(changeSet, { transactionId });
      if (verdict !== true) {
        return { reason: typeof verdict === "string" ? verdict : undefined };
      }
    }
    return null;
  }

  // Gates are the third-party extension point — never hand them live
  // references into the replay log or serverTruth (a mutating gate would
  // corrupt the rollback source of truth). Shallow copies throughout.
  function toProposedWrite(m: OptimisticMutation): ProposedWrite {
    return {
      entityType: m.entityType,
      id: m.id,
      type: m.type,
      data: m.data ? { ...m.data } : undefined,
      previous: store.has(m.entityType, m.id)
        ? { ...store.get(m.entityType, m.id).value! }
        : undefined,
    };
  }

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
   *
   * Every write runs under `origin: "rollback-replay"` so consumers (undo
   * stacks, history, persistence) can tell compensating writes from fresh
   * user intent — AND under a transactionId, because identity decides
   * durability (docs/design/optimistic-durability.md):
   *
   * - Step 1's compensating writes carry the ROLLED-BACK transaction's id:
   *   they exist only to undo that transaction's memory effects, so
   *   persistence buffers them under the dying transaction and discards
   *   them with it at settlement. Disk was never touched by the
   *   transaction; it must not be touched by the undo either.
   * - Step 2's replayed writes each carry their OWNER's id: replayed
   *   optimistic state lands back in its own buffer (idempotent re-buffer).
   *   Replaying without identity was the 2026-07-19 trap — those events
   *   would masquerade as confirmed writes and leak optimistic data to disk.
   */
  function recompute(affectedKeys: Set<string>, rolledBackTxId: string): void {
    // Step 1: Restore server truth for affected entities
    store.runWith({ origin: "rollback-replay", transactionId: rolledBackTxId }, () => {
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
    });

    // Step 2: Replay all active transactions in order, each under its own identity
    for (const tx of activeTransactions) {
      store.runWith({ origin: "rollback-replay", transactionId: tx.transactionId }, () => {
        for (const mutation of tx.mutations) {
          if (mutation.type === "set" && mutation.data) {
            store.set(mutation.entityType, mutation.id, mutation.data);
          } else if (mutation.type === "remove") {
            store.remove(mutation.entityType, mutation.id);
          }
        }
      });
    }
  }

  function transaction(): OptimisticTransaction {
    const mutations: OptimisticMutation[] = [];
    const transactionId = `tx-${++txCounter}`;
    const txEntry = { transactionId, mutations };
    activeTransactions.push(txEntry);
    const meta = { origin: "local-mutation", transactionId };

    // Named so the commit-time veto path can invoke the SAME rollback
    // machinery callers use — no parallel restore logic to drift.
    function doRollback(): void {
      const idx = activeTransactions.indexOf(txEntry);
      if (idx === -1) return; // already committed/rolled back

      // Collect affected keys before removing
      const affectedKeys = new Set(mutations.map((m) => entityKey(m.entityType, m.id)));

      // Remove this transaction
      activeTransactions.splice(idx, 1);

      // Restore server truth + replay remaining transactions — BEFORE the
      // settlement notification, so the compensating events are already
      // buffered under this (dying) transaction when listeners discard it.
      recompute(affectedKeys, transactionId);

      notifySettled(transactionId, "rollback");
    }

    return {
      set(entityType: string, id: string, data: EntityRecord) {
        // Pre-apply gate: a veto throws BEFORE anything is touched — no
        // snapshot, no replay-log entry, no store write, no event.
        checkApply(toProposedWrite({ entityType, id, type: "set", data }), transactionId);
        snapshotIfNeeded(entityType, id);
        mutations.push({ entityType, id, type: "set", data });
        store.runWith(meta, () => store.set(entityType, id, data));
      },

      remove(entityType: string, id: string) {
        checkApply(toProposedWrite({ entityType, id, type: "remove" }), transactionId);
        snapshotIfNeeded(entityType, id);
        mutations.push({ entityType, id, type: "remove" });
        store.runWith(meta, () => store.remove(entityType, id));
      },

      commit() {
        const idx = activeTransactions.indexOf(txEntry);
        if (idx === -1) return; // already committed/rolled back

        // Last-chance willCommit over the NET change set (ADR-007 §2): one
        // entry per entity, `data` = the transaction's net incoming payload
        // FOLDED with the store's shallow-merge semantics (a trailing
        // {note} write must not hide an earlier {balance:0} from the gate
        // — review finding F4), `previous` = the pre-transaction snapshot.
        // Final committed state for a set = {...previous, ...data}. A
        // Σ(new − previous) predicate counts each entity once. Copies,
        // never live references. Veto → settle as rollback (0.3 guarantees
        // disk untouched), then fail visibly.
        if (gates.size > 0) {
          const netByKey = new Map<string, ProposedWrite>();
          for (const m of mutations) {
            const key = entityKey(m.entityType, m.id);
            const prior = netByKey.get(key);
            // Fold exactly like the store applies writes: sets shallow-merge
            // onto the running net (a remove resets the base — a set after
            // it starts fresh); a remove ends the net as a removal.
            let netData: EntityRecord | undefined;
            if (m.type === "set" && m.data) {
              const base = prior?.type === "set" ? prior.data : undefined;
              netData = base ? { ...base, ...m.data } : { ...m.data };
            } else {
              netData = undefined;
            }
            const truth = serverTruth.get(key);
            netByKey.set(key, {
              entityType: m.entityType,
              id: m.id,
              type: m.type === "remove" ? "remove" : "set",
              data: netData,
              previous: truth?.data ? { ...truth.data } : undefined,
            });
          }
          const veto = checkCommit([...netByKey.values()], transactionId);
          if (veto) {
            doRollback();
            throw new PolicyVetoError("commit", transactionId, veto.reason);
          }
        }

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

        notifySettled(transactionId, "commit");
      },

      rollback: doRollback,
    };
  }

  function apply(
    entityType: string,
    id: string,
    data: EntityRecord,
  ): Pick<OptimisticTransaction, "commit" | "rollback"> {
    const tx = transaction();
    try {
      tx.set(entityType, id, data);
    } catch (err) {
      // A gate veto throws before the caller ever receives the handle —
      // settle the otherwise-orphaned transaction so it can't linger in
      // the replay bookkeeping forever.
      tx.rollback();
      throw err;
    }
    return { commit: () => tx.commit(), rollback: () => tx.rollback() };
  }

  function onSettled(listener: (event: TransactionSettledEvent) => void): () => void {
    settledListeners.add(listener);
    return () => {
      settledListeners.delete(listener);
    };
  }

  function useGate(gate: PolicyGate): () => void {
    gates.add(gate);
    return () => {
      gates.delete(gate);
    };
  }

  return { apply, transaction, onSettled, useGate };
}
