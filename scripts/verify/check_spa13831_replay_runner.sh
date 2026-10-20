#!/bin/sh
# SPA-13831: fail-closed verification for .github/workflows/spa-replay-runner.yml
# Reads only the worktree file; no external fixtures. Pure grep, runnable everywhere.
F=".github/workflows/spa-replay-runner.yml"
FAIL=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }
if [ ! -f "$F" ]; then
  echo "FAIL: file exists ($F missing)"
  echo "CHECK-SPA13831: FAIL"
  exit 1
else
  pass "file exists"
fi
TMP="$(mktemp)" || { echo "FAIL: mktemp"; echo "CHECK-SPA13831: FAIL"; exit 1; }
trap 'rm -f "$TMP"' EXIT INT TERM
sed 's/#.*//' "$F" > "$TMP"
if grep -E -q '^[[:space:]]*"?pull_request"?:' "$TMP" && grep -q 'rebuild/v2026.916.0-survivors' "$TMP"; then pass "pull_request trigger on rebuild/v2026.916.0-survivors"; else fail "pull_request trigger on rebuild/v2026.916.0-survivors"; fi
if grep -E -q '^[[:space:]]*"?workflow_dispatch"?:' "$TMP"; then pass "workflow_dispatch trigger"; else fail "workflow_dispatch trigger"; fi
if grep -E -q '^[[:space:]]*"?push"?:' "$TMP" || grep -w -q 'master' "$TMP"; then fail "no push/master reference"; else pass "no push/master reference"; fi
if grep -qF 'src/services/stall-stop-surface.test.ts' "$TMP"; then pass "suite stall-stop-surface.test.ts"; else fail "suite stall-stop-surface.test.ts"; fi
if grep -q 'heartbeat-stall-stop-surface\.test\.ts' "$TMP"; then pass "suite heartbeat-stall-stop-surface.test.ts"; else fail "suite heartbeat-stall-stop-surface.test.ts"; fi
if grep -q 'heartbeat-stall-stop-surface-r45\.test\.ts' "$TMP"; then pass "suite heartbeat-stall-stop-surface-r45.test.ts"; else fail "suite heartbeat-stall-stop-surface-r45.test.ts"; fi
if grep -q 'persist-credentials: false' "$TMP"; then pass "persist-credentials false"; else fail "persist-credentials false"; fi
if grep -q 'secrets\.[A-Za-z_]' "$TMP"; then fail "no secrets reference"; else pass "no secrets reference"; fi
if [ "$FAIL" -eq 0 ]; then echo "CHECK-SPA13831: PASS"; else echo "CHECK-SPA13831: FAIL"; fi
exit "$FAIL"
