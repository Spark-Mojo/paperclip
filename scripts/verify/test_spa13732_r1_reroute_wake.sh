#!/usr/bin/env bash
# SPA-13732 R1: stage-decision reroute to changes_requested must enqueue
# exactly one builder wake. Static contract check over the route file:
# runnable from a clean checkout, no fixtures, no .unlazy deps.
set -euo pipefail
FILE="server/src/routes/issues.ts"
fail() { echo "FAIL: $1" >&2; exit 1; }

# Extract the stage-decision route block by line bounds: from its route-path
# line to the first closing `  );` after it.
START="$(grep -n '"/issues/:id/stage-decision"' "$FILE" | head -1 | cut -d: -f1)"
[ -n "$START" ] || fail "stage-decision route not found in $FILE"
END="$(awk -v s="$START" 'NR>s && /^  \);$/{print NR; exit}' "$FILE")"
[ -n "$END" ] || fail "stage-decision route close not found in $FILE"
BLOCK="$(sed -n "${START},${END}p" "$FILE")"

echo "$BLOCK" | grep -q "execution_changes_requested" \
  || fail "no execution_changes_requested wake in stage-decision route"
echo "$BLOCK" | grep -q "heartbeat.wakeup" \
  || fail "no heartbeat.wakeup call in stage-decision route"
echo "$BLOCK" | grep -Eq "if \(!result\.duplicate\b" \
  || fail "wake not gated on non-duplicate"
echo "$BLOCK" | grep "idempotencyKey:" | grep -q '\${[^}]*result\.decision\.id[^}]*}' \
  || fail "idempotencyKey not interpolated with decisionId"

# Exactly-one: a single heartbeat.wakeup call site in the block, keyed per
# decisionId (one key per reroute => exactly one run per reroute).
CALLS="$(echo "$BLOCK" | grep -c "heartbeat\.wakeup(" || true)"
[ "$CALLS" -eq 1 ] || fail "expected exactly 1 heartbeat.wakeup call, found $CALLS"
echo "$BLOCK" | grep -q 'stage-decision-changes-requested:' \
  || fail "idempotencyKey not per-decisionId"

# Verdict path untouched: no approved-outcome wake in the block.
echo "$BLOCK" | grep -q '"approved"' \
  && fail "verdict (approve) path touched by stage-decision wake" || true

echo "PASS: stage-decision reroute enqueues exactly one execution_changes_requested wake (per-decisionId idempotency)"
