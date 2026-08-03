# ADR-023: The sync wire protocol is a first-class artifact, versioned in the path

**Status:** Accepted
**Implementation:** in-progress (artifact 1, the protocol doc, shipped 2026-08-02 with `src/wire-protocol.ts`; the protocol's client half is now exercised end-to-end by `restAdapter` (DAN-780) against a §13-conformant stub — v1 still DRAFT per §14, freeze deferred to the sync surface's first export/publish; artifacts 2 (server conformance kit) and 3 (reference server) remain open)
**Force:** invariant
**Date:** 2026-08-02
**Relates to:** ADR-006 (the SyncAdapter interface), ADR-021 (CI is the gate of record), ADR-022 (the irreversibility lines — this ADR is about **line 5**)
**Linear:** DAN-767

## Context

ADR-006 rev d froze the sync **client** contract and `src/sync-conformance.ts` made it executable. The **server** side was left entirely unspecified: no verbs, no JSON shapes, no status codes, no statement of where the cursor travels, no retention policy.

The practical consequence, measured rather than feared: **two people implementing `restAdapter` today would build mutually incompatible servers and both would pass the client conformance kit.** The kit checks that an adapter honours the contract; it cannot check that two adapters agree with each other, because they never meet.

### The reframe that is the actual decision

"Should we ship a reference server?" is the wrong unit. It complects two decisions with **opposite reversibility**:

| | Reversible? | Why |
|---|---|---|
| **The wire protocol** | **No.** ADR-022 line 5. | Once a real backend speaks it, both sides are not ours to upgrade together. |
| **The reference server** | **Completely.** | It is a package. Rewrite it, deprecate it, hand it to someone else. |

Pricing them as one decision guarantees getting one of them wrong — either under-designing the permanent artifact or over-committing to the disposable one.

**And the protocol is not optional.** One will exist whether it is written down or not, because the first adapter that ships will define it by accident. That is precisely the calcification ADR-006 was frozen early to prevent, recurring one level down where nobody was watching for it.

## Decision

**Three artifacts, in this order, and the order is the decision:**

1. **`docs/protocol/sync-wire-protocol-v1.md`** — the permanent artifact. Designed deliberately, ADR-022 in full force.
2. **A server-side conformance kit** — `runSyncAdapterContract()` pointed the other way. **This is the mechanism that keeps the protocol neutral.**
3. **A reference server**, as a separate optional package. Never required, never assumed by core.

### The move that makes an irreversible thing survivable: version in the path

`POST /sync/v1/pull`, not `POST /sync/pull`.

**Architecture Invariant:** a protocol version, once published, is frozen forever. Breaking changes ship as a **new path** served alongside the old one, never as an edit to an existing one.

This is what converts "irreversible" into "additive by construction." ADR-022's premise is that a wire shape stops being ours the day a backend speaks it — true, and unavoidable for `v1`. But it says nothing about `v2` **existing next to it**. A server may serve both; an adapter declares which it speaks; neither side is ever forced to upgrade in lockstep. The alternative — an unversioned path — makes every future improvement a coordinated flag day across parties we do not control.

### Auth is deliberately absent

The protocol defines no identity model, no token format, no session concept. Authentication and authorization are transport concerns carried in standard HTTP headers, and the protocol never inspects them.

Two reasons, and the second is the one that matters commercially. Electric's neutrality comes from exactly this posture — you proxy and authorize the request yourself, so no identity lock-in is inherited. And per ADR-0017's open-core line, an identity model is the sort of thing an **organization** needs operated and vouched for; baking one into the free protocol would put the split in the wrong place.

### HTTP status codes carry transport outcomes only

This is the highest-value clause in the whole protocol, because it mechanizes the single most dangerous confusion in ADR-006 — a transient failure reported as a permanent `reject`, which destroys a valid user write silently and forever.

| Class | Meaning | Adapter behaviour |
|---|---|---|
| **2xx** | A verdict is in the body | Return it |
| **4xx** (except 408, 429) | **Permanent** | Map to `reject` / surface |
| **408, 429, 5xx, network** | **Transient** | **Throw** — the coordinator retries with backoff |

A verdict never travels as a status code and a transport outcome never travels in the body. One thing in one place.

## Alternatives Considered

- **Stay client-only, publish nothing.** Rejected: the protocol gets defined anyway, by the first adapter, without review. "No protocol" is not an available state.
- **Ship the reference server first, document it after.** Rejected, and this is the failure mode the neutrality worry actually names. When the protocol is defined *by reading the server's source*, the reference implementation becomes the specification, and every third-party integration becomes a support ticket where a maintainer reads someone's code and guesses. Replicache shipped the doc; that is what made third-party backends real.
- **Unversioned path, negotiate the version in a header.** Rejected: header negotiation is invisible in logs, invisible in a CDN cache key, and easy to omit. A path segment is legible to every intermediary and impossible to forget.
- **Define auth in the protocol.** Rejected — see above.

## Consequences

- **Positive:** two independent implementations can now agree. The protocol becomes reviewable and community-testable before any adapter ships. Versioning in the path means being wrong about `v1` costs a `v2` rather than a migration on someone else's backend.
- **Negative:** a second artifact to maintain, and a second surface where drift can occur between the protocol doc and the client contract. Mitigated by artifact 2, not by discipline.
- **Risk — the dissent worth keeping (Moxie Marlinspike, council 2026-08-02, 71%):** neutral protocols historically lose to centralized ones. The moment a server is operated, product pressure asks it to get smart, and smart servers read plaintext. **ADR-006 C1 dies by product pressure, not by a design decision.**

  **Watch for:** the first request to make the reference server "just do a little filtering." The answer has to be no, every time — a server-evaluated predicate is exactly the one-way door C1 exists to hold open.
- **Leading indicator that the mechanism is working:** the first third-party adapter question. *"What should my endpoint return?"* means the doc is unclear and neutrality is already leaking. *"My server fails conformance test N"* means it is working.
- **What would reverse this:** an inability to commit to maintaining the reference server. **An abandoned reference implementation is worse than none**, because it defines the protocol badly and then stops answering.
