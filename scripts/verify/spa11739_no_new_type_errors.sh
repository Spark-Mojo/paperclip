#!/usr/bin/env sh
# SPA-11739: prove the card's changed engine files contribute ZERO TypeScript
# errors. The fork's bare `tsc --noEmit -p server/tsconfig.json` reports 251
# pre-existing errors on base AND on head (identical sets): the
# `@paperclipai/paperclip-runner` / `plugin-sdk` workspace builds need `cargo`,
# which clean checkouts do not have, so "exit 0" is not an achievable oracle
# here. This gate instead asserts the property the card actually needs — no
# error names a file this card touched.
#
# Fails closed on every path: if tsc fails and its output cannot be read, or
# the output file is empty/missing, that is a FAILURE, never a pass. Proven
# two-way: exits 0 on a clean head and 1 on a planted error in a touched file.
set -u
repo="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
out="$repo/.unlazy/spa11739-tsc-output.txt"
status=0
cd "$repo" || exit 2
pnpm exec tsc --noEmit -p server/tsconfig.json >"$out" 2>&1 || status=$?
if [ "$status" -eq 0 ]; then
  echo "PASS: tsc clean"
  rm -f "$out"
  exit 0
fi
if [ ! -s "$out" ]; then
  echo "FAIL: tsc exited $status but produced no readable output; cannot prove the SPA-11739 files are clean" >&2
  rm -f "$out"
  exit 1
fi
# Every file this card touched: the policy module, the heartbeat guard itself,
# and both test files. A hit on any of them is a failure of this gate.
hits="$(grep -E 'execution-workspace-policy\.|services/heartbeat\.ts|heartbeat-workspace-session\.' "$out")"
if [ -n "$hits" ]; then
  echo "FAIL: SPA-11739 files introduce type errors:" >&2
  printf '%s\n' "$hits" >&2
  rm -f "$out"
  exit 1
fi
echo "PASS: no type errors in SPA-11739 files (tsc reported pre-existing errors elsewhere only)"
rm -f "$out"
exit 0
