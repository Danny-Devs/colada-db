/**
 * The coordinator conformance kit — shared scaffolding for `coordinator-conformance.spec.ts`.
 *
 * Unlike `sync-conformance.ts` (many third-party adapters implement `SyncAdapter`,
 * so a reusable contract suite protects all of them at once), there is exactly
 * one `enableSync()`. The reuse this file buys is across SCENARIOS instead — a
 * scripted, fully test-controllable fake adapter that different tests drive
 * into exact interleavings (a reject alongside a still-pending second write, a
 * multi-page pull, a schema mismatch mid-flight) without each test hand-rolling
 * its own backend.
 *
 * `COORDINATOR_CONTRACT_COVERAGE` is asserted equal to `sync-conformance.ts`'s
 * `SYNC_CONTRACT_COVERAGE.coordinator` in the spec file — this file owns
 * exactly that list and nothing drifts from it silently.
 */
import { vi } from "vitest";
import { createEntityStore } from "./store";
import type {
  LocalChange,
  PullResult,
  PushResult,
  PushVerdict,
  RemoteChange,
  SyncAdapter,
} from "./sync-types";
import type { EntityStore } from "./types";

/** Verbatim from `SYNC_CONTRACT_COVERAGE.coordinator` in `src/sync-conformance.ts` — this
 *  kit's job is to prove every one of these, watched to fail, against the real coordinator. */
export const COORDINATOR_CONTRACT_COVERAGE = [
  "AtMostOnePushInFlightPerClient",
  "InlineResetIsAPokeNeverAnInstruction",
  "HydrationPriorityOrdersStartsAndNeverBlocks",
  "OverlayIsDroppedOnlyByThePullChannel",
  "StagedBatchesAreNotApplied",
  "OutboxIsKeyedByClientAndSeq",
  "UniqueMutationIdentity",
  "RemappedEntriesCarryNoStaleBaseVersion",
  "DeviceLocalTypesNeverEnterTheOutbox",
  "NeverCarriesRemoteProvenance",
  "StoppedSubscriptionsAreQuiescent",
  "HigherPriorityIsRequestedFirst",
  "AuthenticationMaterialIsMintedAtCommitTime",
  "AdoptionIsSameDeviceOnly",
] as const;

export function freshStore(): EntityStore {
  return createEntityStore();
}

/** A `SyncAdapter` whose `push`/`pull` responses are scripted per-call by the test. */
export interface ScriptedAdapter {
  adapter: SyncAdapter;
  pushCalls: LocalChange[][];
  pullCalls: Array<{ cursor: string | null; opts: { limit?: number; schemaVersion?: string; subscription?: string } | undefined }>;
  /** Next response(s) for `push()`, consumed one per call; the last is reused once exhausted. */
  queuePush(
    ...responses: Array<
      PushResult | ((batch: LocalChange[]) => PushResult) | ((batch: LocalChange[]) => Promise<PushResult>) | Error
    >
  ): void;
  /** Next response(s) for `pull()`, consumed one per call; the last is reused once exhausted. */
  queuePull(...responses: Array<PullResult | (() => PullResult) | (() => Promise<PullResult>)>): void;
  emitLive(event: { type: "poke" } | PullResult): void;
  liveHandlerCount(): number;
}

const defaultAck = (batch: LocalChange[]): PushResult => ({
  results: batch.map((c): PushVerdict => ({ mutationId: c.mutationId, status: "ack", version: 1 })),
});
const defaultEmptyPull = (): PullResult => ({ type: "changes", changes: [], cursor: "0", complete: true });

export function makeScriptedAdapter(): ScriptedAdapter {
  const pushCalls: LocalChange[][] = [];
  const pullCalls: ScriptedAdapter["pullCalls"] = [];
  let pushQueue: Array<
    PushResult | ((batch: LocalChange[]) => PushResult) | ((batch: LocalChange[]) => Promise<PushResult>) | Error
  > = [];
  let pullQueue: Array<PullResult | (() => PullResult) | (() => Promise<PullResult>)> = [];
  let liveHandlers: Array<(e: { type: "poke" } | PullResult) => void> = [];

  async function resolvePush(batch: LocalChange[]): Promise<PushResult> {
    const next = pushQueue.length > 1 ? pushQueue.shift()! : pushQueue[0];
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(batch);
    if (next) return next;
    return defaultAck(batch);
  }

  async function resolvePull(): Promise<PullResult> {
    const next = pullQueue.length > 1 ? pullQueue.shift()! : pullQueue[0];
    if (typeof next === "function") return next();
    if (next) return next;
    return defaultEmptyPull();
  }

  const adapter: SyncAdapter = {
    async push(batch, _opts) {
      pushCalls.push(batch);
      return resolvePush(batch);
    },
    async pull(cursor, opts) {
      pullCalls.push({ cursor, opts });
      return resolvePull();
    },
    subscribe(onEvent) {
      liveHandlers.push(onEvent);
      return () => {
        liveHandlers = liveHandlers.filter((h) => h !== onEvent);
      };
    },
  };

  return {
    adapter,
    pushCalls,
    pullCalls,
    queuePush(...responses) {
      pushQueue = responses;
    },
    queuePull(...responses) {
      pullQueue = responses;
    },
    emitLive(event) {
      for (const h of liveHandlers) h(event);
    },
    liveHandlerCount() {
      return liveHandlers.length;
    },
  };
}

/** Flush pending microtasks/macrotasks without needing fake timers — coordinator scheduling
 *  uses `setTimeout(..., 0)` even on the "immediate" path, so a real tick is required. */
export async function tick(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function remoteChange(over: Partial<RemoteChange> = {}): RemoteChange {
  return {
    type: over.type ?? "set",
    entityType: over.entityType ?? "Widget",
    id: over.id ?? "w1",
    data: over.type === "remove" ? undefined : (over.data ?? { id: over.id ?? "w1", label: "remote" }),
    version: over.version ?? 1,
  };
}

export { vi };
