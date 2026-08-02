/**
 * Serializable matcher AST — filters as data, not closures (ADR-009).
 *
 * The substrate for live queries (WatermelonDB-style two-tier
 * observation): a filter expressed as a JSON-pure AST can be re-evaluated
 * in-memory against entity change events with no query re-run, translated
 * to SQL by a worker query tier, hashed into a stable query key, and
 * shipped across an agent boundary — none of which an arbitrary JS
 * closure permits.
 *
 * The classifier FAILS CLOSED (the DAN-605 design law): a filter is
 * `encodable` only when it positively validates as a well-formed AST the
 * evaluator is total over. Closures, unknown operators, malformed shapes,
 * over-deep trees — all `opaque`, routed to the safe re-run tier. A false
 * "encodable" verdict would mean silently missed live-query updates, the
 * worst failure mode this module can have; correctness here is one-sided
 * by construction.
 *
 * Trust boundary: AST inputs are UNTRUSTED (they may arrive as JSON from
 * an agent surface or persisted state) — parsing invokes no accessors
 * (own-data-descriptor reads only; getters are rejected UNREAD), never
 * walks prototype chains, and returns frozen fresh copies. Caveat, stated
 * honestly: Proxy inputs run their own traps during inspection — that is
 * inherent to ANY in-realm examination of a Proxy (even `Array.isArray`
 * triggers traps) and cannot be prevented, only contained. Containment is
 * what we guarantee: a misbehaving Proxy can never yield a false
 * `encodable` verdict (the verdict carries a fresh validated copy, never
 * the input), and {@link classifyFilter} degrades trap-thrown errors to
 * `opaque` instead of crashing. Entity records are TRUSTED store data
 * (same JS realm, plain objects); evaluation reads own properties only.
 *
 * Fields are FLAT own-property names. There is no path traversal: `"a.b"` is
 * the literal key `"a.b"`, not `a` then `b`, so a filter on `"a.b"` against
 * `{ a: { b: 2 } }` matches nothing. This is deliberate — an entity may
 * legitimately own a key containing a dot, and reserving the character would
 * make that key unfilterable — but it is easy to misread, so it is stated
 * here, in `M`'s docs, and in `docs/design/matcher-semantics.md`. Nested
 * access is a normalization concern: give the inner object its own entity
 * type and filter on the flat field that references it.
 *
 * Evaluation semantics are normative and documented in
 * `docs/design/matcher-semantics.md` — the future SQL tier must compile
 * to IDENTICAL semantics (with explicit `IS NULL` guards; see the design
 * doc's SQL-parity notes).
 */

// ─────────────────────────────────────────────
// AST node types (JSON-pure, immutable)
// ─────────────────────────────────────────────

/** A JSON-representable scalar an AST may compare against. */
export type MatcherScalar = string | number | boolean | null;

/** Scalars with a defined ordering (for gt/gte/lt/lte). */
export type MatcherOrderedScalar = string | number;

/** Equality test against one scalar (`eq`) or its negation (`neq`). */
export interface MatcherComparisonNode {
  readonly op: "eq" | "neq";
  readonly field: string;
  readonly value: MatcherScalar;
}

/** Ordered comparison; the AST value must be a string or a number. */
export interface MatcherOrderedNode {
  readonly op: "gt" | "gte" | "lt" | "lte";
  readonly field: string;
  readonly value: MatcherOrderedScalar;
}

/** Membership test against a scalar list (`in`) or its negation (`nin`). */
export interface MatcherListNode {
  readonly op: "in" | "nin";
  readonly field: string;
  readonly values: readonly MatcherScalar[];
}

/**
 * Presence test. `value: true` matches entities where the field is an own
 * property with a value other than `undefined` (a `null` value counts as
 * present); `value: false` matches the complement.
 */
export interface MatcherExistsNode {
  readonly op: "exists";
  readonly field: string;
  readonly value: boolean;
}

/**
 * Boolean combination. `and` of zero nodes is `true`, `or` of zero nodes
 * is `false` (the boolean identities) — documented, deliberate, tested.
 */
export interface MatcherGroupNode {
  readonly op: "and" | "or";
  readonly nodes: readonly MatcherNode[];
}

/** Total negation of the child's two-valued result. */
export interface MatcherNotNode {
  readonly op: "not";
  readonly node: MatcherNode;
}

