#!/usr/bin/env bash
#
# Independent cross-check of the publish-surface invariants (DAN-658).
#
# `check-publish-surface.mjs` is the primary implementation and the one that
# runs everywhere (local, pre-push, prepublishOnly, CI). This script asserts the
# SAME four invariants with a different tool and hardcoded literal paths.
#
# It is not redundant. The Node script self-tests each DETECTOR against a
# counter-example, which proves the detector can fire — but it cannot catch the
# script reading a wrong-yet-existing file, under which the controls and the
# assertions would both pass vacuously. Two implementations, genuinely
# independent failure modes.
#
# POSIX-shell and CI-only by design; the cross-check leg is meant to share as
# little machinery with the primary as possible. Contributors on Windows run the
# Node script, which is the authority.
#
# ── The trap this script exists to NOT repeat ───────────────────────────────
#
# The obvious spelling of an absence assertion is wrong in a way that is silent:
#
#     set -e
#     ! grep -q "forbidden" dist/index.mjs      # ← NEVER fails the script
#
# POSIX: "The shell shall not exit if the command that fails ... has its return
# value inverted with !". `set -e` is *ignored* for `!`-negated commands, so that
# line is a no-op whether or not the forbidden string is present. It reads as an
# assertion and behaves as a comment. Measured 2026-07-23: with three such lines,
# injecting the forbidden branding and injecting `process.env?.NODE_ENV` both
# produced exit 0.
#
# This is the same family as DAN-657 (`grep -c` exits 1 on zero matches, so the
# intuitive absence check reads a PASS as a FAIL). Both are cases where an
# assertion's exit code does not mean what it looks like it means.
#
# Every check below therefore uses an explicit `if` + `exit 1`, which has no
# interaction with `set -e` at all, and the whole block self-tests first.

set -uo pipefail

fail() {
  echo "✗ $1" >&2
  exit 1
}

# Assert `pattern` does NOT appear in the given files.
assert_absent() {
  pattern="$1"
  shift
  if grep -q "$pattern" "$@"; then
    fail "forbidden pattern '$pattern' found in: $* $(grep -l "$pattern" "$@" | tr '\n' ' ')"
  fi
}

# Assert `pattern` DOES appear in the given file.
assert_present() {
  pattern="$1"
  shift
  if ! grep -q "$pattern" "$@"; then
    fail "required pattern '$pattern' is MISSING from: $*"
  fi
}

# ── Self-test: prove both assertion helpers can actually fail ───────────────
# A cross-check that cannot fail is worse than no cross-check, because its green
# tick is what stops the next person looking (LESSONS.md 2026-07-23). Each helper
# is run in a subshell against a fixture engineered to trip it; if the subshell
# exits 0, the helper is broken and we refuse to report on the real artifact.
selftest() {
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  printf 'process.env?.NODE_ENV\n' > "$tmp/poisoned.txt"
  printf 'nothing of interest\n' > "$tmp/empty.txt"

  if ( assert_absent "process.env?.NODE_ENV" "$tmp/poisoned.txt" ) 2>/dev/null; then
    echo "✗ VACUOUS CROSS-CHECK: assert_absent did not fire on a poisoned fixture." >&2
    echo "  Every absence assertion below is meaningless. Fix this first." >&2
    exit 1
  fi

  if ( assert_present "definitely-not-there" "$tmp/empty.txt" ) 2>/dev/null; then
    echo "✗ VACUOUS CROSS-CHECK: assert_present did not fire on an empty fixture." >&2
    echo "  Every presence assertion below is meaningless. Fix this first." >&2
    exit 1
  fi
}

selftest
echo "✔ cross-check helpers self-tested (both can fail)"

# ── The invariants, against literal paths ──────────────────────────────────
# Paths are spelled out rather than derived, on purpose: this leg's job is to be
# wrong in different ways than the Node script, not to share its plumbing.

# colada-db is the standalone engine; the originating plugin's name must not
# appear in the shipped artifact (AGENTS.md, ADR-018).
assert_absent "pinia-colada-plugin-normalizer" dist/index.d.mts dist/index.mjs

# DAN-649: the literal a definer substitutes must be present...
assert_present "process\.env\.NODE_ENV" dist/index.mjs

# ...and must never be optional-chained, which leaves a literal definer nothing
# to replace (+1,106 bytes minified, 5 dev strings leaked — measured).
assert_absent "process\.env?\.NODE_ENV" dist/index.mjs

# ADR-019: the published type surface names no framework.
assert_absent "@vue/reactivity" dist/index.d.mts

echo "✔ cross-check passed — 4 invariants, independent implementation"
