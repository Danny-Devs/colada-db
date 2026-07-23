# ADR-019: Ref Identity Is a VERSIONED Global Registry Key, and Encode Validates What Decode Validates

**Status:** Accepted
**Date:** 2026-07-23

## Context

An `EntityRef` is marked in memory by a `Symbol` (`ENTITY_REF_MARKER`), chosen
over a string key so ordinary API data can never accidentally look like a ref
(Issue #13). Three separate call sites branch on that marker:

- `encodeEntityRefs` (`src/store.ts`) — the WRITE path: a marked object is
  replaced by the string-keyed wire form `__cdb_ref` (ADR-018) before it reaches
  disk.
- `decodeEntityRefs` (`src/store.ts`) — the READ path: a `__cdb_ref` row is
  rebuilt into a marked object.
- `isEntityRef` (`src/normalize.ts`) — the DEREFERENCE path: a marked object is
  swapped for the live entity during `denormalize`.

Two properties of that marker were revisited in DAN-649.

**Marker scope.** Originally a plain `Symbol()`, which is per-module-instance.
Two copies of colada-db in one page therefore disagreed about ref identity:
`isEntityRef` in copy A returned `false` for a ref minted by copy B, and refs
silently degraded to opaque data. That is not hypothetical — chip 3
(`AGENTS.md`) swaps the Pinia Colada adapter's frozen engine copy for a
`colada-db` dependency, and npm can dedupe an app and a dependency onto two
different `colada-db` versions.

**Guard symmetry.** `decodeEntityRefs` validates the full ref shape with type
checks (`entityType` / `id` / `key` all `string`) — the M2 hardening from
DAN-648, added because the *wire* marker is a plain string key that ordinary
persisted data can collide with. The encode path and `isEntityRef` checked only
`record[ENTITY_REF_MARKER] === true`. The write path trusted exactly what the
read path distrusted.

While the marker was per-instance, that asymmetry was **latent**: a
foreign-shaped ref could not carry a matching symbol, so it could never reach
the encode branch in the first place. Interning the symbol globally removes that
accidental protection — for the first time, an object minted by another copy
satisfies the marker check.

## Decision

Three things, adopted together — the third is what makes the first two safe.

1. **`ENTITY_REF_MARKER = Symbol.for("colada-db/entity-ref@1")`** — a key in the
   cross-realm global symbol registry, so duplicate copies agree on ref identity.

2. **The registry key carries an explicit version suffix.** Bump `@1` on any
   breaking change to the ref SHAPE (adding, removing, renaming, or retyping
   `entityType` / `id` / `key`). Not on unrelated majors — the suffix versions
   the ref contract, not the package.

3. **Encode and `isEntityRef` validate the same full ref shape decode does.**
   The marker alone is no longer sufficient at any of the three sites.

## Alternatives Considered

- **Keep the plain `Symbol()`.** Fail-safe across versions, but leaves the real
  duplicate-instance defect open: refs degrade to opaque data whenever two copies
  share a page, which chip 3 makes a normal configuration rather than an exotic
  one. Rejected — it trades a certain bug for the absence of a conditional one.

- **`Symbol.for` with an UNVERSIONED key** (`"colada-db/entity-ref"`). Fixes the
  duplicate-instance case and silently couples incompatible versions: a global
  registry interns across versions as well as instances, so a page holding v1 and
  v2 has v1's `isEntityRef` accept a v2 ref, and v1's encode path then rewrites
  it using v1's field expectations. The plain `Symbol()` it replaced degraded
  such cross-version refs safely to opaque data; that safety property would have
  been given up without anyone noticing. Rejected.

- **`Symbol.for` with a versioned key, but leave encode trusting the marker
  alone** (the shipped state before this ADR). The suffix protects against a
  *declared* future major, but not against any other producer of a marked object
  — including a build that shares this key and a differently-shaped ref. The
  concrete failure: a foreign-shaped ref is destructively rewritten into a
  malformed `__cdb_ref` row, which decode's own M2 guard then permanently
  refuses. The relationship becomes unrecoverable, where before the change it
  round-tripped intact. Rejected.

- **Versioned key + symmetric validation at all three sites (chosen).** Keeps
  100% of the duplicate-instance benefit within a major, restores fail-safe
  degradation across majors, and makes an unrecognised marked object survive as
  plain data on every path instead of being destroyed on one.

## Consequences

**Positive**
- Two copies of the SAME major agree on ref identity — the defect that motivated
  `Symbol.for` is fully closed.
- A ref from a different major degrades to opaque data rather than being
  misinterpreted — the pre-`Symbol.for` fail-safe, restored deliberately.
- Encode, decode, and dereference now share one validation predicate. A future
  change to the ref shape has one contract to update, not three.
- Nothing marked-but-unrecognised is ever destroyed: it falls through to the
  ordinary child walk on every path.

**Negative**
- Three extra `typeof` checks on the encode hot path per marked object. Negligible
  — the branch is only reached for objects already carrying the symbol.
- The version suffix is a contract a future author must remember to bump. Encoded
  in the `ENTITY_REF_MARKER` docstring and pinned by
  `src/encode-decode-integrity.spec.ts`, which asserts the exact registry key.

**Risks / what we watch for**
- A collision whose shape AND types exactly match a real ref remains
  indistinguishable on the wire path. That is an inherent limit of a string-keyed
  wire marker, already bounded honestly by DAN-648/M2; this ADR does not change it.
- The pre-chip-3 frozen plugin copy declares `Symbol("pinia-colada-entity-ref")`
  — a plain symbol with a different description — which `Symbol.for` cannot
  intern with. That case is NOT closed by this ADR, and closing it would require
  the plugin copy to adopt this same registry key.

**Severity, stated honestly.** The destructive scenario requires two colada-db
copies with *different* ref shapes on one page — i.e. a future major. The package
is `0.1.0`, `"private": true`, with zero databases on disk. This ADR closes a
future hazard while it is free; it is not a live bug. Single-instance emitted
bytes were verified byte-identical, so no migration exists or is needed.

## Verification

- `src/encode-decode-integrity.spec.ts` — the interned key and its `@1` suffix;
  a duplicate same-major copy's ref still encodes; a `@2` marker does NOT intern
  and passes through as data; emitted bytes for a legitimate ref are unchanged;
  a foreign-shaped marked object survives encode as plain data (nested and
  top-level); the row the unvalidated encode WOULD have written is one decode's
  M2 guard refuses; `denormalize` returns a foreign-shaped marked object
  untouched instead of erasing it.
