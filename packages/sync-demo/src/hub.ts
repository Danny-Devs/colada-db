/**
 * The hub — ONE in-page, in-memory, server-authoritative backend that both
 * demo clients sync through. It implements `SyncAdapter` (ADR-006 rev d)
 * directly: there is no HTTP, no wire-protocol-v1 body, no process boundary.
 * That is the honest minimum the ticket asks for, and `hub.spec.ts` runs the
 * real conformance kit against it so the transport is proven, not assumed.
 *
 * Posture, per ADR-006 §6: server-authoritative. Every well-formed write is
 * applied in arrival order and acked — the LAST arrival wins, and the hub's
 * verdict is final. There is no `transform` (no rebase) and the only `reject`
 * is a malformed change (empty type or id). Deletes are tombstones, never
 * omissions; `confirmedMutations` rides on every pull (D1, the sole
 * confirmation channel); the live channel is poke-first (D16).
 *
 * Adapted from the reference adapter in `src/sync-conformance.spec.ts`, minus
 * the mutants and plus the observability the UI needs (`stats`, `rows`,
 * `onChange`).
 *
 * What this is NOT (ADR-023): not the server conformance kit (artifact 2) and
 * not the reference server (artifact 3). Both are still open.
 */
import type {
  LocalChange,
  PullResult,
  PushResult,
  PushVerdict,
  RemoteChange,
  SyncAdapter,
  SyncEntityRecord,
} from "@core/sync-types";

/** The schema version this hub serves; anything else is refused per D12. */
export const HUB_SCHEMA_VERSION = "v1";

export interface HubRow {
  entityType: string;
  id: string;
  data?: SyncEntityRecord;
  /** Hub-wide monotonic clock at the moment of apply — the ADR-005 ordering token. */
  version: number;
  /** A tombstone. Never dropped: the hub honours every cursor it ever issued (D15). */
  deleted: boolean;
}

export interface HubStats {
  live: number;
  tombstones: number;
  clock: number;
  /** Distinct clientIds that have pushed at least once. */
  clients: number;
}

export interface SyncHub {
  /** The server-side transport. Every client wraps THIS (see client-adapter.ts). */
  adapter: SyncAdapter;
  /** Write on the server, bypassing push — the conformance kit's `seedRemote` hook. */
  seedRemote(entityType: string, id: string, data: SyncEntityRecord): void;
  /** Delete on the server as a tombstone — the kit's `removeRemote` hook. */
  removeRemote(entityType: string, id: string): void;
  /** Make the NEXT push throw (a transient fault) — the kit's hook for D9's confusion. */
  simulateTransientFailure(): void;
  stats(): HubStats;
  rows(): HubRow[];
  /** Fires after every server-side change (push apply, seed, remove). UI only. */
  onChange(listener: () => void): () => void;
}

const key = (entityType: string, id: string): string => `${entityType}:${id}`;

