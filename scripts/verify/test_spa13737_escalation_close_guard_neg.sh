#!/usr/bin/env bash
# SPA-13737 N4 — escalation close-guard fail-closed negative control.
# Genuine failing-input control: runs the guard test file with a vitest -t
# filter matching ONLY the refuse tests, so a pass proves bad input
# (escalation close with no receipt) is rejected with the 409 refusal code.
set -euo pipefail
cd "$(dirname "$0")/../../server"
../node_modules/.bin/vitest run --config vitest.config.ts \
  src/__tests__/issue-escalation-close-guard.test.ts \
  -t "refuses" 2>&1 | tee /tmp/spa13737-neg-out.txt
# Primary: the -t filter matched ONLY the refuse tests and they passed —
# a green run here proves bad input (escalation close, no receipt) is
# rejected. (Passing tests never echo the 409 code, so assert the count.)
{ grep -qE "Tests +[0-9]+ passed" /tmp/spa13737-neg-out.txt && ! grep -qE "failed" /tmp/spa13737-neg-out.txt && ! grep -qE "No test found|Tests +0[ :]" /tmp/spa13737-neg-out.txt; } || {
  echo "NEG-FAIL: refuse-filter run did not pass its refuse tests (or matched none)" >&2
  exit 1
}
# Pinned fail-closed check: grep within the issueHasEscalationActionReceipt
# function body only, not file-wide (a stray "return false" elsewhere would
# fake a green).
awk '/function issueHasEscalationActionReceipt/,/^}/' src/services/issue-done-gate.ts | grep -q "limit(1)" && awk '/function issueHasEscalationActionReceipt/,/^}/' src/services/issue-done-gate.ts | grep -qE "rows\.length > 0|length === 0" || {
  echo "NEG-FAIL: fail-closed shape (limit(1) + empty-means-false) absent from issueHasEscalationActionReceipt" >&2
  exit 1
}
echo "NEG-PASS: refuse tests reject bad input; fail-closed default present"
