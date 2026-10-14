#!/usr/bin/env bash
# SPA-12214 G1/G2 — 409 refusal carries per-blocker reason.
# Runs the extended blocker diagnostics route suite: the 5 pre-existing
# diagnostics tests plus the 2 new 409-reason tests (pending_finalize for a
# done blocker awaiting workspace finalize, not_done for a cancelled
# blocker). Runnable from a clean checkout: needs nothing untracked, only
# the repo's own node_modules.
set -euo pipefail
cd "$(dirname "$0")/../../server"
exec ../node_modules/.bin/vitest run --config vitest.config.ts \
  src/__tests__/issue-blocker-diagnostics-routes.test.ts