/** Any matcher AST node. The tree is JSON-pure and frozen after parse. */
export type MatcherNode =
  | MatcherComparisonNode
  | MatcherOrderedNode
  | MatcherListNode
  | MatcherExistsNode
  | MatcherGroupNode
  | MatcherNotNode;

// ─────────────────────────────────────────────
// Limits (fail-closed hardening)
// ─────────────────────────────────────────────

/** Maximum AST nesting depth accepted by the parser. */
export const MATCHER_MAX_DEPTH = 32;

/** Maximum `in`/`nin` list length accepted by the parser. */
export const MATCHER_MAX_LIST_LENGTH = 10_000;

/**
 * Maximum AGGREGATE cost of one AST (nodes cost 1 each, list elements
 * cost 1 each). Depth and per-list caps alone don't bound total work —
 * a wide tree of maximal lists would validate yet cost real
 * milliseconds PER CHANGE EVENT in a live query (install-once,
 * pay-per-write amplification). Over-budget trees are refused →
 * `opaque` → the re-run tier, which is always correct (2026-07-20
 * security review, ADVISORY-1). 65 536 units evaluates in well under a
 * millisecond.
 */
export const MATCHER_MAX_COST = 65_536;

/**
 * Field names that can never be matched on. Matching reads own
 * properties only, so these could not reach the prototype chain anyway —
 * rejecting them at parse time is defense in depth against
 * prototype-pollution-shaped input.
 */
const FORBIDDEN_FIELDS = new Set(["__proto__", "constructor", "prototype"]);

const COMPARISON_OPS = new Set(["eq", "neq"]);
const ORDERED_OPS = new Set(["gt", "gte", "lt", "lte"]);
const LIST_OPS = new Set(["in", "nin"]);
const GROUP_OPS = new Set(["and", "or"]);

// ─────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────

/** Why the parser refused an input (also the classifier's opaque reason). */
export type MatcherParseCode =
  | "not-a-node"
  | "unknown-operator"
  | "invalid-field"
  | "invalid-value"
  | "invalid-list"
  | "list-too-large"
  | "invalid-nodes"
  | "unexpected-key"
  | "accessor-property"
  | "depth-exceeded"
  | "budget-exceeded";

/**
 * A malformed AST was refused. Fail-visible by design: an input the
 * evaluator is not provably total over must never be silently accepted
 * (nor silently "matched nothing" — refusal is loud, matching is exact).
 */
export class MatcherParseError extends Error {
  readonly code: MatcherParseCode;
  /** JSON-pointer-ish location of the offending node, e.g. `$.nodes[2].field`. */
  readonly path: string;

