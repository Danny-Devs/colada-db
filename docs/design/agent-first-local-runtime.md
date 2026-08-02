# Design: agent-first local runtime (vision, pre-ADR)

> Not yet ticketed. This is colada-db's side of a cross-repo contract —
> SweeAI (the agent-orchestration app, separate repo/session) owns the
> actual local-model runtime; this document owns what colada-db must
> expose and guarantee for that runtime to be a first-class citizen.
> **Needs reconciliation** with whatever the SweeAI-side design has
> already decided before either side locks anything in — this is a
> starting contract, not a finished one.

## The thesis

colada-db should work for SweeAI agents fully offline, not just fully
synced. A local LLM (weights cached in OPFS, inference in a Worker)
reads and writes through colada-db the same way a human device does,
and reconciles through the same sync pipeline (ADR-006) on reconnect.
Network access becomes optional for AI capability, not just for data
persistence — the same "online first-class, offline equally
first-class" posture colada-db already has for human writers.

## What's already proven, not speculative

- **OPFS + Worker is colada-db's own established pattern** —
  `sqlite-worker.ts` already runs OPFS-backed SQLite in a dedicated
  Worker. A model-runtime Worker follows the identical shape.
- **Model weight caching in OPFS is solved, shipping infrastructure** —
  WebLLM downloads quantized shards once, caches in OPFS, reloads near-
  instantly, ~80% native inference speed via WebGPU (>84% global
  browser support as of its March-2026 candidate-recommendation
  milestone). Not something colada-db builds — something it points at.
- **Realistic on-device models today**: Llama 3.2 1B/3B, Phi-3.5-mini
  (3.8B), Gemma 2 2B, SmolLM2 1.7B — a few hundred MB to ~5GB one-time
  download, practically capped ~8B params. Framing: a capable local
  co-pilot for bounded tasks, not a frontier-model replacement.

## What colada-db must decide (this repo's obligations)

1. **The write surface.** `packages/mcp` (ADR-011) is deliberately
   read-only today — "an agent can NOT write... zero write tools are
   registered." A local-agent runtime needs a write-capable extension
   of this same surface, not a parallel one.
2. **Capability-scoped writes, not trusted writes.** This is the
   non-negotiable one: the parent stack's own thesis is "cage the
   consequences, not the mind" (`swee-capability-firewall-and-sui-
   grant`) — don't trust the model to behave, scope what it's capable
   of doing. A small on-device model can hallucinate a bad tool call
   same as any agent can. The write-MCP surface must apply the
   identical capability-scoping discipline colada-db's parent stack
   already applies to on-chain agent actions — this is not a new
   invention, it's an existing pattern being extended to a new
   boundary. Concretely: which entity types/scopes a given agent
   session may write, and a fail-closed default (deny unless
   explicitly granted), mirroring the read surface's own
   allowlist-filtered schema export.
3. **Writer-identity includes non-human writers.** colada-db's mutation
   identity is already `time + counter + clientId` (HLC-style,
   ADR-006). `clientId` must be documented as agent-agnostic — a local
   model's writes are just another `clientId` in the same rebase-on-
   reconnect pipeline as a second human device. This is a one-line
   addition to the sync architecture's writer-identity sign-off
   (already scoped in the six-gate sync plan, this session), not new
   architecture.
4. **Retrieval substrate for agent memory**: `sqlite-vec` (vector
   search, pure C, WASM-compilable but must be **statically** compiled
   into the WASM SQLite build from the start — cannot be dynamically
   loaded later) + FTS5 (hybrid keyword+semantic retrieval, already in
   SQLite core) + JSON1 (tool-call/agent-memory metadata, already in
   SQLite core). colada-db's existing per-entity (`Type:id`)
   invalidation already solves "keep the embedding index in sync with
   its source record" for free.
5. **Backend convergence, if/when Turso is chosen.** Turso (already on
   ADR-006's sync-adapter roadmap) ships native vector search (F32_BLOB
   + DiskANN) — meaning the sync-backend choice and the AI-capability
   choice could be the same decision, not two.

## Explicitly out of scope for this document

Which specific model, exact Worker message-passing protocol, and the
SweeAI-side agent-loop/prompting design — that's the SweeAI repo's
call, not colada-db's. This document stops at the boundary: what
colada-db promises to expose, and under what safety discipline.

## Status

Vision-stage. Earns its own council/battle-test pass once the sync
campaign's first adapter is shipping (six-gate plan, adversarially
audited 2026-07-23, 18/24 findings survived) — not before, and not as a
third concurrent thread against the ~Jul-31 grant runway.
