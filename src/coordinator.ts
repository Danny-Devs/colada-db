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
import type { EntityDefinition, EntityEvent, EntityRecord, EntityStore, WriteOrigin } from "./types";
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
  /** Opaque per rev c C3 — never parsed, validated, or format-checked here. */
  clientId: string;
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
  /** Poll interval when the adapter has no live `subscribe()` channel. Default 30s. */
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

  // The coordinator's own record of "what did a sync-pull apply last stamp
  // here" — EntityEvent.version is never populated by the in-memory store
  // (ADR-006 implementation note, part 1), so this map IS the version slot
  // baseVersion reads from. Absent key = no baseVersion, never 0.
  const versions = new Map<EntityKeyStr, SyncVersion>();

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
    const entry: OutboxEntry = {
      mutationId: makeMutationId(clientId),
      clientId,
      seq: nextSeq(),
      transactionId: event.transactionId,
      op: event.type,
      entityType: event.entityType,
      id: event.id,
      data: event.type === "set" ? event.data : undefined,
      baseVersion: versions.get(k),
      auth: mintAuth?.(),
      previousData: event.previousData,
      previousExisted: event.previousData !== undefined,
      pushed: false,
    };
    outbox.push(entry);
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
  function replaySiblings(entityType: string, id: string, exclude: OutboxEntry): void {
    const k = toKey(entityType, id);
    for (const other of outbox) {
      if (other === exclude) continue;
      if (other.pushed) continue; // already server-accepted; not ours to replay over
      if (toKey(other.entityType, other.id) !== k) continue;
      if (other.op === "set" && other.data) store.set(other.entityType, other.id, other.data);
      else if (other.op === "remove") store.remove(other.entityType, other.id);
    }
  }

  /** ADR-006 "Implementation note, part 2" — revert to previousData, then replay any OTHER
   *  still-outstanding entry for the same key, in outbox order, so a second in-flight writer's
   *  edit is never silently erased by the first writer's rejection. */
  function revertAndReplay(rejected: OutboxEntry): void {
    store.runWith({ origin: "undo" as WriteOrigin, transactionId: rejected.transactionId }, () => {
      if (rejected.previousExisted) applyReplaceOrRemove(rejected.entityType, rejected.id, rejected.previousData);
      else store.remove(rejected.entityType, rejected.id);
      replaySiblings(rejected.entityType, rejected.id, rejected);
    });
  }

  /** rev d / D14 — rewrite dependent outbox refs to the new id, clearing their stale baseVersion. */
  function applyRemap(oldId: string, entityType: string, newId: string): void {
    for (const entry of outbox) {
      if (entry.entityType === entityType && entry.id === oldId) {
        entry.id = newId;
        entry.baseVersion = undefined;
      }
    }
  }

  function handleVerdict(entry: OutboxEntry, verdict: PushVerdict): void {
    if (verdict.status === "reject") {
      revertAndReplay(entry);
      const idx = outbox.indexOf(entry);
      if (idx !== -1) outbox.splice(idx, 1);
      return;
    }

    if (verdict.status === "transform") {
      // D2 — id remap + corrected entity apply immediately; overlay drop still waits (below, unchanged).
      const targetId = verdict.remappedId ?? entry.id;
      store.runWith({ origin: "sync-pull" as WriteOrigin }, () => {
        if (verdict.data) applyReplaceOrRemove(entry.entityType, targetId, verdict.data);
        if (verdict.remappedId && verdict.remappedId !== entry.id) {
          store.remove(entry.entityType, entry.id); // "one move event" — see ADR implementation note part 2
          applyRemap(entry.id, entry.entityType, verdict.remappedId); // rewrites siblings' .id to targetId too
        }
        entry.id = targetId;
        // A second, still-unconfirmed writer to the same key must not be silently erased by the
        // server's correction landing on top of it — same hazard §1c/D4's revert-and-replay fixes
        // for reject, found by independent review during DAN-776 (part 2's fix only covered reject).
        replaySiblings(entry.entityType, targetId, entry);
      });
      if (verdict.version !== undefined) versions.set(toKey(entry.entityType, targetId), verdict.version);
      entry.pushed = true;
      return;
    }

    // ack
    if (verdict.version !== undefined) versions.set(toKey(entry.entityType, entry.id), verdict.version);
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
      if (err instanceof SchemaVersionError || /SchemaVersionError/.test(String(err))) {
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
    });
    versions.set(k, change.version);
  }

  function dropConfirmed(confirmedMutations: Record<string, number> | undefined): void {
    if (!confirmedMutations) return;
    for (let i = outbox.length - 1; i >= 0; i--) {
      const entry = outbox[i]!;
      const confirmedSeq = confirmedMutations[entry.clientId];
      if (confirmedSeq !== undefined && confirmedSeq >= entry.seq) outbox.splice(i, 1);
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
    try {
      pendingByChangesRef.set(subName, []);
      let status: "more" | "done" | "reset" | "stopped" | "error" = "more";
      // Bounded like the adapter conformance kit's own pullAll — an adapter that never
      // sets complete would otherwise hang the coordinator's poll loop forever.
      for (let i = 0; i < 200 && status === "more"; i++) {
        status = await pullOnce(subName);
      }
      if (status === "stopped") return;

      if (status === "error") {
        pendingByChangesRef.delete(subName);
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
  } else {
    for (const s of orderedSubs) schedulePoll(s.name);
  }

  // D20 — starts requested in priority order; none of these are awaited before the next starts.
  for (const s of orderedSubs) void pullSubscription(s.name);

  // ── §1c/D4 — boot-time sibling-outbox recovery, relay never re-authorship ──
  if (recoverStrandedOutbox) {
    void Promise.resolve(recoverStrandedOutbox()).then((stranded) => {
      if (stopped) return;
      for (const s of stranded) {
        // Forwarded exactly as committed: same mutationId/clientId/seq/auth. Never re-minted.
        // previousData/previousExisted come from the sibling's own commit-time capture when
        // supplied — NOT hardcoded to "didn't exist", which would make a reject of a relayed
        // update always delete the entity instead of reverting it.
        outbox.push({ ...s, previousExisted: s.previousExisted ?? false, pushed: false });
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
    },
    getRetryState(): RetryState {
      return { ...retryState };
    },
    getPendingCount(): number {
      return outbox.length;
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
