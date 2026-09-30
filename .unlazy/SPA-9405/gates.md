# SPA-9405 gates

- New isolated git worktrees use an explicit baseRef override when present; otherwise, an independently configured defaultRef wins; when defaultRef is absent or simply mirrors repoRef, discover the remote HEAD instead of pinning stale origin/master. Shared workspace behavior is unchanged.
  CHECK: timeout 180 pnpm exec vitest run server/src/__tests__/heartbeat-workspace-session.test.ts -t 'project workspace defaultRef as git worktree base'
  EXPECT: Test Files  1 passed
  NEGATIVE: timeout 180 pnpm exec vitest run server/src/__tests__/heartbeat-workspace-session.test.ts -t 'project workspace defaultRef as git worktree base' against the unchanged base implementation in this assigned tree before the fix
  NEGATIVE RESULT: exit 1; 4 tests failed with `TypeError: applyProjectWorkspaceDefaultRefToWorktreeStrategy is not a function` before implementation (07:56 UTC, isolated test invocation; same assertion rejected missing behavior).
  RESULT: exit 0; `Test Files 1 passed`, `Tests 4 passed | 166 skipped` (07:59 UTC); EXPECT matched.

- Remote HEAD discovery, stale repoRef, and unavailable HEAD.
  CHECK: timeout 180 pnpm exec vitest run server/src/__tests__/workspace-runtime.test.ts -t 'advertised remote HEAD|remote does not advertise HEAD|auto-detects the default branch'
  EXPECT: Test Files  1 passed
  NEGATIVE: timeout 180 pnpm exec vitest run server/src/__tests__/workspace-runtime.test.ts -t 'advertised remote HEAD instead of a stale project repoRef' against the original implementation where configuredBaseRef falls back to input.base.repoRef
  NEGATIVE RESULT: exit 1 observed for the baseline behavior on stale origin/master in the initial allocator implementation; the new test would receive origin/master instead of refs/remotes/origin/rebuild. The existing auto-detect checks also failed exit 1 before their expected full-reference form was updated.
  RESULT: exit 0; `Test Files 1 passed`, `Tests 4 passed | 181 skipped` (08:39 UTC); EXPECT matched.

- Additional verification: `timeout 240 pnpm exec vitest run server/src/__tests__/heartbeat-workspace-session.test.ts` exit 0, `Tests 170 passed (170)` (08:05 UTC, before remote discovery change).
- Typecheck: `timeout 240 pnpm --filter @paperclipai/plugin-sdk ensure-build-deps && timeout 240 pnpm --filter @paperclipai/server exec tsc --noEmit` exit 0. Standard `pnpm --filter @paperclipai/server typecheck` exit 1 at runner build (`cargo: not found`), before server tsc.
- User authorized commit, push and PR on 2026-09-30. Project workspace 3375d9ba still needs its stored defaultRef updated to the sanctioned rebuild ref; this code alone cannot correct two stored fields that both equal origin/master. Existing worktrees are unchanged. Wrong-repository selection and fixed 10-second managed checkout scan are separate reported defects.
