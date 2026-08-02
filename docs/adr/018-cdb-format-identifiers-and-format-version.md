# ADR-018: Unify the Persisted Format on `cdb`, Reserve a `formatVersion` Escape Hatch

**Status:** Accepted
**Implementation:** shipped
**Date:** 2026-07-23

## Context

The persisted on-disk / wire format straddled two naming eras. The engine was
extracted from `pinia-colada-plugin-normalizer` (ADR heritage; AGENTS.md), and
the durable identifiers still carried that lineage's `pcn` prefix while the
project itself had already been renamed **colada-db** (`cdb`). Concretely, three
identifiers occupy on-disk / wire positions that a persisted database commits
to forever:

- `__pcn_ref` — the string wire key `encodeEntityRefs`/`decodeEntityRefs` use to
  represent an `EntityRef` in serialized data (the Symbol marker cannot survive
  `JSON.stringify` / structured clone, so a plain string key is the wire form).
- `pcn_entities` — the default IndexedDB database name (and the SQLite OPFS file
  is `pcn_entities.sqlite3`).

The manifest namespace (`__cdb_manifest__:`) had already been minted on `cdb`;
these three were the stragglers.

This is a persisted **contract**: once a real user's browser has written a DB,
these identifiers cannot change without a migration. Two facts make the change
free *right now* and a breaking migration if deferred:

1. **colada-db is `"private": true`** — it has never been published. Zero
   databases exist in the wild under these names.
2. The Vue/Pinia adapter has **never shipped persisted data** either (the
   plugin-swap is chip 3, still gated on publish — AGENTS.md).

So the window to make a clean break — no dual-read, no compat shim — is open
now and closes at first publish. Danny's call: take it now.

Separately, the format had **no version marker at all**. A pre-publish escape
hatch costs one integer today; retrofitting versioning onto an already-published
unversioned format is archaeology.

## Decision

**1. Clean-break rename, no dual-read.** Every `pcn` identifier in a wire / disk
position becomes `cdb`:

| Old | New | Position |
|-----|-----|----------|
| `__pcn_ref` | `__cdb_ref` | entity-ref wire key (`store.ts`) |
| `pcn_entities` | `cdb_entities` | default IDB db name (`persist.ts`, `idb.ts`) |
| `pcn_entities.sqlite3` | `cdb_entities.sqlite3` | default OPFS file (`sqlite.ts`, `persist.ts`) |

No reader for the old names is retained — a DB written by an old build is not a
thing that exists (private, never published). The `ENTITY_REF_MARKER` **Symbol
description** (`Symbol("pinia-colada-entity-ref")`) is deliberately **out of
scope** — it is an in-memory identity only, never serialized, and is owned by a
separate change (DAN-649). Diagnostic log prefixes were groomed `[pcn-persist]`
→ `[cdb-persist]` for brand consistency (not a wire position; no behavior
depends on them).

**2. `CDB_FORMAT_VERSION = 1`, stamped in the manifest index row.** A single
monotonic integer describing the whole persisted format (entity wire codec +
manifest/index rows). Its home is the manifest **INDEX row**
(`__cdb_manifest__:__index__`) — the one row the coordinator itself owns and
reads on every boot, so no new key and no per-entity overhead. The index row
gains an optional `formatVersion?: number` field, written on every index-row
flush as `CDB_FORMAT_VERSION`.

**Boot policy — the ONLY machinery that exists, by design:**

- **absent** → treat as v1 and proceed silently. A pre-publish DB, or *any* DB
  that never created a manifest (hence has no index row), legitimately carries
  no version. Absent ≡ v1.
- **equal** → normal boot.
- **higher than this build knows** → `console.warn` **once** and proceed anyway.
  Forward-tolerant: a user on an old build who opens a DB a newer build wrote
  must not crash — they get a warning and a best-effort read.

There is **no migration machinery and no dual-read**. `formatVersion` is purely
a future escape hatch: when a genuinely breaking format change ships, bump the
constant and add the migration *at that time*, with the version field already in
place to branch on.

## Alternatives Considered

- **Dual-read / compat shim (read both `pcn` and `cdb`):** rejected. There is no
  old data to be compatible with (private, unpublished). A shim would be
  permanent dead code hedging against a population of size zero, and it would
  dilute the very clean-break this ADR exists to make.
- **Defer the rename until after publish:** rejected. This is the entire reason
  the ticket is urgent — post-publish it becomes a breaking migration with real
  user DBs to move. Free now, expensive later.
- **Per-entity-row `formatVersion`:** rejected. The format version is a property
  of the *database*, not of each row; stamping it N times wastes space and
  invites rows disagreeing. The index row is exactly one per DB.
- **A dedicated version key (e.g. `__cdb_meta__:version`):** rejected as
  premature. The index row is already read first on every boot and already
  coordinator-owned; a separate key adds a load and a write path for one
  integer. If the metadata surface grows, promoting it to its own row is a
  cheap later move.
- **Crash / refuse to boot on a higher version:** rejected. Fail-closed is right
  for *corruption*, wrong for a *version bump* — bricking a user's app because
  they haven't updated is hostile. Warn-once-and-proceed is the forward-tolerant
  posture (a real breaking change is what a future migration, gated on the
  bumped constant, will handle deliberately).

## Consequences

- **Positive:** the durable format speaks one name — `cdb` — end to end. The
  format is now versioned, so the first breaking change has a clean branch point
  instead of an unversioned blob to sniff. Both achieved before any user DB
  exists, so both are zero-migration.
- **Negative / accepted:** a hypothetical DB written by a pre-rename build is
  unreadable — accepted, because no such DB exists outside a dev's own machine
  (which can be wiped). The `formatVersion` field is inert until the first real
  format break; carrying an unused integer is the deliberate cost of the escape
  hatch.
- **Risks watched:** the version lives only in the index row, which only exists
  once a manifest is written — so a manifest-free DB is unversioned by
  construction. That is fine *as long as* "absent ≡ v1" holds, which it does and
  must: the moment absent needs to mean something other than v1, the version
  must move to a row that always exists. Flagged here so a future migration
  author does not assume every DB carries a version.
