/**
 * Live matcher views (DAN-606, Stage 2d-2) — reference-stable reactive
 * membership over one entity type, maintained against change events.
 *
 * The WatermelonDB two-tier observation design (steal-list #1) running
 * on the DAN-605 fail-closed classifier (ADR-009):
 *
 * - **encodable** — the filter validated into a canonical AST.
 *   Membership is maintained purely from event payloads: per `set`
 *   event, matched-before × matches-now → noop / add / remove (the
 *   Zero-IVM 80/20 lesson: single-entity deltas, no operator-pipeline
 *   IVM). ZERO projection re-scans after the initial seed.
 * - **opaque** — the filter is a JS closure. Correct but slower: each
 *   relevant event schedules a full projection re-scan, coalesced per
 *   microtask (a synchronous burst of N writes costs one re-scan).
 *
 * **Honest scope (ADR-003/ADR-010):** the view's universe is the MEMORY
 * PROJECTION — the same boundary as `getEntities()`/`getByType()`.
 * Durable-but-cold rows (manifest hydration, DAN-578) are invisible
 * until they hydrate; worker-seeded universes are DAN-579's scope.
 * `remove` events drop membership (the entity ceased to exist); `evict`
 * events ALSO drop membership (the entity left the projection, so the
 * view can no longer claim to know it matches). Retention makes
 * sweep-driven eviction of a live member impossible; a DIRECT
 * `store.evict()` still wins — the view honestly tracks the projection.
 *
 * **Reference stability (steal-list #2):** `getMembers()` exposes a
 * readonly array of entity IDS. Membership changes mint exactly one new
 * array; row edits that keep membership ride the per-entity reactivity
 * channel and never touch the array — same instance, `===` stable.
 * Order: seed-scan order, then adds append.
 *
 * **Retention (a view = a retaining scope, ADR-010):** every member is
 * `store.retain()`ed while it is a member, so `gc()` sweeps can never
 * evict a live result member mid-session. Released on membership exit
 * and on `dispose()`. Corollary (the DAN-578 residency ratchet): a
 * member becomes gc-TRACKED — after it exits membership it is evictable
 * at the next sweep, even if it was previously never-retained/immune.
 *
 * **Timing:** encodable views update synchronously with the event;
 * opaque views converge at the microtask boundary. A view created from
 * inside a store listener mid-drain may process queued events that are
 * older than its seed snapshot; delta maintenance converges against
 * settled state by the end of the synchronous drain (legal, but
 * creating views inside store listeners is discouraged).
 */

import { resolveBoundaryStore, type StoreBoundary } from "./boundary";
import { classifyFilter, evaluateMatcher } from "./matcher";
import type { EntityEvent, EntityRecord } from "./types";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/** Which maintenance tier a view runs on — see the module doc. */
export type MatcherViewTier = "encodable" | "opaque";

/** An opaque filter: any total predicate over one entity's data. */
export type MatcherPredicate = (entity: EntityRecord) => boolean;

/**
 * What `createMatcherView` accepts: a matcher AST (validated through
 * `classifyFilter`, ADR-009 — including `M.*` builder output and plain
 * JSON from an agent surface) or a predicate function. Anything else is
 * refused loudly ({@link MatcherViewError}) — a malformed AST is a bug,
 * not a fallback. (Typed `unknown` because raw agent-surface JSON is a
 * first-class input — validation happens at runtime, fail-closed.)
 */
export type MatcherViewFilter = unknown;

/** Divergence report from the dev-mode integrity check. */
export interface MatcherViewDivergence {
  entityType: string;
  /** Ids the re-scan says should be members but the delta tier missed. */
  missing: string[];
  /** Ids the delta tier tracks that the re-scan refuses. */
  extra: string[];
}

export interface MatcherViewOptions {
  /**
   * Dev-mode two-tier divergence guard: after every event-driven update
   * on the encodable tier, re-scan the projection, compare membership,
   * report divergence via {@link MatcherViewOptions.onDivergence}, and
   * SELF-HEAL to scan truth. Off by default — it costs a full scan per
   * event, exactly what the encodable tier exists to avoid. Turn it on
   * in tests and staging; an encodable-tier bug must never silently
   * diverge from re-run truth (wrong live results, the worst failure
   * class this subsystem has).
   * @default false
   */
  verifyIntegrity?: boolean;
  /** Where divergence reports go. @default console.error */
  onDivergence?: (divergence: MatcherViewDivergence) => void;
}

