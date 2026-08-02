/**
 * The SyncAdapter wire contract — ADR-006 rev d (2026-08-02), as TypeScript.
 *
 * This is a TRANSCRIPTION of the frozen contract, the same way
 * `docs/specs/sync-adapter.allium` is. It invents nothing. Where a comment
 * cites a D-number it is pointing at the rev-d resolution that settled that
 * clause, and the ADR remains the asserter.
 *
 * ## ⚠️ NOT re-exported from `src/index.ts`, and that is deliberate
 *
 * ADR-022 lines 1 and 2: the public API surface and the packed manifest are
 * irreversibility lines. Exporting these types would add a permanent
 * compatibility promise for a coordinator that does not exist yet — the exact
 * calcification freezing this contract early was meant to prevent. They live
 * here so the conformance kit can compile against them; promoting them to a
 * published entry point is a separate, deliberate act.
 *
 * `src/engine-conformance.ts` sets this precedent and states the same rule.
 *
 * ## Why these types exist before the coordinator does
 *
 * The contract is frozen and unbuilt, which is the entire point. A third-party
 * adapter author needs something to implement against, and the conformance kit
 * needs something to check. Neither can wait for a coordinator, because the
 * coordinator is what the kit is supposed to protect from a bad adapter.
 */

/** An entity payload. Neither colada-db nor the adapter inspects its shape. */
export type SyncEntityRecord = Record<string, unknown>;

/**
 * Backend-supplied ordering token (ADR-005 §1: opaque, never fabricated by the
 * store). `string | number` — widened from `number` before the 0.1.0 publish so
 * a hybrid logical clock stays representable in the slot. Core must never apply
 * a relational operator to one; every comparison routes through
 * {@link SyncAdapter.compareVersions} (rev c C2).
 */
export type SyncVersion = string | number;

/**
 * rev d / D3 — four-valued, because three cannot say *concurrent* and C2
 * requires this seam to be able to express a partial order.
 *
 * The default comparator never returns `"concurrent"`, so the fourth value
 * costs a server-authoritative deployment nothing. It exists so a future E2EE
 * or CRDT-ish adapter has somewhere to put causality that today's code already
 * routes through, rather than a comparison site that must later change.
 */
export type SyncVersionOrder = "older" | "same" | "newer" | "concurrent";

/** A change arriving FROM the backend. Deletes are tombstones, never omissions. */
export interface RemoteChange {
  /** `remove` = tombstone. A hard delete with no tombstone is unsyncable: an
   *  absent row is indistinguishable from a row outside the current selection. */
  type: "set" | "remove";
  entityType: string;
  id: string;
  /** Absent for `remove`. */
  data?: SyncEntityRecord;
  version: SyncVersion;
}

/**
 * rev d / D19. A mutation's INTENT rather than its result — a named mutator and
 * its arguments (Zero / Replicache style), which a matched client+server pair
 * replays server-side for true rebase.
 *
 * Optional, and `data` stays required, because a bring-your-own-backend
 * contract cannot assume the server runs client code: an existing REST API
 * cannot execute a function from your client bundle. An adapter that does not
 * understand `intent` ignores it and applies `data`.
 */
export interface MutationIntent {
  name: string;
  args: unknown;
}

/** A committed local write heading TO the backend — one outbox entry. */
export interface LocalChange {
  /** Idempotency key. HLC-style: time + counter + clientId (unique AND ordered). */
  mutationId: string;
  /** Opaque per rev c C3 — core never generates, validates or parses it, so a
   *  decentralized adapter may put a public-key fingerprint here. */
  clientId: string;
  /** Monotonic per client. Server ignores `seq <= lastSeen`, rejects gaps. */
  seq: number;
  /** Groups a multi-entity optimistic transaction for atomic server apply. */
  transactionId?: string;
  op: "set" | "remove";
  entityType: string;
  id: string;
  /** PATCH-style dirty fields preferred over full rows. */
  data?: SyncEntityRecord;
  /** The version the client last saw; the server may use it for conflict checks. */
  baseVersion?: SyncVersion;
  /** rev d / D19 — optional. See {@link MutationIntent}. */
  intent?: MutationIntent;
}

