/**
 * The sync coordinator — `enableSync(store, opts)` — ADR-006 rev d.
 *
 * Turns the frozen `SyncAdapter` contract (`src/sync-types.ts`) into a working
 * local-first sync loop: taps locally-committed writes into a durable-shaped
 * outbox, pushes them, pulls remote changes, and arbitrates "which write wins"
 * with a version-aware apply. See `docs/adr/006-sync-adapter-interface.md`
 * "Coordinator semantics" and both "Implementation note" sections — this file
 * is their executable form, and every non-obvious choice below cites the
 * clause it resolves.
 *
 * NOT re-exported from `src/index.ts` — ADR-022 lines 1-2 (same precedent as
 * `sync-types.ts` / `sync-conformance.ts`). Promoting this to a published
 * entry point is a separate, later, deliberate act.
 */
import type { EntityDefinition, EntityEvent, EntityRecord, EntityStore, StorageEngine, WriteOrigin } from "./types";
import { defaultCompareVersions } from "./sync-types";
import type { LocalChange, PullResult, PushVerdict, RemoteChange, SyncAdapter, SyncVersion } from "./sync-types";

/** Thrown by an adapter's `push()` when the client's `schemaVersion` can no longer be served. */
export class SchemaVersionError extends Error {
  constructor(message = "schema version mismatch") {
    super(message);
    this.name = "SchemaVersionError";
  }
}

type EntityKeyStr = string;
function toKey(entityType: string, id: string): EntityKeyStr {
  return `${entityType}:${id}`;
}

/** One outbox entry — a local write not yet confirmed by the pull channel (rev d D1). */
interface OutboxEntry {
  mutationId: string;
  clientId: string;
  seq: number;
  transactionId?: string;
  op: "set" | "remove";
  entityType: string;
  id: string;
  data?: EntityRecord;
  baseVersion?: SyncVersion;
  /** How many authoritative server-side store writes (pull-applies + transform data-applies)
   *  this key had seen when this entry captured `previousData` — the revert gate compares
   *  against the live counter, never the version map (an ack advances versions WITHOUT
   *  writing the store). Adopted entries take the session floor 0: their `previousData` is
   *  from a previous session by construction. See `revertAndReplay`. */
  baseServerGen: number;
  intent?: { name: string; args: unknown };
  /** rev d / D4 — minted at commit time (outbox-entry-creation time here), never at push time. */
  auth?: unknown;
  /** For `reject` compensating writes and revert-and-replay — see ADR-006 "Implementation note, part 2". */
  previousData?: EntityRecord;
  previousExisted: boolean;
  /** `ack`/`transform` already landed server-side; only pull confirmation retires the entry (D1/D2). */
  pushed: boolean;
}

/** A stranded sibling's outbox entry, forwarded exactly as committed (§1c/D4). Never re-authored. */
export interface StrandedOutboxEntry {
  mutationId: string;
  clientId: string;
  seq: number;
  transactionId?: string;
  op: "set" | "remove";
  entityType: string;
  id: string;
  data?: EntityRecord;
  baseVersion?: SyncVersion;
  intent?: { name: string; args: unknown };
  auth?: unknown;
  /**
   * What this entity held before this entry's own mutation, captured by the sibling at ITS
   * commit time (same fields `OutboxEntry` carries for this exact purpose). Required for a
   * correct `reject` revert — omitting it makes a rejected relayed entry always resolve to
   * "didn't exist", silently deleting an entity that a reject should instead have reverted to
   * its prior value. A recovery source that cannot supply this should not adopt `set` entries
   * over pre-existing entities without accepting that risk.
   */
  previousData?: EntityRecord;
  previousExisted?: boolean;
}

export interface RetryState {
  attempt: number;
  nextRetryAt: number | null;
  suspendedForSchema: boolean;
}

export interface SubscriptionSpec {
  /** Opaque partition name (rev d / D5). Omit for the single default partition. */
  name?: string;
  /** Higher = pulled first. Only affects the ORDER pulls are *started* in (D20) — never blocking. */
  priority?: number;
}

