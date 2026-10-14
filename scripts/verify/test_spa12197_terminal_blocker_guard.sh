#!/usr/bin/env bash
# SPA-12197 G1/G2 — terminal-blocker guard relaxation suite.
# Runs the new route-level suite that pins the repair (request-driven guard
# relaxation for terminal-only blocker removals) and its three integrity
# invariants (open blocker still blocks, blocker-free path unchanged,
# omitted-blockedByIssueIds unchanged).
#
# Runnable from a clean checkout: needs nothing untracked, only the repo's own
# node_modules (pnpm install --frozen-lockfile --ignore-scripts is the
# sanctioned local setup for a fleet worktree). The vitest config's include
# paths are relative to server/, so the suite runs from there.
set -euo pipefail
cd "$(dirname "$0")/../../server"
exec ../node_modules/.bin/vitest run --config vitest.config.ts \
  src/__tests__/issue-blocker-guard-terminal-relaxation.test.ts
