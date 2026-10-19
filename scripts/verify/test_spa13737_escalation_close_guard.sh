#!/usr/bin/env bash
# SPA-13737 G2 — escalation close-guard positive gate.
# Runs the new guard test file from the server dir; exit 0 on pass.
set -euo pipefail
cd "$(dirname "$0")/../../server"
exec ../node_modules/.bin/vitest run --config vitest.config.ts \
  src/__tests__/issue-escalation-close-guard.test.ts
