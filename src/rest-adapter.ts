/**
 * `restAdapter` — the reference `SyncAdapter`, and the client half of the sync
 * wire protocol `v1` (`docs/protocol/sync-wire-protocol-v1.md`).
 *
 * It does exactly two things: `POST` the pull request to `/sync/v1/pull` and
 * the push batch to `/sync/v1/push`, and translate each HTTP response into the
 * one thing the coordinator's contract can accept — a verdict body, or a
 * thrown error of the right kind. Everything with judgment in it lives
 * elsewhere: the status table is `classifyWireStatus` (`src/wire-protocol.ts`),
 * retry/backoff is the coordinator's (D9), and conflict posture is the
 * server's (§6). An adapter that accumulates policy stops being a reference.
 *
 * ## What this adapter deliberately does NOT have
 *
 * - **No `subscribe()`.** Protocol v1 defines no live channel (§2 — out of
 *   band); the coordinator polls. Absence is the honest signal.
 * - **No `compareVersions`.** This is the server-authoritative reference; the
 *   default comparator is the contract's default for exactly this case (D3).
 * - **No predicate surface** (rev c C2-1, DAN-676 constraint 1). Selection is
 *   a cursor and an opaque subscription name, full stop. A `where`/`filter`
 *   option here would be the E2EE one-way door.
 * - **No identity model** (§4). Credentials ride in caller-supplied headers;
 *   this module never reads them, and `clientId` is bytes (C3).
 *
 * ## NOT re-exported from `src/index.ts`
 *
 * ADR-022 lines 1 and 2 — same precedent as `sync-types.ts`,
 * `wire-protocol.ts` and `coordinator.ts`. Promoting the sync surface to a
 * published entry point is a separate, deliberate act, and per the protocol
 * doc's §14 it is ALSO the act that freezes `v1`.
 */
import { SchemaVersionError } from "./coordinator";
import type { LocalChange, PullOptions, PullResult, PushResult, SyncAdapter } from "./sync-types";
import { classifyWireStatus, WIRE_PULL_PATH, WIRE_PUSH_PATH } from "./wire-protocol";

/** Transport-level headers (§4 — the protocol never inspects them). A callback
 *  form exists so a caller can refresh a token per request. */
export type RestAdapterHeaders =
  | Record<string, string>
  | (() => Record<string, string> | Promise<Record<string, string>>);

export interface RestAdapterOptions {
  /** Server origin (plus any path prefix) the `/sync/v1/*` paths append to. */
  baseUrl: string;
  headers?: RestAdapterHeaders;
  /** Injectable for tests; defaults to the global. The adapter itself must run
   *  in bundler-less browsers, so `fetch` is the only transport it may assume. */
  fetch?: typeof globalThis.fetch;
  /** Sent on every request unless a per-call option overrides it. */
  schemaVersion?: string;
}

/**
 * A non-2xx HTTP outcome, thrown rather than returned. `outcome` is
 * `classifyWireStatus`'s word for it, preserved so an application watching the
 * coordinator's retry state (D9) can tell a retrying 503 from a stuck 401 —
 * the coordinator itself retries both, because staying visibly stuck is the
 * contract's chosen failure mode and a dropped write is not (D9).
 */
export class RestAdapterHttpError extends Error {
  readonly status: number;
  readonly outcome: "transient" | "permanent";

