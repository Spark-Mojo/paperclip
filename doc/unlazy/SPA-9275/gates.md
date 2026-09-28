# SPA-9275 — Gates

## Gate 1 — Worktree naming for ephemeral lifecycle
- OBSERVABLE: `realizeExecutionWorkspace` with `strategy.lifecycle === "ephemeral"` creates the worktree under `${worktreeParentDir}/runs/<runId>/` (NOT `${worktreeParentDir}/<branch>/`), and the branch is still created/attached off baseRef.
- CHECK: `pnpm --filter @paperclipai/server exec vitest run server/src/__tests__/workspace-runtime.test.ts -t "ephemeral lifecycle names the worktree by run id"`
- EXPECT: a test that asserts `realized.worktreePath` ends with `/runs/<runId>/` and that `git worktree list` shows the branch checked out there, while `realized.branchName` still matches the template-rendered branch.
- EXIT: 0; `PASS` line printed.

## Gate 2 — Push-then-remove at run release
- OBSERVABLE: new exported helper `releaseRunExecutionWorkspace({ repoRoot, worktreePath, branchName, runId, resolveGitAuth, recorder })` first attempts `git push origin <branch>` (via existing GitRemoteAuthProvider), then `git worktree remove --force`, then `git worktree prune`, then `fs.rm` if the directory still exists. On a stale git lock it retries `git worktree remove --force` once after a 200ms backoff and re-checks `directoryExists`. Failures are returned as `{ pushed, removed, errors }` and recorded via the WorkspaceOperationRecorder under phase `worktree_cleanup`.
- CHECK: `pnpm --filter @paperclipai/server exec vitest run server/src/__tests__/workspace-runtime.test.ts -t "releaseRunExecutionWorkspace pushes the branch then removes the worktree"` (covers happy path) and `-t "releaseRunExecutionWorkspace retries on a stale git lock and ultimately removes the directory"` (covers retry path).
- EXPECT: both tests pass; the first asserts `git push` and `git worktree remove --force` are recorded in order; the second asserts a second `git worktree remove --force` is recorded after the lock retry and the directory is gone at the end.
- EXIT: 0; `PASS` lines printed.

## Gate 3 — Heartbeat finally composite (removes dir AND archives workspace row)
- OBSERVABLE: a unit test exercises `releaseEphemeralRunWorkspaceForHeartbeatFinally` (the SAME function the heartbeat finally block calls) with a real embedded-postgres DB row and a real `/runs/<runId>/` directory. The composite: pushes the branch, `git worktree remove --force` (retry once on stale lock), `git worktree prune`, `fs.rm` fallback; then archives the execution workspace row (`status = "archived"`, `cleanupReason = "ephemeral_run_release"`). Both the directory removal AND the workspace row archive are observed.
- CHECK: `pnpm --filter @paperclipai/server exec vitest run server/src/__tests__/workspace-runtime.test.ts -t "heartbeat finally composite removes the worktree AND archives the execution workspace row"`
- EXPECT: test passes; `result.removed === true`, `result.archived === true`, `existsSync(worktreePath) === false`, the DB row reads `status: "archived"` and `cleanupReason: "ephemeral_run_release"`.
- EXIT: 0; `PASS` line printed.

## Gate 4 — Startup reaper never loses unpushed work
- OBSERVABLE: `reapOrphanedRunWorktrees({ worktreeParentDir, expectedWorktreeSuffix, resolveGitAuth })` enumerates git worktrees, identifies any whose path ends with the suffix AND is not referenced by a live run (caller passes the set of live run ids); for each, if the branch is not reachable from origin, the rescue branch (`paperclip/rescue/<runId>/<ts>`) is created with the dirty+untracked work as a single commit; then the worktree is force-removed and the dir cleaned. Any failure leaves the dir alone and is recorded via WorkspaceOperationRecorder.
- CHECK: `pnpm --filter @paperclipai/server exec vitest run server/src/__tests__/workspace-runtime.test.ts -t "reaper rescues unpushed work before removing an orphan run worktree"`
- EXPECT: the test asserts the rescue branch exists on the repo with the orphan's last commit before removal, and the directory is gone after.
- EXIT: 0; `PASS` line printed.