export interface EnableSyncOptions {
  adapter: SyncAdapter;
  /**
   * Opaque per rev c C3 — never parsed, validated, or format-checked here.
   *
   * ⚠️ **Without `outboxEngine`, a `clientId` must be fresh per coordinator
   * instance.** The in-memory outbox restarts `seq` at 1 on every
   * `enableSync()`, and the wire contract has the server ignore
   * `seq <= lastSeen` — so reusing a stable `clientId` across reloads makes
   * the server silently ignore EVERY post-reload write (DAN-777 finding A).
   * Supply `outboxEngine` to get the ADR-006 §1 durable outbox, which is what
   * makes a stable `clientId` safe.
   */
  clientId: string;
  /**
   * ADR-006 §1 — the durable outbox. A SEPARATE StorageEngine instance (its
   * own file/store — e.g. `idbEngine({ dbName: "cdb_outbox" })`), never the
   * entity store's engine: §1 requires that a state reset can never destroy
   * unpushed writes. When supplied, outbox entries and the per-client `seq`
   * watermark are persisted at commit time and restored on boot, so pending
   * pushes survive reloads and `seq` never regresses (the watermark is its
   * own row rather than derived from surviving entries — confirmed entries
   * are deleted, and re-issuing their seqs would be silently ignored
   * server-side). One coordinator instance per `clientId` per outbox store;
   * sibling tabs recover each other via `recoverStrandedOutbox`, not by
   * sharing one live store. Persistence failures degrade gracefully to
   * in-memory operation with a console warning — a storage fault must not
   * block local writes.
   */
  outboxEngine?: StorageEngine;
  /** Same shape `normalize.ts` already takes — there is no global entity-definition registry. */
  entityDefs?: Record<string, EntityDefinition>;
  subscriptions?: SubscriptionSpec[];
  schemaVersion?: string;
  pullLimit?: number;
  /** rev d / D4 — called once per outbox entry, at commit time. Omit for no auth material. */
  mintAuth?: () => unknown;
  /**
   * Boot-time sibling-outbox recovery (§1c/D4). Called once at `enableSync()`
   * start; returns OTHER same-device clients' stranded entries to relay
   * exactly as committed. Never invoked again — adoption is boot-time only.
   */
  recoverStrandedOutbox?: () => StrandedOutboxEntry[] | Promise<StrandedOutboxEntry[]>;
  /** Interval between pull cycles — the poll cadence when the adapter has no live `subscribe()`
   *  channel, and a background re-pull cadence alongside one (D16 licenses the live channel to
   *  be lossy, so polling next to it is a safety net, not a contradiction). Default 30s. */
  pollIntervalMs?: number;
}

export interface SyncCoordinatorHandle {
  /** Stop accepting new work. Already-in-flight push verdicts still apply (see file header); pull does not. */
  stop(): void;
  /** rev d / D9 — the coordinator's push retry state, so an app can surface "not landed yet". */
  getRetryState(): RetryState;
  /**
   * Diagnostic — how many outbox entries are still unconfirmed (pushed or not).
   * An entry counts here from creation until a pull's `confirmedMutations` mark
   * retires it (D1) — this is the one place "has the overlay actually dropped
   * yet" is externally observable, since the outbox itself is private state.
   */
  getPendingCount(): number;
  /**
   * D12 says a schema mismatch "suspends the outbox" but does not specify how
   * suspension lifts — the coordinator cannot detect an app-level migration on
   * its own, so this is how the app says "I've migrated; resume." A no-op if
   * the outbox is not currently suspended.
   */
  resumeAfterSchemaMigration(): void;
}

const PUSH_BASE_DELAY_MS = 1000;
const PUSH_MAX_DELAY_MS = 60_000;
const RESET_JITTER_MAX_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 30_000;

/** rev d / D9 — exponential backoff with FULL jitter, 1s base, no ceiling on attempts.
 *  `attempt` is 1-indexed (the first failure passes 1), so the first retry's cap is
 *  genuinely `PUSH_BASE_DELAY_MS` (1s), not 2s. */
function pushBackoffDelay(attempt: number): number {
  const cap = Math.min(PUSH_MAX_DELAY_MS, PUSH_BASE_DELAY_MS * 2 ** (attempt - 1));
  return Math.random() * cap;
}

/** rev d / D10 — uniform in [0, 30s), drawn independently per subscription. */
function resetJitterDelay(): number {
  return Math.random() * RESET_JITTER_MAX_MS;
}

let mutationCounter = 0;
/** HLC-style: time + counter + clientId — unique AND ordered (§1 `LocalChange.mutationId`). */
function makeMutationId(clientId: string): string {
  mutationCounter += 1;
  return `${Date.now()}-${mutationCounter}-${clientId}`;
}

