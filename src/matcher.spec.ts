/**
 * Matcher AST suite (DAN-605 / ADR-009): the fail-closed classifier can
 * never be tricked into `encodable`; evaluation semantics are strict,
 * coercion-free, and match the normative table in
 * `docs/design/matcher-semantics.md`; parsing untrusted input executes
 * no foreign code and leaves no time-of-check/time-of-use gap.
 */
import { describe, expect, it } from "vitest";
import {
  classifyFilter,
  evaluateMatcher,
  M,
  MATCHER_MAX_DEPTH,
  MATCHER_MAX_LIST_LENGTH,
  MatcherParseError,
  parseMatcher,
  serializeMatcher,
  type MatcherGroupNode,
  type MatcherNode,
} from "./matcher";

describe("matcher builder (M)", () => {
  it("produces JSON-pure, frozen, canonical nodes", () => {
    const ast = M.and(
      M.eq("status", "active"),
      M.gt("age", 21),
      M.not(M.in("region", ["test", "staging"])),
    );
    // JSON-pure: survives a JSON round-trip losslessly.
    expect(JSON.parse(JSON.stringify(ast))).toEqual(ast);
    // Frozen, recursively.
    expect(Object.isFrozen(ast)).toBe(true);
    const and = ast as MatcherGroupNode;
    expect(Object.isFrozen(and.nodes)).toBe(true);
    expect(Object.isFrozen(and.nodes[0])).toBe(true);
  });

  it("rejects invalid construction eagerly (builder = parser citizens)", () => {
    expect(() => M.eq("", "x")).toThrow(MatcherParseError);
    expect(() => M.eq("__proto__", "x")).toThrow(MatcherParseError);
    // Ordered ops refuse non-ordered scalars even via the typed builder
    // (runtime callers may not be typed).
    expect(() => M.gt("age", true as unknown as number)).toThrow(MatcherParseError);
    expect(() => M.eq("age", Number.NaN)).toThrow(MatcherParseError);
  });
});

/**
 * Fields are flat own-property names — the documented semantic in
 * `docs/design/matcher-semantics.md` and the `matcher.ts` module docs.
 * Pinned here because until the pre-publish review 2026-08-01 the ONLY thing
 * asserting it was prose, and the failure mode is silent: a filter written
 * with nested intent returns an empty result rather than an error, which on
 * the agent surface reads as a confident "no matches".
 */
describe("matcher fields are flat — no path traversal", () => {
  it("a dotted field is a literal key, not a path", () => {
    expect(evaluateMatcher(M.eq("a.b", 2), { a: { b: 2 } })).toBe(false);
    // ...and it DOES match the literal key, which is why the dot stays legal.
    expect(evaluateMatcher(M.eq("a.b", 2), { "a.b": 2 })).toBe(true);
  });

  it("the parser accepts a dotted field rather than refusing it", () => {
    expect(() => parseMatcher({ op: "eq", field: "a.b", value: 2 })).not.toThrow();
  });

  it("exists does not traverse either", () => {
    expect(evaluateMatcher(M.exists("a.b"), { a: { b: 2 } })).toBe(false);
    expect(evaluateMatcher(M.exists("a.b"), { "a.b": undefined })).toBe(false);
    expect(evaluateMatcher(M.exists("a.b"), { "a.b": null })).toBe(true);
  });
});

