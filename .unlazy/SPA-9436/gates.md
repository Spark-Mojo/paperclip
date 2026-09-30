# SPA-9436 gates

- Resolved cross-card interaction reaches adapter with target issue history and accepted outcome, not creator work.
  CHECK: timeout 180 pnpm exec vitest run server/src/__tests__/heartbeat-comment-wake-batching.test.ts -t 'dispatches a resolved cross-card interaction'
  EXPECT: Test Files  1 passed
  NEGATIVE: timeout 180 pnpm exec vitest run server/src/services/execution-continuation.test.ts (pre-fix cross-card fixture exited 1 on continuation_source_context_missing at 20:37Z).
  RESULT: exit 0, EXPECT matched, 1 passed at 2026-09-30 00:00Z; embedded Postgres + controlled gateway dispatch succeeded and no foreign-card summary reached adapter.

- Cross-card resolved interaction builds a wake from the target card's history without importing source-card work.
  CHECK: timeout 180 pnpm exec vitest run server/src/services/execution-continuation.test.ts
  EXPECT: Test Files  1 passed
  NEGATIVE: timeout 180 pnpm exec vitest run server/src/services/execution-continuation.test.ts (before implementation, four relevant assertions failed, exit 1: continuation_source_context_missing, missing origin). Same suite rejects bad input before fix.
  RESULT: exit 0, EXPECT matched; 16 tests passed (23:08Z), including cross-card and explicit authorization overlap. NEGATIVE exit 1 observed at 20:37Z.
- Missing source run and missing origin context degrade without failing setup; explicit user continuation remains authorization-gated.
  CHECK: PAPERCLIP_IN_WORKTREE=false timeout 180 pnpm exec vitest run server/src/services/execution-continuation.test.ts server/src/services/explicit-native-continuation.test.ts
  EXPECT: Test Files  2 passed
  NEGATIVE: timeout 180 pnpm exec vitest run server/src/services/execution-continuation.test.ts (pre-fix fixture, exit 1 with continuation_source_context_missing in cross-card and missing-source assertions).
  RESULT: exit 0, EXPECT matched: 138 passed at 2026-09-30 00:05Z. Prior 30 failures under PAPERCLIP_IN_WORKTREE=true were due to heartbeat.scheduling_suppressed/worktree_instance (receipt observed); not code failures. At 2026-09-29 23:33Z baseline cddf88b979 (own clean worktree, pnpm install --frozen-lockfile, Node v24.20.0/pnpm 9.15.4): `timeout 180 pnpm exec vitest run server/src/services/explicit-native-continuation.test.ts server/src/services/execution-control-reconciliation.test.ts` exit 0, 122 passed. On merged head with PAPERCLIP_IN_WORKTREE=false, same explicit-native+reconciliation+focused suite exit 0, 140 passed at 23:48Z. Preflight missing-history test proves hold remains resolved/blocked; strict explicit authorization rejects foreign source.
- Server code remains type-safe.
  CHECK: timeout 300 pnpm --filter @paperclipai/server typecheck
  EXPECT: exit 0
  NEGATIVE: timeout 300 pnpm --filter @paperclipai/server typecheck (cargo absent; exit 1 in runner-vendor prerequisite, not a code-rejection control).
  RESULT: exit 1, EXPECT not matched; cargo absent in runner-vendor prerequisite. Gate unproven locally. `timeout 180 pnpm --filter @paperclipai/plugin-sdk ensure-build-deps && timeout 180 pnpm --filter @paperclipai/server exec tsc --noEmit` exited 0 (23:08Z). GitHub Typecheck + Release Registry green on previous PR head per manager comment; re-check final head CI.