/**
 * A live membership view. Boundary-idiomatic external-store shape:
 * `subscribe` + synchronous snapshot getters; the members array's
 * identity IS the snapshot (`===`-compare to skip downstream work).
 * Signal/ref-flavored wrappers belong in framework adapters.
 */
export interface MatcherView {
  /** Which maintenance tier this view runs on (fixed at creation). */
  readonly tier: MatcherViewTier;
  /**
   * Current member ids. SAME array instance while membership is
   * unchanged; each membership change mints one new array. Row edits
   * that keep membership never touch it.
   */
  getMembers(): readonly string[];
  /** O(1) membership test. */
  has(id: string): boolean;
  /** Notify on every membership change. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /**
   * Tear down: unsubscribe from the boundary and release every
   * retention this view holds. Idempotent. A disposed view reads as
   * empty and never notifies again.
   */
  dispose(): void;
}

// ─────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────

/**
 * The filter is unusable: not a predicate function and refused by the
 * fail-closed classifier. Fail-visible by design (ADR-009's
 * refusal-is-loud posture) — silently treating a malformed AST as
 * match-nothing would be the silent-wrong-results failure class.
 */
export class MatcherViewError extends Error {
  readonly code = "unusable-filter";
  /** The classifier's opaque reason, when one exists. */
  readonly reason?: string;

  constructor(reason?: string) {
    super(
      `Unusable matcher-view filter: not a predicate function and not a valid matcher AST${
        reason ? ` (${reason})` : ""
      }`,
    );
    this.name = "MatcherViewError";
    this.reason = reason;
  }
}

// ─────────────────────────────────────────────
// createMatcherView
// ─────────────────────────────────────────────

const EMPTY_MEMBERS: readonly string[] = Object.freeze([]);

/**
 * Create a live membership view of `entityType` under `filter`.
 *
 * Classification happens ONCE, here: a function filter runs on the
 * opaque tier; anything else must fully validate through
 * `classifyFilter` (ADR-009) to run on the encodable tier, else
 * {@link MatcherViewError} is thrown.
 *
 * Retention requires a boundary created by `createStoreBoundary` (the
 * store is discovered internally). A foreign boundary implementation
 * still yields a correct view — without gc pinning (dev-mode warning).
 */
