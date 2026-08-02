---
title:       colada-db sync wire protocol, version 1
kind:        reference
status:      draft
updated:     2026-08-02
owner:       danny
verified_by: "pnpm test -t 'wire protocol v1' (src/wire-protocol.spec.ts)"
---

# colada-db sync wire protocol — `v1`

**What this is:** the HTTP contract between a colada-db client and any backend that wants to sync with one. Implement it and `restAdapter` talks to your server. It is the *only* normative statement of what a colada-db sync server does.

**Who it is for:** anyone writing a sync backend — including us. It is not for application developers, who should never see it.

**What would prove this document should stop existing:** if two independently written servers can pass the server conformance kit and still fail to interoperate with the same client, this document is not doing its job.

> **Status: DRAFT.** `v1` is not frozen until the first adapter ships against it. Until then it may change freely. **After that it may never change** — see [Versioning](#versioning), which is the mechanism that makes that survivable rather than terrifying.
>
> Decision record: [ADR-023](../adr/023-the-sync-wire-protocol-is-versioned-in-the-path.md). Client contract: [ADR-006 rev d](../adr/006-sync-adapter-interface.md).

---

## 1. The shape in one paragraph

A client holds an opaque **cursor**. It `POST`s that cursor to `/sync/v1/pull` and gets back either a batch of changes and a new cursor, or an order to discard its copy and start over. It `POST`s locally-made changes to `/sync/v1/push` and gets back one verdict per change. That is the entire protocol. Everything below is precision about those two exchanges.

```
   client                                     server
     │                                           │
     ├── POST /sync/v1/pull  {cursor:null}  ────▶│   initial sync
     │◀── 200  {changes:[…], cursor:"c1", complete:true}
     │                                           │
     ├── POST /sync/v1/push  {changes:[…]}  ────▶│   local writes
     │◀── 200  {results:[{mutationId, status:"ack", version}]}
     │                                           │
     ├── POST /sync/v1/pull  {cursor:"c1"}  ────▶│   confirmation arrives HERE,
     │◀── 200  {…, confirmedMutations:{…}}       │   never on the push response
```

That last arrow is the one people get wrong. See [§6](#6-confirmation).

## 2. Transport

- **HTTP/1.1 or later, over TLS.** No WebSocket requirement; the live channel is optional and out of band ([§8](#8-the-optional-live-channel)).
- **`Content-Type: application/json`** on every request and response with a body.
- **UTF-8.** No other encoding is negotiated.
- **`POST` for both endpoints**, including `pull`.

### Why `POST` for a read

Because the cursor belongs in the body, not the path. A cursor is opaque and may be long or structured; putting it in a URL invites truncation, logging leaks, and accidental cache keys on data that is not what it appears to be.

**`pull` MUST remain free of side effects anyway.** Implement it as a genuine read even though `POST` does not require that. The reason is forward-looking: HTTP QUERY (RFC 10008) is safe, idempotent *and* cacheable with a request body, and a `pull` that is already side-effect-free becomes a drop-in the day it is widely supported — which buys CDN-cacheable partial sync for free. **Do not depend on QUERY yet**; its rollout is unmeasured. Just do not foreclose it.

## 3. Versioning

**The version is a path segment: `/sync/v1/…`.**

**Invariant — a published protocol version is frozen forever.** A breaking change ships as a new path served *alongside* the old one. It is never an edit to an existing path.

This is what makes an irreversible artifact survivable. Being wrong about `v1` costs a `v2`, not a migration on somebody else's backend. A server may serve several versions at once; an adapter declares which it speaks; neither side upgrades in lockstep.

**Additive changes within a version are permitted and MUST be ignorable.** A client MUST ignore unrecognized fields in a response. A server MUST ignore unrecognized fields in a request. Without both halves, adding an optional field becomes a breaking change and the version freeze eats every improvement.

## 4. Authentication — deliberately absent

**This protocol defines no identity model, no token format and no session concept.**

Carry credentials in standard HTTP headers (`Authorization`, or a cookie your proxy sets). The protocol never inspects them and never mentions them again.

This is a deliberate neutrality property, not an omission. A protocol that names an identity model inherits that model's lock-in, and every deployment that disagrees has to fight it. Authorize the request in front of your handler and let the protocol move entities.

**Corollary:** `clientId` ([§5](#5-common-types)) is **not** an authentication claim. It is a dedup key. Never authorize on it.

## 5. Common types

All wire types are the ADR-006 rev d shapes, encoded as JSON.

```jsonc
// An ordering token. Opaque to the client, meaningful to you.
// string OR number — never an object. See §9 on why string is preferred.
"version": 42            // or "1722571200000-a3f"

// A pull position. Fully opaque; the client treats it as bytes and
// never parses, compares or orders it.
"cursor": "eyJvIjoxNzJ9"
```

### `RemoteChange` — server → client

```jsonc
{
  "type": "set",         // "set" | "remove"
  "entityType": "Run",
  "id": "run_01H…",
  "data": { "id": "run_01H…", "status": "complete" },  // ABSENT when type is "remove"
  "version": 42
}
```

**`remove` is a tombstone, and this is a hard requirement.** A deletion MUST arrive as an explicit `remove` change. A row that simply stops appearing is indistinguishable from a row outside the current selection, so a hard delete with no tombstone is unsyncable — the client will keep the row forever and never learn why.

In practice this means your table needs a soft-delete column and your feed emits the deletion as a change.

### `LocalChange` — client → server

```jsonc
{
  "mutationId": "01H…",        // idempotency key, globally unique
  "clientId": "c_a3f9…",       // opaque; may be a public key. Never validate its format.
  "seq": 17,                   // monotonic per clientId
  "transactionId": "tx_88…",   // optional; groups a multi-entity write for atomic apply
  "op": "set",                 // "set" | "remove"
  "entityType": "Decision",
  "id": "dec_01H…",
  "data": { "approved": true },     // PATCH-style dirty fields preferred over full rows
  "baseVersion": 41,                // optional; the version the client last saw
  "intent": {                       // OPTIONAL. See §10.
    "name": "approveGate",
    "args": { "gateId": "g_01H…" }
  }
}
```

## 6. Confirmation

**A push acknowledgement does not confirm a mutation. A subsequent pull does.**

This is the single most important behavioural rule in the protocol, and the most common thing to get wrong. The server's obligation:

> Every `pull` response MUST include `confirmedMutations`: a map of `clientId` → the highest `seq` from that client already contained in this snapshot.

The client uses that map, and only that map, to retire its optimistic overlay. If you omit it, clients will hold every optimistic write forever and the UI will show duplicates when the snapshot catches up.

There is exactly one confirmation channel. An earlier draft of ADR-006 offered a second — a checkpoint watermark — and it was **deleted** in rev d, because comparing a checkpoint against a watermark presumes versions are totally ordered, which the protocol deliberately does not require ([§9](#9-version-ordering)).

## 7. Endpoints

### `POST /sync/v1/pull`

**Request**

```jsonc
{
  "cursor": null,             // null = initial sync; otherwise a cursor you issued
  "limit": 500,               // OPTIONAL. A HINT — see below.
  "schemaVersion": "3",       // OPTIONAL
  "subscription": "gates"     // OPTIONAL. An opaque partition name — see §11.
}
```

**`limit` is a ceiling, not a quota.** You MAY return fewer rows than asked. You MUST NOT return more. If omitted, choose your own page size. The client imposes no maximum, because a backend knows its own page size and this protocol does not.

**Response `200` — changes**

```jsonc
{
  "type": "changes",
  "changes": [ /* RemoteChange[] */ ],
  "cursor": "eyJvIjoxODB9",
  "complete": true,
  "confirmedMutations": { "c_a3f9…": 17 },
  "checksum": "sha256:…",        // OPTIONAL — see below
  "subscription": "gates",       // echo it back if the request named one
  "retentionSeconds": 2592000    // OPTIONAL — see §12
}
```

**`complete: false` means more batches follow.** The client stages everything and applies nothing until it sees `complete: true`, so a partial snapshot is never observable to the application. **If you withheld rows, you MUST say so.** Claiming completeness while holding rows back makes the client apply a partial snapshot as though it were the whole world — a silent, permanent divergence.

**`checksum` is presence-driven.** Send it and the client verifies it; a mismatch resets that subscription and only that one. There is no flag to disable verification, because an adapter that sends a checksum is asserting it means something. If you cannot compute one cheaply, omit the field.

**Response `200` — reset**

```jsonc
{ "type": "reset", "cursor": null, "subscription": "gates" }
```

Return this when the client's cursor is expired, compaction has dropped tombstones it needed, the schema changed underneath it, or you detect corruption. The client discards its copy of that partition and resyncs from scratch. **`reset` is a normal outcome, not an error** — it has a first-class path in the client and does not surface to the user as a failure.

If a `schemaVersion` you cannot serve arrives on `pull`, answer with `reset`. **Never answer with an empty `changes` batch** — that reads to the client as "you are fully synced," which is the worst available answer to "I cannot serve your schema."

### `POST /sync/v1/push`

**Request**

```jsonc
{
  "changes": [ /* LocalChange[] */ ],
  "schemaVersion": "3"        // OPTIONAL
}
```

**Response `200`**

```jsonc
{
  "results": [
    { "mutationId": "01H…", "status": "ack",       "version": 43 },
    { "mutationId": "01H…", "status": "reject" },
    { "mutationId": "01H…", "status": "transform", "version": 44,
      "data": { "…": "corrected entity" }, "remappedId": "srv_991" }
  ]
}
```

One verdict per submitted change, and every `mutationId` in the response MUST be one that was submitted.

| Verdict | Meaning | Server obligation |
|---|---|---|
| `ack` | Applied. `version` is the write watermark. | — |
| `reject` | **Permanently** invalid. The client drops the write and reverts. | **MUST still advance this client's `seq`.** |
| `transform` | You rebased the write. Carries the corrected entity, and MAY carry `remappedId` (temp id → server id). | — |

**The `reject` seq rule is not optional.** If you reject a change without advancing that client's `seq`, the next push carries a `seq` you read as a gap, and the client wedges forever behind a write it can never retract. This is the most subtle way to brick a client.

### Durability

**`push` MUST NOT respond until the write is durable in the same store `pull` reads from.**

Responding from an async queue breaks sync in a way that looks like flakiness: the client pulls a snapshot that does not contain the write it was just told had landed, and the bug appears only under load. If your architecture is write-behind, the sync endpoint has to wait for the read model.

### Idempotency

A `mutationId` seen before MUST produce the same verdict and no second application. A `seq` at or below the highest seen for that client is a replay — return the recorded verdict, do not re-apply, and **do not `reject` it**; rejecting a replay makes the client revert a write you already applied.

A `seq` above `lastSeen + 1` is a gap. Refuse the batch as a transport error (`409`) rather than applying it out of order.

## 8. Status codes

**Status codes carry transport outcomes. The body carries verdicts. Never mix them.**

| Code | Class | What the adapter does |
|---|---|---|
| `200` | A verdict is in the body | Return it |
| `400` | Malformed request | Permanent — surface it |
| `401` `403` | Auth | Permanent — surface it |
| `409` | Schema mismatch on `push`, or a `seq` gap | **Throw** a typed error; the outbox is suspended, never drained |
| `404` | Unknown protocol version or endpoint | Permanent — surface it |
| `408` `429` | Timeout / rate limit | **Transient — throw**, client retries with backoff |
| `5xx` | Server fault | **Transient — throw**, client retries with backoff |

**This table exists to mechanize one distinction: transient versus permanent.** Reporting a transient network condition as a permanent `reject` destroys a valid user write silently and forever — the client reverts the overlay, drops the outbox entry, and nothing anywhere logs an error. If you are unsure which a condition is, **return `5xx`**. A retried write is recoverable; a rejected one is not.

Retries use exponential backoff with full jitter and have **no attempt ceiling and no dead-letter queue**. A write is dropped by a user or by an explicit `reject` — never by a timer.

## 9. Version ordering

`version` is **your** token. The client never parses it, never compares it with `>`, and never fabricates one.

A client MAY supply a comparator that returns one of four results: `older`, `same`, `newer`, `concurrent`. The default comparator — used when none is supplied — is numeric when both tokens parse as numbers and lexicographic otherwise, and **never returns `concurrent`**.

**Prefer a string version even for integer counters, and left-pad it, or just send a number.** The trap: `"10" < "9"` lexicographically, so a backend issuing integer versions as unpadded strings silently orders its own history backwards. The default comparator parses numeric strings numerically to defuse this, but do not rely on that if you might ever mix formats.

The fourth value exists so a hybrid logical clock or vector clock stays expressible. If you are a conventional server-authoritative backend you will never emit `concurrent` and can ignore this section.

## 10. `intent` — optional, and `data` is not

A change MAY carry `intent`, a named mutator and its arguments. If you can replay that mutator server-side against post-apply state, you get true rebase rather than judging a patch computed against stale state.

**`data` is still required, and you MUST be able to apply a change using `data` alone.** This is the property that keeps the protocol backend-neutral: a REST API that already exists cannot execute a function from someone's client bundle. Ignoring `intent` entirely is a valid, conformant implementation. Failing because of it is not.

If a replayed intent disagrees with the submitted `data`, you win — report it as `transform`.

## 11. Subscriptions

A subscription is **an opaque partition name**. That is the whole definition.

The client holds a name and a cursor per partition, and knows nothing else. It never learns what predicate produced the partition. You own the namespace; any string is a legal name, and the client will not validate it.

**Do not accept a query, a filter, or a predicate here — not now and not later.** A server-evaluated predicate over plaintext is the one-way door: a backend that cannot decrypt user data can never evaluate one, so the moment the client expresses selection as a predicate, end-to-end encryption is foreclosed permanently and no future adapter recovers it. Filtering that happens *inside* your server, keyed by a name you chose, is fine and is the intended design.

If a request names no subscription, serve the single default partition.

## 12. Retention

**Retention of the change feed is not retention of the data.** Conflating them is what makes retention look expensive.

- Entities live as long as your application needs them — typically forever.
- The **change log** — the ordered feed cursors point into — lives for a bounded window that you choose.

**Obligation:** tombstones MUST survive at least as long as the oldest cursor you will honour. Compaction that drops tombstones MUST invalidate the affected cursors, which clients observe as `reset`. This turns "how long must a tombstone live?", which has no general answer, into a relation between two things you already know.

**`retentionSeconds` on the pull response is how a client avoids being surprised.** Declare your window and a client that has been offline longer can resync deliberately instead of discovering expiry through a failed pull. Omitting it is legal; the `reset` path still works. Including it turns an interruption into a scheduled operation.

A window of days to weeks is normal. For small append-only records, a client outside the window refetches current state in seconds, so the cost of being wrong here is low — which is the argument for choosing a modest window and keeping the feed cheap.

## 13. Minimal conformant server — the checklist

Nothing here is optional.

- [ ] `POST /sync/v1/pull` and `POST /sync/v1/push`, JSON in and out
- [ ] An ordered, resumable change feed a cursor points into
- [ ] Per-`clientId` `lastSeen` seq tracking, replays deduped by `mutationId`
- [ ] `seq` advanced even on `reject`
- [ ] Soft deletes emitted as `remove` tombstones
- [ ] `confirmedMutations` on every pull response
- [ ] `complete: false` whenever rows were withheld
- [ ] Writes durable before `push` responds
- [ ] Transient conditions as `5xx`, never as a `reject` verdict
- [ ] Unknown request fields ignored

Notably **not** required: subscriptions, checksums, a live channel, `intent` replay, a custom version comparator, `retentionSeconds`. Each is a capability, not a floor.

## 14. Open

- **The server conformance kit does not exist yet.** Until it does, this document is a claim rather than a check — which is exactly the state ADR-023 says the protocol must not stay in. It is the next artifact.
- **The reference server does not exist yet.** Third in the ship order, deliberately.
- **`v1` is not frozen.** It freezes when the first adapter ships against it. Say so loudly at that moment; it is a one-way door.
