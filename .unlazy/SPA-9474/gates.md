# SPA-9474 gates

- Relative PR route with same-comment repository identity refuses open PR and yields Spark-Mojo/sparkmojo-internal#936; GitHub issue and unrelated bare number do not bind; unresolved route cannot silently close.
  CHECK: timeout 900 pnpm exec vitest run server/src/__tests__/issue-done-pr-merged-gate.test.ts
  EXPECT: Test Files  1 passed
  NEGATIVE: timeout 900 pnpm exec vitest run server/src/__tests__/issue-done-pr-merged-gate.test.ts (pre-implementation fixture, 2026-09-30 08:19 UTC); exit 1, 2 failed / 23 passed; SPA-9288-shaped test received { outcome: 'allow' } instead of 'refuse'; unresolved-route test likewise received allow. Post-implementation exit 0, 26 passed; parser suite combined exit 0, 43 passed (2026-09-30 08:28 UTC).
- Parser and gate compile.
  CHECK: timeout 900 pnpm --filter @paperclipai/server typecheck
  EXPECT: exit 0
  NEGATIVE: unavailable safe same-assertion fixture; gate remains UNPROVEN. Observed typecheck exit 1: cargo not found during runner build. After `timeout 900 pnpm --filter @paperclipai/plugin-sdk ensure-build-deps`, `timeout 900 pnpm exec tsc -p server/tsconfig.json --noEmit` exits 0. Full server typecheck wrapper still exits 1 at cargo not found.