  constructor(code: MatcherParseCode, path: string, detail?: string) {
    super(`Invalid matcher AST at ${path}: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "MatcherParseError";
    this.code = code;
    this.path = path;
  }
}

// ─────────────────────────────────────────────
// Parsing / validation (untrusted input → frozen canonical tree)
// ─────────────────────────────────────────────

/**
 * Read an own DATA property from an untrusted object without executing
 * foreign code: accessor properties (getters/setters) are reported, not
 * invoked. Returns `undefined` when absent — callers that need to
 * distinguish absence check `has` first.
 */
function ownDataProperty(obj: object, key: string, path: string): unknown {
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  if (desc === undefined) return undefined;
  if (desc.get !== undefined || desc.set !== undefined) {
    throw new MatcherParseError("accessor-property", `${path}.${key}`);
  }
  return desc.value;
}

function isScalar(value: unknown): value is MatcherScalar {
  if (value === null) return true;
  const t = typeof value;
  if (t === "string" || t === "boolean") return true;
  // NaN / ±Infinity are not JSON-representable → not serializable → refuse.
  return t === "number" && Number.isFinite(value as number);
}

/**
 * `-0` cannot survive JSON (`JSON.stringify(-0)` is `"0"`), so keeping it
 * in the AST would break the round-trip law. Normalize at the door;
 * evaluation is unaffected (`-0 === 0`).
 */
function canonicalScalar(value: MatcherScalar): MatcherScalar {
  return typeof value === "number" && Object.is(value, -0) ? 0 : value;
}

function parseField(raw: unknown, path: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new MatcherParseError("invalid-field", `${path}.field`, "must be a non-empty string");
  }
  if (FORBIDDEN_FIELDS.has(raw)) {
    throw new MatcherParseError("invalid-field", `${path}.field`, `'${raw}' is reserved`);
  }
  return raw;
}

function expectKeys(obj: object, allowed: readonly string[], path: string): void {
  // getOwnPropertyNames, not keys: non-enumerable smuggled properties are
  // refused too — "nothing is silently dropped" holds exactly.
  for (const key of Object.getOwnPropertyNames(obj)) {
    if (!allowed.includes(key)) {
      throw new MatcherParseError("unexpected-key", `${path}.${key}`);
    }
  }
}

/** Mutable aggregate-cost accumulator threaded through one parse. */
interface ParseBudget {
  cost: number;
}

function charge(budget: ParseBudget, units: number, path: string): void {
  budget.cost += units;
  if (budget.cost > MATCHER_MAX_COST) {
    throw new MatcherParseError("budget-exceeded", path, `max ${MATCHER_MAX_COST} cost units`);
  }
}

function parseNode(input: unknown, path: string, depth: number, budget: ParseBudget): MatcherNode {
  if (depth > MATCHER_MAX_DEPTH) {
    throw new MatcherParseError("depth-exceeded", path, `max ${MATCHER_MAX_DEPTH}`);
  }
  charge(budget, 1, path);
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new MatcherParseError("not-a-node", path);
  }

  const op = ownDataProperty(input, "op", path);
  if (typeof op !== "string") {
    throw new MatcherParseError("unknown-operator", `${path}.op`, "missing or not a string");
  }

  if (COMPARISON_OPS.has(op) || ORDERED_OPS.has(op)) {
    expectKeys(input, ["op", "field", "value"], path);
    const field = parseField(ownDataProperty(input, "field", path), path);
    const value = ownDataProperty(input, "value", path);
    if (!isScalar(value)) {
      throw new MatcherParseError("invalid-value", `${path}.value`, "must be a JSON scalar");
    }
    if (ORDERED_OPS.has(op) && typeof value !== "number" && typeof value !== "string") {
      throw new MatcherParseError(
        "invalid-value",
        `${path}.value`,
        `'${op}' requires a string or number`,
      );
    }
    return Object.freeze({ op, field, value: canonicalScalar(value) } as
      | MatcherComparisonNode
      | MatcherOrderedNode);
  }

  if (LIST_OPS.has(op)) {
    expectKeys(input, ["op", "field", "values"], path);
    const field = parseField(ownDataProperty(input, "field", path), path);
    const rawValues = ownDataProperty(input, "values", path);
    if (!Array.isArray(rawValues)) {
      throw new MatcherParseError("invalid-list", `${path}.values`, "must be an array");
    }
    if (rawValues.length > MATCHER_MAX_LIST_LENGTH) {
      throw new MatcherParseError(
        "list-too-large",
        `${path}.values`,
        `max ${MATCHER_MAX_LIST_LENGTH}`,
      );
    }
    charge(budget, rawValues.length, `${path}.values`);
    const values: MatcherScalar[] = [];
    for (let i = 0; i < rawValues.length; i++) {
      // Index reads go through the descriptor too — a getter planted on
      // an array index must be rejected unread, same as on an object.
      const v = ownDataProperty(rawValues, String(i), `${path}.values`);
      if (!isScalar(v)) {
        throw new MatcherParseError("invalid-value", `${path}.values[${i}]`, "must be a JSON scalar");
      }
      values.push(canonicalScalar(v));
    }
    return Object.freeze({ op, field, values: Object.freeze(values) } as MatcherListNode);
  }

  if (op === "exists") {
    expectKeys(input, ["op", "field", "value"], path);
    const field = parseField(ownDataProperty(input, "field", path), path);
    const value = ownDataProperty(input, "value", path);
    if (typeof value !== "boolean") {
      throw new MatcherParseError("invalid-value", `${path}.value`, "'exists' requires a boolean");
    }
    return Object.freeze({ op, field, value } as MatcherExistsNode);
  }

  if (GROUP_OPS.has(op)) {
    expectKeys(input, ["op", "nodes"], path);
    const rawNodes = ownDataProperty(input, "nodes", path);
    if (!Array.isArray(rawNodes)) {
      throw new MatcherParseError("invalid-nodes", `${path}.nodes`, "must be an array");
    }
    const nodes: MatcherNode[] = [];
    for (let i = 0; i < rawNodes.length; i++) {
      const raw = ownDataProperty(rawNodes, String(i), `${path}.nodes`);
      nodes.push(parseNode(raw, `${path}.nodes[${i}]`, depth + 1, budget));
    }
    return Object.freeze({ op, nodes: Object.freeze(nodes) } as MatcherGroupNode);
  }

  if (op === "not") {
    expectKeys(input, ["op", "node"], path);
    const child = parseNode(
      ownDataProperty(input, "node", path),
      `${path}.node`,
      depth + 1,
      budget,
    );
    return Object.freeze({ op, node: child } as MatcherNotNode);
  }

  throw new MatcherParseError("unknown-operator", `${path}.op`, `'${op}'`);
}

/**
 * Validate untrusted input into a canonical matcher AST.
 *
 * The returned tree is built from FRESH frozen objects — mutating the
 * input after parsing cannot change what was validated (no
 * time-of-check/time-of-use gap), and nothing from the input's prototype
 * chain or accessor properties survives into the result.
 *
 * @throws MatcherParseError when the input is not a well-formed AST.
 */
export function parseMatcher(input: unknown): MatcherNode {
  return parseNode(input, "$", 1, { cost: 0 });
}

// ─────────────────────────────────────────────
// Classification (the fail-closed two-tier gate)
// ─────────────────────────────────────────────

/** The classifier's verdict — see {@link classifyFilter}. */
export type MatcherClassification =
  | { readonly tier: "encodable"; readonly ast: MatcherNode }
  | { readonly tier: "opaque"; readonly reason: string };

/**
 * The two-tier gate (WatermelonDB `canEncodeMatcher` pattern, steal-list
 * item #1): decide whether a filter can run in-memory against change-set
 * events (`encodable`) or must fall back to a full query re-run
 * (`opaque`).
 *
 * FAILS CLOSED: `encodable` is returned ONLY for input that fully
 * validates via {@link parseMatcher} — the verdict carries the canonical
 * frozen AST, so downstream consumers never re-trust the raw input.
 * Everything else (functions, malformed trees, unknown operators, things
 * that aren't ASTs at all) is `opaque` with the refusal reason. `opaque`
 * is always safe — it costs a re-run, never a missed update.
 */
export function classifyFilter(input: unknown): MatcherClassification {
  if (typeof input === "function") {
    return { tier: "opaque", reason: "function-filter" };
  }
  try {
    return { tier: "encodable", ast: parseMatcher(input) };
  } catch (error) {
    if (error instanceof MatcherParseError) {
      return { tier: "opaque", reason: `${error.code} at ${error.path}` };
    }
    // The only non-parse errors reachable inside parseMatcher originate
    // from FOREIGN code — a Proxy trap that throws, a revoked handle.
    // Misbehaving input degrades to the safe tier; it never crashes the
    // classifier (deliberate contract, reviewed 2026-07-20).
    return { tier: "opaque", reason: `parse-threw: ${String(error)}` };
  }
}

// ─────────────────────────────────────────────
// Evaluation (strict, total, two-valued)
// ─────────────────────────────────────────────

/**
 * A field is ABSENT when it is not an own property or its value is
 * `undefined`. Absent fields fail every comparison operator; only
 * `exists` can see absence. (`null` is a present value: `eq null`
 * matches it, `exists true` counts it.)
 */
function presentValue(entity: Record<string, unknown>, field: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(entity, field)) return undefined;
  return entity[field];
}

/**
 * Evaluate a matcher AST against one entity record. Pure, synchronous,
 * total over every tree {@link parseMatcher} accepts.
 *
 * Strict semantics — normative table in `docs/design/matcher-semantics.md`:
 * no type coercion ever (`eq 1` does not match `"1"`); ordered
 * comparisons require the entity value and AST value to be the SAME
 * primitive type (both number or both string), otherwise `false`;
 * strings compare by UTF-16 code units; absent fields fail all
 * comparisons (including `neq`/`nin` — SQL `NULL` discipline) and are
 * visible only to `exists`; `not` is total negation of this two-valued
 * logic (the SQL tier compiles inner expressions with `IS NULL` guards
 * to match — see the design doc).
 */
export function evaluateMatcher(node: MatcherNode, entity: Record<string, unknown>): boolean {
  switch (node.op) {
    case "and":
      return node.nodes.every((n) => evaluateMatcher(n, entity));
    case "or":
      return node.nodes.some((n) => evaluateMatcher(n, entity));
    case "not":
      return !evaluateMatcher(node.node, entity);
    case "exists": {
      const present = presentValue(entity, node.field) !== undefined;
      return present === node.value;
    }
    case "eq":
    case "neq":
    case "in":
    case "nin": {
      const value = presentValue(entity, node.field);
      if (value === undefined) return false;
      switch (node.op) {
        case "eq":
          return value === node.value;
        case "neq":
          return value !== node.value;
        case "in":
          return node.values.some((candidate) => value === candidate);
        case "nin":
          return node.values.every((candidate) => value !== candidate);
      }
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const value = presentValue(entity, node.field);
      if (value === undefined) return false;
      // Ordered: same primitive type required; NaN fails all (IEEE).
      if (typeof value === "number" && typeof node.value === "number") {
        return evaluateOrdered(node.op, value, node.value);
      }
      if (typeof value === "string" && typeof node.value === "string") {
        return evaluateOrdered(node.op, value, node.value);
      }
      return false;
    }
    default:
      return unreachableNode(node);
  }
}

function evaluateOrdered<T extends number | string>(
  op: "gt" | "gte" | "lt" | "lte",
  value: T,
  bound: T,
): boolean {
  switch (op) {
    case "gt":
      return value > bound;
    case "gte":
      return value >= bound;
    case "lt":
      return value < bound;
    case "lte":
      return value <= bound;
  }
}

/** Unreachable for parseMatcher-validated trees; loud for forged ones. */
function unreachableNode(node: never): never {
  throw new MatcherParseError(
    "unknown-operator",
    "$(evaluate)",
    String((node as { op?: unknown }).op),
  );
}

// ─────────────────────────────────────────────
// Serialization (canonical, hash-stable)
// ─────────────────────────────────────────────

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value).sort();
    const body = keys
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
      .join(",");
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

/**
 * Canonical JSON encoding of a matcher AST: object keys sorted, arrays
 * in order. Equal trees always serialize identically, making the result
 * safe to use as (part of) a live-query key. Round-trip law:
 * `parseMatcher(JSON.parse(serializeMatcher(ast)))` deep-equals `ast`.
 */
export function serializeMatcher(node: MatcherNode): string {
  return stableStringify(node);
}

// ─────────────────────────────────────────────
// Builder (typed construction; every node parse-validated)
// ─────────────────────────────────────────────

function build(node: unknown): MatcherNode {
  return parseMatcher(node);
}

/**
 * Matcher builder — the ergonomic way to write filters in code. Every
 * builder call routes through {@link parseMatcher}, so a builder-made
 * tree and a parsed-from-JSON tree are byte-identical citizens: frozen,
 * canonical, already validated. Builder arguments are TRUSTED caller
 * code (the spread reads them plainly); untrusted JSON goes through
 * {@link parseMatcher} / {@link classifyFilter} instead.
 *
 * @example
 * ```typescript
 * const active = M.and(
 *   M.eq("status", "active"),
 *   M.gt("age", 21),
 *   M.not(M.in("region", ["test", "staging"])),
 * )
 * ```
 *
 * `field` is a FLAT own-property name — no path traversal. `M.eq("a.b", 2)`
 * looks for the literal key `"a.b"` and will not match `{ a: { b: 2 } }`.
 * See the module docs for why the dot is not reserved.
 */
export const M = {
  eq: (field: string, value: MatcherScalar): MatcherNode => build({ op: "eq", field, value }),
  neq: (field: string, value: MatcherScalar): MatcherNode => build({ op: "neq", field, value }),
  gt: (field: string, value: MatcherOrderedScalar): MatcherNode =>
    build({ op: "gt", field, value }),
  gte: (field: string, value: MatcherOrderedScalar): MatcherNode =>
    build({ op: "gte", field, value }),
  lt: (field: string, value: MatcherOrderedScalar): MatcherNode =>
    build({ op: "lt", field, value }),
  lte: (field: string, value: MatcherOrderedScalar): MatcherNode =>
    build({ op: "lte", field, value }),
  in: (field: string, values: readonly MatcherScalar[]): MatcherNode =>
    build({ op: "in", field, values: [...values] }),
  nin: (field: string, values: readonly MatcherScalar[]): MatcherNode =>
    build({ op: "nin", field, values: [...values] }),
  exists: (field: string, value = true): MatcherNode => build({ op: "exists", field, value }),
  and: (...nodes: readonly MatcherNode[]): MatcherNode => build({ op: "and", nodes: [...nodes] }),
  or: (...nodes: readonly MatcherNode[]): MatcherNode => build({ op: "or", nodes: [...nodes] }),
  not: (node: MatcherNode): MatcherNode => build({ op: "not", node }),
} as const;