describe("evaluateMatcher — strict semantics", () => {
  const entity = {
    id: "1",
    status: "active",
    age: 30,
    score: 0,
    nick: null,
    tags: "b",
    nan: Number.NaN,
  };

  it("eq/neq never coerce types", () => {
    expect(evaluateMatcher(M.eq("age", 30), entity)).toBe(true);
    expect(evaluateMatcher(M.eq("age", "30"), entity)).toBe(false); // number ≠ "30"
    expect(evaluateMatcher(M.eq("score", 0), entity)).toBe(true);
    expect(evaluateMatcher(M.eq("score", false as unknown as number), entity)).toBe(false); // 0 ≠ false
    expect(evaluateMatcher(M.neq("age", "30"), entity)).toBe(true); // present + different type
  });

  it("null is a present value; absence is not null", () => {
    expect(evaluateMatcher(M.eq("nick", null), entity)).toBe(true);
    expect(evaluateMatcher(M.eq("missing", null), entity)).toBe(false); // absent fails eq null
    expect(evaluateMatcher(M.exists("nick"), entity)).toBe(true); // null counts as present
    expect(evaluateMatcher(M.exists("missing"), entity)).toBe(false);
    expect(evaluateMatcher(M.exists("missing", false), entity)).toBe(true);
  });

  it("undefined-valued own property counts as absent", () => {
    const e = { ghost: undefined };
    expect(evaluateMatcher(M.exists("ghost"), e)).toBe(false);
    expect(evaluateMatcher(M.eq("ghost", null), e)).toBe(false);
  });

  it("absent fields fail EVERY comparison, including neq and nin (SQL NULL discipline)", () => {
    expect(evaluateMatcher(M.neq("missing", "x"), entity)).toBe(false);
    expect(evaluateMatcher(M.nin("missing", ["x"]), entity)).toBe(false);
    expect(evaluateMatcher(M.in("missing", ["x", null]), entity)).toBe(false);
    expect(evaluateMatcher(M.gt("missing", 0), entity)).toBe(false);
  });

  it("not() is total negation of the two-valued result (documented SQL-compile divergence)", () => {
    expect(evaluateMatcher(M.not(M.eq("missing", "x")), entity)).toBe(true);
    expect(evaluateMatcher(M.not(M.eq("status", "active")), entity)).toBe(false);
  });

  it("ordered comparisons require the same primitive type — no cross-type ordering", () => {
    expect(evaluateMatcher(M.gt("age", 21), entity)).toBe(true);
    expect(evaluateMatcher(M.gt("age", "21"), entity)).toBe(false); // number vs string bound
    expect(evaluateMatcher(M.gte("age", 30), entity)).toBe(true);
    expect(evaluateMatcher(M.lt("tags", "c"), entity)).toBe(true); // UTF-16 code units
    expect(evaluateMatcher(M.lt("tags", "B"), entity)).toBe(false); // "B" (0x42) < "b" (0x62)
  });

  it("NaN entity values fail all ordered comparisons and eq (IEEE)", () => {
    expect(evaluateMatcher(M.gt("nan", 0), entity)).toBe(false);
    expect(evaluateMatcher(M.lt("nan", 0), entity)).toBe(false);
    expect(evaluateMatcher(M.in("nan", [1, 2]), entity)).toBe(false);
    expect(evaluateMatcher(M.neq("nan", 0), entity)).toBe(true); // present + !==
  });

  it("in/nin use eq semantics per element; empty lists follow the identities", () => {
    expect(evaluateMatcher(M.in("status", ["active", "archived"]), entity)).toBe(true);
    expect(evaluateMatcher(M.in("status", []), entity)).toBe(false);
    expect(evaluateMatcher(M.nin("status", []), entity)).toBe(true); // present, excluded by nothing
    expect(evaluateMatcher(M.nin("status", ["archived"]), entity)).toBe(true);
    expect(evaluateMatcher(M.in("nick", [null]), entity)).toBe(true);
  });

  it("and([]) is true, or([]) is false (boolean identities, documented)", () => {
    expect(evaluateMatcher(M.and(), entity)).toBe(true);
    expect(evaluateMatcher(M.or(), entity)).toBe(false);
  });

  it("reads OWN properties only — prototype-chain values are invisible", () => {
    const proto = { inherited: "yes" };
    const e = Object.create(proto) as Record<string, unknown>;
    e.own = "here";
    expect(evaluateMatcher(M.eq("own", "here"), e)).toBe(true);
    expect(evaluateMatcher(M.eq("inherited", "yes"), e)).toBe(false);
    expect(evaluateMatcher(M.exists("inherited"), e)).toBe(false);
  });

  it("throws loudly on a forged node with an unknown operator (never silently false)", () => {
    const forged = { op: "regex", field: "id", value: ".*" } as unknown as MatcherNode;
    expect(() => evaluateMatcher(forged, entity)).toThrow(MatcherParseError);
  });
});

