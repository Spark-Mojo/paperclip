# SPA-9437 gates

## Behavior contract

When the issue's `projectWorkspaceId` changes, the next run must produce a fresh
git worktree bound to the NEW repo's project workspace — never re-attempt to
reuse the OLD repo's persisted execution workspace, and never fail
deterministically with `Persisted git worktree ... is not registered in git
worktree list`.

Two complementary guards:
- **Issue-update guard:** when `projectWorkspaceId` changes and the issue has a
  live execution workspace pointing at a different repo, retire that workspace
  (set `status='archived'`, clear `issue.executionWorkspaceId`). Guarded: if
  the OLD worktree has uncommitted OR unpushed work, refuse and surface the
  reason — never silently destroy.
- **Realize-time guard:** in `ensurePersistedExecutionWorkspaceAvailable`, if the
  persisted cwd is registered under a different repo root than the current
  project workspace's repo AND the worktree is clean AND every branch ref is
  reachable from origin (or runtime-owned), tear the worktree down and let the
  caller re-realize from the current workspace. If dirty OR unpushed, throw a
  `WorkspaceRuntimeValidationFailure` carrying
  `reason: "git_worktree_belongs_to_other_repo"`.

Acceptance case (SPA-9359): retrying the card on the fixed engine succeeds
without hand cleanup. SPA-9359 stays untouched as evidence.

Distinct from SPA-9405 (allocator base ref) and SPA-8018 / SPA-9283 (DR / agent
default validation).
## Gates

1. Realize-time guard tears down a clean OLD worktree and signals
   unprovisionable so the allocator provisions a fresh workspace against
   the NEW repo (covers the canonical rebind path).
   CHECK: timeout 180 pnpm exec vitest run server/src/__tests__/workspace-runtime.test.ts -t "tears down a clean persisted git worktree bound to a different repo and signals unprovisionable"
   EXPECT: exit 0, test PASS
   RESULT: exit 0; 1 SPA-9437 test passed (clean different-repo tear-down +
   typed throw).

2. Realize-time guard refuses and preserves a dirty OLD worktree.
   CHECK: timeout 180 pnpm exec vitest run server/src/__tests__/workspace-runtime.test.ts -t "refuses and preserves a dirty persisted git worktree whose repo no longer matches the project workspace"
   EXPECT: exit 0, test PASS
   RESULT: exit 0; 1 SPA-9437 test passed (dirty refusal + preservation).

3. Realize-time guard refuses when the branch ref is gone from BOTH local
   and origin (operator-owned branch with no live upstream).
   CHECK: timeout 180 pnpm exec vitest run server/src/__tests__/workspace-runtime.test.ts -t "refuses a clean persisted git worktree when the branch ref is gone from BOTH local and origin"
   EXPECT: exit 0, test PASS
   RESULT: exit 0; 1 SPA-9437 test passed (unreachable branch refusal).

4. Normalization regression: same-repo worktrees (baseCwd is itself a worktree
   of the same repo as the persisted cwd) MUST NOT trigger the
   different-repo tear-down path.
   CHECK: timeout 180 pnpm exec vitest run server/src/__tests__/workspace-runtime.test.ts -t "does not tear down a persisted worktree whose owning repo matches the current project workspace"
   EXPECT: exit 0, test PASS
   RESULT: exit 0; 1 SPA-9437 test passed (same-repo normalization
   regression). Both `baseCwd` and the persisted cwd are worktrees of the
   same sharedRepo; the validator returns the realized workspace, the
   persisted cwd is untouched on disk, and the persisted worktree's branch
   tip is unchanged.

5. Issue-update guard retires a clean runtime-owned workspace on rebind.
   CHECK: timeout 180 pnpm exec vitest run server/src/__tests__/workspace-runtime.test.ts -t "archives a clean runtime-owned execution workspace on rebind"
   EXPECT: exit 0, test PASS
   RESULT: exit 0; 1 SPA-9437 retireExecutionWorkspaceAfterProjectWorkspaceRebind
   test passed (clean retire + clear `issue.executionWorkspaceId`).