## Gate 5 — One-time sweep for done/cancelled card worktrees (incl. cleanup_failed)
- OBSERVABLE: `sweepTerminalIssueRunWorktrees` finds every `git_worktree` execution workspace whose path lives under `<worktreeParentDir>/...` (both ephemeral `/runs/<runId>/` and legacy `/<branch>/` shapes) AND whose source issue is `done`/`cancelled`. Includes `cleanup_failed` rows — the 717 stuck teardowns are the primary target. For each: confirm the branch is reachable from origin (rescue if not), force-remove the worktree dir, archive the row with `cleanupReason = "issue_terminal_sweep"`. Idempotent: re-running on a clean tree reports zero changes.
- CHECK: `pnpm --filter @paperclipai/server exec vitest run server/src/__tests__/workspace-runtime.test.ts -t "sweepTerminalIssueRunWorktrees removes done issue worktrees and is idempotent"` AND `-t "sweep covers legacy per-branch and cleanup_failed worktrees, not just ephemeral shape"`
- EXPECT: both tests pass; the second asserts a `cleanup_failed` row with a legacy `/<branch>/` path is archived and the dir is gone.
- EXIT: 0; `PASS` lines printed.

## Gate 5b — Startup reconciliation wires both passes into one boot call
- OBSERVABLE: `reconcileEphemeralWorktreesOnStartup(db)` is called once from `server/src/index.ts` on engine boot. It (a) reads the heartbeat SELECT to derive `liveRunIds`, (b) groups every `git_worktree` execution workspace by `<parent>` + `<repoRoot>`, (c) runs the orphan reaper, then (d) runs the terminal-issue sweep, against every group. Existing production import: `import { reconcileEphemeralWorktreesOnStartup } from "./services/index.js"` in `server/src/index.ts:60`. Existing production call: `void reconcileEphemeralWorktreesOnStartup(db as any)` in `server/src/index.ts:830`.
- CHECK: `pnpm --filter @paperclipai/server exec vitest run server/src/__tests__/workspace-runtime.test.ts -t "reconcileEphemeralWorktreesOnStartup reaps orphans and sweeps done issues in one call"`
- EXPECT: a single startup call removes both an orphan run worktree AND a stuck cleanup_failed legacy worktree.
- EXIT: 0; `PASS` line printed.

## Gate 6 — Concurrent runs of two cards never share a dir
- OBSERVABLE: two parallel `realizeExecutionWorkspace` calls with `lifecycle === "ephemeral"` and distinct run ids create two distinct dirs under `${worktreeParentDir}/runs/` and never collide.
- CHECK: `pnpm --filter @paperclipai/server exec vitest run server/src/__tests__/workspace-runtime.test.ts -t "concurrent ephemeral realizations never share a directory"`
- EXPECT: test passes; both `worktreePath` values are distinct and both `git worktree add` invocations are recorded.
- EXIT: 0; `PASS` line printed.

## Gate 7 — Persistent (legacy) behavior is unchanged when the flag is off
- OBSERVABLE: with the experimental flag disabled (default), `realizeExecutionWorkspace` behavior matches the pre-change tree — worktree path is `${worktreeParentDir}/<branch>/`, branch template unchanged, no push-on-cleanup, reaper is a no-op.
- CHECK: `pnpm --filter @paperclipai/server exec vitest run server/src/__tests__/workspace-runtime.test.ts -t "persistent lifecycle still names the worktree by branch"` (new) plus the existing `realizeExecutionWorkspace` suite (`pnpm --filter @paperclipai/server exec vitest run server/src/__tests__/workspace-runtime.test.ts -t "realizeExecutionWorkspace"`).
- EXPECT: both pass.
- EXIT: 0; `PASS` lines printed.

## Gate 8 — Typecheck clean
- OBSERVABLE: `pnpm --filter @paperclipai/server build` (which runs the typecheck + build gap pipeline per `package.json:scripts.typecheck`) completes with no errors.
- CHECK: `timeout 600 pnpm --filter @paperclipai/server build`
- EXPECT: exit 0, no type errors.
- EXIT: 0.

## Gate 9 — Heartbeat + workspace-runtime test suites still pass
- OBSERVABLE: the heartbeat workspace-session suite and the broader workspace-runtime suite (including the new ephemeral tests above) all pass.
- CHECK: `pnpm --filter @paperclipai/server exec vitest run server/src/__tests__/heartbeat-workspace-session.test.ts server/src/__tests__/workspace-runtime.test.ts server/src/__tests__/execution-workspaces-service.test.ts`
- EXPECT: all suites green; ephemeral-only behavior changes are confined to the new test surface and the new code paths; no persistent-lifecycle tests regress.
- EXIT: 0; `PASS` summary line printed.

## Gate 10 — FORK-PATCHES.md row 14 recorded
- OBSERVABLE: `doc/FORK-PATCHES.md` gains row 14 documenting SPA-9275's ephemeral-worktree mode — what it does, why it exists (203 GB / 168-worktree HDD load), the carry shape, the retirement condition, and the kill switch (the experimental flag). The row follows the table style of rows 1–13.
- CHECK: `grep -c '^| 14 |' doc/FORK-PATCHES.md` (or visual review for table-row style)
- EXPECT: at least one row whose first column is `14` and which references SPA-9275 in the third column.
- EXIT: 0; grep returns ≥1.
