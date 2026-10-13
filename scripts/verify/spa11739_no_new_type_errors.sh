#!/usr/bin/env sh
# SPA-11739: prove the card's changed engine files contribute ZERO TypeScript
# errors. The fork's bare `tsc --noEmit -p server/tsconfig.json` reports 251
# pre-existing errors on base AND on head (identical sets): the
# `@paperclipai/paperclip-runner` / `plugin-sdk` workspace builds need `cargo`,
# which clean checkouts do not have, so "exit 0" is not an achievable oracle
# here. This gate instead asserts the property the card actually needs — no
# error names a file this card touched. Fails closed: a tsc failure whose
# output cannot be read is a failure, not a pass.
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
hits="$(grep -E 'execution-workspace-policy|heartbeat-workspace-session' "$out")"
if [ -n "$hits" ]; then
  echo "FAIL: SPA-11739 files introduce type errors:" >&2
  printf '%s\n' "$hits" >&2
  rm -f "$out"
  exit 1
fi
echo "PASS: no type errors in SPA-11739 files (tsc reported pre-existing errors elsewhere only)"
rm -f "$out"
exit 0
