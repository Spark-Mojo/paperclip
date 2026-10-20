#!/usr/bin/env bash
# SPA-13732 R2-engine: blocked-asking park never lands on backlog, including
# the 422 path. Static contract check: runnable from a clean checkout, no
# fixtures, no .unlazy deps.
set -euo pipefail
fail() { echo "FAIL: $1" >&2; exit 1; }

ISSUES="server/src/routes/issues.ts"
TEST="server/src/__tests__/issue-stage-decision-routes.test.ts"
WAKE="server/src/services/issue-assignment-wakeup.ts"

# 1. Both blocked-entry 422 arms exist in the entering-blocked region:
# baseBlockedRefusal present AND at least two res.status(422) returns
# between `const enteringBlocked =` and the reviewRequest guard below it.
grep -q "baseBlockedRefusal" "$ISSUES" \
  || fail "check1: blocked-entry 422 validation (baseBlockedRefusal) missing in $ISSUES"
REGION="$(awk '/const enteringBlocked =/{f=1} f{print} /reviewRequest !== undefined/{if(f) exit}' "$ISSUES")"
COUNT422="$(printf '%s\n' "$REGION" | grep -c "res.status(422)" || true)"
[ "$COUNT422" -ge 2 ] \
  || fail "check1: expected >=2 res.status(422) arms in enteringBlocked region, found $COUNT422"

# 2a. No direct backlog mutation: updateFields.status is never assigned
# the string backlog (covers the direct-mutation syntax Mira thread 2 named).
HITS="$(grep -nE 'updateFields\.status\s*=\s*["'\'']backlog' "$ISSUES" || true)"
[ -z "$HITS" ] \
  || fail "check2a: direct backlog mutation in $ISSUES: $HITS"

# 2b. No other backlog write in the route file: every `status: "backlog"`
# (either quote style) line must be a comparison/read, never an assignment.
CANDIDATES="$(grep -nE 'status:\s*['\''"]backlog['\''"]' "$ISSUES" || true)"
WRITES="$(printf '%s\n' "$CANDIDATES" | grep -vE '!==|===|statusChangedFromBacklog' || true)"
[ -z "$WRITES" ] \
  || fail "check2b: status backlog write found in $ISSUES: $WRITES"

# 3. Behavioral R2 rehearsal test exists: name carries 422 + backlog,
# body asserts .toBe(422) at least twice, and reads the issue back
# asserting the status is never backlog.
grep -E 'it\(.*422.*backlog|it\(.*backlog.*422' "$TEST" | grep -q . \
  || fail "check3: rehearsal test name containing 422 + backlog missing in $TEST"
ASSERTS="$(grep -c "toBe(422)" "$TEST" || true)"
[ "$ASSERTS" -ge 2 ] \
  || fail "check3: expected >=2 .toBe(422) assertions in $TEST, found $ASSERTS"
grep -q 'not.toBe("backlog")' "$TEST" \
  || fail "check3: rehearsal never-backlog readback assertion missing in $TEST"

# 4. Backlog wake skip intact (backlog cards never wake).
grep -q 'input.issue.status === "backlog") return' "$WAKE" \
  || fail "check4: backlog wake skip missing in $WAKE"

echo "PASS: r2 park guard — (1) both 422 arms ($COUNT422) with baseBlockedRefusal; (2) no backlog write in PATCH lane; (3) R2 rehearsal test with $ASSERTS x 422 + never-backlog readback; (4) backlog wake skip intact"
