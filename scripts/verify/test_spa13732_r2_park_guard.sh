#!/usr/bin/env bash
# SPA-13732 R2-engine: blocked-asking park never lands on backlog, including
# the 422 path. Static contract check: runnable from a clean checkout, no
# fixtures, no .unlazy deps.
set -euo pipefail
fail() { echo "FAIL: $1" >&2; exit 1; }

# 1. Both 422 branches in the entering-blocked validation return without
#    mutating status: the 422 responses sit inside `if (enteringBlocked)`
#    before any status write, and neither 422 arm assigns backlog.
grep -n "baseBlockedRefusal" server/src/routes/issues.ts | grep -q . \
  || fail "blocked-entry 422 validation (baseBlockedRefusal) missing"
awk '/if \(enteringBlocked\)/,0' server/src/routes/issues.ts \
  | grep -A3 "status(422)" | grep -qi "backlog" \
  && fail "backlog write adjacent to blocked 422 return" || true

# 2. The PATCH lane never writes status backlog: no `status: "backlog"` /
#    `status:"backlog"` assignment anywhere in the route file (the only
#    backlog statuses are reads/comparisons; the sole backlog writer lives
#    in heartbeat.ts rewake breaker, out of scope).
if grep -nE 'status:\s*"backlog"' server/src/routes/issues.ts | grep -qv "!=="; then
  CANDIDATES="$(grep -nE 'status:\s*"backlog"' server/src/routes/issues.ts || true)"
  echo "$CANDIDATES" | grep -qE '!==|===|statusChangedFromBacklog' \
    || fail "status backlog write found in issues.ts PATCH lane: $CANDIDATES"
fi
grep -nE "status:\s*['\"]backlog['\"]" server/src/routes/issues.ts \
  | grep -vE "(!==|===|backlog.*&&|&&.*backlog)" \
  && fail "status backlog write in issues.ts" || true

# 3. Assignment-wakeup backlog skip is intact (backlog cards never wake).
grep -q 'input.issue.status === "backlog") return' \
  server/src/services/issue-assignment-wakeup.ts \
  || fail "backlog wake skip missing in issue-assignment-wakeup.ts"

echo "PASS: blocked 422 returns without backlog fallback; no backlog park write in PATCH lane; backlog wake skip intact"
