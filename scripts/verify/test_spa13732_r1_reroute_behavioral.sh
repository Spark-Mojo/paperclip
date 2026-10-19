#!/usr/bin/env bash
# SPA-13732 R1 behavioral: request_changes reroute enqueues exactly one
# execution_changes_requested builder wake; duplicate replay never re-wakes.
# Runs the route-level suite and requires BOTH the new R1 test and the R2
# rehearsal test to pass. Runnable from a clean checkout (repo with deps
# installed); single-purpose — g17 covers the static contract.
set -euo pipefail
cd "$(dirname "$0")/../../server"

OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT
timeout 600 pnpm vitest run src/__tests__/issue-stage-decision-routes.test.ts --reporter=verbose >"$OUT" 2>&1
RC=$?
cat "$OUT"
[ "$RC" -eq 0 ] || { echo "FAIL: vitest exited $RC" >&2; exit 1; }
grep -q "R1 reroute: request_changes enqueues exactly one execution_changes_requested builder wake" "$OUT" \
  || { echo "FAIL: R1 reroute behavioral test missing/not passing" >&2; exit 1; }
grep -q "forced-422 blocked entry on both branches leaves the prior wakeable status byte-equal and never backlog" "$OUT" \
  || { echo "FAIL: R2 rehearsal test missing/not passing" >&2; exit 1; }
echo "PASS: R1 reroute behavioral wake + R2 rehearsal green"
