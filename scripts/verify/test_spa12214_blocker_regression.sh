#!/usr/bin/env bash
# SPA-12214 G3 — blocker-area regression gate.
# The fix touches the 409 site in routes/issues.ts only; the two suites that
# own the adjacent surfaces (cancelled-blocker auto-drop, blocker
# diagnostics) must stay green.
set -euo pipefail
cd "$(dirname "$0")/../../server"
exec ../node_modules/.bin/vitest run --config vitest.config.ts \
  src/__tests__/issue-cancelled-blocker-auto-drop.test.ts \
  src/__tests__/issue-blocker-diagnostics-routes.test.ts
