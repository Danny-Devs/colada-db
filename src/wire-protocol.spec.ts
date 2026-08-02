/**
 * The `v1` wire protocol's normative claims, pinned.
 *
 * `docs/protocol/sync-wire-protocol-v1.md` names this file in its `verified_by`
 * frontmatter, so these tests are what stop that document from being a claim
 * nothing checks.
 */
import { describe, expect, it } from "vitest";
import {
  WIRE_PROTOCOL_VERSION,
  WIRE_PULL_PATH,
  WIRE_PUSH_PATH,
  classifyWireStatus,
  wireBackoffMs,
  wireOutcomeThrows,
} from "./wire-protocol";
import { defaultCompareVersions } from "./sync-types";

describe("wire protocol v1 — versioning (ADR-023)", () => {
  it("puts the version in the path, not a header", () => {
    // A path segment is legible to every intermediary and impossible to omit.
    // Header negotiation is invisible in logs and in a CDN cache key.
    expect(WIRE_PULL_PATH).toBe("/sync/v1/pull");
    expect(WIRE_PUSH_PATH).toBe("/sync/v1/push");
    expect(WIRE_PROTOCOL_VERSION).toBe("v1");
  });

  it("pins v1 so a breaking change must become a new path", () => {
    // This assertion is the freeze. Editing it is the loud moment ADR-023
    // describes — a v2 is a new constant and a new path, never a changed one.
    expect(WIRE_PULL_PATH.startsWith("/sync/v1/")).toBe(true);
  });
});

describe("wire protocol v1 — §8, the transient/permanent split", () => {
  it("treats 2xx as a verdict in the body", () => {
    for (const s of [200, 201, 204, 299]) expect(classifyWireStatus(s)).toBe("verdict");
  });

  it("treats ordinary 4xx as permanent", () => {
    for (const s of [400, 401, 403, 404, 422]) {
      expect(classifyWireStatus(s)).toBe("permanent");
    }
  });

  it("treats 408 and 429 as TRANSIENT despite being 4xx", () => {
    // The reason this cannot be `status < 500`. A rate-limited push is the most
    // ordinary thing in the world and must never cost the user their write.
    expect(classifyWireStatus(408)).toBe("transient");
    expect(classifyWireStatus(429)).toBe("transient");
  });

  it("routes 409 to the schema channel, not to permanent", () => {
    // 409 is a 4xx and LOOKS permanent, which is exactly why it is the case
    // most likely to be mishandled. It suspends the outbox; it never drains it.
    expect(classifyWireStatus(409)).toBe("schema");
  });

  it("treats 5xx as transient", () => {
    for (const s of [500, 502, 503, 504]) expect(classifyWireStatus(s)).toBe("transient");
  });

  it("defaults an UNRECOGNIZED status to transient, never permanent", () => {
    // The deliberate asymmetry: a retried write is recoverable, a wrongly
    // permanent one is not. If the classifier must guess, it guesses in the
    // direction that cannot destroy data.
    for (const s of [0, 99, 600, 999, -1, Number.NaN]) {
      expect(classifyWireStatus(s)).toBe("transient");
    }
  });

  it("never returns a verdict for anything outside 2xx", () => {
    // The clause the whole table exists to enforce: a transport outcome must
    // never be readable as an application verdict.
    for (let s = 300; s < 600; s++) expect(classifyWireStatus(s)).not.toBe("verdict");
  });

  it("makes every non-verdict outcome throw", () => {
    expect(wireOutcomeThrows("verdict")).toBe(false);
    for (const o of ["transient", "permanent", "schema"] as const) {
      expect(wireOutcomeThrows(o)).toBe(true);
    }
  });
});

describe("wire protocol v1 — §8, backoff", () => {
  const half = () => 0.5;

  it("grows exponentially from the initial delay", () => {
    expect(wireBackoffMs(1, half)).toBe(500); // 0.5 × 1000
    expect(wireBackoffMs(2, half)).toBe(1_000); // 0.5 × 2000
    expect(wireBackoffMs(3, half)).toBe(2_000); // 0.5 × 4000
  });

  it("caps at the maximum no matter how many attempts", () => {
    // No attempt ceiling means `attempt` grows without bound; the DELAY must
    // not, or a client that has been offline a week never retries again.
    expect(wireBackoffMs(999, half)).toBe(30_000); // 0.5 × 60_000
    expect(wireBackoffMs(Number.MAX_SAFE_INTEGER, half)).toBe(30_000);
  });

  it("uses FULL jitter, so a synchronized fleet decorrelates", () => {
    // random()=0 must be able to produce 0. A narrow jitter band around the
    // exponential leaves a fleet that all failed at once still synchronized.
    expect(wireBackoffMs(5, () => 0)).toBe(0);
    expect(wireBackoffMs(5, () => 0.999)).toBeGreaterThan(wireBackoffMs(5, () => 0.001));
  });

  it("never returns a negative or fractional delay", () => {
    for (const attempt of [0, 1, 7, 100]) {
      for (const r of [0, 0.3, 0.999]) {
        const ms = wireBackoffMs(attempt, () => r);
        expect(ms).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(ms)).toBe(true);
      }
    }
  });
});

describe("wire protocol v1 — §9, the numeric-string trap", () => {
  it('orders "10" after "9" instead of lexicographically', () => {
    // The trap the protocol warns server authors about: a backend issuing
    // integer versions as unpadded strings would otherwise silently order its
    // own history backwards, and nothing would report an error.
    expect(defaultCompareVersions("10", "9")).toBe("newer");
    expect(defaultCompareVersions("9", "10")).toBe("older");
  });

  it("still orders genuinely non-numeric tokens lexicographically", () => {
    expect(defaultCompareVersions("2026-01-02", "2026-01-01")).toBe("newer");
  });

  it("never invents concurrency", () => {
    // §9: the default comparator NEVER returns `concurrent`. A conventional
    // server-authoritative backend must be able to ignore that value entirely.
    const tokens = [1, 2, "a", "b", "10", "9", "2026-01-01"];
    for (const a of tokens) {
      for (const b of tokens) expect(defaultCompareVersions(a, b)).not.toBe("concurrent");
    }
  });
});
