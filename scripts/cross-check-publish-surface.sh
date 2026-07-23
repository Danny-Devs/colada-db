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

# ── The SUBJECT must be substantive before any assertion about it means anything
#
# `grep` exits **2** on a file that does not exist — not 0 and not 1 — so
# `if grep -q "$p" missing.txt; then fail; fi` takes the false branch and the
# absence assertion "passes" against a file nobody ever opened. And a file
# truncated to zero bytes contains no forbidden string by definition, so every
# absence assertion below passes vacuously over an empty artifact while printing
# a green tick. Measured 2026-07-23: deleting `dist/index.d.mts` printed
# "✔ 4 invariants"; truncating it to 0 bytes did the same, with no stderr at all.
#
# The repo's existing anti-vacuity machinery proves each DETECTOR can fire. This
# proves the SUBJECT is real. Both are required — a working detector aimed at
# nothing is still nothing.
require_substantive() {
  f="$1"
  [ -e "$f" ] || fail "artifact does NOT EXIST: $f — run \`pnpm build\` first. (Asserting against a missing file is how an absence check passes vacuously.)"
  [ -f "$f" ] || fail "artifact is not a regular file: $f"
  [ -s "$f" ] || fail "artifact is EMPTY (0 bytes): $f — every absence assertion about it would pass for the wrong reason."
}

# Run grep and classify its exit code honestly.
#   0 = matched, 1 = no match, >=2 = grep itself failed (missing file, bad
#   pattern, unreadable). Treating >=2 as "no match" is the bug this function
#   exists to prevent.
grep_status() {
  pattern="$1"
  shift
  grep -q -- "$pattern" "$@"
  status=$?
  if [ "$status" -ge 2 ]; then
    fail "grep ERRORED (exit $status) on pattern '$pattern' over: $* — this is not 'no match'; the check did not run."
  fi
  return "$status"
}

# Assert `pattern` does NOT appear in the given files.
assert_absent() {
  pattern="$1"
  shift
  for f in "$@"; do require_substantive "$f"; done
  if grep_status "$pattern" "$@"; then
    fail "forbidden pattern '$pattern' found in: $(grep -l -- "$pattern" "$@" | tr '\n' ' ')"
  fi
}

# Assert `pattern` DOES appear in the given file.
assert_present() {
  pattern="$1"
  shift
  for f in "$@"; do require_substantive "$f"; done
  if ! grep_status "$pattern" "$@"; then
    fail "required pattern '$pattern' is MISSING from: $*"
  fi
}

# ── Self-test: prove every helper can actually fail ────────────────────────
# A cross-check that cannot fail is worse than no cross-check, because its green
# tick is what stops the next person looking (LESSONS.md 2026-07-23). Each helper
# is run in a subshell against a fixture engineered to trip it; if the subshell
# exits 0, the helper is broken and we refuse to report on the real artifact.
#
# Four cases, not two: the detectors (does the pattern logic fire?) AND the
# subject floor (does a missing or empty artifact fire?). The 2026-07-23 review
# found the second half missing — both implementations of this gate reported
# green over a DELETED and over a ZERO-BYTE declaration file.
expect_fail() {
  label="$1"
  shift
  if ( "$@" ) > /dev/null 2>&1; then
    echo "✗ VACUOUS CROSS-CHECK: $label did not fire." >&2
    echo "  Every assertion below is meaningless while that is true. Fix this first." >&2
    exit 1
  fi
}

selftest() {
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  printf 'process.env?.NODE_ENV\n' > "$tmp/poisoned.txt"
  printf 'nothing of interest\n' > "$tmp/plain.txt"
  : > "$tmp/zero-bytes.txt"

  expect_fail "assert_absent on a poisoned fixture" \
    assert_absent "process.env?.NODE_ENV" "$tmp/poisoned.txt"
  expect_fail "assert_present on a fixture lacking the pattern" \
    assert_present "definitely-not-there" "$tmp/plain.txt"

  # The subject floor. `grep` exits 2 on a missing file, which an `if` reads as
  # "no match" — the exact shape of every absence assertion below.
  expect_fail "assert_absent on a MISSING artifact" \
    assert_absent "anything" "$tmp/does-not-exist.txt"
  expect_fail "assert_present on a MISSING artifact" \
    assert_present "anything" "$tmp/does-not-exist.txt"
  expect_fail "assert_absent on a ZERO-BYTE artifact" \
    assert_absent "anything" "$tmp/zero-bytes.txt"
}

selftest
echo "✔ cross-check helpers self-tested (detectors fire; missing/empty subjects rejected)"

# ── The invariants, against literal paths ──────────────────────────────────
# Paths are spelled out rather than derived, on purpose: this leg's job is to be
# wrong in different ways than the Node script, not to share its plumbing.

# The artifact must actually say something. A declaration file can be present,
# nonempty, and still be a stub that asserts nothing — so each shipped file is
# pinned to an anchor it must contain. Without this, "no forbidden string found"
# is a claim about a file that might have been reduced to a comment.
assert_present "declare function createEntityStore" dist/index.d.mts
assert_present "function createEntityStore" dist/index.mjs
assert_present "declare function runSqliteWorker" dist/sqlite-worker.d.mts
assert_present "function runSqliteWorker" dist/sqlite-worker.mjs

# colada-db is the standalone engine; the originating plugin's name must not
# appear in the shipped artifact (AGENTS.md, ADR-018). `./sqlite-worker` is a
# published entry point too — it was outside every publish assertion until the
# 2026-07-23 review, which made the branding invariant blind to half of what
# ships.
assert_absent "pinia-colada-plugin-normalizer" \
  dist/index.d.mts dist/index.mjs dist/sqlite-worker.d.mts dist/sqlite-worker.mjs

# DAN-649: the literal a definer substitutes must be present...
assert_present "process\.env\.NODE_ENV" dist/index.mjs

# ...and must never be optional-chained, which leaves a literal definer nothing
# to replace (+1,106 bytes minified, 5 dev strings leaked — measured). Checked on
# BOTH entry points: `src/engines/sqlite.ts` carries a guard, so a bundling
# change moves the worker chunk into scope without anyone editing this file.
assert_absent "process\.env?\.NODE_ENV" dist/index.mjs dist/sqlite-worker.mjs

# ADR-019: the published type surface names no framework — both declarations.
assert_absent "@vue/reactivity" dist/index.d.mts dist/sqlite-worker.d.mts

echo "✔ cross-check passed — 10 invariants over 4 shipped artifacts, independent implementation"
