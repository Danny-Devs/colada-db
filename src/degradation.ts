/**
 * The runtime-independent degradation channel (DAN-659).
 *
 * ## Why this module exists
 *
 * Five paths in this library degrade rather than fail: a `writeBatch` failure,
 * an engine `open()` failure, the SQLite/OPFS fallback, a persisted format
 * version newer than this build, and a matcher view built on a foreign
 * `StoreBoundary`. Three of them were already observable in ANY runtime — two
 * through `onError`, one through the public `engine.persistent` getter. The
 * remaining two spoke only through `console.warn`, behind the
 * `process.env.NODE_ENV` guard DAN-649 installed.
 *
 * That guard is correct and stays. Its consequence is what this module answers:
 * where `process` is absent the guard evaluates false, so a CDN / plain
 * `<script type="module">` consumer — the exact audience DAN-649 was written to
 * rescue — got graceful degradation with **no diagnostic at all**. The flagship
 * framework-free demo could run on an empty database because OPFS was
 * unavailable outside a secure context, and the page had no way to know.
 *
 * The rejected fix was to assume-dev-when-the-environment-is-unknown so the
 * warnings survive. It is self-defeating: the runtimes without `process` are
 * precisely those most likely to lack a full `console`, so it would reintroduce
 * an unguarded global read on the very paths whose purpose is never to crash.
 * A CDN consumer also has no `NODE_ENV` to turn the noise back off.
 *
 * So the channel is a callback the consumer supplies. No `console`, no
 * `process`, no bundler, no globals of any kind.
 *
 * ## Architecture Invariant: a degradation signal never throws into its emitter
 *
 * Every one of these events fires on a path that is already recovering from
 * something. A handler that throws must not convert a survived degradation into
 * an unhandled rejection during boot — which is why {@link emitDegradation} is
 * the only sanctioned way to call one, and why nothing here re-raises.
 *
 * ## Architecture Invariant: reason codes are an OPEN vocabulary
 *
 * {@link DegradationReason} is deliberately not a closed union. ADR-018's boot
 * policy is forward-tolerant by design — a database stamped with a version this
 * build has never heard of is read anyway rather than refused — and a
 * diagnostic vocabulary for a forward-tolerant system must be forward-tolerant
 * too. The `(string & {})` arm keeps editor autocomplete on the known codes
 * while making an unrecognized code a value a consumer's `switch` must already
 * handle, so publishing a sixth code later is additive rather than a silent
 * change of meaning for anyone who wrote an exhaustive match.
 *
 * The KNOWN codes, on the other hand, are permanent. They are matched by string
 * equality in consumer code, so renaming one is a breaking change with no
 * compiler error anywhere to announce it.
 */

/**
 * Machine-readable identity of a degradation event — stable, matched by string
 * equality, and never renamed.
 *
 * - `"format-version-newer"` — the persisted database was written by a newer
 *   build of colada-db than the one reading it (ADR-018). Data is readable, but
 *   rows written by the newer format may not hydrate correctly. Nothing is lost
 *   and nothing is migrated; this is the forward-tolerance escape hatch
 *   announcing itself.
 * - `"matcher-view-foreign-boundary"` — a matcher view was created over a
 *   `StoreBoundary` this library cannot resolve an entity store from (a foreign
 *   implementation). Membership results stay correct; what is lost is gc
 *   pinning, so members may be swept out from under the view.
 *
 * Treat any other value as a degradation this build predates.
 */
export type DegradationReason =
  | "format-version-newer"
  | "matcher-view-foreign-boundary"
  // Open on purpose — see the module invariant above. The intersection with an
  // empty object is the standard idiom for "any string, but keep autocomplete".
  | (string & {});

/** One degradation, described in a form a program can branch on. */
export interface DegradationEvent {
  /** Stable machine-readable identity. Branch on this, never on `message`. */
  readonly reason: DegradationReason;
  /**
   * Human-readable explanation for logs and error reporters. Wording is NOT
   * part of the contract and may change in any release — anything a program
   * needs to act on lives in {@link DegradationEvent.detail}.
   */
  readonly message: string;
  /**
   * Structured particulars, keyed per reason:
   *
   * - `format-version-newer` → `{ found: number; supported: number }`
   * - `matcher-view-foreign-boundary` → `{ entityType: string }`
   */
  readonly detail?: Readonly<Record<string, unknown>>;
}

/**
 * Where degradation events go. Supplied by the consumer, so it works in every
 * runtime — the same handler can be passed to `enablePersistence` and to every
 * `createMatcherView`, giving one place to observe all of them.
 */
export type DegradationHandler = (event: DegradationEvent) => void;

/**
 * Deliver `event` to `handler`, if there is one, without ever throwing.
 *
 * The error-isolation posture the rest of the library already uses for consumer
 * callbacks (matcher-view listeners, throwing predicates), applied here for a
 * sharper reason: these callbacks fire mid-recovery. A consumer whose reporter
 * is momentarily broken must not have that turn a handled degradation into an
 * unhandled failure of the operation that survived it.
 *
 * The swallowed error is re-reported through the dev console — guarded in the
 * DAN-649 strippable shape, because this file ships to the same bundler-less
 * runtimes as the rest.
 */
export function emitDegradation(
  handler: DegradationHandler | undefined,
  event: DegradationEvent,
): void {
  if (!handler) return;
  try {
    handler(event);
  } catch (err) {
    if (typeof process !== "undefined" && process.env && process.env.NODE_ENV !== "production") {
      console.error(
        `[colada-db] onDegraded handler threw while reporting "${event.reason}" ` +
          "(swallowed — a degradation report must never break the path it reports on):",
        err,
      );
    }
  }
}