6. Issue-update guard refuses when the OLD worktree is dirty.
   CHECK: timeout 180 pnpm exec vitest run server/src/__tests__/workspace-runtime.test.ts -t "refuses to retire an execution workspace on project workspace rebind when the old worktree is dirty"
   EXPECT: exit 0, test PASS
   RESULT: exit 0; 1 SPA-9437 retireExecutionWorkspaceAfterProjectWorkspaceRebind
   test passed (dirty refusal + row stays `active`).

7. Existing not-registered persisted-worktree test still passes (the clone
   scenario exercises the SPA-9437 different-repo detector at the new
   error code; the recovery-sweep routing is unchanged).
   CHECK: timeout 180 pnpm exec vitest run server/src/__tests__/workspace-runtime.test.ts -t "routes non-reusable persisted git worktrees through workspace validation recovery"
   EXPECT: exit 0, test PASS
   RESULT: exit 0, test PASS. Test updated to expect
   `reason: git_worktree_belongs_to_other_repo /
   reasonCode: worktree_remove_failed` (the clone has its own `.git` so the
   new detector classifies it as a different repo and refuses to tear down).

8. Server typecheck introduces no new errors in changed files.
   CHECK: timeout 60 ./node_modules/.bin/tsc --noEmit --project server/tsconfig.json | grep -E "workspace-runtime\.ts|issues\.ts|execution-workspaces\.ts"
   EXPECT: empty output
    RESULT: empty output. No diagnostics in any file changed by SPA-9437.
    Pre-existing environment errors in unrelated files (missing
    `@paperclipai/paperclip-runner` build, `TS7006: implicit any` in
    `src/services/native-runtime/*` and `src/services/project-tools.ts`)
    remain unchanged.
    RE-RUN 2026-10-03 (verbatim same command, on head e634c931f0):
      no output; the pipeline's grep exited 1 (no match), which is the
      pass condition for this gate.

9. Diff is whitespace-clean.
   CHECK: timeout 30 git diff --check
   EXPECT: exit 0
   RESULT: exit 0, EXPECT matched (empty output).

10. issues-service.test.ts full suite (133 tests) still passes — the
    post-commit-action wiring in `issues.ts` does not regress existing
    service behavior.
    CHECK: timeout 1500 pnpm exec vitest run server/src/__tests__/issues-service.test.ts
    EXPECT: exit 0, all tests PASS
    RESULT: exit 0; 133/133 passed.
    RE-RUN 2026-10-03 (verbatim same command, on the commit that became head
    e634c931f0a72bcd290dfba7d0923664d24c5804):
      Test Files  1 passed (1)
      Tests  133 passed (133)
      Duration  101.06s
      exit 0

11. Clean but unpushed runtime-owned commits are preserved by both guards.
    CHECK: timeout 180 pnpm exec vitest run server/src/__tests__/workspace-runtime.test.ts -t 'unpushed runtime-owned commit'
    EXPECT: exit 0; 2 tests pass
    RESULT: exit 0; 2 passed, 189 skipped (2026-09-29). Failing control before repair: exit 1, both tests failed; realize deleted old worktree and update archived active row.
    RE-RUN 2026-10-03 on head e634c931f0a72bcd290dfba7d0923664d24c5804 (covered by gate 12, same assertion set): exit 0.
    NEGATIVE: timeout 180 pnpm exec vitest run server/src/__tests__/workspace-runtime.test.ts -t 'unpushed runtime-owned commit' against PR head db63174fd55e73c5dda5c3de391a8e7a7b042ddf before repair
    NEGATIVE RESULT: exit 1; expected branch_unreachable_in_other_repo, got execution_workspace_not_provisionable; expected refused_unpushed, got retired. This was the same assertion on disposable test repositories.