export function enableSync(store: EntityStore, opts: EnableSyncOptions): SyncCoordinatorHandle {
  const {
    adapter,
    clientId,
    entityDefs = {},
    schemaVersion,
    pullLimit,
    mintAuth,
    recoverStrandedOutbox,
    outboxEngine,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  } = opts;
  const subscriptions: SubscriptionSpec[] = opts.subscriptions?.length ? opts.subscriptions : [{}];
  // D20 — starts requested in priority order; nothing here ever awaits one before starting the next.
  const orderedSubs = [...subscriptions].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const compareVersions = adapter.compareVersions ?? defaultCompareVersions;

  // `stopped` gates the START of new work only — see the file header and the
  // 2026-07-22 LESSONS entry this design deliberately does not repeat.
  let stopped = false;

  const outbox: OutboxEntry[] = [];
  let seqCounter = 0;
  const nextSeq = (): number => (seqCounter += 1);
  /** Highest `confirmedMutations` mark seen per clientId (review A1) — so a
   *  mark that arrived before a restore/adoption completed still retires the
   *  late-arriving entries it covers. Marks are cumulative by definition. */
  const confirmedHighWater = new Map<string, number>();

  // ── ADR-006 §1 — the durable outbox (DAN-777 finding A) ─────────────────
  // Row layout in the caller-supplied SEPARATE engine: one meta row holding
  // the seq watermark, one row per still-pending OWN-client entry. Adopted
  // sibling entries are never persisted here — they belong to the recovery
  // source that supplied them and are re-supplied on the next boot.
  const OUTBOX_META_KEY = "outbox-meta:seq" as const;
  const entryKey = (seq: number): `outbox-entry:${number}` => `outbox-entry:${seq}`;

  /** The commit-time facts a reload must restore. `baseServerGen` and `pushed`
   *  are deliberately NOT persisted: server-write generations are
   *  session-scoped (a restored entry takes the session floor 0, the same
   *  reasoning as adoption — its `previousData` is from a previous session by
   *  construction), and a pushed-but-unconfirmed entry is safely re-pushed
   *  because the server dedups by `mutationId`. */
  interface PersistedOutboxEntry {
    mutationId: string;
    clientId: string;
    seq: number;
    transactionId?: string;
    op: "set" | "remove";
    entityType: string;
    id: string;
    data?: EntityRecord;
    baseVersion?: SyncVersion;
    intent?: { name: string; args: unknown };
    auth?: unknown;
    previousData?: EntityRecord;
    previousExisted: boolean;
  }

  let outboxPersistWarned = false;
  function warnOutboxPersist(err: unknown): void {
    if (outboxPersistWarned) return;
    outboxPersistWarned = true;
    console.warn("[colada-db sync] durable outbox write failed — continuing in-memory:", err);
  }

  function toPersisted(entry: OutboxEntry): PersistedOutboxEntry {
    return {
      mutationId: entry.mutationId,
      clientId: entry.clientId,
      seq: entry.seq,
      transactionId: entry.transactionId,
      op: entry.op,
      entityType: entry.entityType,
      id: entry.id,
      data: entry.data,
      baseVersion: entry.baseVersion,
      intent: entry.intent,
      auth: entry.auth,
      previousData: entry.previousData,
      previousExisted: entry.previousExisted,
    };
  }

  let outboxEngineOpened = false;

  /** Persist one own-client entry plus the seq watermark, best-effort. The
   *  watermark rides on every entry write, so it can only ever grow. */
  function persistEntry(entry: OutboxEntry): void {
    if (!outboxEngine || !outboxEngineOpened || entry.clientId !== clientId) return;
    outboxEngine
      .writeBatch(
        [
          { key: entryKey(entry.seq), value: toPersisted(entry) },
          { key: OUTBOX_META_KEY, value: { seq: seqCounter } },
        ],
        [],
      )
      .catch(warnOutboxPersist);
  }

  /** Delete a retired (confirmed or rejected) entry's persisted row. */
  function retireEntry(entry: OutboxEntry): void {
    if (!outboxEngine || !outboxEngineOpened || entry.clientId !== clientId) return;
    outboxEngine.writeBatch([], [entryKey(entry.seq)]).catch(warnOutboxPersist);
  }

  /** Local-mutation events observed before the durable outbox finished
   *  loading. Everything commit-time is already captured (mutationId, auth,
   *  previousData — D4's mint-at-commit law); only `seq` waits, because it
   *  must be allocated AFTER the restored watermark or a fast first write
   *  collides with a previous session's numbering. `null` = no buffering
   *  (no engine, or boot complete). */
  let preBootBuffer: Array<Omit<OutboxEntry, "seq">> | null = outboxEngine ? [] : null;

  function materializeEntry(captured: Omit<OutboxEntry, "seq">): void {
    const entry: OutboxEntry = { ...captured, seq: nextSeq() };
    outbox.push(entry);
    persistEntry(entry);
  }

  async function bootDurableOutbox(engine: StorageEngine): Promise<void> {
    try {
      if (engine.isSupported()) {
        await engine.open();
        outboxEngineOpened = true;
        // Review B2 (DAN-777 gauntlet): stop() before open() resolved cannot
        // close what is not yet open — so the close is owed HERE. A leaked
        // handle can hold an exclusive OPFS lock and silently degrade the
        // next instance to in-memory, resurrecting the finding-A hazard.
        if (stopped) {
          outboxEngineOpened = false;
          engine.close();
          return;
        }
        const rows = await engine.loadAll();
        if (stopped) {
          outboxEngineOpened = false;
          engine.close();
          return;
        }
        let watermark = 0;
        const restored: PersistedOutboxEntry[] = [];
        for (const row of rows) {
          if (row.key === OUTBOX_META_KEY) {
            const seq = (row.data as { seq?: unknown } | undefined)?.seq;
            if (typeof seq === "number") watermark = Math.max(watermark, seq);
          } else if (row.key.startsWith("outbox-entry:")) {
            const p = row.data as PersistedOutboxEntry | undefined;
            // Review A5: one corrupt row must not poison seqCounter to NaN —
            // every later seq would be NaN on the wire and every later row
            // key would collide on disk.
            if (typeof p?.seq !== "number" || typeof p?.mutationId !== "string") {
              console.warn(`[colada-db sync] skipping corrupt durable-outbox row ${row.key}`);
              continue;
            }
            restored.push(p);
          }
        }
        restored.sort((a, b) => a.seq - b.seq);
        for (const p of restored) {
          watermark = Math.max(watermark, p.seq);
          // Review A1: a confirmation mark can arrive BEFORE the restore
          // completes (the boot pull races the engine open, and delta-style
          // marks — Replicache lastMutationIDChanges — are sent once). An
          // already-confirmed entry re-pushed forever is a ghost; retire it
          // now instead of restoring it.
          if ((confirmedHighWater.get(p.clientId) ?? 0) >= p.seq) {
            engine.writeBatch([], [entryKey(p.seq)]).catch(warnOutboxPersist);
            continue;
          }
          // Session floor 0 and pushed:false — see PersistedOutboxEntry.
          outbox.push({ ...p, baseServerGen: 0, pushed: false });
        }
        seqCounter = Math.max(seqCounter, watermark);
      } else {
        console.warn("[colada-db sync] outboxEngine.isSupported() is false — outbox is in-memory this session");
      }
    } catch (err) {
      // Review A2: a read fault must degrade to PURE in-memory. Leaving the
      // engine writable would persist fresh seq-1 rows over the previous
      // session's still-unpushed entries — §1's one forbidden outcome.
      outboxEngineOpened = false;
      warnOutboxPersist(err);
    }
    if (stopped) return;
    // Flip out of buffering FIRST, then materialize — a listener firing
    // mid-loop must take the normal path, not append behind our back.
    const buffered = preBootBuffer ?? [];
    preBootBuffer = null;
    for (const captured of buffered) materializeEntry(captured);
    if (outbox.some((e) => !e.pushed)) schedulePush();
  }

  // The coordinator's own record of "what did a sync-pull apply last stamp
  // here" — EntityEvent.version is never populated by the in-memory store
  // (ADR-006 implementation note, part 1), so this map IS the version slot
  // baseVersion reads from. Absent key = no baseVersion, never 0.
  const versions = new Map<EntityKeyStr, SyncVersion>();

  // Monotonic per-key counter of authoritative server-side store writes this session —
  // pull-applies AND transform data-applies, both of which write under `sync-pull`. The
  // reject-revert gate reads THIS, not `versions`: an ack stamps a version into `versions`
  // without any store write, and a gate on the version map falsely suppressed a legitimate
  // same-key revert (round-2 review gauntlet, DAN-776).
  const serverWriteGen = new Map<EntityKeyStr, number>();
  // The server SHADOW — cumulative best-known server state per key (`data: undefined` = an
  // authoritative remove). The reject path re-bases onto THIS when the entry's commit-time
  // `previousData` has been superseded — merely declining to revert is not enough, because a
  // transform's sibling replay may have baked the about-to-be-rejected edit on top of the
  // correction, and the server's echo classifies "same" and cannot heal it (round-3 gauntlet).
  //
  // Maintained patch-over-patch, NOT as the last raw payload: pull `set` payloads are partial
  // patches that the apply path MERGES (store.set — the documented enrichment semantics), so
  // caching a raw patch and re-applying it as a full replacement drops every field the patch
  // didn't carry (round-4 gauntlet). And never captured from post-apply `store.get()`, which
  // would bake unconfirmed pending local edits into "server truth."
  const serverTruth = new Map<EntityKeyStr, { data?: EntityRecord }>();

  function recordServerWrite(k: EntityKeyStr, data: EntityRecord | undefined, mode: "merge" | "replace"): void {
    serverWriteGen.set(k, (serverWriteGen.get(k) ?? 0) + 1);
    if (data === undefined) serverTruth.set(k, { data: undefined });
    else if (mode === "merge") {
      const prev = serverTruth.get(k)?.data;
      serverTruth.set(k, { data: { ...prev, ...data } });
    } else serverTruth.set(k, { data });
  }

  function isLocalType(entityType: string): boolean {
    return entityDefs[entityType]?.local === true;
  }

  function applyReplaceOrRemove(entityType: string, id: string, data: EntityRecord | undefined): void {
    if (data === undefined) store.remove(entityType, id);
    else store.replace(entityType, id, data);
  }

  // ── §4 / ADR-004 boundary + outbox tap (§1, implementation note part 1) ──
  const unsubscribeOutboxTap = store.subscribe((event: EntityEvent) => {
    if (stopped) return;
    if (event.origin !== "local-mutation") return; // accept-list, never a deny-list
    if (isLocalType(event.entityType)) return; // DeviceLocalTypesNeverEnterTheOutbox
    if (event.type === "evict") return; // ADR-004 — evict is never pushed
    if (event.type !== "set" && event.type !== "remove") return;

    const k = toKey(event.entityType, event.id);
    // Everything here is commit-time capture (D4: auth is minted NOW, never at
    // push time) — except `seq`, which the durable-outbox boot may still owe a
    // restored watermark for. Buffered events are materialized in arrival
    // order once the watermark is known.
    const captured: Omit<OutboxEntry, "seq"> = {
      mutationId: makeMutationId(clientId),
      clientId,
      transactionId: event.transactionId,
      op: event.type,
      entityType: event.entityType,
      id: event.id,
      data: event.type === "set" ? event.data : undefined,
      baseVersion: versions.get(k),
      baseServerGen: serverWriteGen.get(k) ?? 0,
      auth: mintAuth?.(),
      previousData: event.previousData,
      previousExisted: event.previousData !== undefined,
      pushed: false,
    };
    if (preBootBuffer) {
      preBootBuffer.push(captured);
      return;
    }
    materializeEntry(captured);
    schedulePush();
  });

  // ── push loop (§1, D1, D2, D4, D9) ──────────────────────────────────────
  let pushInFlight = false; // AtMostOnePushInFlightPerClient
  let pushScheduled = false;
  let pushSuspendedForSchema = false; // D12
  const retryState: RetryState = { attempt: 0, nextRetryAt: null, suspendedForSchema: false };
  let pushRetryTimer: ReturnType<typeof setTimeout> | undefined;

  function schedulePush(delayMs = 0): void {
    if (stopped || pushInFlight || pushScheduled || pushSuspendedForSchema) return;
    pushScheduled = true;
    pushRetryTimer = setTimeout(() => {
      pushScheduled = false;
      void runPush();
    }, delayMs);
  }

  /** Replays every OTHER still-outstanding (`pushed === false`) outbox entry for `key` on top of
   *  whatever the caller just wrote — the same "revert/apply truth, then replay the remaining
   *  active mutations" shape `transactions.ts`'s own `recompute()` uses. Shared by `reject`
   *  (revert to previousData, replay) and `transform` (apply the server's correction, replay) —
   *  both are "this key just got an authoritative write; don't let it silently erase a second,
   *  still-unconfirmed writer's edit to the same key" (ADR-006 implementation note, part 2). Must
   *  run inside the caller's own `runWith`, so the replayed writes share its origin/transactionId.
   */
  function replaySiblings(entityType: string, id: string, exclude: OutboxEntry | null): void {
    const k = toKey(entityType, id);
    for (const other of outbox) {
      if (exclude !== null && other === exclude) continue;
      if (other.pushed) continue; // already server-accepted; not ours to replay over
      if (toKey(other.entityType, other.id) !== k) continue;
      if (other.op === "set" && other.data) store.set(other.entityType, other.id, other.data);
      else if (other.op === "remove") store.remove(other.entityType, other.id);
    }
    // Review A3: writes buffered behind the durable-outbox boot are pending
    // local writers too — finding B must hold inside the boot window, or the
    // exact "optimistic edit visibly vanishes" symptom returns for its
    // duration. Buffered entries are never pushed, so none can be `exclude`.
    if (preBootBuffer) {
      for (const captured of preBootBuffer) {
        if (toKey(captured.entityType, captured.id) !== k) continue;
        if (captured.op === "set" && captured.data) store.set(captured.entityType, captured.id, captured.data);
        else if (captured.op === "remove") store.remove(captured.entityType, captured.id);
      }
    }
  }

  /** ADR-006 "Implementation note, part 2" — revert to previousData, then replay any OTHER
   *  still-outstanding entry for the same key, in outbox order, so a second in-flight writer's
   *  edit is never silently erased by the first writer's rejection.
   *
   *  The revert is GATED ON PULL-WRITE GENERATION (review gauntlet, DAN-776, both rounds):
   *  commit-time `previousData` is only authoritative while no pull-channel write has landed on
   *  this key since the entry captured it. If one has, the store holds newer server truth —
   *  reverting over it diverges PERMANENTLY, because `versions` keeps the newer stamp, so the
   *  re-pull of that same version classifies as "same" and is skipped. The gate deliberately
   *  does NOT read `versions`: an ack stamps a version there with no store write, and gating on
   *  it falsely suppressed the revert of a rejected same-key sibling (round-2 finding).
   *  Sibling replay still runs either way. */
  function revertAndReplay(rejected: OutboxEntry): void {
    store.runWith({ origin: "undo" as WriteOrigin, transactionId: rejected.transactionId }, () => {
      const k = toKey(rejected.entityType, rejected.id);
      if ((serverWriteGen.get(k) ?? 0) === rejected.baseServerGen) {
        // No authoritative write since this entry captured previousData — it is the basis.
        if (rejected.previousExisted) applyReplaceOrRemove(rejected.entityType, rejected.id, rejected.previousData);
        else store.remove(rejected.entityType, rejected.id);
      } else {
        // Superseded — re-base onto the last server-applied value. A gen mismatch implies
        // recordServerWrite ran for this key, so the cache entry exists.
        const truth = serverTruth.get(k);
        if (truth) applyReplaceOrRemove(rejected.entityType, rejected.id, truth.data);
      }
      replaySiblings(rejected.entityType, rejected.id, rejected);
    });
  }

  /** rev d / D14 — rewrite dependent outbox refs to the new id, clearing their stale baseVersion. */
  function applyRemap(oldId: string, entityType: string, newId: string): void {
    for (const entry of outbox) {
      if (entry.entityType === entityType && entry.id === oldId) {
        entry.id = newId;
        entry.baseVersion = undefined;
        // The persisted row must match what a reload would need to re-push —
        // an entry restored under the old id would ship a temp id the server
        // no longer knows.
        persistEntry(entry);
      }
    }
    // Review A4: entries still buffered behind the boot are outbox-shaped
    // state too — left unrewritten they materialize and push a dead temp id.
    if (preBootBuffer) {
      for (const captured of preBootBuffer) {
        if (captured.entityType === entityType && captured.id === oldId) {
          captured.id = newId;
          captured.baseVersion = undefined;
        }
      }
    }
  }

  /**
   * Stamp a version only when it ADVANCES the entity's last-known one
   * (DAN-777 finding B, the related case): a push verdict's version can
   * arrive after a pull already stamped something newer for the same key —
   * push and pull overlap by design (D17) — and an unconditional stamp
   * regresses the map, misclassifying the next pull as "same"/"older".
   * `applyRemoteChange` keeps its own direct set: its gate has already
   * decided the change applies (including "concurrent", where the stamp must
   * follow the applied data even though the comparator refuses to rank it).
   */
  function stampVersionIfNewer(k: EntityKeyStr, version: SyncVersion): void {
    const known = versions.get(k);
    if (known === undefined || compareVersions(version, known) === "newer") versions.set(k, version);
  }

  function handleVerdict(entry: OutboxEntry, verdict: PushVerdict): void {
    if (verdict.status === "reject") {
      revertAndReplay(entry);
      const idx = outbox.indexOf(entry);
      if (idx !== -1) outbox.splice(idx, 1);
      retireEntry(entry);
      return;
    }

    if (verdict.status === "transform") {
      // D2 — id remap + corrected entity apply immediately; overlay drop still waits (below, unchanged).
      const targetId = verdict.remappedId ?? entry.id;
      // Review B1 (DAN-777 gauntlet): push and pull overlap (D17), so a
      // transform's data can arrive carrying a version OLDER than what a pull
      // stamped mid-flight. Applying it anyway is permanent divergence — the
      // guarded stamp keeps the newer version, so the newer state's re-delivery
      // classifies "same" and can never heal the store. A stale transform
      // skips the data apply and the sibling replay (nothing was erased); the
      // id remap below still runs — identity correction is not versioned, and
      // queued entries would otherwise keep pushing a dead temp id.
      const knownBeforeApply = versions.get(toKey(entry.entityType, entry.id));
      const staleTransform =
        verdict.version !== undefined &&
        knownBeforeApply !== undefined &&
        compareVersions(verdict.version, knownBeforeApply) === "older";
      store.runWith({ origin: "sync-pull" as WriteOrigin }, () => {
        if (verdict.data && !staleTransform) {
          applyReplaceOrRemove(entry.entityType, targetId, verdict.data);
          // An authoritative store write outside applyRemoteChange — the reject gate must see
          // it, or a same-key reject reverts commit-time previousData over the server's
          // correction and the "same"-classified echo never heals it (round-3 gauntlet).
          // "replace": a transform verdict carries the full corrected entity, not a patch
          // (it is applied with applyReplaceOrRemove → store.replace above, same semantics).
          recordServerWrite(toKey(entry.entityType, targetId), verdict.data, "replace");
        }
        if (verdict.remappedId && verdict.remappedId !== entry.id) {
          // Skip the "move" remove when stale: the store's content under the
          // temp id is NEWER than this verdict; the server's own feed delivers
          // the authoritative state under the new id (and a tombstone for the
          // temp id) in due course.
          if (!staleTransform) store.remove(entry.entityType, entry.id); // "one move event" — see ADR implementation note part 2
          applyRemap(entry.id, entry.entityType, verdict.remappedId); // rewrites siblings' .id to targetId too
        }
        entry.id = targetId;
        // A second, still-unconfirmed writer to the same key must not be silently erased by the
        // server's correction landing on top of it — same hazard §1c/D4's revert-and-replay fixes
        // for reject, found by independent review during DAN-776 (part 2's fix only covered reject).
        if (!staleTransform) replaySiblings(entry.entityType, targetId, entry);
      });
      if (verdict.version !== undefined) stampVersionIfNewer(toKey(entry.entityType, targetId), verdict.version);
      entry.pushed = true;
      return;
    }

    // ack
    if (verdict.version !== undefined) stampVersionIfNewer(toKey(entry.entityType, entry.id), verdict.version);
    entry.pushed = true;
  }

  async function runPush(): Promise<void> {
    if (stopped || pushInFlight || pushSuspendedForSchema) return;
    const batch = outbox.filter((e) => !e.pushed);
    if (batch.length === 0) return;

    pushInFlight = true;
    try {
      const wire: LocalChange[] = batch.map((e) => ({
        mutationId: e.mutationId,
        clientId: e.clientId,
        seq: e.seq,
        transactionId: e.transactionId,
        op: e.op,
        entityType: e.entityType,
        id: e.id,
        data: e.data,
        baseVersion: e.baseVersion,
        intent: e.intent,
      }));
      const result = await adapter.push(wire, schemaVersion ? { schemaVersion } : undefined);
      retryState.attempt = 0;
      retryState.nextRetryAt = null;
      for (const verdict of result.results) {
        const entry = batch.find((e) => e.mutationId === verdict.mutationId);
        if (entry) handleVerdict(entry, verdict);
      }
    } catch (err) {
      // Name-based, never message-text matching: a proxy relaying a server stack trace can put
      // the string "SchemaVersionError" in any error's message, and suspending on that would
      // turn a retryable blip into a permanently suspended outbox. The `.name` check still
      // catches cross-realm instances `instanceof` misses. (review gauntlet, DAN-776)
      if (err instanceof SchemaVersionError || (err instanceof Error && err.name === "SchemaVersionError")) {
        // D12 — suspend the outbox; never drain or discard it.
        pushSuspendedForSchema = true;
        retryState.suspendedForSchema = true;
      } else {
        retryState.attempt += 1;
        const delay = pushBackoffDelay(retryState.attempt);
        retryState.nextRetryAt = Date.now() + delay;
        pushInFlight = false;
        schedulePush(delay);
        return;
      }
    } finally {
      pushInFlight = false;
    }
    if (outbox.some((e) => !e.pushed)) schedulePush();
  }

  // ── pull loop (§1b, §2, §3, D1, D5, D8, D10, D11, D12, D16, D18, D20) ───
  interface SubState {
    cursor: string | null;
    resetTimer?: ReturnType<typeof setTimeout>;
    pollTimer?: ReturnType<typeof setTimeout>;
    liveDispose?: () => void;
    pullInFlight: boolean;
    /** Independent of push's retryState — a thrown pull() gets the same backoff shape (D9's
     *  spirit: never a silent, permanently-dead subscription) but is tracked per-subscription. */
    pullRetryAttempt: number;
  }
  const subStates = new Map<string | undefined, SubState>();
  for (const s of orderedSubs) subStates.set(s.name, { cursor: null, pullInFlight: false, pullRetryAttempt: 0 });

  function applyRemoteChange(change: RemoteChange): void {
    if (isLocalType(change.entityType)) {
      // D18 — a device-local type arriving on pull is ignored and warned, never applied.
      console.warn(
        `[colada-db sync] ignoring remote change for local-only type "${change.entityType}" (id ${change.id})`,
      );
      return;
    }
    const k = toKey(change.entityType, change.id);
    const known = versions.get(k);
    const order = known === undefined ? "newer" : compareVersions(change.version, known);
    // §3/D3 — applied when strictly newer, OR concurrent (pull-arrival order is the tiebreak).
    if (order === "older" || order === "same") return;

    store.runWith({ origin: "sync-pull" as WriteOrigin }, () => {
      if (change.type === "remove") store.remove(change.entityType, change.id); // §4 — semantic delete
      else if (change.data) store.set(change.entityType, change.id, change.data);
      // DAN-777 finding B — the third sibling of the replay hazard. `reject`
      // and `transform` both replay still-pending same-key writers after an
      // authoritative write lands; a pull-applied change is the same event
      // shape and, without this, visibly erases pending optimistic edits
      // until the push echo returns (and is the enabling half of the
      // reject-after-newer-pull divergence fixed at DAN-776's landing).
      // Runs inside this runWith — same origin discipline as transform's
      // replay — so the replayed writes never re-enter the outbox.
      replaySiblings(change.entityType, change.id, null);
    });
    versions.set(k, change.version);
    // The revert gate counts WRITES, not stamps — and the shadow accumulates what they held.
    // "merge" mirrors the store.set above: a pull payload is a patch, not a whole entity.
    recordServerWrite(k, change.type === "remove" ? undefined : change.data, "merge");
  }

  function dropConfirmed(confirmedMutations: Record<string, number> | undefined): void {
    if (!confirmedMutations) return;
    // Review A1: remember every mark's high-water, because entries restored
    // (or adopted) AFTER a mark arrived must still be retired by it.
    for (const [cid, seq] of Object.entries(confirmedMutations)) {
      if (typeof seq === "number" && seq > (confirmedHighWater.get(cid) ?? 0)) confirmedHighWater.set(cid, seq);
    }
    for (let i = outbox.length - 1; i >= 0; i--) {
      const entry = outbox[i]!;
      const confirmedSeq = confirmedMutations[entry.clientId];
      if (confirmedSeq !== undefined && confirmedSeq >= entry.seq) {
        outbox.splice(i, 1);
        retireEntry(entry);
      }
    }
  }

  async function pullOnce(subName: string | undefined): Promise<"more" | "done" | "reset" | "stopped" | "error"> {
    const state = subStates.get(subName);
    if (!state || stopped) return "stopped";
    let result: PullResult;
    try {
      result = await adapter.pull(state.cursor, { limit: pullLimit, schemaVersion, subscription: subName });
    } catch {
      // A thrown pull() must not become an unhandled rejection that silently kills this
      // subscription forever — every caller invokes pullSubscription() fire-and-forget.
      return "error";
    }
    if (stopped) return "stopped"; // pull-side: in-flight completions no-op once stopped — see file header

    if (result.type === "reset") {
      state.cursor = result.cursor ?? null;
      return "reset";
    }

    // StagedBatchesAreNotApplied — accumulate; only the caller applies, and only at complete:true.
    state.cursor = result.cursor;
    pendingByChangesRef.set(subName, [...(pendingByChangesRef.get(subName) ?? []), result]);
    return result.complete ? "done" : "more";
  }

  const pendingByChangesRef = new Map<string | undefined, PullResult[]>();

  async function pullSubscription(subName: string | undefined): Promise<void> {
    const state = subStates.get(subName);
    if (!state || stopped || state.pullInFlight) return;
    state.pullInFlight = true;
    // Snapshot for the two non-complete outcomes (thrown pull, bound-hit): staged pages are
    // discarded AND the cursor rewinds to the cycle's start, so the discarded pages' changes are
    // re-pulled next cycle rather than silently skipped past (the per-page `pullOnce` advances
    // the cursor as it accumulates). Version-aware apply makes the re-pull idempotent.
    // (review gauntlet, DAN-776)
    const cycleStartCursor = state.cursor;
    try {
      pendingByChangesRef.set(subName, []);
      let status: "more" | "done" | "reset" | "stopped" | "error" = "more";
      // Bounded like the adapter conformance kit's own pullAll — an adapter that never
      // sets complete would otherwise hang the coordinator's poll loop forever.
      for (let i = 0; i < 200 && status === "more"; i++) {
        status = await pullOnce(subName);
      }
      if (status === "stopped") return;

      if (status === "error" || status === "more") {
        // "more" here means the bound fired — the adapter never set `complete: true`.
        // StagedBatchesAreNotApplied has no bound-shaped exception: discard, rewind, retry.
        pendingByChangesRef.delete(subName);
        state.cursor = cycleStartCursor;
        if (stopped) return;
        state.pullRetryAttempt += 1;
        const delay = pushBackoffDelay(state.pullRetryAttempt); // same exponential+jitter shape as D9
        state.pollTimer = setTimeout(() => void pullSubscription(subName), delay);
        return;
      }
      state.pullRetryAttempt = 0; // a successful cycle (reset included) clears prior pull failures

      if (status === "reset") {
        pendingByChangesRef.delete(subName);
        if (stopped) return;
        state.resetTimer = setTimeout(() => void pullSubscription(subName), resetJitterDelay());
        return;
      }

      const pages = pendingByChangesRef.get(subName) ?? [];
      pendingByChangesRef.delete(subName);
      if (stopped) return; // pull-side quiescence — see file header
      for (const page of pages) {
        if (page.type !== "changes") continue;
        for (const change of page.changes) applyRemoteChange(change);
        dropConfirmed(page.confirmedMutations);
      }
    } finally {
      state.pullInFlight = false;
    }
    if (!stopped) schedulePoll(subName);
  }

  function schedulePoll(subName: string | undefined): void {
    const state = subStates.get(subName);
    if (!state || stopped) return;
    state.pollTimer = setTimeout(() => void pullSubscription(subName), pollIntervalMs);
  }

  // Live channel: POKE-FIRST. Every inline event — poke, reset, or inline changes — only ever
  // SCHEDULES a pull; it never applies data itself. This is what makes
  // InlineResetIsAPokeNeverAnInstruction true unconditionally: a lossy channel that can only
  // ever trigger the real (staged, version-aware) pull path can never destroy state on its own.
  if (adapter.subscribe) {
    for (const s of orderedSubs) {
      const state = subStates.get(s.name);
      if (!state) continue;
      state.liveDispose = adapter.subscribe(() => {
        if (stopped) return;
        void pullSubscription(s.name);
      });
    }
  }
  // Poll-mode boot needs no schedulePoll here: each boot pull below schedules the next cycle on
  // completion, giving exactly one self-perpetuating chain per subscription. A second boot-time
  // chain doubled the poll rate forever and leaked its pending timer past stop(), since
  // `pollTimer` is a single slot. (review gauntlet, DAN-776)

  // D20 — starts requested in priority order; none of these are awaited before the next starts.
  for (const s of orderedSubs) void pullSubscription(s.name);

  // ── ADR-006 §1 — durable-outbox restore (DAN-777 finding A) ─────────────
  if (outboxEngine) void bootDurableOutbox(outboxEngine);

  // ── §1c/D4 — boot-time sibling-outbox recovery, relay never re-authorship ──
  if (recoverStrandedOutbox) {
    void Promise.resolve(recoverStrandedOutbox()).then((stranded) => {
      if (stopped) return;
      for (const s of stranded) {
        // Review A1, adoption's identical race: a mark that arrived before
        // this recovery resolved already confirms this entry — adopting it
        // anyway re-pushes a ghost forever under delta-style marks.
        if ((confirmedHighWater.get(s.clientId) ?? 0) >= s.seq) continue;
        // Forwarded exactly as committed: same mutationId/clientId/seq/auth. Never re-minted.
        // previousData/previousExisted come from the sibling's own commit-time capture when
        // supplied — NOT hardcoded to "didn't exist", which would make a reject of a relayed
        // update always delete the entity instead of reverting it.
        outbox.push({
          ...s,
          previousExisted: s.previousExisted ?? false,
          // Session floor, NEVER adoption-time capture: recovery is an async read that races
          // the boot pull, and a stranded entry's previousData is from a previous session by
          // construction — any server write this session supersedes it (round-3 gauntlet).
          baseServerGen: 0,
          pushed: false,
        });
      }
      if (stranded.length > 0) schedulePush();
    });
  }

  return {
    stop(): void {
      if (stopped) return;
      stopped = true; // StoppedSubscriptionsAreQuiescent — blocks all NEW scheduling from here down.
      unsubscribeOutboxTap();
      if (pushRetryTimer) clearTimeout(pushRetryTimer);
      for (const state of subStates.values()) {
        if (state.resetTimer) clearTimeout(state.resetTimer);
        if (state.pollTimer) clearTimeout(state.pollTimer);
        state.liveDispose?.();
      }
      if (outboxEngine && outboxEngineOpened) {
        outboxEngineOpened = false; // no writes after close — persist/retire no-op from here
        outboxEngine.close();
      }
    },
    getRetryState(): RetryState {
      return { ...retryState };
    },
    getPendingCount(): number {
      // Pre-boot buffered writes are unconfirmed local writes too — hiding
      // them would make "has everything landed?" read 0 during the one window
      // where a write is at its most volatile.
      return outbox.length + (preBootBuffer?.length ?? 0);
    },
    resumeAfterSchemaMigration(): void {
      if (!pushSuspendedForSchema) return;
      pushSuspendedForSchema = false;
      retryState.suspendedForSchema = false;
      retryState.attempt = 0;
      if (!stopped && outbox.some((e) => !e.pushed)) schedulePush();
    },
  };
}
