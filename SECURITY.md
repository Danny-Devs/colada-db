# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub's private vulnerability reporting, on the
[Security tab](https://github.com/Danny-Devs/colada-db/security/advisories/new)
of this repository. That channel is private between you and the maintainer
until a fix is published, and it lets us credit you in the advisory.

If private reporting is unavailable to you for any reason, open a public issue
containing **only** the words "security report, requesting private contact" —
no details — and you will be given a private channel.

Expect an acknowledgement within a week. This is a small project without a
funded security team, so please read the scope below before reporting: it will
tell you quickly whether what you found is a bug or a documented boundary.

## Supported versions

Pre-1.0. Only the latest published version receives fixes. There are no
backports.

## Scope — what counts as a vulnerability

In scope:

- Bypassing the `packages/mcp` agent surface's per-type allowlist, or reaching
  any write path through it. That surface registers **zero** write tools by
  design; a way to mutate the store through it is a serious bug.
- Causing `parseMatcher` to accept a filter that then escapes own-property
  reads — prototype pollution, accessor invocation, prototype-chain traversal.
  The parser is meant to be total and fail-closed over untrusted JSON.
- A `PolicyGate` veto that fails to prevent the write it refused.
- Corruption or cross-origin leakage of persisted data through the storage
  engines.

## Out of scope — documented boundaries, not defects

These are stated in the README and the ADRs. Reporting them is welcome as a
docs issue, but they are not vulnerabilities:

- **`WriteOrigin` is attribution, not authentication.** Origin tags identify a
  write channel within one trust domain. Any code with store access is inside
  that domain. They are not a capability system and do not survive an attacker
  already running in your page.
- **Entity data is untrusted by construction.** The store holds whatever your
  server, your users, or your other code put in it. The MCP surface marks
  results untrusted in-band and via `_meta`, but a label cannot compel a model
  to honor it — that is the host's job.
- **The MCP surface returns entity data verbatim.** A visible entity's
  foreign-key fields may name ids of hidden types. The hidden type's schema,
  fields and rows stay unreachable; the referencing id does not.
- **Durable storage is origin-private, and that is the whole boundary.**
  colada-db adds no encryption at rest. Anything with same-origin script
  execution can read the database, exactly as it can read IndexedDB directly.
- **Denial of service through your own data volume.** Matcher cost limits
  (`MATCHER_MAX_COST` and friends) bound per-filter work, not total store size.
