# Matcher evaluation semantics (normative)

> Companion to ADR-009 and `src/matcher.ts` (DAN-605). This table is the
> single source of truth for what a matcher AST *means*. The in-memory
> evaluator implements it; the future worker SQL tier (DAN-579) MUST
> compile to **identical** semantics — every divergence between the two
> tiers is a silent-wrong-results bug, the worst failure class this
> subsystem has. Treat any change here as a breaking semantic change:
> new operators extend the table; existing rows never change meaning.

## The absence rule (read this first)

A field is **absent** when it is not an *own* property of the entity, or
its value is `undefined`. Prototype-chain properties are invisible.

- Absent fields fail **every** comparison operator — including `neq` and
  `nin`. This is SQL `NULL` discipline: "not equal to x" still requires
  the value to exist.
- Only `exists` can see absence. `null` is a **present** value: it
  satisfies `exists: true`, and `eq null` matches it.

## Fields are flat (no path traversal)

A `field` is a single own-property name, matched literally. There is **no**
dot-path traversal: `{ op: "eq", field: "a.b", value: 2 }` looks for a
property whose key is the four-character string `a.b`, and does **not**
match `{ a: { b: 2 } }`.

The dot is not a reserved character, and deliberately so — an entity may own
a key that contains one, and reserving it would make that key unfilterable.
The parser therefore accepts `"a.b"` rather than refusing it. The cost is
that a filter written with nested intent returns an empty result instead of
an error, so it is stated here, in the `matcher.ts` module docs, and on `M`.

Nested access is a **normalization** concern, not a matcher one: give the
inner object its own entity type and filter on the flat field that
references it. This is also what keeps the SQL-parity contract below
tractable — a path syntax would require JSON-extraction semantics to be
identical across the in-memory and SQL tiers.

## Operator table

| Op | AST shape | Matches when | Notes |
|---|---|---|---|
| `eq` | `{op, field, value: scalar}` | field present ∧ `entityValue === value` | `===` — zero coercion. `eq 1` never matches `"1"`; `eq 0` never matches `false`; `eq null` matches only literal `null`. |
| `neq` | same | field present ∧ `entityValue !== value` | Present-but-different-type matches (e.g. `5 neq "a"` → true). Absent → false. |
| `gt` `gte` `lt` `lte` | `{op, field, value: string\|number}` | field present ∧ same primitive type ∧ ordering holds | Cross-type never matches (`30 gt "21"` → false). Strings: UTF-16 code-unit order. Entity `NaN`: all four false (IEEE). Booleans/null are not orderable (parser rejects them as bounds). |
| `in` | `{op, field, values: scalar[]}` | field present ∧ some element `===` entityValue | Empty list → false. `[null]` matches a present `null`. |
| `nin` | same | field present ∧ every element `!==` entityValue | Empty list → true **if present**. Absent → false (SQL `NOT IN` + NULL discipline). |
| `exists` | `{op, field, value: boolean}` | (field present) `===` value | The only operator that sees absence. `null` counts as present. |
| `and` | `{op, nodes: Node[]}` | every child matches | `and([])` → **true** (boolean identity). |
| `or` | same | some child matches | `or([])` → **false**. |
| `not` | `{op, node: Node}` | child does not match | **Total two-valued negation** — see SQL-parity note below. |

## Type discipline

- AST scalar values are JSON-pure: `string | number | boolean | null`.
  `NaN`, `±Infinity`, `undefined`, `BigInt`, `Date`, objects, arrays —
  all rejected at parse time (they cannot round-trip through JSON).
- Entity values are compared with `===` semantics only. There is no
  numeric-string coercion, no boolean-number bridging, no date parsing.
- Entity-side `NaN` (`typeof "number"`): fails `eq`, all ordered ops,
  and `in`; matches `neq`/`nin` against any value (it is present and
  `!==` everything, itself included).

## SQL-parity contract (for the DAN-579 worker tier)

Our logic is **total and two-valued**; SQL's is three-valued (`NULL` →
`UNKNOWN`). The SQL tier implements OUR semantics, not the reverse:

- Every comparison compiles with an explicit presence guard:
  `eq` → `col IS NOT NULL AND col = ?` (adjust for the JSON-column
  representation of absent-vs-null once the storage schema exists —
  JSON `null` vs SQL `NULL` must map to our present-`null` vs absent).
- `neq` → `col IS NOT NULL AND col <> ?` (plus a type guard, below).
- `not(inner)` → `NOT (compiled_inner)` — safe **only because** every
  compiled inner expression is already total (never `UNKNOWN`). E.g.
  `not(eq(missing, 'x'))` matches here; naive SQL `NOT (col = 'x')`
  with `col NULL` would not. The guards make the two agree.
- Ordered ops add a same-type guard (SQLite: `typeof(col)`) and require
  **BINARY collation** for strings (UTF-8 byte order ≡ UTF-16 code-unit
  order for these comparisons only when values are same-plane; if the
  schema ever allows non-BMP-sensitive ordering disputes, the compile
  must mark such matchers opaque rather than approximate). When in
  doubt: **route to opaque** — the re-run tier is always correct.
- `in`/`nin` compile with the presence guard and exact-value lists;
  `nin` with an empty list → the presence guard alone.

## Serialization

`serializeMatcher` emits canonical JSON: object keys sorted, arrays in
order. Equal trees serialize identically → usable as (part of) a
live-query key. Round-trip law:
`parseMatcher(JSON.parse(serializeMatcher(ast)))` deep-equals `ast`.

## Limits (fail-closed hardening)

- Depth cap: `MATCHER_MAX_DEPTH = 32` nesting levels.
- List cap: `MATCHER_MAX_LIST_LENGTH = 10 000` elements per `in`/`nin`.
- **Aggregate budget**: `MATCHER_MAX_COST = 65 536` total cost units per
  tree (each node 1, each list element 1). Depth and per-list caps alone
  don't bound total work — a wide tree of maximal lists would validate
  yet cost real milliseconds per change event in a live query.
  Over-budget → refused → `opaque` (the re-run tier is always correct).
- Field names `__proto__`, `constructor`, `prototype` are rejected.
- Untrusted parse invokes no accessors (own-data-descriptor reads only;
  getters — including ones planted on array indices — are rejected
  UNREAD) and returns a fresh frozen copy (no time-of-check/time-of-use
  gap). Honest caveat: **Proxy** inputs run their own traps during
  inspection — inherent to any in-realm examination of a Proxy (even
  `Array.isArray` triggers traps). The guarantee is containment, not
  prevention: a misbehaving Proxy can never produce a false `encodable`
  verdict (the verdict carries the fresh validated copy, never the
  input), and a trap that throws degrades to `opaque` rather than
  crashing `classifyFilter`. Note that Vue `reactive()` objects are
  Proxies — they parse correctly through their (benign) traps.
- `-0` is normalized to `0` at parse (`-0` cannot survive JSON; the
  round-trip law would otherwise fail — evaluation is unaffected since
  `-0 === 0`).
- Anything outside this table — unknown operators, extra keys, wrong
  shapes — is refused at parse time and classified **opaque**, never
  guessed at.
