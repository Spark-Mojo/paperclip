#!/usr/bin/env bash
# SPA-13732 R1: stage-decision wake is enqueued atomically inside decide().
# Static contract check: runnable from a clean checkout, no fixtures.
set -euo pipefail
SVC="server/src/services/issue-stage-decisions.ts"
SCHEMA="packages/db/src/schema/agent_wakeup_requests.ts"
ROUTE="server/src/routes/issues.ts"
fail() { echo "FAIL: $1" >&2; exit 1; }

grep -q "tx.insert" "$SVC" \
  || fail "no tx.insert in $SVC (wake not in transaction)"
grep -q "agentWakeupRequests" "$SVC" \
  || fail "no agentWakeupRequests reference in $SVC"
grep -q "stage-decision-changes-requested:" "$SVC" \
  || fail "no stage-decision-changes-requested: idempotencyKey in $SVC"

grep -q "stageDecisionRerouteIdempotencyUq" "$SCHEMA" \
  || fail "no stageDecisionRerouteIdempotencyUq in $SCHEMA"
grep -q "LIKE 'stage-decision-changes-requested:%'" "$SCHEMA" \
  || fail "reroute unique index missing stage-decision-changes-requested:% prefix in $SCHEMA"

if grep -q "stage-decision-changes-requested" "$ROUTE"; then
  fail "route $ROUTE must NOT call heartbeat.wakeup with stage-decision-changes-requested key (tx insert in decide() is single source)"
fi

echo "PASS: stage-decision wake is atomic in decide() with per-decisionId idempotency (service + schema agree, route is not a wake source)"