12. Scoped rebind tests.
    CHECK: timeout 180 pnpm exec vitest run server/src/__tests__/workspace-runtime.test.ts -t 'SPA-9437|unpushed runtime-owned commit'
    EXPECT: exit 0; 8 tests pass
    RESULT: exit 0; 8 passed, 183 skipped (2026-09-29).
    RE-RUN 2026-10-03 (verbatim same command, in the card worktree, on the
    commit that became head e634c931f0a72bcd290dfba7d0923664d24c5804):
      Test Files  1 passed (1)
      Tests  8 passed | 183 skipped (191)
      Duration  90.24s
      exit 0
    NEGATIVE: timeout 180 pnpm exec vitest run server/src/__tests__/workspace-runtime.test.ts -t 'SPA-9437|unpushed runtime-owned commit' before repairing reachability
    NEGATIVE RESULT: exit 1; 1 failed / 7 passed: unreachable-branch fixture with reachable HEAD demonstrated the old assertion's invalid premise. A separate earlier run failed both unpushed tests before repair.

13. Full workspace-runtime suite.
    CHECK: timeout 240 pnpm exec vitest run server/src/__tests__/workspace-runtime.test.ts
    EXPECT: exit 0; all tests pass
    RESULT: UNPROVEN; timed out after 240s while managed-runtime readiness tests were still running. No pass claimed.
    NEGATIVE: no safe full-suite failing control recorded; UNPROVEN.

14. Changed-file lint and typecheck.
    CHECK: timeout 180 pnpm exec tsc --noEmit --project server/tsconfig.json
    EXPECT: exit 0
    RESULT: UNPROVEN; nonzero due missing @paperclipai/paperclip-runner build and unrelated implicit-any diagnostics; no changed-file diagnostic observed.
    NEGATIVE: no safe typecheck negative recorded; UNPROVEN.
    CHECK: timeout 180 pnpm exec eslint server/src/services/execution-workspaces.ts server/src/services/workspace-runtime.ts server/src/__tests__/workspace-runtime.test.ts
    EXPECT: exit 0
    RESULT: UNPROVEN; eslint binary unavailable in workspace.
    NEGATIVE: no safe lint negative recorded; UNPROVEN.

15. Fork CI baseline — RE-RUN 2026-10-03, now PROVEN under the WORKFLOW.md
    step 4 / SPA-9702 base-reproduction test (all four clauses recorded under
    "Base-reproduction evidence" below; the earlier UNPROVEN verdict against
    commit cddf88b979 is superseded).

## Base-reproduction evidence (SPA-9702 clause 3 + 4, recorded 2026-10-03)

PR #125, `Spark-Mojo/paperclip`. The fork reports
`gh api repos/Spark-Mojo/paperclip --jq .allow_auto_merge` -> `false` and
`gh api repos/Spark-Mojo/paperclip/rulesets` -> `[]`, so the engine-fork
hand-merge fallback (not auto-merge) is the applicable path and no REQUIRED
check is load-bearing.

Clause 1 — head and base pinned atomically from one read:

    CHECK: /home/jamesilsley/.config/opencode-fleet-xdg/fleet/pr-read.sh head 125 --repo Spark-Mojo/paperclip
    H = 918272705e19b3c179e360de3a2e83c27f00af00
    B = 694d0fbe002a7214f027a2f5d09a5b69d0686a4c
    baseRefName = rebuild/v2026.916.0-survivors
    RESULT: exit 0; H and B read from the same response.
    (H advanced twice during this evidence pass: db63174fd5 -> e634c931f0
    after the safety fix, -> 918272705e after the boundary test in gate 16.
    Every clause below was re-derived against the final H; the earlier
    e634c931f0 reads are superseded, not relied on.)

Clause 2 — conflict state:

    CHECK: gh api repos/Spark-Mojo/paperclip/pulls/125 --jq .mergeable
    EXPECT: MERGEABLE
    RESULT: `true` (not `unknown`).

