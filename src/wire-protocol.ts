/**
 * The `v1` wire protocol's normative rules, as code.
 *
 * `docs/protocol/sync-wire-protocol-v1.md` is the specification. This module is
 * the part of it that must never be re-derived by hand, because getting it
 * wrong is silent and permanent.
 *
 * ## Why the status-code table is code and not prose
 *
 * The single most dangerous confusion in ADR-006 is a transient failure
 * reported as a permanent `reject`. A `reject` makes the coordinator revert the
 * optimistic overlay and drop the outbox entry — so a network blip becomes
 * irreversible loss of a valid user write, with nothing logged anywhere.
 *
 * Every adapter author has to make that call for every status code. A table in
 * a markdown file gets read once and remembered wrong. A function gets called
 * every time. `restAdapter` and every adapter after it route through this.
 *
 * ## NOT re-exported from `src/index.ts`
 *
 * ADR-022 lines 1 and 2, same as `sync-types.ts` and `sync-conformance.ts`.
 */

/** The protocol version this module speaks. A path segment, per ADR-023. */
export const WIRE_PROTOCOL_VERSION = "v1" as const;

export const WIRE_PULL_PATH = `/sync/${WIRE_PROTOCOL_VERSION}/pull` as const;
export const WIRE_PUSH_PATH = `/sync/${WIRE_PROTOCOL_VERSION}/push` as const;

/**
 * What an adapter must do with an HTTP response.
 *
 * - `verdict` — a body is present and carries the answer. Return it.
 * - `transient` — **throw.** The coordinator retries with backoff, the outbox
 *   entry survives, and the optimistic overlay stays on screen.
 * - `permanent` — surface it. The request will never succeed as sent.
 * - `schema` — throw a typed schema error. The outbox is SUSPENDED, never
 *   drained: a schema bump may need an application-level migration, and the
 *   outbox is the one thing that has to survive one.
 */
export type WireOutcome = "verdict" | "transient" | "permanent" | "schema";

/**
 * Classify an HTTP status per the protocol's §8 table.
 *
 * **Architecture Invariant — the default is `transient`, and the asymmetry is
 * deliberate.** An unrecognized status could be either. A retried write is
 * recoverable; a wrongly-permanent one is not. So anything this function does
 * not recognize is retried rather than discarded, and the protocol tells server
 * authors the same thing: *if you are unsure which a condition is, return 5xx.*
 */
export function classifyWireStatus(status: number): WireOutcome {
  if (status >= 200 && status < 300) return "verdict";

  // Checked before the general 4xx branch: 409 is the schema/gap channel, and
  // it must suspend rather than reject. Ordering matters here.
  if (status === 409) return "schema";

  // Timeout and rate-limit are 4xx by number and transient by nature. They are
  // the reason this cannot be a simple `status < 500` test.
  if (status === 408 || status === 429) return "transient";

  if (status >= 400 && status < 500) return "permanent";

  return "transient";
}

/**
 * Whether a classified outcome means the adapter throws rather than returns.
 *
 * Exists so an adapter never has to remember that `schema` throws too — it is
 * the case most likely to be mishandled, because it is a 4xx and *looks*
 * permanent while carrying writes that must not be dropped.
 */
export function wireOutcomeThrows(outcome: WireOutcome): boolean {
  return outcome === "transient" || outcome === "schema" || outcome === "permanent";
}

/**
 * Exponential backoff with full jitter — protocol §8.
 *
 * **No attempt ceiling and no dead-letter queue.** A write is dropped by a user
 * or by an explicit `reject`, never by a timer. Callers pass their own random
 * source so the schedule is testable rather than merely plausible.
 */
export function wireBackoffMs(
  attempt: number,
  random: () => number,
  initialMs = 1_000,
  maxMs = 60_000,
): number {
  const exponential = Math.min(maxMs, initialMs * 2 ** Math.max(0, attempt - 1));
  // FULL jitter, not "exponential plus a wobble": the whole point is to
  // decorrelate a fleet of clients that all failed at the same instant, and a
  // narrow jitter band leaves them synchronized enough to thunder anyway.
  return Math.floor(random() * exponential);
}
