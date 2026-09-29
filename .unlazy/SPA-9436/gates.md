# SPA-9436 gates

- Cross-card resolved interaction builds a wake from the target card's history without importing source-card work.
  CHECK: timeout 180 pnpm exec vitest run server/src/services/execution-continuation.test.ts
  EXPECT: Test Files  1 passed
  NEGATIVE: timeout 180 pnpm exec vitest run server/src/services/execution-continuation.test.ts (before implementation, four relevant assertions failed, exit 1: continuation_source_context_missing, missing origin). Same suite rejects bad input before fix.
  RESULT: exit 0, EXPECT matched; 16 tests passed (23:08Z), including cross-card and explicit authorization overlap. NEGATIVE exit 1 observed at 20:37Z.
- Missing source run and missing origin context degrade without failing setup; explicit user continuation remains authorization-gated.
  CHECK: timeout 180 pnpm exec vitest run server/src/services/execution-continuation.test.ts server/src/services/explicit-native-continuation.test.ts
  EXPECT: Test Files  2 passed
  NEGATIVE: timeout 180 pnpm exec vitest run server/src/services/execution-continuation.test.ts (pre-fix fixture, exit 1 with continuation_source_context_missing in cross-card and missing-source assertions).
  RESULT: exit 1, EXPECT not matched; 1 passed/1 failed, 30 explicit-native wake-scheduling failures. Baseline not established: clean base checkout lacks vitest installation. Gate unproven; explicit authorization assertions in the focused file pass, including same-id overlap.
- Server code remains type-safe.
  CHECK: timeout 300 pnpm --filter @paperclipai/server typecheck
  EXPECT: exit 0
  NEGATIVE: timeout 300 pnpm --filter @paperclipai/server typecheck (cargo absent; exit 1 in runner-vendor prerequisite, not a code-rejection control).
  RESULT: exit 1, EXPECT not matched; cargo absent in runner-vendor prerequisite. Gate unproven. `timeout 180 pnpm --filter @paperclipai/plugin-sdk ensure-build-deps && timeout 180 pnpm --filter @paperclipai/server exec tsc --noEmit` exited 0 (23:08Z).
