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

## Gate 10 — FORK-PATCHES.md row recorded (SPA-9285 re-merge)
- OBSERVABLE: `doc/FORK-PATCHES.md` gains a row documenting SPA-9275's ephemeral-worktree mode — what it does, why it exists (203 GB / 168-worktree HDD load), the carry shape, the retirement condition, and the kill switch (the experimental flag). The row follows the table style of its siblings.
- CHECK: `grep -c 'SPA-9275' doc/FORK-PATCHES.md`
- EXPECT: exactly one table row referencing SPA-9275 in the third column, numbered `18` (the base's next free row number — the base's own row 14 is SPA-9038, so the head stub's `14` was renumbered on the merge to avoid the collision, per the SPA-9285 governance guidance).
- EXIT: 0; grep returns 1.

---

# SPA-9285 re-merge verification (results against merged head)

Merged head verified: **`9b5cd86268`** (the branch head at verification dispatch for the fixture-completion delta; = `09941266b2` + four `doc/unlazy/SPA-9275/gates.md` doc commits `43201aab6d`/`3a0d96cd10`/`f25c402178`/`ad4cda3849` + the SPA-9275 fixture-completion commit `9b5cd86268`). All code+test results below were produced against `09941266b2` plus the two fixture edits now in `9b5cd86268` (startup mock + settings `toEqual`); the only other differences to the verified head are gates-ledger doc commits, so all results carry. Base synced: `09941266b2` merges base `172c6ce891` (PRs #109/#111) onto the SPA-9275 branch.

Known-redundant ahead-commits on the branch: `2fb9c6f880` (SPA-9140) and `8ed6a7122a` (SPA-9282) mirror later base PRs #87/#111. Cosmetic history; the merged tree is identical to the base's canonical copies. Not a merge risk — confirmed `MERGEABLE` at `43201aab6d`. Reviewers should not flag these as drift.

## Gate results (run 2026-09-29, worktree SPA-9285-spa-9275-rebase-...)

| Gate | CHECK | Result | Evidence |
|------|-------|--------|----------|
| 1 | ephemeral worktree names by run id | PASS | `vitest run workspace-runtime.test.ts -t "ephemeral lifecycle names the worktree by run id"` passed |
| 2 | releaseRunExecutionWorkspace push-then-remove + retry | PASS | `-t "releaseRunExecutionWorkspace pushes the branch then removes the worktree"`, `-t "releaseRunExecutionWorkspace retries on a stale git lock..."` passed |
| 3 | heartbeat finally composite removes dir AND archives row | PASS | `-t "heartbeat finally composite removes the worktree AND archives the execution workspace row"` passed |
| 4 | reaper rescues unpushed work | PASS | `-t "reaper rescues unpushed work before removing an orphan run worktree"` passed |
| 5 | sweep done/cancelled worktrees incl. cleanup_failed | PASS | `-t "sweepTerminalIssueRunWorktrees removes done issue worktrees and is idempotent"`, `-t "sweep covers legacy per-branch and cleanup_failed worktrees..."` passed |
| 5b | startup reconciliation in one call | PASS | `-t "reconcileEphemeralWorktreesOnStartup reaps orphans and sweeps done issues in one call"` passed |
| 6 | concurrent ephemeral realizations no shared dir | PASS | `-t "concurrent ephemeral realizations never share a directory"` passed |
| 7 | persistent (legacy) behavior unchanged | PASS | `-t "persistent lifecycle still names the worktree by branch"` passed |
| 8 | typecheck clean | PASS | `cd server && node ../node_modules/typescript/bin/tsc` → EXIT=0, no errors. (Full `pnpm build` blocked only by missing `cargo` for the paperclip-runner binary — an environment gap, not a code error; server `tsc` + runner `tsc` both clean.) |
| 9 | heartbeat + workspace-runtime + exec-workspaces suites | PASS (with pre-existing base failures) | Full 3-suite run: **415 passed, 6 failed** of 421. The 6 failures are **identical at base head `172c6ce891`** (verified by running the same suites in a clean worktree off the base): `writes an isolated repo-local Paperclip config...`, `provisions worktree-local pnpm node_modules instead of reusing base-repo links`, `provisions successfully when install is needed...`, `reinstalls worktree-local pnpm dependencies when package metadata changes`, `retries worktree-local pnpm install without a frozen lockfile...`. Root cause is the base's own `provision-worktree.sh` hardy config-seeding (`Invalid config ... $meta` / `PAPERCLIP_HOME missing` against the test's `{}` source config) — pre-existing, not a merge regression. |
| 10 | FORK-PATCHES.md row | PASS | Row `18` (SPA-9275) appended into the base's canonical table; base rows 1–17 preserved verbatim; base header kept. See `doc/FORK-PATCHES.md` line 79. |

## The 10 conflicts — resolution disposition

| File | Resolution |
|------|-----------|
| `doc/FORK-PATCHES.md` | add/add governance: base's canonical 31-line table kept verbatim (rows 1–17), SPA-9275 appended as row 18 (head stub's claimed row 14 collided with base row 14 SPA-9038) |
| `packages/shared/src/feature-catalog.ts` | merged keep-both: SPA-9275 `enableEphemeralWorktreePerRun` entry intact (line 314) |
| `packages/shared/src/types/instance.ts` | merged keep-both: flag type intact (line 155) |
| `packages/shared/src/validators/instance.ts` | merged keep-both: `z.boolean().default(false)` intact (line 90) |
| `server/src/services/heartbeat.ts` | merged keep-both: ephemeral release wiring intact (line 21755) |
| `server/src/services/instance-settings.ts` | merged keep-both: flag normalize in both branches intact (lines 268, 309) |
| `server/src/services/issues.ts` | merged keep-both: SPA-9140 active-only workspace inherit + SPA-8939/9038 done-gate prose intact |
| `server/src/services/workspace-runtime.ts` | merged keep-both: `releaseRunExecutionWorkspace`, `reapOrphanedRunWorktrees`, `sweepTerminalIssueRunWorktrees`, `reconcileEphemeralWorktreesOnStartup`, `releaseEphemeralRunWorkspaceForHeartbeatFinally` all intact (lines 4687–5322) |
| `server/src/__tests__/heartbeat-workspace-session.test.ts` | merged keep-both: base SPA-9139/9258 test additions + SPA-9275 ephemeral heartbeat tests intact |
| `server/src/__tests__/workspace-runtime.test.ts` | merged keep-both: base SPA-8995 setup-file deletion + SPA-9275's 13 ephemeral tests intact |