export interface PushVerdict {
  mutationId: string;
  /**
   * - `ack` — applied; carries the server watermark in `version`.
   * - `reject` — PERMANENTLY invalid. The server MUST still advance its
   *   per-client seq, or the client wedges forever behind a write it can never
   *   retract. **A transient failure is NOT a reject** — the adapter signals
   *   those by throwing from `push()`, and returning `reject` for one causes
   *   permanent silent loss of a valid user write.
   * - `transform` — the server rebased the write; carries the corrected entity
   *   and MAY carry an id remap.
   */
  status: "ack" | "reject" | "transform";
  data?: SyncEntityRecord;
  version?: SyncVersion;
  /** Temp-ID → server-ID. Applied atomically (rev d / D2: immediately, unlike
   *  the overlay drop, which waits for pull confirmation). */
  remappedId?: string;
}

export interface PushResult {
  results: PushVerdict[];
}

export type PullResult =
  | {
      type: "changes";
      changes: RemoteChange[];
      /** Opaque; adapters may encode Electric-style `{handle, offset}` inside. */
      cursor: string;
      /** `false` = more batches follow. The coordinator STAGES and applies only
       *  at `complete`, so a partial snapshot is never observable to the app. */
      complete: boolean;
      /**
       * Replicache-style `lastMutationIDChanges`. **The sole confirmation
       * channel as of rev d / D1** — the overlay is dropped here, on the pull
       * channel, never on a push ack alone.
       */
      confirmedMutations?: Record<string, number>;
      /** rev d / D11 — verification is PRESENCE-driven. Sending this asserts it
       *  means something; a mismatch resets this subscription and only this one. */
      checksum?: string;
      /** rev d / D5 — which partition this belongs to. Opaque: the adapter owns
       *  the namespace and core never parses it. Absent = the single default
       *  partition, which is the entire single-subscription case. */
      subscription?: string;
    }
  | {
      /** Cursor expired / compaction / DDL / corruption: discard that partition
       *  and resync. Applied per-subscription with jitter, never a global storm. */
      type: "reset";
      cursor?: string;
      subscription?: string;
    };

export interface PullOptions {
  /** rev d / D8 — a HINT. An adapter MAY return fewer and MUST NOT return more.
   *  Omitted means the adapter chooses; core imposes no ceiling. */
  limit?: number;
  schemaVersion?: string;
  /** rev d / D5 — the opaque partition name. */
  subscription?: string;
}

/** Transport to one backend. Implement three methods; the coordinator does the rest. */
export interface SyncAdapter {
  /** PULL: server → client. Cursor-based, batched, resumable. `null` = initial sync. */
  pull(cursor: string | null, opts?: PullOptions): Promise<PullResult>;
  /**
   * PUSH: client → server. Ordered outbox delivery; per-change verdicts.
   *
   * **Contract: `push` MUST NOT resolve until the write is durable in the same
   * store `pull()` reads from.** An adapter that resolves on enqueue into an
   * async backend queue breaks sync — the coordinator will pull a snapshot that
   * does not contain the write it was just told had landed.
   */
  push(batch: LocalChange[], opts?: { schemaVersion?: string }): Promise<PushResult>;
  /** Optional live channel — POKE-FIRST. A bare hint that triggers `pull()`;
   *  inline data is an optimization, not a delivery guarantee. Licensed to be
   *  lossy: `reset` on the pull channel is the recovery path. */
  subscribe?(onEvent: (event: { type: "poke" } | PullResult) => void): () => void;
  /** OPTIONAL, rev d / D3. Omit it and core uses the default comparator:
   *  numeric when both tokens parse as numbers, lexicographic otherwise —
   *  which never returns `"concurrent"`. */
  compareVersions?(a: SyncVersion, b: SyncVersion): SyncVersionOrder;
}

/**
 * The default comparator (rev c C2, rev d D3).
 *
 * **Architecture Invariant:** this NEVER returns `"concurrent"`. An adapter
 * that needs to express concurrency must supply its own — which is the whole
 * reason `compareVersions` is on the adapter rather than baked into core.
 */
export function defaultCompareVersions(a: SyncVersion, b: SyncVersion): SyncVersionOrder {
  const an = typeof a === "number" ? a : Number(a);
  const bn = typeof b === "number" ? b : Number(b);
  const bothNumeric = Number.isFinite(an) && Number.isFinite(bn);
  if (bothNumeric) return an === bn ? "same" : an > bn ? "newer" : "older";
  const as = String(a);
  const bs = String(b);
  return as === bs ? "same" : as > bs ? "newer" : "older";
}
