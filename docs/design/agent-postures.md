# Design note: agent postures — who an agent IS at the data layer

**Status:** DESIGN NOTE 2026-07-19 (promised in the 2026-07-19 handoff). Vocabulary for Stages 2c–3+; grounded in the four ADR-007 primitives shipped 2026-07-19 (origins, gate, history, schema export).

An "agent surface" is not one thing. An agent touches the data layer in one of six **postures**, each needing a different slice of authority. Naming them keeps the MCP surface (DAN-580) and the guard layer honest: every tool an agent gets should be traceable to a posture, and every posture to the primitives that bound it.

## The six postures

| Posture | What it does | Primitives that bound it | Stage |
|---|---|---|---|
| **Reader** | Discovers the model (`exportSchema`), queries entities via the boundary. Never writes. | Schema export · read-only tools · per-type allowlist | 2c (the launch demo: ZERO write tools registered — deny-by-default is verifiable by reading the tool list) |
| **Auditor** | Answers "what changed, from what, to what, on whose authority?" Reads `enableHistory` rows; never touches entities at all. | History store (origins + write ids) · purge semantics limit what it can ever see | 2c (history is queryable in-page today) |
| **Writer** | Proposes mutations through optimistic transactions — NEVER through the raw store API. Every write arrives as `origin: "agent"` (with identifier), pre-apply gated, settling like any user mutation. | Write channel (`agent` origin) · `useGate` pre-apply veto · history rows for receipts | post-2c (needs the guard layer; the gate is THE enforcement point, shipped) |
| **Sync-peer** | Not interactive: a replication process applying remote state under `sync-pull`. Named a posture so its authority is never conflated with an interactive agent's — echo-suppression and gate-bypass rules differ. | Origin separation (`sync-pull` vs `agent`) · ADR-005/006 contracts | 3 |
| **Purchaser** | A writer whose mutations carry economic consequence (orders, payments). Same mechanics as Writer, but gates evaluate predicates over `previous → data` (amounts, rates, counterparties) and receipts are non-optional. | Gate predicates on `ProposedWrite.previous` · history as receipt substrate · (external: mandate layers ride these rails — ADR-007's convergence verdict) | beyond core — the SWEE-shaped trust layer binds HERE, without the core knowing what a "mandate" is |
| **Operator** | Lifecycle administration: hydration scope, gc, engine swap, erasure (`clear()`). Powerful, boring, and NEVER exposed to agents — `clear()`/`remove()` stay structurally off the MCP surface (roadmap 3.2). | Structural absence (no tool registered) beats policy (a gate that could be misconfigured) | 3.2 hardening |

## Design consequences (the reasons this note exists)

1. **Posture ≠ identity.** One assistant may hold Reader today and Writer after the guard ships. Authority attaches to the posture granted, not the agent's name — which is why `origin` stays a channel stamp (`agent:assistant-1`) and never an ACL.
2. **Escalation order is fixed:** Reader → Auditor → Writer → Purchaser. Each step adds exactly one new primitive dependency (queries → history → gate → predicates). Ship demos in this order; never skip a rung in public claims.
3. **Two postures are never agent-grantable:** Sync-peer (a process, not a conversation) and Operator (structurally absent). If a future feature request wants an agent to "clean up" data, the answer is a Writer proposing `remove`s through the gate — never Operator tools.
4. **The trust caveat propagates.** Origins are attribution within one trust domain, not authentication (see `WriteOrigin`). A posture is therefore a *product* boundary enforced by what tools exist, backed by gates — not a cryptographic one. Unforgeable-authority claims belong to layers above (and chains beyond) this library; the README must never claim otherwise.

## Non-goals

No posture registry, no runtime enum, no code in this note. When 2c builds the MCP server, tool groups should quote these posture names in docs and tests ("reader tools", "auditor tools") — that's the entire binding.