Clause 3 — every red check reproduced on an ancestor of B, by check identity
and failure signature, with the offending assertion non-touched by the PR.

Ancestor stand-in A = 9a4034850626c6cf8ccc335ba1e1b5b9010caba7 (five commits
behind B; `git rev-list --count A..B` = 5). It carries a `pull_request`-event
CI run, id 36574906925, conclusion `failure`. B itself has NO
`pull_request`-event CI run — only `schedule` and `workflow_dispatch` runs —
so the ancestor stand-in below is required, not optional.

    CHECK: git merge-base --is-ancestor 9a4034850626c6cf8ccc335ba1e1b5b9010caba7 694d0fbe002a7214f027a2f5d09a5b69d0686a4c
    EXPECT: exit 0
    RESULT: exit 0.

Red-check identity, A vs H. Three reds are real and independently exempted;
two are aggregates derived from them; one is exempt by rule, not by evidence:

  REAL base reds (independently reproduced):
  | check                                  | A (ancestor) | H (PR head) |
  |----------------------------------------|--------------|-------------|
  | `ci / policy`                          | failure      | failure     |
  | `ci / General tests (workspaces-b)`    | failure      | failure     |
  | `ci / Verify serialized server suites (2/9)` | failure | failure     |

  AGGREGATE gates — their only failing step is a roll-up of the above. They
  are NOT independent exemptions and must not be counted as such:
  | check        | A      | H      | failing step                    |
  |--------------|--------|--------|---------------------------------|
  | `ci / e2e`   | failure| failure| `Fail if any e2e shard failed`   |
  | `ci / verify`| failure| failure| `Fail if any split verify lane failed` |

  EXEMPT BY RULE, not by base-red evidence:
  | `review`     | failure| failure| vendor `commitperclip` action, no key on the fork — never a blocker per WORKFLOW.md step 4 |

    CHECK: gh api repos/Spark-Mojo/paperclip/actions/runs/36574906925/jobs?per_page=100 --jq '.jobs[] | select(.conclusion=="failure") | .name'
    RESULT (A): 5 reds —
      `ci / policy` (step `Reject git push in adapter/runtime code`),
      `ci / General tests (workspaces-b)` (step `Run grouped general test suites`),
      `ci / Verify serialized server suites (2/9)` (step `Run serialized server test shard`),
      `ci / verify` (step `Fail if any split verify lane failed`),
      `ci / e2e` (step `Fail if any e2e shard failed`).
    RESULT (H): same 5 names, same 5 step names, same conclusions.

