# ADR-011: Read-Only In-Page MCP Agent Surface — Topology, Allowlist, Deny-by-Default

**Status:** Accepted
**Date:** 2026-07-20

## Context

DAN-580 ships the Stage-2c agent surface — the launch-demo chip
(ADR-008 §5) and the deliverable ADR-007's revised sequencing promoted
to Stage 2 ("we are the trigger"). The 2026-07-12 council audit fixed
the hard requirements: browser pages cannot accept stdio or
streamable-HTTP (the only standard MCP transports), deny-by-default
must be structural, the surface needs a per-entity-type allowlist, and
returned app data is a prompt-injection channel that must be marked
untrusted. The matcher AST (ADR-009) supplies the agent-boundary
filter language; `exportSchema` (ADR-007 §4) supplies the resource
input. Several design forks remained open; this ADR records them.

## Decision

`packages/mcp` — the first real second workspace member (private; npm
naming stays Danny's gate), exporting `createColadaDbMcpServer`. Core
gains ZERO MCP awareness (ADR-008 §2: agent surface = edge package);
the package consumes only public core exports, and this chip needed no
new re-exports.

1. **In-page server over `InMemoryTransport`, named as the topology.**
   The server lives in the page; the agent's official-SDK `Client`
   connects over `InMemoryTransport.createLinkedPair()` — a real MCP
   session (initialize handshake, JSON-RPC framing), not a mock. The
   durable store (OPFS/IDB) is origin-private, so an external process
   could not read it anyway; external-client bridging (dev-server
   relay, extension port) is explicitly out of scope for this stage.
2. **Low-level SDK `Server`, not `McpServer`.** The high-level API
   expresses tool inputs as Zod shapes, which would add `zod` as a
   second DIRECT (authored) runtime dependency — zod is already in the
   tree transitively via the SDK; the distinction is what WE author
   against and audit; the packet's security gate permits exactly one
   authored dependency (`@modelcontextprotocol/sdk`). The SDK marks
   `Server` deprecated-in-favor-of-`McpServer` but its own JSDoc
   blesses it for "advanced use cases" with no removal schedule
   (verified in 1.29.0 types at the 2026-07-20 land review) — the
   `^1.29.0` pin plus the risk-watch below is the mitigation. With the low-level API
   the tool list is ONE literal array (`buildToolList`) — the
   deny-by-default headline is verifiable by reading it — and argument
   validation is ours, which is where fail-closed refusals with
   verbatim `parseMatcher` errors belong.
3. **Deny-by-default writes, structurally.** Zero write tools are
   registered; a write attempt is an unknown tool — there is no
   handler to reach. Tests assert the exact tool list, assert no
   write-shaped name, and observe a write attempt bounce off the
   protocol with the store byte-identical.
4. **Explicit allowlist (`allowedTypes`), not flag inference.** The
   registry's `local` flag describes SYNC posture, not agent
   visibility — a local-only type (drafts, token caches) is often
   exactly what must stay hidden, and a synced type is often fine to
   expose. Inferring visibility from an orthogonal flag would smuggle
   a trust decision into a schema property. Explicit, required,
   empty-is-legal (= maximally denied): the trust decision stays in
   the app author's hand, in one auditable place. The flags still ride
   along in the schema resource so agents see sync posture.
5. **Allowlist is airtight, including relations.** The schema resource
   omits non-allowlisted types AND scrubs a visible type's relations
   that TARGET hidden types (a relation entry carries the hidden
   type's name — a leak vector). Tool refusals for a non-allowlisted
   type are identical whether the type exists or not: the surface is
   not an existence oracle.
6. **Schema snapshot at creation, deep-frozen text.** Re-reading a
   caller-owned mutable `entityDefs` per request would be a TOCTOU
   surface and make the resource non-deterministic; the registry is
   static in practice. Dogfooded: the server serves exactly the
   `exportSchema` JSON it consumes.
7. **`read_history` exists only when a `HistoryStore` is provided.**
   The tool list adapts to actual capability instead of shipping a
   permanently-erroring tool — the agent's view of the surface is
   never a lie. History rows pass through allowlist + JSON
   serialization, so purged rows stay data-free markers (erasure
   semantics honored end-to-end).
8. **Untrusted marking, three redundant layers.** MCP has no standard
   "untrusted" annotation yet, so: in-band envelope
   (`untrusted: true` + explicit notice — survives every client
   pipeline), `_meta["colada-db/untrusted"]` on the result, and on
   each content block. Marking labels; it cannot force a model to
   comply — the README says so plainly.

## Alternatives Considered

- **High-level `McpServer` + zod:** more idiomatic SDK usage; rejected
  — second runtime dependency against the security gate, and the tool
  registry becomes API calls instead of one readable literal.
- **Allowlist inferred from `local`/`sync` flags:** zero-config appeal;
  rejected — conflates sync posture with agent visibility and takes
  the trust decision away from the app author (decision 4).
- **Registering write tools behind a config flag ("enableWrites:
  false"):** rejected outright — deny-by-default must be structural,
  not conventional; a flag is a leak waiting for a default flip. The
  future write path arrives only WITH the guard/policy middleware
  (ADR-007's deferred surfaces), as a separate deliberate surface.
- **Recomputing the schema resource per read:** always-fresh appeal;
  rejected — TOCTOU surface over a caller-owned mutable object, and
  staleness is not real (registries are defined once at app start).
- **Playground demo pane now:** packet discretion; deferred to the 3.3
  film chip — the observe-run script already exercises the built
  artifacts end-to-end, and demo polish belongs with the film work.

## Consequences

- Positive: the launch-demo claim ("deny-by-default, verifiable by
  reading the tool list") is true in code with tests pointing at it;
  the allowlist has no known leak path through the schema resource,
  relation declarations, error messages, refusal paths, or history
  markers (all filtered; no existence oracle — verified by the
  2026-07-20 land review's executed attacks); core remains MCP-free.
- Scope boundary (stated precisely, land-review finding): entity DATA
  is returned verbatim, so a visible entity's foreign-key FIELD NAMES
  and id VALUES pointing at hidden types do reach the agent (e.g.
  `{vault: "s1"}` on a visible contact). The hidden type's name,
  fields, and rows remain unreachable. If FK-field confidentiality
  ever enters scope, that is a data-level scrub feature with its own
  ticket — not a hole in the current claims, which govern the schema
  and refusal surfaces.
- Negative: the low-level API means we own argument validation
  forever; the in-band refusal shape (`{error: {code, message}}`) is
  our own convention, to be kept stable for agents.
- Risks / watch: MCP standardizing an untrusted-content annotation
  (adopt it, keep the envelope); SDK major versions changing the
  low-level API (pinned `^1.29.0`); the 3.3 film chip needing the
  browser MCP Inspector run this stage deferred.
