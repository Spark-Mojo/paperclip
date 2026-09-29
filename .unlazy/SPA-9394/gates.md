# SPA-9394 gates

## Behavior contract

Dex's workspace attachment is now realized: live executionWorkspaceId 38beb907-67b5-41d0-a9dd-5bf985224d4c, cwd and branch match the assigned tree. No earlier implementation exists.

Protect every entry other than the ownership marker, without Git/extension heuristics or recursive scans. This covers standalone deliverables, nested worktrees, clean/pushed repositories, links and empty directories. Marker-only scratch remains disposable. Enumeration errors fail closed as content_check_failed. Ownership and live-process guards retain precedence. Existing heartbeat lifecycle event emits warn with reason and retained directory; recovery guidance is included in the cleanup result payload.

Retention: no automatic age-based reaper for protected data. Ty/operator must recover content into a durable workspace, remove the recovered scratch entries, then retry ownership-checked cleanup after writers stop. Retained scratch remains on tmp storage and can be evicted by the OS; this is not durable backup. Conservative retention may accumulate caches; manual evacuation is deliberate rather than guessing what is disposable.

Read SPA-9011 live (backlog): R2 concerns registered execution-workspace cleanup; this change only protects unregistered run scratch and does not settle or supersede its R1/R2 decisions. PR #119's releaseRunExecutionWorkspace remains disjoint from scratch cleanup at survivor base 1751e28631.

## Gates

1. Content survives cleanup, errors retain, marker-only cleanup and ownership/process guards remain correct.
   CHECK: timeout 120 pnpm exec vitest run server/src/services/run-scratch.test.ts
   EXPECT: Test Files  1 passed
   RESULT: exit 0, EXPECT matched: Test Files  1 passed (1); Tests 14 passed (14). Red-first receipt: 7 failed / 6 passed before implementation. Added late-write protection test; marker-only deletion now uses unlink + nonrecursive rmdir, restoring marker exclusively on failure.

2. Server typecheck introduces no errors.
   CHECK: timeout 900 pnpm --filter @paperclipai/server typecheck
   EXPECT: exit 0
   RESULT: exit 1, EXPECT not matched: unchanged runner build prerequisite fails `sh: 1: cargo: not found`. Standard command remains blocked by environment. Supplemental CHECK: timeout 600 pnpm --filter @paperclipai/plugin-sdk ensure-build-deps && timeout 180 pnpm --filter @paperclipai/server exec tsc --noEmit. Supplemental RESULT: exit 0; no diagnostics. No typecheck gate weakened.

3. Diff is whitespace-clean.
   CHECK: timeout 30 git diff --check
   EXPECT: exit 0
   RESULT: exit 0, EXPECT matched (empty output).

No lint script exists in root or server package.json; do not invent one.
