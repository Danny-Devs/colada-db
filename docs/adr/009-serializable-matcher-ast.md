# ADR-009: Serializable Matcher AST with Fail-Closed Classification

**Status:** Accepted
**Date:** 2026-07-20

> Numbering note: the roadmap (Phase 1.3) informally referred to a future
> "ADR-009: worker read tier". ADRs number by creation order (append-only
> convention); the worker read tier decision will take the next free
> number when it lands with DAN-579.

## Context

Live queries (roadmap 2.2, promoted by Danny 2026-07-19) need reactive
filtered views maintained against entity change events. The DAN-575
council audit (blocker #7) identified the structural obstacle: filters
expressed as arbitrary JS closures are unclassifiable and untranslatable
— the system cannot know whether a closure reads one field or the whole
database, so it can never safely re-evaluate it against a single change
event, compile it to SQL, hash it into a stable query key, or ship it
across an agent boundary. WatermelonDB's two-tier query observation
(steal-list item #1) works precisely because its queries are data.

The failure asymmetry drives the design: classifying an encodable filter
as opaque costs a redundant query re-run (correct, slower); classifying
an opaque filter as encodable produces silently missed updates (wrong
results, invisible). The gate must therefore fail CLOSED — and this is
the same deny-by-default posture as ADR-007's trust primitives.

## Decision

Ship `src/matcher.ts`: a JSON-pure filter AST as a boring-core primitive
(ADR-008 §1 — pure data, no framework, engine, or reactivity coupling).

1. **Operator vocabulary (deliberately minimal):** `eq`/`neq`,
   `gt`/`gte`/`lt`/`lte` (string|number bounds only), `in`/`nin`,
   `exists`, `and`/`or`/`not`. Anything else — including future
   operators we haven't shipped yet — parses as an error and classifies
   opaque. Operators are added only together with evaluator coverage,
   tests, and a semantics-table row.
2. **Normative semantics live in `docs/design/matcher-semantics.md`:**
   strict `===` discipline (zero coercion), SQL-NULL-style absence
   (absent fields fail every comparison; only `exists` sees absence;
   `null` is a present value), total two-valued `not`. The future SQL
   tier compiles to THESE semantics with explicit `IS NULL` guards —
   the doc is the contract that prevents evaluator/SQL divergence.
3. **Fail-closed classification:** `classifyFilter(input)` returns
   `{tier: "encodable", ast}` ONLY when the input fully validates via
   `parseMatcher`; the verdict carries the canonical frozen tree so
   consumers never re-trust raw input. Functions, malformed shapes,
   unknown operators, over-deep trees → `{tier: "opaque", reason}`.
4. **Untrusted-input hardening:** parsing invokes no accessors
   (own-data-descriptor reads only; getters rejected unread, including
   on array indices), reads own properties only, rejects
   `__proto__`/`constructor`/`prototype` field names, caps depth (32),
   list length (10 000), and AGGREGATE tree cost (65 536 units — depth
   and per-list caps alone don't bound total per-event evaluation work;
   security review 2026-07-20), and returns fresh frozen copies (no TOCTOU
   gap). Proxy inputs are the honest exception: their traps run during
   inspection (inherent to in-realm examination — even `Array.isArray`
   triggers them); the guarantee is CONTAINMENT — no false `encodable`
   verdict is possible (the verdict carries the fresh validated copy)
   and trap-thrown errors degrade to `opaque` in `classifyFilter`
   rather than crashing. ASTs may arrive from agent surfaces or
   persisted state; the parser is the trust boundary.
5. **Canonical serialization:** `serializeMatcher` emits sorted-key
   JSON — equal trees serialize identically, making the output usable
   as (part of) a stable live-query key.

## Alternatives Considered

- **Keep closures, always re-run queries on change:** correct but
  O(queries × writes) with no path to the worker SQL tier or the agent
  surface (a closure cannot cross the MCP boundary). Rejected — this is
  exactly the ceiling blocker #7 describes.
- **SQL strings as the filter language:** maximally expressive, but
  unparseable-in-practice for the in-memory tier, injection-prone at
  the agent boundary, and engine-coupled. Rejected.
- **Adopt Mongo-style query object syntax (`{field: {$gt: 5}}`):**
  familiar, but its implicit-equality and `$`-key conventions collide
  with entity field names, complicate fail-closed validation (every
  unknown key must be guessed as field-or-operator), and import
  coercion expectations we refuse. Rejected in favor of explicit
  `{op, field, value}` nodes where nothing is ambiguous.
- **Three-valued (SQL-style) evaluation logic:** maximizes naive SQL
  parity but leaks `UNKNOWN` into an API JS consumers expect to be
  boolean, and makes `not` non-total. Rejected: two-valued totality
  with documented compile guards is simpler and the parity burden sits
  with the (single) SQL compiler, not every consumer.

## Consequences

- Positive: live queries gain their substrate (filters re-evaluable
  per-event); the classifier verdict is trustworthy by construction;
  matchers are agent-shippable data (MCP tools can accept them —
  deny-by-default validation included); serialized form feeds stable
  query keys.
- Negative: the minimal vocabulary can't express joins, sorts, string
  prefix/contains, or nested-path reads yet — such filters stay opaque
  (correct, just slower) until vocabulary rows are added deliberately.
- Risks: evaluator/SQL semantic drift when DAN-579 lands — mitigated by
  the normative table and the rule that doubtful compilations route to
  opaque; vocabulary creep adding operators without full table+test
  coverage — mitigated by the fail-closed parser making half-added
  operators unreachable.