  constructor(status: number, outcome: "transient" | "permanent", endpoint: string) {
    super(`restAdapter: HTTP ${status} (${outcome}) from ${endpoint}`);
    this.name = "RestAdapterHttpError";
    this.status = status;
    this.outcome = outcome;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A 200 whose body does not carry what the protocol requires. Loud on purpose:
 *  propagating `undefined` into the coordinator's cursor map would corrupt the
 *  pull position silently, which is strictly worse than a retried error. */
function malformed(endpoint: string, why: string): Error {
  return new Error(`restAdapter: malformed response from ${endpoint} — ${why}`);
}

/** Validates the §7 pull-response shape, then returns the SAME object: §3
 *  requires unknown fields (checksum, retentionSeconds, future additions) to be
 *  ignored, and passing the body through untouched is what "ignored" means —
 *  reconstructing it field-by-field would silently strip them instead. */
function toPullResult(body: unknown): PullResult {
  if (!isRecord(body)) throw malformed(WIRE_PULL_PATH, "body is not a JSON object");

  if (body.type === "reset") {
    // §7's reset example sends `"cursor": null`; anything else non-string would
    // be adopted by the coordinator's `result.cursor ?? null` and POSTed back
    // into a slot the protocol declares string-or-null — a reset loop.
    if (body.cursor != null && typeof body.cursor !== "string") {
      throw malformed(WIRE_PULL_PATH, "a reset's cursor is neither a string nor null");
    }
    return body as unknown as PullResult;
  }

  if (body.type === "changes") {
    if (typeof body.cursor !== "string") throw malformed(WIRE_PULL_PATH, "'changes' without a string cursor");
    if (typeof body.complete !== "boolean") throw malformed(WIRE_PULL_PATH, "'changes' without a boolean complete");
    if (!Array.isArray(body.changes)) throw malformed(WIRE_PULL_PATH, "'changes' without a changes array");
    if (body.confirmedMutations !== undefined) {
      if (!isRecord(body.confirmedMutations)) throw malformed(WIRE_PULL_PATH, "confirmedMutations is not an object");
      for (const seq of Object.values(body.confirmedMutations)) {
        // A null/non-numeric mark passes the coordinator's `!== undefined` check
        // while `null >= seq` is always false — the overlay would be pinned
        // forever with nothing anywhere erroring (the silent half of D1).
        if (typeof seq !== "number") throw malformed(WIRE_PULL_PATH, "confirmedMutations carries a non-numeric seq");
      }
    }
    for (const change of body.changes) {
      if (!isRecord(change)) throw malformed(WIRE_PULL_PATH, "a change is not an object");
      if (change.type !== "set" && change.type !== "remove") {
        throw malformed(WIRE_PULL_PATH, `a change has unknown type ${JSON.stringify(change.type)}`);
      }
      if (typeof change.entityType !== "string" || typeof change.id !== "string") {
        throw malformed(WIRE_PULL_PATH, "a change is missing entityType/id");
      }
      // §5: data is absent for `remove` and an entity object for `set`. A falsy
      // or non-object data on a set would slip past the coordinator's
      // `else if (change.data)` write-skip while the version still got stamped —
      // the re-delivered real payload then classifies "same" and is dropped
      // forever. Silent, permanent divergence; refuse it here, loudly.
      if (change.type === "set" && !isRecord(change.data)) {
        throw malformed(WIRE_PULL_PATH, "a set change's data is not an entity object");
      }
      // The version stays opaque bytes (C2/§9) — this checks the JSON slot's
      // presence and primitive kind, never its format or order.
      if (typeof change.version !== "string" && typeof change.version !== "number") {
        throw malformed(WIRE_PULL_PATH, "a change is missing its version token");
      }
    }
    return body as unknown as PullResult;
  }

  throw malformed(WIRE_PULL_PATH, `unknown result type ${JSON.stringify(body.type)}`);
}

/** Same pass-through discipline as `toPullResult`. An unknown VERDICT is not an
 *  unknown field: `v1` is frozen with exactly three, and the coordinator's
 *  verdict switch treats anything unrecognized as an ack — so an unvalidated
 *  novel status would silently confirm a write the server never applied. */
function toPushResult(body: unknown): PushResult {
  if (!isRecord(body)) throw malformed(WIRE_PUSH_PATH, "body is not a JSON object");
  if (!Array.isArray(body.results)) throw malformed(WIRE_PUSH_PATH, "no results array");
  for (const verdict of body.results) {
    if (!isRecord(verdict) || typeof verdict.mutationId !== "string") {
      throw malformed(WIRE_PUSH_PATH, "a verdict is missing its mutationId");
    }
    if (verdict.status !== "ack" && verdict.status !== "reject" && verdict.status !== "transform") {
      throw malformed(WIRE_PUSH_PATH, `a verdict has unknown status ${JSON.stringify(verdict.status)}`);
    }
    // The push-verdict twins of the pull-side checks above — same hazard
    // classes, other channel (found by the landing gauntlet's sibling-branch
    // sweep). A null version would be stamped into the coordinator's version
    // map and lexicographically outrank real tokens forever; truthy non-object
    // transform data reaches store.replace AND the reject re-base shadow; an
    // empty-string remappedId is non-nullish (so it becomes the target id) yet
    // falsy (so the remap block skips) — the correction lands under id "".
    if (verdict.version !== undefined && typeof verdict.version !== "string" && typeof verdict.version !== "number") {
      throw malformed(WIRE_PUSH_PATH, "a verdict's version is neither a string nor a number");
    }
    if (verdict.data !== undefined && !isRecord(verdict.data)) {
      throw malformed(WIRE_PUSH_PATH, "a verdict's data is not an entity object");
    }
    if (verdict.remappedId !== undefined && (typeof verdict.remappedId !== "string" || verdict.remappedId === "")) {
      throw malformed(WIRE_PUSH_PATH, "a verdict's remappedId is not a non-empty string");
    }
  }
  return body as unknown as PushResult;
}

export function restAdapter(options: RestAdapterOptions): SyncAdapter {
  const { baseUrl, headers, schemaVersion } = options;
  const maybeFetch =
    options.fetch ?? (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined);
  if (!maybeFetch) {
    throw new Error("restAdapter: no fetch implementation available — supply options.fetch");
  }
  const fetchImpl: typeof globalThis.fetch = maybeFetch;
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;

  async function resolveHeaders(): Promise<Record<string, string>> {
    const custom = typeof headers === "function" ? await headers() : headers;
    // HTTP headers are a case-insensitive namespace but a plain object is not:
    // spreading a caller's canonical `Content-Type` over the lowercase default
    // would keep BOTH keys, and fetch's Headers fill algorithm JOINS them into
    // one comma-separated value — which strict body parsers refuse. Lowercase
    // the caller's keys so an override is an override in any casing.
    const merged: Record<string, string> = { "content-type": "application/json" };
    for (const [key, value] of Object.entries(custom ?? {})) merged[key.toLowerCase()] = value;
    return merged;
  }

  /** One exchange: POST JSON, classify the status (§8), return the parsed body
   *  or throw the outcome. The cursor and every other field travel in the BODY
   *  (§2) — the URL is the two constants and nothing else. */
  async function post(path: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: await resolveHeaders(),
      body: JSON.stringify(body),
    });

    const outcome = classifyWireStatus(response.status);
    if (outcome === "verdict") {
      // A 200 that isn't JSON (a proxy's HTML error page is the common case)
      // gets the loud diagnosis, not a bare SyntaxError. Still retryable.
      try {
        return await response.json();
      } catch {
        throw malformed(path, "body is not valid JSON");
      }
    }
    if (outcome === "schema") {
      // §8: 409 is the schema-mismatch / seq-gap channel. The coordinator
      // suspends the outbox on this exact class (D12) — never drains it.
      throw new SchemaVersionError(`server returned HTTP 409 for ${path} (schema mismatch or seq gap)`);
    }
    throw new RestAdapterHttpError(response.status, outcome, path);
  }

  return {
    async pull(cursor: string | null, opts?: PullOptions): Promise<PullResult> {
      const body: Record<string, unknown> = { cursor };
      if (opts?.limit !== undefined) body.limit = opts.limit;
      const sv = opts?.schemaVersion ?? schemaVersion;
      if (sv !== undefined) body.schemaVersion = sv;
      if (opts?.subscription !== undefined) body.subscription = opts.subscription;
      return toPullResult(await post(WIRE_PULL_PATH, body));
    },

    async push(batch: LocalChange[], opts?: { schemaVersion?: string }): Promise<PushResult> {
      // The batch is serialized verbatim — transactionId, baseVersion, intent
      // and clientId are the coordinator's and the server's business (§5, D19),
      // and an adapter that edits them in flight is forging one side's words.
      const body: Record<string, unknown> = { changes: batch };
      const sv = opts?.schemaVersion ?? schemaVersion;
      if (sv !== undefined) body.schemaVersion = sv;
      return toPushResult(await post(WIRE_PUSH_PATH, body));
    },
  };
}
