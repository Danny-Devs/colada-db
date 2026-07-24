#!/usr/bin/env bash
#
# Publish-manifest gate (DAN-658 review pass, 2026-07-23).
#
# Asserts that `pnpm pack` produces EXACTLY the file list in
# `scripts/expected-pack-manifest.txt` — in both directions. A path that should
# ship and stopped shipping fails; a path that ships and is not on the list
# fails.
#
# ── What this replaced, and why ─────────────────────────────────────────────
#
# The CI step this grew out of was:
#
#     pnpm pack --pack-destination "$RUNNER_TEMP"
#     tar -tzf "$RUNNER_TEMP"/colada-db-*.tgz | sort
#
# That produces output and asserts nothing. It is the fourth instance in one day
# of the same defect class in this repo — a check that reports success on a
# question it never evaluated (`grep -c` exiting 1 on success; `! grep -q`
# no-oping under `set -e`; a lint reporting clean on a scan that never opened the
# file; and the engines-floor smoke test resolving through package
# self-reference so it never opened the tarball). Printing a manifest looks like
# diligence and carries no verdict.
#
# ── Notes on the mechanics ──────────────────────────────────────────────────
#
# * `LC_ALL=C sort` on both sides. Default collation differs between macOS and
#   ubuntu-latest (case-folding vs byte order), so an unpinned `sort` produces a
#   diff that depends on the machine rather than on the artifact.
# * Bash, and CI/local-only rather than part of `prepublishOnly`: this needs
#   `pnpm pack` and `tar`. `scripts/check-publish-surface.mjs` remains the
#   portable authority for the textual invariants; this leg covers the file list.
# * It self-tests the comparison against a deliberately wrong expectation before
#   trusting a pass, for the reason the whole ticket exists.

set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
expected_file="$root/scripts/expected-pack-manifest.txt"

fail() {
  echo "✗ $1" >&2
  exit 1
}

# Strip comments and blank lines; sort in byte order.
normalize_expected() {
  grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "$1" | LC_ALL=C sort
}

# ── Self-test: prove the comparison can actually fail ──────────────────────
# A manifest check that cannot go red is decoration. Before asserting anything
# about the real tarball, run the exact comparison used below against an
# expectation engineered to be wrong, and refuse to continue if it passes.
selftest() {
  st_tmp="$(mktemp -d)"
  printf 'a.txt\nb.txt\n' > "$st_tmp/expected"
  printf 'a.txt\nUNEXPECTED.txt\n' > "$st_tmp/actual"
  if diff -u "$st_tmp/expected" "$st_tmp/actual" > /dev/null 2>&1; then
    rm -rf "$st_tmp"
    echo "✗ VACUOUS MANIFEST GATE: diff reported two different lists as equal." >&2
    echo "  The comparison below would pass no matter what pack emits." >&2
    exit 1
  fi
  rm -rf "$st_tmp"
}

selftest
echo "✔ manifest comparison self-tested (it can fail)"

[ -f "$expected_file" ] || fail "expected manifest is missing: $expected_file"
[ -s "$expected_file" ] || fail "expected manifest is EMPTY: $expected_file"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

( cd "$root" && pnpm pack --pack-destination "$tmp" ) || fail "pnpm pack failed"

# Fail closed on zero or multiple tarballs rather than letting a glob quietly
# pick one — `tar -tzf a.tgz b.tgz` would silently read only the first.
shopt -s nullglob
tarballs=("$tmp"/colada-db-*.tgz)
shopt -u nullglob
[ "${#tarballs[@]}" -eq 1 ] || fail "expected exactly 1 tarball in $tmp, found ${#tarballs[@]}"
tarball="${tarballs[0]}"

tar -tzf "$tarball" | sed 's|^package/||' | grep -v '/$' | LC_ALL=C sort > "$tmp/actual.txt"
[ -s "$tmp/actual.txt" ] || fail "the packed tarball listed NO files: $tarball"

normalize_expected "$expected_file" > "$tmp/expected.txt"

if ! diff -u "$tmp/expected.txt" "$tmp/actual.txt"; then
  cat >&2 <<'MSG'

✗ PUBLISH MANIFEST MISMATCH

`pnpm pack` did not produce the file list in scripts/expected-pack-manifest.txt.
Above: `-` lines are expected-but-missing, `+` lines are shipped-but-unlisted.

This is not a formatting nit. The list is what every consumer receives, forever,
at those exact paths:

  * A `-` line means something the package promised to ship is GONE. Whatever
    imports it is now broken for consumers only — and only after publish.
  * A `+` line means something is being shipped that nobody decided to ship.
    Source trees, fixtures, dotfiles and secrets all arrive this way, and a
    version already on the registry cannot be un-shipped.

ADDING A PUBLISHED FILE IS A DELIBERATE ACT. If the new list is correct, say so
by editing scripts/expected-pack-manifest.txt in the same commit as the change
that caused it — that edit is the record of the decision. Do not edit it to make
CI green without answering the question the diff is asking.
MSG
  exit 1
fi

echo "✔ publish manifest matches — $(wc -l < "$tmp/actual.txt" | tr -d ' ') entries, asserted in both directions"
