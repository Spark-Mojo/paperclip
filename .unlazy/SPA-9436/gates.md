# SPA-9436 gates

- Resolved cross-card interaction reaches adapter with target issue history and accepted outcome, not creator work.
  CHECK: timeout 180 pnpm exec vitest run server/src/__tests__/heartbeat-comment-wake-batching.test.ts -t 'dispatches a resolved cross-card interaction'
  EXPECT: Test Files  1 passed
  NEGATIVE: timeout 180 pnpm exec vitest run server/src/services/execution-continuation.test.ts -t 'does not relax a missing target wake origin for a foreign interaction' (isolated invalid target commentId; assertion requires rejection).
  RESULT: exit 0, EXPECT matched, 1 passed at 2026-09-30 00:59Z; embedded Postgres + controlled gateway dispatch succeeded and no foreign-card summary reached adapter. Resolved-interaction producer `server/src/routes/issues.ts:2715-2767` emits interaction.sourceCommentId as sourceCommentId, never as context.commentId; interaction creation `server/src/services/issue-thread-interactions.ts:3398-3415` rejects sourceCommentId from another card. `context.commentId` is a separate target-wake origin and must remain fail-closed. Pre-fix negative exit 1 observed at 20:37Z; isolated invalid target origin rejected by test in gate 2.

- Cross-card resolved interaction builds a wake from the target card's history without importing source-card work.
  CHECK: timeout 180 pnpm exec vitest run server/src/services/execution-continuation.test.ts
  EXPECT: Test Files  1 passed
  NEGATIVE: timeout 180 pnpm exec vitest run server/src/services/execution-continuation.test.ts -t 'fails closed when required originating context is missing' (isolated invalid target commentId; assertion requires rejection).
  RESULT: exit 0, EXPECT matched; 22 tests passed at 00:59Z, including foreign-interaction target-origin rejection, absent-interaction-source origin rejection, and coalesced foreign auxiliary rejection. NEGATIVE pre-fix exit 1 observed at 20:37Z.
- Missing source run and foreign interaction origins degrade without failing setup; missing target wake origins and explicit user continuation remain fail-closed.
  CHECK: PAPERCLIP_IN_WORKTREE=false timeout 180 pnpm exec vitest run server/src/services/execution-continuation.test.ts server/src/services/explicit-native-continuation.test.ts
  EXPECT: Test Files  2 passed
  NEGATIVE: timeout 180 pnpm exec vitest run server/src/services/execution-continuation.test.ts -t 'does not treat a cross-card interaction source as explicit user authorization' (isolated unauthorized foreign run; assertion requires rejection).
  RESULT: exit 0, EXPECT matched, 142 passed at 2026-09-30 00:59Z; target-origin and coalesced auxiliary negative tests passed. NEGATIVE pre-fix exit 1 observed at 20:37Z. Prior 30 failures under PAPERCLIP_IN_WORKTREE=true were due to heartbeat.scheduling_suppressed/worktree_instance (receipt observed); not code failures. At 2026-09-29 23:33Z baseline cddf88b979 (own clean worktree, pnpm install --frozen-lockfile, Node v24.20.0/pnpm 9.15.4): `timeout 180 pnpm exec vitest run server/src/services/explicit-native-continuation.test.ts server/src/services/execution-control-reconciliation.test.ts` exit 0, 122 passed. On merged head with PAPERCLIP_IN_WORKTREE=false, same explicit-native+reconciliation+focused suite exit 0, 140 passed at 23:48Z. Preflight missing-history test proves hold remains resolved/blocked; strict explicit authorization rejects foreign source.
- Server code remains type-safe.
  CHECK: timeout 300 pnpm --filter @paperclipai/server typecheck
  EXPECT: exit 0
  NEGATIVE: timeout 300 pnpm --filter @paperclipai/server typecheck (cargo absent; exit 1 in runner-vendor prerequisite, not a code-rejection control).
  RESULT: exit 1 at 00:45Z, EXPECT not matched; cargo absent in runner-vendor prerequisite. Gate unproven locally. `timeout 180 pnpm --filter @paperclipai/plugin-sdk ensure-build-deps && timeout 180 pnpm --filter @paperclipai/server exec tsc --noEmit` exit 0 at 00:45Z. GitHub run 36652985609 job 109691541841 `ci / Typecheck + Release Registry`: status completed, conclusion success, head_sha 3e041151c8c9c6c7b224d4915448ad382ab52e5a (read live 2026-09-30); this certifies that head's CI, not a later ledger commit. NEGATIVE cargo absence is environmental, not a positive bad-code control; gate unproven locally. Recheck CI on any new PR head.