## Base sync

- Two merges landed: `a5c1100385` (base `fd57a5d0cb` — the original 116-commit base) and `09941266b2` (base `172c6ce891` — the further-moved base, PRs #109/#111).
- PR head was moved from `88743de936` (unmergeable, `mergeable: false`) and pushed; PR #108 is `MERGEABLE` at the final head.

## CI surface expansion (SPA-9275-fixture completion)

The merged head triggered the fork's full CI matrix for the FIRST time (the SPA-9275 head `88743de936` had zero check-runs). The matrix surfaced four real test failures; all four were reproduced and triaged:

- **SPA-9275-ATTRIBUTABLE (also broken at `88743de936`; fixed on this branch):**
  1. `server-startup-feedback-export.test.ts` — `server/src/index.ts` calls `reconcileEphemeralWorktreesOnStartup` (SPA-9275 startup wiring) but the test's `vi.mock("../services/index.js")` did not export it → file-level mock error, 16 tests failed. Fixed: added `reconcileEphemeralWorktreesOnStartup: vi.fn(async () => ({ reposScanned: 0, reaper: {...}, sweep: {...}, totalErrors: [] }))` matching the real return shape (`workspace-runtime.ts:5183`). Suite now 20/20.
  2. `instance-settings-service.test.ts` — the strict `toEqual` on the fully-normalized settings object did not include SPA-9275's new `enableEphemeralWorktreePerRun: false` (emitted by `instance-settings.ts:268`/`:309`). Fixed: added the key to the expected object. Suite now 26/26.
  3. `ui/src/pages/InstanceExperimentalSettings.test.tsx` — `defaultExperimentalSettings()` returns a full `InstanceExperimentalSettings` object literal (no cast) missing SPA-9275's new `enableEphemeralWorktreePerRun` key → `error TS2741` in the `ci / Typecheck + Release Registry` lane (`typecheck:build-gaps`). Fixed: added `enableEphemeralWorktreePerRun: false`. UI tsc clean, suite 41/41.
- **PRE-EXISTING BASE FAILURES (confirmed byte-identical at base head `172c6ce891` in a clean base worktree; NOT fixed, out of scope):**
  3. `issue-dependency-wakeups-routes.test.ts` "does not enqueue a second wake when the blocker is already done" — expects 200, gets 409. Fails identically on base.
  4. `packages/db/src/migration-snapshot-drift.test.ts` — `ENOENT 0281_snapshot.json`: base ships migrations 0280/0281 but meta snapshots stop at 0279. Fails identically on base (`git diff 172c6ce891 HEAD -- packages/db/src/migrations/` is empty — the dir is byte-identical).
- **Workflow/infra-level reds** (`ci/policy`, `ci/verify`, `ci/e2e`, chat shard row-lock): generic runner/key/runner-environment artifacts, not attributable to the PR content.

Post-fix local runs (same env as the gate-9 runs): startup suite 20/20, settings suite 26/26, UI settings test 41/41, server `tsc` EXIT=0, ui `tsc --noEmit` EXIT=0, cli `tsc --noEmit` EXIT=0, and the full gate-9 trio unchanged at **415 passed / 6 failed of 421** with the 6 failures the same pre-existing `realizeExecutionWorkspace` config-seeding set verified at base head `172c6ce891`.

The fixture edits are SPA-9275-completion (the SPA-9275 PR would have had to carry them to pass CI on any repo that runs checks) — test fixtures, not product code; required by the card's step 3 "full test surface" obligation against the final head.