export function createMatcherView(
  boundary: StoreBoundary,
  entityType: string,
  filter: MatcherViewFilter,
  options: MatcherViewOptions = {},
): MatcherView {
  const { verifyIntegrity = false, onDivergence } = options;

  // ── Classify (once, at creation) ───────────
  let tier: MatcherViewTier;
  let matches: (entity: EntityRecord) => boolean;
  let warnedPredicateThrow = false;

  if (typeof filter === "function") {
    tier = "opaque";
    const predicate = filter as MatcherPredicate;
    matches = (entity) => {
      try {
        return predicate(entity) === true;
      } catch (err) {
        // Error-isolation posture (boundary idiom): a throwing predicate
        // is a consumer bug — report once, treat the entity as
        // non-matching. Predicates must be total.
        if (!warnedPredicateThrow) {
          warnedPredicateThrow = true;
          console.error("[colada-db] matcher-view predicate threw (treated as non-match):", err);
        }
        return false;
      }
    };
  } else {
    const verdict = classifyFilter(filter);
    if (verdict.tier === "opaque") throw new MatcherViewError(verdict.reason);
    tier = "encodable";
    const ast = verdict.ast; // the canonical frozen tree — never the raw input
    matches = (entity) => evaluateMatcher(ast, entity);
  }

  // ── Retention wiring (ADR-010: a view = a retaining scope) ──
  const store = resolveBoundaryStore(boundary);
  if (!store && process.env.NODE_ENV !== "production") {
    console.warn(
      "[colada-db] matcher-view: boundary has no resolvable store " +
        "(foreign StoreBoundary implementation?) — members will not be " +
        "retained against gc sweeps.",
    );
  }
  const retain = (id: string): void => store?.retain(entityType, id);
  const release = (id: string): void => store?.release(entityType, id);

  // ── State ──────────────────────────────────
  const membership = new Set<string>();
  let members: readonly string[] = EMPTY_MEMBERS;
  const listeners = new Set<() => void>();
  let disposed = false;
  let scanScheduled = false; // opaque-tier microtask coalescing

  const notify = (): void => {
    for (const fn of listeners) {
      try {
        fn();
      } catch (err) {
        // One broken subscriber must never starve the others.
        console.error("[colada-db] matcher-view listener threw:", err);
      }
    }
  };

  // ── Scan (seed / opaque re-run / integrity truth) ──
  /** Evaluate the whole projection; returns matching ids in scan order. */
  const scan = (): string[] => {
    const ids: string[] = [];
    for (const { id, data } of boundary.getEntities(entityType)) {
      if (matches(data)) ids.push(id);
    }
    return ids;
  };

  /**
   * Adopt `nextIds` as the membership if it differs from the current
   * set — reconciling retention per entered/exited id and minting one
   * new array. Keeps the SAME array instance when membership is
   * set-equal (opaque re-scans with no net change stay `===` stable).
   * Returns true when membership changed.
   */
  const adopt = (nextIds: string[]): boolean => {
    const next = new Set(nextIds);
    let changed = next.size !== membership.size;
    if (!changed) {
      for (const id of membership) {
        if (!next.has(id)) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) return false;
    for (const id of next) if (!membership.has(id)) retain(id);
    for (const id of membership) if (!next.has(id)) release(id);
    membership.clear();
    for (const id of next) membership.add(id);
    members = nextIds;
    return true;
  };

  // ── Encodable tier: per-event delta maintenance ──
  /**
   * matched-before × matches-now (steal-list #1 / Zero-IVM 80/20).
   * `set` carries the full post-merge entity, so `matches(event.data)`
   * is exact; `remove`/`evict` are always matches-now = false (the
   * entity left the projection — honest scope note above).
   */
  const applyDelta = (event: EntityEvent): boolean => {
    const id = event.id;
    const before = membership.has(id);
    const now = event.type === "set" && event.data !== undefined && matches(event.data);
    if (before === now) return false;
    if (now) {
      membership.add(id);
      retain(id);
      members = [...members, id];
    } else {
      membership.delete(id);
      release(id);
      members = members.filter((m) => m !== id);
    }
    return true;
  };

  /**
   * Dev-mode divergence guard: compare delta-maintained membership to
   * re-scan truth; report and SELF-HEAL on divergence. Runs after every
   * relevant event (not just delta-changing ones — in-place entity
   * mutation outside store events diverges exactly on the noop path).
   */
  const checkIntegrity = (): void => {
    const truthIds = scan();
    const truth = new Set(truthIds);
    const missing = truthIds.filter((id) => !membership.has(id));
    const extra: string[] = [];
    for (const id of membership) if (!truth.has(id)) extra.push(id);
    if (missing.length === 0 && extra.length === 0) return;
    (onDivergence ?? defaultDivergenceReport)({ entityType, missing, extra });
    if (adopt(truthIds)) notify();
  };

  // ── Opaque tier: coalesced re-scan ─────────
  const scheduleScan = (): void => {
    if (scanScheduled) return;
    scanScheduled = true;
    queueMicrotask(() => {
      scanScheduled = false;
      if (disposed) return;
      if (adopt(scan())) notify();
    });
  };

  // ── Seed ───────────────────────────────────
  const seedIds = scan();
  for (const id of seedIds) {
    membership.add(id);
    retain(id);
  }
  if (seedIds.length > 0) members = seedIds;

  // ── Event wiring ───────────────────────────
  const unsubscribe = boundary.subscribeEvents((event) => {
    if (disposed || event.entityType !== entityType) return;
    if (tier === "encodable") {
      if (applyDelta(event)) notify();
      if (verifyIntegrity) checkIntegrity();
    } else {
      scheduleScan();
    }
  });

  // ── Public handle ──────────────────────────
  return {
    tier,
    getMembers() {
      return members;
    },
    has(id: string) {
      return membership.has(id);
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      // Refcounts must not outlive the view that took them (the
      // persist.ts dispose discipline).
      for (const id of membership) release(id);
      membership.clear();
      members = EMPTY_MEMBERS;
      listeners.clear();
    },
  };
}

function defaultDivergenceReport(divergence: MatcherViewDivergence): void {
  console.error(
    `[colada-db] matcher-view DIVERGENCE on "${divergence.entityType}" — ` +
      `encodable tier drifted from re-scan truth (self-healed). ` +
      `missing=${JSON.stringify(divergence.missing)} extra=${JSON.stringify(divergence.extra)}. ` +
      "This is a bug in the delta tier or an entity was mutated in place " +
      "outside store writes — please report it.",
  );
}