describe("parseMatcher — untrusted input", () => {
  it("returns fresh frozen copies: mutating the input after parse changes nothing", () => {
    const input = { op: "eq", field: "status", value: "active" };
    const ast = parseMatcher(input);
    input.value = "EVIL";
    input.field = "other";
    expect(ast).toEqual({ op: "eq", field: "status", value: "active" });
    expect(Object.isFrozen(ast)).toBe(true);
  });

  it("never executes foreign code: accessor properties are rejected, not read", () => {
    let executed = false;
    const trap = {
      op: "eq",
      field: "status",
      get value() {
        executed = true;
        return "active";
      },
    };
    expect(() => parseMatcher(trap)).toThrow(MatcherParseError);
    try {
      parseMatcher(trap);
    } catch (e) {
      expect((e as MatcherParseError).code).toBe("accessor-property");
    }
    expect(executed).toBe(false);
  });

  it("rejects getters planted on ARRAY INDICES too — unread", () => {
    let executed = false;
    const values = [1, 2];
    Object.defineProperty(values, 1, {
      get() {
        executed = true;
        return 2;
      },
    });
    expect(() => parseMatcher({ op: "in", field: "a", values })).toThrow(MatcherParseError);
    const nodes = [{ op: "eq", field: "a", value: 1 }];
    Object.defineProperty(nodes, 0, {
      get() {
        executed = true;
        return { op: "eq", field: "a", value: 1 };
      },
    });
    expect(() => parseMatcher({ op: "and", nodes })).toThrow(MatcherParseError);
    expect(executed).toBe(false);
  });

  it("rejects prototype-pollution-shaped field names, including via JSON.parse", () => {
    for (const field of ["__proto__", "constructor", "prototype"]) {
      expect(() => parseMatcher({ op: "eq", field, value: 1 })).toThrow(MatcherParseError);
    }
    const viaJson: unknown = JSON.parse('{"op":"eq","field":"__proto__","value":{"polluted":1}}');
    expect(() => parseMatcher(viaJson)).toThrow(MatcherParseError);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("caps depth — a depth bomb is refused without a stack overflow", () => {
    let bomb: Record<string, unknown> = { op: "eq", field: "id", value: "1" };
    for (let i = 0; i < 100_000; i++) bomb = { op: "not", node: bomb };
    try {
      parseMatcher(bomb);
      expect.unreachable("depth bomb must be refused");
    } catch (e) {
      expect(e).toBeInstanceOf(MatcherParseError);
      expect((e as MatcherParseError).code).toBe("depth-exceeded");
    }
    // Boundary: exactly MATCHER_MAX_DEPTH parses; one more does not.
    let ok: Record<string, unknown> = { op: "eq", field: "id", value: "1" };
    for (let i = 0; i < MATCHER_MAX_DEPTH - 1; i++) ok = { op: "not", node: ok };
    expect(() => parseMatcher(ok)).not.toThrow();
    expect(() => parseMatcher({ op: "not", node: ok })).toThrow(MatcherParseError);
  });

  it("caps in/nin list length", () => {
    const values = Array.from({ length: MATCHER_MAX_LIST_LENGTH + 1 }, () => 0);
    expect(() => parseMatcher({ op: "in", field: "id", values })).toThrow(MatcherParseError);
  });

  it("caps AGGREGATE cost — wide trees of maximal lists are refused (install-once DoS)", () => {
    // Each list is individually legal (10k ≤ cap); together they blow the
    // aggregate budget. Security review 2026-07-20, ADVISORY-1.
    const bigList = Array.from({ length: MATCHER_MAX_LIST_LENGTH }, (_, i) => i);
    const wide = {
      op: "and",
      nodes: Array.from({ length: 10 }, () => ({ op: "in", field: "a", values: bigList })),
    };
    const verdict = classifyFilter(wide);
    expect(verdict.tier).toBe("opaque");
    if (verdict.tier === "opaque") expect(verdict.reason).toContain("budget-exceeded");
    // A merely-large tree under budget stays encodable.
    const moderate = {
      op: "and",
      nodes: Array.from({ length: 100 }, (_, i) => ({ op: "eq", field: "f", value: i })),
    };
    expect(classifyFilter(moderate).tier).toBe("encodable");
  });

  it("rejects unexpected keys — nothing is silently dropped, even non-enumerable", () => {
    expect(() => parseMatcher({ op: "eq", field: "a", value: 1, extra: true })).toThrow(
      MatcherParseError,
    );
    const smuggler: Record<string, unknown> = { op: "eq", field: "a", value: 1 };
    Object.defineProperty(smuggler, "hidden", { value: "payload", enumerable: false });
    expect(() => parseMatcher(smuggler)).toThrow(MatcherParseError);
  });

  it("normalizes -0 to 0 so the round-trip law holds exactly", () => {
    const ast = parseMatcher({ op: "eq", field: "x", value: -0 });
    expect(Object.is((ast as { value: unknown }).value, 0)).toBe(true);
    expect(parseMatcher(JSON.parse(serializeMatcher(ast)))).toEqual(ast);
    const list = parseMatcher({ op: "in", field: "x", values: [-0, 1] });
    expect(Object.is((list as { values: readonly unknown[] }).values[0], 0)).toBe(true);
  });

  it("reports the offending path", () => {
    const bad = { op: "and", nodes: [{ op: "eq", field: "a", value: 1 }, { op: "??" }] };
    try {
      parseMatcher(bad);
      expect.unreachable();
    } catch (e) {
      expect((e as MatcherParseError).path).toBe("$.nodes[1].op");
    }
  });
});

describe("classifyFilter — fails CLOSED", () => {
  it("valid ASTs are encodable, carrying the canonical frozen tree", () => {
    const verdict = classifyFilter({ op: "eq", field: "status", value: "active" });
    expect(verdict.tier).toBe("encodable");
    if (verdict.tier === "encodable") {
      expect(Object.isFrozen(verdict.ast)).toBe(true);
      expect(evaluateMatcher(verdict.ast, { status: "active" })).toBe(true);
    }
  });

  it("never returns encodable for anything the evaluator is not total over", () => {
    const adversarial: Array<[string, unknown]> = [
      ["function filter", (e: { x: number }) => e.x > 1],
      ["arrow returning true", () => true],
      ["string", "status = 'active'"],
      ["number", 42],
      ["null", null],
      ["undefined", undefined],
      ["array", [{ op: "eq", field: "a", value: 1 }]],
      ["empty object", {}],
      ["unknown operator", { op: "regex", field: "a", value: ".*" }],
      ["SQL-ish operator", { op: "like", field: "a", value: "%x%" }],
      ["missing field", { op: "eq", value: 1 }],
      ["numeric field", { op: "eq", field: 7, value: 1 }],
      ["undefined value", { op: "eq", field: "a", value: undefined }],
      ["NaN value", { op: "eq", field: "a", value: Number.NaN }],
      ["Infinity value", { op: "gt", field: "a", value: Number.POSITIVE_INFINITY }],
      ["Date value", { op: "eq", field: "a", value: new Date(0) }],
      ["BigInt value", { op: "eq", field: "a", value: 1n }],
      ["object value", { op: "eq", field: "a", value: { nested: 1 } }],
      ["boolean ordered bound", { op: "gt", field: "a", value: true }],
      ["null ordered bound", { op: "lte", field: "a", value: null }],
      ["non-array in-list", { op: "in", field: "a", values: "abc" }],
      ["nested bad node", { op: "and", nodes: [{ op: "eq", field: "a", value: 1 }, null] }],
      ["nodes not an array", { op: "or", nodes: { op: "eq", field: "a", value: 1 } }],
      ["exists with string flag", { op: "exists", field: "a", value: "true" }],
      ["extra key smuggling", { op: "eq", field: "a", value: 1, $where: "code" }],
    ];
    for (const [label, input] of adversarial) {
      const verdict = classifyFilter(input);
      expect(verdict.tier, `must be opaque: ${label}`).toBe("opaque");
    }
  });
});

describe("classifyFilter — misbehaving Proxies degrade to opaque, never crash", () => {
  it("a trap that throws is opaque (deliberate contract: foreign errors never escape)", () => {
    const bomb = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("trap-bomb");
        },
      },
    );
    const verdict = classifyFilter(bomb);
    expect(verdict.tier).toBe("opaque");
  });

  it("a revoked proxy is opaque", () => {
    const { proxy, revoke } = Proxy.revocable({ op: "eq", field: "a", value: 1 }, {});
    revoke();
    expect(classifyFilter(proxy).tier).toBe("opaque");
  });

  it("a benign proxy (Vue-reactive-shaped) parses through its traps to a fresh validated copy", () => {
    const target = { op: "eq", field: "status", value: "active" };
    const proxy = new Proxy(target, {}); // transparent traps, like reactive()
    const verdict = classifyFilter(proxy);
    expect(verdict.tier).toBe("encodable");
    if (verdict.tier === "encodable") {
      expect(verdict.ast).not.toBe(target); // fresh copy, not the proxy or target
      expect(evaluateMatcher(verdict.ast, { status: "active" })).toBe(true);
    }
  });
});

describe("serializeMatcher — canonical round-trip", () => {
  it("is key-order independent and round-trip stable", () => {
    const a: unknown = JSON.parse('{"op":"eq","field":"status","value":"active"}');
    const b: unknown = JSON.parse('{"value":"active","field":"status","op":"eq"}');
    const sa = serializeMatcher(parseMatcher(a));
    const sb = serializeMatcher(parseMatcher(b));
    expect(sa).toBe(sb);

    const ast = M.and(M.eq("status", "active"), M.or(M.gt("age", 21), M.exists("vip")));
    const reparsed = parseMatcher(JSON.parse(serializeMatcher(ast)));
    expect(reparsed).toEqual(ast);
    expect(serializeMatcher(reparsed)).toBe(serializeMatcher(ast));
  });
});
