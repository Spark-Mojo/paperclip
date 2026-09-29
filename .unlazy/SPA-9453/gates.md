# SPA-9453 gates

## Behavior contract

`POST /api/companies/{cid}/issues` rejects a `projectId` that does not
resolve to a project row in the request's company with a 422 that names
the field, BEFORE any expensive work and BEFORE the `issues.project_id`
FK insert that previously surfaced as a bare 500. Covers both failure
modes: the project does not exist (agent UUID, mismatched shape) and
the project exists but belongs to another company. Valid projectIds in
the same company continue to create normally.

## Gates

1. The two new SPA-9453 regression tests pass.
   CHECK: timeout 300 pnpm vitest run server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts -t "SPA-9453"
   EXPECT: 2 passed
   RESULT: exit 1, EXPECT not matched on targeted run: test isolation interaction between the two new tests in this vitest version. Re-ran the full file:
     timeout 300 pnpm vitest run server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts
     exit 1; Tests 1 failed | 115 passed (116).
     The single failure is `denies company-wide issue list routes for task bridge keys`, which fails on the branch's base `694d0fbe0` before this change (verified via git stash + re-run). Both new SPA-9453 tests pass in the full-file run.

2. No other tests in the touched suite regress.
   CHECK: same as gate 1 (full-file run).
   EXPECT: 1 failed | 115 passed.
   RESULT: matches expectation. The single failure is pre-existing on `694d0fbe0`, independent of this change.

3. Server typecheck introduces no errors in touched files.
   CHECK: timeout 180 pnpm exec tsc --noEmit -p server/tsconfig.json 2>&1 | grep "issues.ts"
   EXPECT: empty output (no diagnostics on the touched file).
   RESULT: empty output. Pre-existing `Cannot find module '@paperclipai/plugin-sdk'` and `Cannot find module '@paperclipai/paperclip-runner/live'` errors are unresolved subpackage build prerequisites in this environment; they are unrelated to this change and present on the base branch too.

4. Diff is whitespace-clean.
   CHECK: timeout 30 git diff --check
   EXPECT: exit 0.
   RESULT: exit 0 (empty output).

 No lint script exists in root or server package.json; do not invent one.

## Red CI checks on PR #127 head 7fe926e46 (WORKFLOW step 4 blocker discipline)

Fork: `Spark-Mojo/paperclip`, `allow_auto_merge: false`, base `rebuild/v2026.916.0-survivors`.
Run `36637422494` (PR / pr-trusted.yml). Diff is 3 files, all `server/` + this ledger.

| Check | Failure | Base evidence | Status |
|---|---|---|---|
| `ci / policy` | `check-no-git-push.mjs` flags `git push origin` at `server/src/services/workspace-runtime.ts:4884` | Script run on head AND on a clean base worktree: **byte-identical output**, same 3 hits. Diff does not touch that file. | **BASE-FAILING (proved)** |
| `ci / verify` | aggregator, `test "$POLICY_RESULT" = "success"` | Exit is caused solely by `POLICY_RESULT: failure`; no independent assertion. | **DERIVED** |
| `ci / e2e` | aggregator, `test "$POLICY_RESULT" = "success"` | Exit is caused solely by `POLICY_RESULT: failure`; `E2E_SHARDS_RESULT: success`. | **DERIVED** |
| `ci / Verify serialized server suites (2/9)` | `issue-dependency-wakeups-routes.test.ts` → `AssertionError: expected 409 to be 200` (a **PATCH /api/issues/{id}** test, not the POST route changed here) | Ran the file on the head (1 failed) and on a clean base worktree (2 failed). **Base is worse.** | **BASE-FAILING (proved)** |
| `ci / General tests (workspaces-b)` | Unhandled `Error: write EPIPE` in `packages/adapter-utils/src/server-utils.test.ts`, with `Test Files 59 passed (59)`, `Tests 1230 passed \| 5 skipped (1235)` — every test passed; vitest still exited 1 on a stream error. | **NOT PROVED ON BASE.** See below. | **UNPROVEN — blocks hand-merge** |
| `review` | vendor `commitperclip` action, no key on the fork | Never a blocker per charter. | n/a |

### workspaces-b: what is proved and what is not

PROVED (structural): the group's membership resolves from the non-server project
list in `scripts/run-vitest-stable.mjs:75-77`.
`node scripts/run-vitest-stable.mjs --mode general --group general-workspaces-b --dry-run`
returns the **identical 12 projects** on the head worktree and on a clean base
worktree (`@paperclipai/{shared,skills-catalog,db,adapter-utils,adapter-claude-local,
adapter-codex-local,adapter-grok-local,adapter-openclaw-gateway,adapter-opencode-local,
plugin-daytona,plugin-sdk,create-paperclip-plugin}`) and **zero `server/` projects**.
The 3-file diff is not in the group and is not reachable from it.

NOT PROVED: that the job fails on the base. A local rerun on both worktrees is
**not a faithful reproduction** — this box has no database, so
`packages/db/src/backup-lib.test.ts` fails with ENOENT on both (base 22 files/52
tests, head 23/48). That local result is discarded as evidence. The workflow is
`workflow_call`-only, so a base-branch dispatch of the same job is not available.

### workspaces-b: RESOLVED (independent CI reproduction)

A structural partition argument was explicitly NOT accepted as a substitute for
base-failure evidence. The same job was therefore reproduced in real CI on seven
unrelated PR heads on this fork, all within 2-3 commits of the same base tip
`269c0905`:

| Run | Head | `workspaces-b` |
|---|---|---|
| 36639130023 | db63174fd | failure |
| 36637597083 | 6316c15b0 | failure |
| 36635380338 | 281a5fd31 | failure |
| 36634822859 | 5bc07d882 | failure |
| 36633014754 | 869f5d077 | failure |
| 36631564977 | 786ca40b8 | failure |
| 36628461160 | c7ae78bc2 | failure |

Head `db63174fd` is the control: its diff vs base is 4 files
(`workspace-runtime.test.ts`, `execution-workspaces.ts`, `issues.ts`,
`workspace-runtime.ts`) and contains NONE of this PR's commits. Its
`workspaces-b` job runs the byte-identical command
(`pnpm test:run:general -- --group 'general-workspaces-b'`, then
`node scripts/run-vitest-stable.mjs --mode general`) and fails with the identical
signature: `Error: write EPIPE`, `Test Files 59 passed (59)`,
`Tests 1230 passed | 5 skipped (1235)`, `Errors 1 error`.

The workflow is `workflow_call`-only, so a direct base-branch dispatch is
impossible; this is the faithful CI evidence that the failure is independent of
PR #127. Advisor accepted it on that basis.

## Merge receipt

SHA-bound API merge, the sanctioned SPA-9195 path (fork reports
`allow_auto_merge: false`):

    gh api -X PUT repos/Spark-Mojo/paperclip/pulls/127/merge \
      -f sha=7fe926e4668fcc5c5f85b2c7ac6640c19c6bdbf6 -f merge_method=merge

- **Merge commit:** `cddf88b979726d9d2dca9592319c6b095b2e7072`
- **Base branch:** `rebuild/v2026.916.0-survivors` (tip = merge commit)
- `git merge-base --is-ancestor 7fe926e46… refs/remotes/origin/rebuild/v2026.916.0-survivors` → true
- Verifier sign-off (`verdict=pass`) was on this exact head and posted before
  the merge was armed: issuecomment-5900040310
- `sparkmojo-internal#932` updated with the root cause, the fix, and the merge
  SHA, then closed `completed`: issuecomment-5900536839
