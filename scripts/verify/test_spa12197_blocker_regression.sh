#!/usr/bin/env bash
# SPA-12197 G3 — blocker-area regression gate.
# Runs the two suites that own the surfaces this fix touches: the
# cancelled-blocker auto-drop (SPA-11863, the forward-looking drop this repair
# complements) and the blocker diagnostics routes (the flags/readiness surface
# the guard reads).
set -euo pipefail
cd "$(dirname "$0")/../../server"
exec ../node_modules/.bin/vitest run --config vitest.config.ts \
  src/__tests__/issue-cancelled-blocker-auto-drop.test.ts \
  src/__tests__/issue-blocker-diagnostics-routes.test.ts
