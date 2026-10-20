#!/usr/bin/env sh
# SPA-13888: prove the card's changed engine files contribute ZERO TypeScript
# errors. The fork's bare `tsc --noEmit -p server/tsconfig.json` reports
# pre-existing errors on base AND on head (identical sets): the
# `@paperclipai/paperclip-runner` / `plugin-sdk` workspace builds need `cargo`,
# which clean checkouts do not have, so "exit 0" is not an achievable oracle
# here. This gate instead asserts the property the card actually needs — no
# error names a file this card touched.
#
# Fails closed on every path: if tsc cannot run at all (preflight), if it fails
# and its output cannot be read, if the output file is empty/missing, or if a
# nonzero exit produced no `error TS` diagnostics (toolchain failure, not a
# type-check result), that is a FAILURE, never a pass. Proven two-way: exits 0
# on the card head and 1 on a planted error in a touched file.
# Improvement over spa11739: the output directory is created first, so a
# checkout without it fails nothing — the redirect can never fail closed for
# the wrong reason.
set -u
repo="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
out="$repo/.unlazy/spa13888-tsc-output.txt"
status=0
cd "$repo" || exit 2
mkdir -p "$(dirname -- "$out")" || { echo "FAIL: cannot create output directory $(dirname -- "$out")" >&2; exit 2; }
if ! pnpm exec tsc --version >/dev/null 2>&1; then
  echo "FAIL: tsc not runnable (pnpm exec tsc --version failed); cannot prove the SPA-13888 files are clean" >&2
  rm -f "$out"
  exit 1
fi
if [ ! -f server/tsconfig.json ]; then
  echo "FAIL: server/tsconfig.json not found; tsc would check nothing, so a pass would be vacuous" >&2
  rm -f "$out"
  exit 1
fi
pnpm exec tsc --noEmit -p server/tsconfig.json >"$out" 2>&1 || status=$?
if [ "$status" -eq 0 ]; then
  echo "PASS: no type errors in SPA-13888 files (tsc exited 0; output fully clean)"
  rm -f "$out"
  exit 0
fi
if [ ! -s "$out" ]; then
  echo "FAIL: tsc exited $status but produced no readable output; cannot prove the SPA-13888 files are clean" >&2
  rm -f "$out"
  exit 1
fi
# A nonzero exit is only a type-check result if tsc actually loaded the project
# and checked files, proven by at least one per-file diagnostic of the form
# `path(line,col): error TSnnnn`. Config-only failures (e.g. error TS5058,
# "specified path does not exist") check ZERO files and check nothing about the
# SPA-13888 files — treating them as a result would fail open exactly like a
# pnpm launch failure.
if ! grep -qE '\([0-9]+,[0-9]+\): error TS[0-9]+' "$out"; then
  echo "FAIL: tsc exited nonzero but produced no TS diagnostics — toolchain failure, not a type-check result" >&2
  rm -f "$out"
  exit 1
fi
# Every file this card touched: the policy module, the execution-workspaces
# service, and the test file (never actually tsc'd — src/__tests__ is
# excluded — kept in the grep for completeness). A hit on any of them is a
# failure of this gate.
hits="$(grep -E 'issue-execution-policy\.|execution-workspaces\.|issue-patch-stage-decision-ban\.' "$out")"
if [ -n "$hits" ]; then
  echo "FAIL: SPA-13888 files introduce type errors:" >&2
  printf '%s\n' "$hits" >&2
  rm -f "$out"
  exit 1
fi
echo "PASS: no type errors in SPA-13888 files (tsc reported pre-existing errors elsewhere only)"
rm -f "$out"
exit 0