export function createSyncHub(): SyncHub {
  const rows = new Map<string, HubRow>();
  /** mutationId → verdict: replay is idempotent (same verdict, no second apply). */
  const applied = new Map<string, PushVerdict>();
  /** clientId → highest seq applied or rejected — becomes `confirmedMutations`. */
  const lastSeen = new Map<string, number>();
  const liveListeners = new Set<(e: { type: "poke" } | PullResult) => void>();
  const changeListeners = new Set<() => void>();
  let clock = 0;
  let pendingTransient = false;

  /** Poke-first (D16): a bare hint that a pull is worth doing. Never carries data. */
  function poke(): void {
    queueMicrotask(() => {
      for (const l of liveListeners) l({ type: "poke" });
    });
  }
  function changed(): void {
    for (const l of changeListeners) l();
    poke();
  }

  function apply(c: LocalChange): void {
    clock += 1;
    rows.set(key(c.entityType, c.id), {
      entityType: c.entityType,
      id: c.id,
      data: c.op === "remove" ? undefined : c.data,
      version: clock,
      deleted: c.op === "remove",
    });
  }

  const adapter: SyncAdapter = {
    async push(batch, opts): Promise<PushResult> {
      if (pendingTransient) {
        pendingTransient = false;
        // A transient condition is THROWN, never returned as `reject` — the
        // coordinator retries with backoff; a reject would drop the write.
        throw new Error("transient: hub unreachable");
      }
      if (opts?.schemaVersion !== undefined && opts.schemaVersion !== HUB_SCHEMA_VERSION) {
        // D12 — name-based so the coordinator suspends the outbox instead of
        // draining it (it matches `err.name`, never message text).
        const err = new Error(`hub cannot serve schema version ${opts.schemaVersion}`);
        err.name = "SchemaVersionError";
        throw err;
      }

      const results: PushVerdict[] = [];
      let touched = false;
      for (const c of batch) {
        const already = applied.get(c.mutationId);
        if (already) {
          results.push(already); // idempotent replay
          continue;
        }
        if (!c.entityType || !c.id) {
          // The one permanent verdict this hub issues. The per-client seq
          // still advances, or the client wedges behind a write it can
          // never retract (RejectStillAdvancesServerSeq).
          const verdict: PushVerdict = { mutationId: c.mutationId, status: "reject" };
          lastSeen.set(c.clientId, Math.max(lastSeen.get(c.clientId) ?? 0, c.seq));
          applied.set(c.mutationId, verdict);
          results.push(verdict);
          continue;
        }
        apply(c);
        touched = true;
        lastSeen.set(c.clientId, Math.max(lastSeen.get(c.clientId) ?? 0, c.seq));
        const verdict: PushVerdict = { mutationId: c.mutationId, status: "ack", version: clock };
        applied.set(c.mutationId, verdict);
        results.push(verdict);
      }
      // Durable-before-resolve holds trivially: the Map IS the store pull reads.
      if (touched) changed();
      return { results };
    },

    async pull(cursor, opts): Promise<PullResult> {
      if (opts?.schemaVersion !== undefined && opts.schemaVersion !== HUB_SCHEMA_VERSION) {
        return { type: "reset" }; // D12: never an empty "you are synced" batch
      }
      const from = cursor === null ? 0 : Number(cursor);
      // A cursor this hub never issued is refused loudly, not served as a gap.
      if (cursor !== null && (!Number.isFinite(from) || from < 0 || from > clock)) return { type: "reset" };

      const pending = [...rows.values()].filter((r) => r.version > from).sort((a, b) => a.version - b.version);
      const limit = opts?.limit ?? 500;
      const slice = pending.slice(0, limit);
      const changes: RemoteChange[] = slice.map((r) => ({
        type: r.deleted ? "remove" : "set",
        entityType: r.entityType,
        id: r.id,
        ...(r.deleted ? {} : { data: r.data }),
        version: r.version,
      }));
      return {
        type: "changes",
        changes,
        cursor: String(slice.at(-1)?.version ?? from),
        complete: slice.length === pending.length,
        confirmedMutations: Object.fromEntries(lastSeen),
        // D5 — echoed as bytes; the hub has one partition and never parses the name.
        ...(opts?.subscription !== undefined ? { subscription: opts.subscription } : {}),
      };
    },

    subscribe(onEvent) {
      liveListeners.add(onEvent);
      return () => {
        liveListeners.delete(onEvent);
      };
    },
    // No `compareVersions`: the default (numeric) comparator is exactly right
    // for a monotonic integer clock, and a server-authoritative reference
    // should not pretend it can say "concurrent".
  };

  return {
    adapter,
    seedRemote(entityType, id, data) {
      clock += 1;
      rows.set(key(entityType, id), { entityType, id, data, version: clock, deleted: false });
      changed();
    },
    removeRemote(entityType, id) {
      clock += 1;
      rows.set(key(entityType, id), { entityType, id, data: undefined, version: clock, deleted: true });
      changed();
    },
    simulateTransientFailure() {
      pendingTransient = true;
    },
    stats() {
      let tombstones = 0;
      for (const r of rows.values()) if (r.deleted) tombstones += 1;
      return { live: rows.size - tombstones, tombstones, clock, clients: lastSeen.size };
    },
    rows() {
      return [...rows.values()].sort((a, b) => a.version - b.version);
    },
    onChange(listener) {
      changeListeners.add(listener);
      return () => {
        changeListeners.delete(listener);
      };
    },
  };
}
