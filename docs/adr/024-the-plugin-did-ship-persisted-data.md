# ADR-024: The plugin DID ship persisted data — ADR-018's clean break owes a migration

**Status:** Accepted
**Implementation:** in-progress
**Force:** invariant
**Date:** 2026-08-02
**Amends:** ADR-018 (corrects its factual premise 2 and the conclusion drawn from it; the `cdb` naming decision itself stands)
**Relates to:** ADR-020 (versioned registry key), ADR-022 (line 1 — persisted format)

## Context

ADR-018 unified every wire and disk identifier on `cdb` — `__pcn_ref` → `__cdb_ref`, `pcn_entities` → `cdb_entities`, `pcn_entities.sqlite3` → `cdb_entities.sqlite3` — as a **clean break with no migration and no dual-read**. It justified that on two facts:

> 1. **colada-db is `"private": true`** — it has never been published. Zero databases exist in the wild under these names.
> 2. The Vue/Pinia adapter has **never shipped persisted data** either (the plugin-swap is chip 3, still gated on publish — AGENTS.md).

**Fact 1 was true when written. Fact 2 was false when written, and is verifiable as false from the public registry.**

### The evidence

`pinia-colada-plugin-normalizer@0.3.0` is published on npm — with a release history back to `0.1.8` — and its shipped bundle contains all four identifiers:

```
$ npm pack pinia-colada-plugin-normalizer@0.3.0 && tar xzf *.tgz
$ grep -o "enablePersistence\|idbEngine\|pcn_entities\|__pcn_ref" package/dist/index.mjs | sort | uniq -c
   1 __pcn_ref
   5 enablePersistence
   3 idbEngine
   3 pcn_entities
```

294 downloads in the month to 2026-08-01.

### How the error was made, because the shape matters more than the instance

The parenthetical in fact 2 is the whole mistake: *"the plugin-swap is chip 3, still gated on publish."*

That is a true statement about **the plugin depending on colada-db**, which had indeed not happened. It was then used to support a different claim — that **the plugin does not persist data**. The plugin has always persisted data; it does so through its own frozen fork of the engine, which is precisely why the fork exists.

**Two propositions about the same package got conflated because one implies the other in the wrong direction.** "Does not depend on colada-db" does not imply "does not persist." Nothing was hidden; the premise was simply never checked against the registry, and it was checkable in one command.

## Decision

**1. ADR-018's naming decision stands.** `cdb` as the single identifier family is correct and is not reopened. Every argument for it survives this correction.

**2. ADR-018's "no migration needed" conclusion does not stand.** A migration obligation now exists, owned by the plugin, at the moment chip 3 lands.

**3. Chip 3 is a MAJOR version of the plugin, and it may not ship without one of:**
   - a **legacy read path** that recognizes `__pcn_ref` and the `pcn_entities` / `pcn_entities.sqlite3` stores and rewrites them forward on first boot; **or**
   - an **explicit, loud refusal**: detect the legacy store, refuse to silently start empty, and tell the user what happened and what to do.

   **What is forbidden is the current behaviour: start, find nothing under the new names, and present an empty database with no error.** Silent data loss is the one outcome neither option permits.

**4. `colada-db` core takes on nothing.** The legacy names are the *plugin's* history, not the engine's, and ADR-018's rejection of a compat shim in core was right for the reason it gave. The engine stays clean; the plugin owns its own upgrade path. This is also what keeps the engine free of a `pcn_` identifier it never issued.

## Alternatives Considered

- **Do nothing; 294 downloads is probably bots.** Rejected. "Probably nobody" is not a data-loss policy, and the cost of being wrong is a stranger's data with no error message. The number is also unfalsifiable in the direction that matters — registry downloads cannot tell you whether any of them enabled persistence.
- **Add a dual-read to `colada-db` core.** Rejected, consistent with ADR-018: the engine never issued `pcn_` identifiers and should not learn them. Putting the shim in core would make every future consumer carry the plugin's history.
- **Revert to the `pcn_` names.** Rejected: it would spend the clean break to preserve a prefix that names a package the engine is not.

## Consequences

- **Positive:** the actual obligation is now written down before chip 3 rather than discovered by a user with an empty database. ADR-018's decision is preserved with its reasoning corrected rather than quietly patched.
- **Negative:** chip 3 costs more than a dependency swap. It is a major version with a migration path and release notes.
- **Risk:** the same conflation can recur anywhere an ADR reasons about what a package "has shipped." **The general form: a claim about what is on a public registry is checkable in one command, and an ADR that asserts one without running it is asserting a belief.**

## The rule this earns

**Verify the premise, not just the conclusion.** ADR-018's reasoning was sound and its conclusion followed correctly from its stated facts — which is exactly why nobody caught it. A review that checks whether the argument is valid will pass a valid argument built on a false premise every time.

Concretely, and cheap enough that there is no excuse:

> Before any ADR asserts what a package has or has not shipped, run `npm view <pkg> versions` and inspect the published artifact. Paste the output into the ADR.
