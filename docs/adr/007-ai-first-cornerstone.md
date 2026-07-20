# ADR-007: AI-First From the Cornerstone

**Status:** Accepted
**Date:** 2026-07-12

## Context

Colada DB is being designed while AI agents become first-class actors in web applications. Council deliberation (2026-07-12) resolved what "AI-first" concretely binds us to NOW versus what is speculative, and whether agentic-trust engineering (capability scoping, unforgeable authority, receipts) structurally converges with a local-first data layer.

Key observation: an in-browser agent's working memory and action surface IS the client data layer. Agents need: legible schemas, attributable writes, bounded authority, and replayable history. Users need: agent access WITHOUT data harvesting — which is precisely the local-first promise extended to agents.

## Decision

Adopt the four zero/low-cost commitments now — each independently justified by non-AI needs, which is how we know they're architecture and not fashion:

1. **Origin on every write, from day one.** Every entity event carries `origin: "local-mutation" | "sync-pull" | "hydration" | "undo" | "agent"` (extensible; `agent` origins may carry an agent identifier). Already required by undo (don't undo hydrations), sync (echo suppression), and devtools. AI-first payoff: agent writes are attributable → auditable → selectively revocable.
2. **The commit veto gate.** Transactions expose `willCommit(changeSet) => boolean | reason` (TinyBase-validated pattern). Already justified as a validation hook. AI-first payoff: this is THE policy enforcement point — capability-scoped agent write authority (which entity types, which predicates, what rate) plugs in here without the core knowing what a "mandate" is.
3. **The capped history store** (Evolu-validated): `{entityRef, field, old → new, mutationId, origin}` in a bounded, queryable log. Already justified by undo and devtools ("why did this field change?"). AI-first payoff: agent explainability + the receipt substrate — an agent (or a trust layer above it) can answer "what did the agent touch and on whose authority?"
4. **Machine-legible schema surface.** The entity registry (types, id fields, relations via EntityRefs, sync/local flags) must be exportable as plain data (JSON). Already justified by devtools and docs generation. AI-first payoff: the export IS an MCP resource / tool-definition input — agents discover the data model without reading source.

**Sequencing (revised same day — Danny's call, offense not defense):** the read-only **MCP server over the entity store is a Stage-2 deliverable**, not a wait-and-see item. Rationale: (a) it's thin — the schema export + query surface it wraps are Stage-2 work anyway; (b) first-mover on the agent surface IS the differentiation ("the first local-first data layer with a native agent surface"), and ElectricSQL's pivot to an agent platform confirms the market direction; (c) deny-by-default writes keep it shippable before the guard layer exists. Still deferred behind primitives: the `guard` policy middleware (needs the veto gate battle-tested first) and agent write affordances (need the guard). The original "watch for a major data layer to ship an MCP surface" trigger is retired — we are the trigger.

## The trust-engineering convergence verdict

**Convergent at the primitive level; separate at the product level.** Colada DB ships neutral primitives (origin, veto gate, history) that any trust/policy layer can bind to — including, but not privileging, SWEE-style mandate engines. The data layer stays unopinionated infrastructure; trust products ride the rails rather than being welded into them. This keeps Colada DB adoptable by people who have never heard of agentic trust, while making it the most trust-ready data layer in the ecosystem.

## Alternatives Considered

- **"AI-first" as marketing only (do nothing now):** rejected — retrofitting origin tags and a veto gate after Stage 3 means re-touching every write path; doing it now is near-free.
- **Building the agent/policy layer INTO the core now:** rejected — speculative surface area, violates the drop-in-plugin identity, and couples a neutral data layer to one trust vocabulary.
- **CRDT-based agent merging:** rejected per ADR-005's sync posture; agent writes are ordinary attributed writes under server-authoritative sync.

## Consequences

- Positive: four cheap commitments make every future AI surface (MCP, guards, receipts) an add-on instead of a rewrite; differentiates Colada DB as the agent-ready local-first layer.
- Negative: origin plumbing adds one field to event/transaction paths now; the history store has memory bounds to tune.
- Risks: agent-client conventions (MCP for app data layers) are young — the deferred surfaces should track standards rather than invent them.