Failure signature, per red:

  1. `ci / policy` — the check script is byte-identical at A, B and H:
       `git rev-parse <rev>:scripts/check-no-git-push.mjs`
         A = 7254f6cafedeed4b694167f1ffa05c38b4ae11dd
         B = 7254f6cafedeed4b694167f1ffa05c38b4ae11dd
         H = 7254f6cafedeed4b694167f1ffa05c38b4ae11dd
     Signature at A (verbatim, `gh run view --log-failed --job 109428208796`):
       ERROR: `git push` (or equivalent remote-mutating git command) found in adapter/runtime code:
         server/src/services/workspace-runtime.ts:4884: ... `git push origin ${input.branchName} failed`;
         server/src/__tests__/workspace-runtime.test.ts:4572: ...
         server/src/__tests__/workspace-runtime.test.ts:4577: ...
     Non-touch proof: the PR diff touches
     `server/src/services/workspace-runtime.ts` and
     `server/src/__tests__/workspace-runtime.test.ts`, so line numbers shift —
     but the CONTENT of every line containing `git push` is byte-identical at
     A, B and H:
       `git show <rev>:<file> | grep "git push" | sha256sum`
         workspace-runtime.ts   A = 8a04423d7c4010614271a18eca56f75182df5e4513305960f8a0ee42d8ce1691
                                 B = 8a04423d7c4010614271a18eca56f75182df5e4513305960f8a0ee42d8ce1691
                                 H = 8a04423d7c4010614271a18eca56f75182df5e4513305960f8a0ee42d8ce1691
         workspace-runtime.test.ts
                                 A = 384a2cca8c75bc43addf3a6fb1c780b55fdc45752225d77955de0308490d1fab
                                 B = 384a2cca8c75bc43addf3a6fb1c780b55fdc45752225d77955de0308490d1fab
                                 H = 384a2cca8c75bc43addf3a6fb1c780b55fdc45752225d77955de0308490d1fab
     Occurrence counts also identical (1 and 2). And directly:
       `git diff B..H -- server/src/services/workspace-runtime.ts server/src/__tests__/workspace-runtime.test.ts | grep -E "^[+-].*git push"`
       -> empty (no added or removed line contains `git push`).
     VERDICT: base-red only. This red names files the PR edits but does not
     alter the offending lines or the check that flags them; it is a
     pre-existing `SPA-9275` push-then-remove error message on the fork's
     default branch.

  2. `ci / General tests (workspaces-b)` — signature at A:
       ELIFECYCLE  Command failed with exit code 1.
       This error originated in "packages/adapter-utils/src/server-utils.test.ts".
     The PR diff is exactly four files:
       `git diff --name-only B..H`
         server/src/__tests__/workspace-runtime.test.ts
         server/src/services/execution-workspaces.ts
         server/src/services/issues.ts
         server/src/services/workspace-runtime.ts
     `packages/adapter-utils/src/server-utils.test.ts` is NOT among them.
     VERDICT: base-red only, by non-touch of the failing test file.

  3. `ci / Verify serialized server suites (2/9)` — signature at A:
       FAIL  @paperclipai/server  src/__tests__/issue-dependency-wakeups-routes.test.ts
         > issue dependency wakeups in issue routes
         > does not enqueue a second wake when the blocker is already done
       Test Files  1 failed (1)
     `server/src/__tests__/issue-dependency-wakeups-routes.test.ts` is NOT in
     the PR's four-file diff (verified by `git diff --name-only B..H | grep
     issue-dependency` -> empty).
     VERDICT: base-red only, by non-touch of the failing test file.

  4. `ci / e2e` and `ci / verify` are AGGREGATE, derived from reds 2 and 3
     above — the PR introduces no e2e or verify-lane change. Not counted as
     independent exemptions.

  5. `review` is the vendor `commitperclip` action with no key on the fork.
     Exempt by rule, not by base-red evidence; no reproduction attempted.

MECHANICAL RECEIPTS (run 2026-10-03, replacing log-reading with re-runs — a
log read is inference, a re-run is a receipt):

R1. `ci / policy` — the check script executed at both revs.
    CHECK: git archive <rev> scripts/check-no-git-push.mjs server/src/services/workspace-runtime.ts server/src/__tests__/workspace-runtime.test.ts | tar -x -C <dir>
    CHECK: node <dir>/scripts/check-no-git-push.mjs --repo-root <dir>
    RESULT at A: exit 1, 3 offenses.
    RESULT at H: exit 1, 3 offenses.
    CHECK: diff <(sed -E 's/:[0-9]+:/:LINE:/' pol-A.out) <(sed -E 's/:[0-9]+:/:LINE:/' pol-H.out)
    EXPECT: no differences
    RESULT: no differences — the two outputs are byte-identical once line
    numbers are normalized away.
    The check is BOOLEAN, not count- or threshold-based: the script's exit is
    `if (allOffenses.length > 0) ... process.exit(...)` (line 171, line 195).
    The offense count is identical (3 at A, 3 at H), so the verdict is
    identical under boolean OR any threshold reading. Offense content at both
    revs, verbatim and identical:
      server/src/services/workspace-runtime.ts  `git push origin ${input.branchName} failed`
      server/src/__tests__/workspace-runtime.test.ts  two `git push` op-filter lines
    This is the same SPA-9275 push-then-remove error message that fails on the
    fork's default branch. VERDICT: base-red only, established by execution
    rather than by argument.

R2. `ci / Verify serialized server suites (2/9)` — the failing suite re-run at
    pinned A in a throwaway worktree (`/srv/bulk/scratch/spa9437-baseA`,
    created with `git worktree add --detach`; deliberately NOT under
    `$PAPERCLIP_RUN_SCRATCH_DIR`, which is removed at run teardown).
    CHECK: timeout 600 pnpm exec vitest run server/src/__tests__/issue-dependency-wakeups-routes.test.ts
      (run in the pinned-A worktree, pnpm-linked to the card worktree's node_modules)
    EXPECT: the CI failure reproduces at A
    RESULT: exit 1 —
      Test Files  1 failed (1)
      Tests  1 failed | 7 passed (8)
      x does not enqueue a second wake when the blocker is already done 1059ms
    Identical test name, identical file, identical single-failure shape as the
    CI log at A. VERDICT: base-red only, by re-run.

R3. `ci / General tests (workspaces-b)` — the failing suite re-run at pinned A.
    CHECK: timeout 600 pnpm exec vitest run packages/adapter-utils/src/server-utils.test.ts
      (run in the pinned-A worktree)
    EXPECT: the CI unhandled-error signature reproduces at A
    RESULT: exit 1 —
      Unhandled Errors
      This error originated in "packages/adapter-utils/src/server-utils.test.ts"
      Test Files  1 passed (1)
      Tests  122 passed (122)
      Errors  1 error
    Identical signature to the CI log at A (`Errors  1 error`, same originating
    file, `ELIFECYCLE Command failed with exit code 1`). Note the shape: all 122
    tests PASS and the file is torn down by an unhandled error after the run —
    which is why the assertion is on the error count, not a test failure.
    Neither `packages/adapter-utils/src/server-utils.test.ts` nor
    `server/src/__tests__/issue-dependency-wakeups-routes.test.ts` is in the
    PR's four-file diff. VERDICT: base-red only, by re-run.

Clause 4 — base ref has no CI run, ancestor stand-in used:

    CHECK: gh api repos/Spark-Mojo/paperclip/commits/694d0fbe002a7214f027a2f5d09a5b69d0686a4c/check-runs --jq .total_count
    RESULT: 24 — but every one is a `release`-family or skipped job
    (`Authorize optional paid E2E` failure, `select_nightly` failure, the rest
    skipped). No `ci / ...` PR check ran on B.
    CHECK: gh run list --repo Spark-Mojo/paperclip --branch rebuild/v2026.916.0-survivors --limit 20
    RESULT: at B, only `Release` (schedule) and `E2E Tests` (workflow_dispatch)
    ran. No `pull_request` CI run exists for B or any ancestor-bound PR head
    (verified: zero of the 48 `pull_request` run heads are ancestors of B), so
    the ancestor stand-in A above is the only available evidence and is used
    under the clause-4 allowance.
    NEGATIVE (the exemption is falsifiable, and was): the A-vs-H identity table
    above is check-by-check. A candidate that did NOT reproduce was rejected on
    this test: `4d940c89f6f53728dd37a38883c3b1ac7aa1e94f` has `ci / e2e`
    `success` while H has it `failure`, so it was discarded as a stand-in and
    `9a4034850626c6cf8ccc335ba1e1b5b9010caba7` chosen instead.

## Notes

16. The deliberate boundary of the reachability guard: a branch that was
    PUSHED but has no pull request behind it IS torn down. This is the one
    behavior a reviewer can reasonably read as harm, so it is asserted
    rather than left to prose — the guard's contract is "nothing unpushed",
    not "nothing orphaned".
    CHECK: timeout 400 pnpm exec vitest run server/src/__tests__/workspace-runtime.test.ts -t 'already pushed to origin'
    EXPECT: exit 0; the worktree is removed AND the origin ref still names the
    exact pre-teardown tip
    RESULT: exit 0; 1 passed, 191 skipped. First run of this test FAILED on my
    own fixture error, not on the guard: I asserted the origin ref against
    `main`, but the commit lands on the worktree's own branch. Corrected to
    capture the tip with `rev-parse HEAD` before the teardown and compare
    against that; the guard's behavior (teardown + typed
    `ExecutionWorkspaceNotProvisionableError`) was correct from the first run.
    NEGATIVE: the sibling test in the same suite is its own negative —
    gate 12's `preserves a clean old-repo worktree with an unpushed
    runtime-owned commit` asserts the opposite outcome for the one-commit-earlier
    state (no origin ref -> refuse and preserve), so the pair brackets the
    boundary from both sides. Removing the `update-ref` line from this fixture
    flips this test to a preserve-and-refuse failure, which is the
    discriminating control.
- "Different repo" = the persisted cwd's owning repo (resolved through
  `resolveGitOwnerRepoRoot` → `--git-common-dir`) does not match the
  current `executionWorkspaceBase.baseCwd`'s owning repo (same
  normalization). Both sides go through the same helper so a project
  workspace that is itself a worktree of repo X does NOT spuriously
  classify a same-repo worktree as a different repo (gate 4 covers this).
- The realize-time guard covers a missed retire (race: board release with
  the same record); the issue-update guard covers the canonical path. Both
  surface a typed signal so the recovery sweep / operator sees a clear
  cause: typed `ExecutionWorkspaceNotProvisionableError` on the safe
  path (allocator's SPA-9315 fallback provisions fresh), typed
  `WorkspaceRuntimeValidationFailure` with
  `reason: git_worktree_belongs_to_other_repo` on the refuse paths.
- A `git_worktree` provider with a clean status and a runtime-owned branch
  is always safe to retire; an operator-owned branch is retire-safe only
  when its branch ref is reachable from origin or a local ref exists.
  SUPERSEDED by the 2026-09-29 safety fix: the test is no longer "is the
  branch ref reachable" and no longer short-circuits on runtime ownership.
  It is `git rev-list --count HEAD --not --remotes=origin` evaluated AT THE
  WORKTREE, on both guards. A clean worktree can hold commits that exist
  nowhere but its local branch, and archiving the execution workspace or
  deleting the worktree destroys them unrecoverably. A runtime-owned branch
  is not automatically unpushed-proof; the old `createdByRuntime` short-circuit
  is gone.
- The recoverability test deliberately ignores pull requests. A pushed branch
  with no PR behind it is torn down (gate 16): the commits survive on origin
  and `git fetch` re-attaches them, so nothing is lost, but the card's work
  is left with nothing pointing at it. This is the intended reading of the
  card's "nothing unpushed" criterion, recorded as a test so the no-harm
  claim does not have to be reconstructed by a reviewer.
- Both git helpers (`readGitStdout` in execution-workspaces.ts, `runGit` in
  workspace-runtime.ts) throw on a nonzero git exit, so the `catch` arms on
  the reachability check fail CLOSED toward refusing rather than tearing down.
  Verified by reading both helper bodies: `readGitStdout` returns
  `Promise<string | null>` from a `runGit` that throws, and `runGit` in
  workspace-runtime.ts returns `Promise<string>` (trimmed stdout) and throws
  otherwise. Neither can return a non-`"0"` string that compares equal to
  `"0"`, so `=== "0"` is a sound allow and anything else — including `null`
  from an empty stdout — refuses.
- The `routes non-reusable persisted git worktrees` test's clone scenario
  exercises the SPA-9437 different-repo detector (the clone's `.git` is
  its own directory, not a worktree linked to `repoRoot`). The test was
  updated to expect the new error code; the recovery-sweep routing is
  unchanged.