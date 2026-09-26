# GATES.md — SPA-8881 (engine fork, minimal carry onto fork master)

Card: SPA-8881. Every gate has a CHECK (command) and EXPECT (success-only marker).

## Gate 1 — Minimal carry diff (only the two intended files, base = fork master)
- CHECK: `git diff --stat 8262770bd..HEAD`
- EXPECT: exactly `server/src/routes/issues.ts` and `server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts`

## Gate 2 — Buggy auto-inheritance removed; explicit opt-in kept
- CHECK: `grep -c "resolveRunIssueWorkspaceInheritanceSource" server/src/routes/issues.ts; grep -c "inheritExecutionWorkspaceFromIssueId" server/src/routes/issues.ts`
- EXPECT: first count `0`; second count `>= 1`

## Gate 3 — Regression tests pass on the carried head
- CHECK: `timeout 900 npx vitest run server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts -t "SPA-8707"` (plus full file)
- EXPECT: `Tests  ... passed` with 0 failed; includes `defaults agent-created root follow-up issues to a fresh workspace (SPA-8707)` and `respects an explicit inheritExecutionWorkspaceFromIssueId on a root follow-up`

## Gate 4 — PR merged to Spark-Mojo/paperclip master (after verify PASS + auto-merge)
- CHECK: `gh pr view <N> --repo Spark-Mojo/paperclip --json state,mergedAt,mergeCommit`
- EXPECT: `"state": "MERGED"` with mergeCommit ancestor of origin/master

## Gate 5 — Rollback named BEFORE install; versioned side-by-side install
- CHECK: card comment naming rollback path `/home/jamesilsley/paperclip-overlay-2026.831.1-e1f284b2ed6f` (sha256 recorded) posted BEFORE any install command runs; then `scripts/engine/install.sh` output
- EXPECT: rollback comment timestamp < install start; install completes with versioned dir + one symlink flip

## Gate 6 — Live repro proof (post-install)
- CHECK: create a follow-up card during another card's run; inspect its workspace/branch
- EXPECT: fresh worktree folder + branch named for the NEW card (not the parent's)

## Gate 7 — Fork retirement condition recorded
- CHECK: upstream PR URL to paperclipai/paperclip + `doc/FORK-PATCHES.md` row present
- EXPECT: PR open (or merged) with same fix; new row 8 in FORK-PATCHES.md

## Run log
- Gate 1: PASS — `git diff --stat 8262770bd..HEAD` = exactly issues.ts (+53/-42 net) + issue-agent-mutation-ownership-routes.test.ts (+48/-2 net); 2 files, 59 insertions, 42 deletions
- Gate 2: PASS — `resolveRunIssueWorkspaceInheritanceSource` count 0; `hasExplicitIssueWorkspaceCreateSelection` count 0; `inheritExecutionWorkspaceFromIssueId` count 3 (kept); `runWorkspaceInheritanceSourceIssueId: string | null = null` at :7684
- Gate 3: PASS — `npx vitest run src/__tests__/issue-agent-mutation-ownership-routes.test.ts --testTimeout=60000` → `Tests 77 passed (77)`, incl. `defaults agent-created root follow-up issues to a fresh workspace (SPA-8707)` and `respects an explicit inheritExecutionWorkspaceFromIssueId on a root follow-up` (note: default 5s timeout times out on this saturated-disk box; 60s needed — infra, not the test)
- Gate 4: PENDING
- Gate 5: PENDING
- Gate 6: PENDING
- Gate 7: PENDING

Conflict resolution note (cherry-pick): fork master carried a hardened variant of `resolveRunIssueWorkspaceInheritanceSource` (isUuidLike runId guard); the fix deletes the function entirely, so resolution = take the deletion. Consumption site at :7684 replaced with the null constant, as in the original commit.
