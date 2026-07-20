/**
 * The capped history store (ADR-007 §3, Evolu-validated) — a bounded,
 * queryable log of field-level changes: who changed what, from what, to
 * what, on which channel. The substrate for undo, devtools ("why did this
 * field change?"), and agent receipts ("what did the agent touch?").
 *
 * Memory-only in Stage 2 (no durable trail yet — by design: the history
 * must never outlive the erasure semantics below).
 *
 * Semantics:
 * - `set` events → one row per changed field (shallow diff of
 *   previousData → data), all rows of one event sharing a mutationId.
 * - `remove` events → PURGE every retained row for that entity, then
 *   append a single data-free remove marker. Erasure/logout must actually
 *   erase: `store.clear()` emits a remove per entity, so a reset scrubs
 *   the history of entity data too (audit amendment).
 *
 *   ⚠️ ERASURE BOUNDARY (2026-07-19 review finding): the guarantee holds
 *   for SETTLED state. In-flight optimistic transactions hold replay
 *   copies (server-truth snapshots + mutation logs) that `remove`/`clear`
 *   do not invalidate — a later rollback replays them, re-writing the
 *   store and re-recording rows here. Settle or abort all transactions
 *   BEFORE an erasure flow (logout). Transaction-aware erasure
 *   invalidation is specced as follow-up work (see the erasure boundary
 *   test in history.spec.ts, which pins today's behavior).
 * - `evict` events → excluded entirely. Cache trimming is not a data
 *   change; existing rows for the entity remain (they describe real
 *   changes that happened).
 * - Bounds: BOTH a row-count cap and a byte budget (estimated via JSON
 *   size). Oldest rows drop first; a single row larger than the whole
 *   byte budget is not retained at all (budget-honest, no exceptions).
 *
 * Origin caveat inherited from the write channel: rows attribute writes
 * within one trust domain — they are receipts material, not proof against
 * a hostile same-realm caller (see WriteOrigin).
 */
import type { EntityEvent, EntityKey, EntityStore, WriteOrigin } from "./types";

/** One field-level change (or a data-free remove marker when field is null). */
export interface HistoryEntry {
  key: EntityKey;
  entityType: string;
  id: string;
  /** The changed field; `null` on the remove marker row. */
  field: string | null;
  /** Value before the change (undefined on the remove marker — erased). */
  old: unknown;
  /** Value after the change (undefined on the remove marker). */
  new: unknown;
  /** Write id — groups the rows of one event; unique per history store. */
  mutationId: string;
  /** Write channel that produced the change (undefined = plain store API). */
  origin?: WriteOrigin;
  /** Owning optimistic transaction, when the write was transactional. */
  transactionId?: string;
  type: "set" | "remove";
}

export interface HistoryOptions {
  /** Maximum retained rows. @default 1000 */
  maxEntries?: number;
  /** Maximum retained bytes (JSON-estimated). @default 1_048_576 (1 MiB) */
  maxBytes?: number;
}

export interface HistoryStore {
  /** Snapshot of retained rows, oldest first. Optionally filtered. */
  list(filter?: {
    entityType?: string;
    id?: string;
    origin?: WriteOrigin;
    transactionId?: string;
  }): HistoryEntry[];
  /** Retained row count. */
  size(): number;
  /** Retained byte estimate. */
  bytes(): number;
  /** Unsubscribe from the store; retained rows stay readable. */
  dispose(): void;
}

/**
 * Monotonic write-id generator. mutationId has no upstream source until
 * Stage 3's LocalChange (HLC ids, ADR-006) — until then this is the
 * single place write identity is minted, so swapping the source later
 * touches one seam.
 */
export function createWriteIdGenerator(prefix = "w"): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

/** JSON-size estimate; entries hold normalized plain data, but stay safe. */
function estimateBytes(entry: HistoryEntry): number {
  try {
    return JSON.stringify(entry).length;
  } catch {
    return 256; // non-serializable payload — charge a flat estimate
  }
}

/**
 * Attach a history store to an entity store. Subscribes to the event
 * stream; recording starts at attach time (no retroactive history).
 */
export function enableHistory(store: EntityStore, options: HistoryOptions = {}): HistoryStore {
  const { maxEntries = 1000, maxBytes = 1_048_576 } = options;

  const rows: Array<{ entry: HistoryEntry; bytes: number }> = [];
  let totalBytes = 0;
  const nextWriteId = createWriteIdGenerator();

  function push(entry: HistoryEntry): void {
    const bytes = estimateBytes(entry);
    rows.push({ entry, bytes });
    totalBytes += bytes;
    // Enforce both caps, oldest-first. The new row itself is evicted if it
    // alone busts the byte budget — budget-honest over history-complete.
    while (rows.length > 0 && (rows.length > maxEntries || totalBytes > maxBytes)) {
      totalBytes -= rows.shift()!.bytes;
    }
  }

  /** Erasure: drop every retained row for an entity key. */
  function purge(key: EntityKey): void {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].entry.key === key) {
        totalBytes -= rows[i].bytes;
        rows.splice(i, 1);
      }
    }
  }

  const unsub = store.subscribe((event: EntityEvent) => {
    if (event.type === "evict") return; // cache trimming ≠ data change

    if (event.type === "remove") {
      purge(event.key);
      push({
        key: event.key,
        entityType: event.entityType,
        id: event.id,
        field: null,
        old: undefined, // deliberately erased — never retain removed data
        new: undefined,
        mutationId: nextWriteId(),
        origin: event.origin,
        transactionId: event.transactionId,
        type: "remove",
      });
      return;
    }

    // set — shallow field diff, one row per changed field, one write id
    const prev = (event.previousData ?? {}) as Record<string, unknown>;
    const next = (event.data ?? {}) as Record<string, unknown>;
    const fields = new Set([...Object.keys(prev), ...Object.keys(next)]);
    const mutationId = nextWriteId();
    for (const field of fields) {
      if (Object.is(prev[field], next[field])) continue;
      push({
        key: event.key,
        entityType: event.entityType,
        id: event.id,
        field,
        old: prev[field],
        new: next[field],
        mutationId,
        origin: event.origin,
        transactionId: event.transactionId,
        type: "set",
      });
    }
  });

  return {
    list(filter) {
      let out = rows.map((r) => r.entry);
      if (filter?.entityType !== undefined) out = out.filter((e) => e.entityType === filter.entityType);
      if (filter?.id !== undefined) out = out.filter((e) => e.id === filter.id);
      if (filter?.origin !== undefined) out = out.filter((e) => e.origin === filter.origin);
      if (filter?.transactionId !== undefined)
        out = out.filter((e) => e.transactionId === filter.transactionId);
      return out;
    },
    size: () => rows.length,
    bytes: () => totalBytes,
    dispose: unsub,
  };
}
