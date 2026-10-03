# SPA-9437 gates

## READ THIS FIRST — two things a reviewer will otherwise re-litigate

**1. The `not_registered` -> `git_worktree_belongs_to_other_repo` reclassification
in `routes non-reusable persisted git worktrees` is NOT an out-of-scope
behaviour change, and the premise has been tested.** Verifier round 1 raised
it as finding 6. I implemented the `not_a_registered_worktree` fall-through
that finding implies, ran it, and it did not fire — which disproved the
premise. Measured:

    # the fixture nests a clone INSIDE the old repo
    git -C origin worktree list --porcelain   -> REPORTS the nested clone path
    git -C c1   worktree list --porcelain    -> reports itself

`inspectManagedGitWorktreeBranch` takes `repoRoot` from the clone's OWN
`--show-toplevel`, so the path IS a registered worktree and `git worktree
remove --force` runs against the clone itself. Two consequences:

  - The "pre-existing" `not_registered` expectation was never produced by this
    fixture: `listLinkedGitWorktreePaths(repoRoot)` returns the clone, so the
    pre-SPA-9437 code took `wrong_repository_root`. (Reasoned from the
    fixture's construction, not measured at base — flagged as such below.)
  - `git worktree remove` cannot delete another repository's directory, so the
    guard's refusal is CORRECT here; the alternative leaves a directory no
    cleanup path can ever remove.

The fall-through was reverted. Production code at this head is byte-identical
to what round 1 reviewed — only tests, comments and this ledger changed:

    git diff f17538edf4..3c637c1585 -- server/src/services packages   # empty

Boundary pinned by a new test rather than argued — gate 17:
`still tears down a REGISTERED other-repo worktree` asserts the path IS in the
old repo's worktree list BEFORE the call (precondition stated, not assumed)
and is absent from disk AND pruned afterwards.

**2. Base-red evidence uses an ANCESTOR stand-in, and it is recorded.** The
base branch advanced 41 commits mid-run; GitHub's REST `.base.sha` still
reports the open-time merge base `694d0fbe002a`, which is stale. The live tip
`916919bb7c` is what CI built and what a merge lands on. Neither the stale pin
nor the live tip has any `ci / …` run — exactly the WORKFLOW.md step 4
clause-4 case, so an ancestor stands in:

    A = f519242095fac059955387af6f68cc28e1408895   (PR #130 head)
    git merge-base --is-ancestor f519242095... 916919bb7c  -> exit 0
    check-runs at A -> 48 runs, 11 reds = a SUPERSET of all 9 head reds

Full per-check signature match, blob-identity causal non-touch, and the
local reproduction (base alone fails / guard's parent passes / base+head
passes) are in "Base-advance supersession" and "Verifier round 1" below.

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
    H = 16d2961aebc6cdeb8e042fedb79ef8f764560154
    B = 694d0fbe002a7214f027a2f5d09a5b69d0686a4c
    baseRefName = rebuild/v2026.916.0-survivors
    RESULT: exit 0; H and B read from the same response.

    HOW TO READ THIS PIN. Every clause below was gathered against H =
    16d2961aeb, which is the head that carries the final CODE state: the
    reachability fix (e634c931f0), the boundary test (918272705e) and this
    ledger (16d2961aeb). Commits after it touch this markdown file only, so
    the code under test is identical at any later head. Rather than chase
    the SHA with further ledger edits — which is self-referential and never
    terminates — the verifier should read the live head itself
    (`pr-read.sh head 125 --repo Spark-Mojo/paperclip`) and confirm the
    code-identical claim directly:

        git diff 16d2961aebc6cdeb8e042fedb79ef8f764560154..<live head> \
          -- server/src packages

    An empty result is the whole check. The B pin needs no such caveat: B is
    the branch tip and is stable.

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

## Base-advance supersession (recorded 2026-10-03, run 2b248190's successor)

**The B pin above is SUPERSEDED. Re-read this section before the older one.**

Between the previous run and this one, `rebuild/v2026.916.0-survivors`
advanced 41 commits:

    git ls-remote origin refs/heads/rebuild/v2026.916.0-survivors
      -> 916919bb7cbdbdfddaac59e31bf6b2e94bcf637c
    git merge-base f17538edf4 refs/remotes/origin/rebuild/v2026.916.0-survivors
      -> 694d0fbe002a7214f027a2f5d09a5b69d0686a4c   (UNCHANGED)
    git rev-list --count f17538edf4..refs/remotes/origin/rebuild/v2026.916.0-survivors
      -> 41

`gh api .../pulls/125 --jq .base.sha` still reports `694d0fbe002a` because
GitHub's REST `base.sha` is the merge base pinned when the PR was opened, not
the live branch tip. Reading `.base.sha` alone would have pinned a 41-commit-
stale base. **The live tip `916919bb7c` is the correct B for a merge, and it
is what CI actually built.**

The material consequence: `f519242095` ("feat(engine): refuse an
agent-created root issue that names no project", SPA-9498, merged as PR #130
in `a4bc04c428`) landed on base inside that window. It adds
`assertAgentRootIssueHasProject` to `server/src/services/issues.ts`, which
throws 422 on an agent-created root issue that names no project. Three
existing test files predate that guard and do not name a project, so they now
fail. This is **another card's change**, and the evidence below shows the
failing state is the base's alone.

Reproduction, run 2026-10-03 in a throwaway worktree at `/srv/bulk/probe/base-tip-9437`
(NOT the card worktree, NOT scratch — it survives teardown):

    # 1. Base tip ALONE, zero SPA-9437 code present
    git checkout --detach 916919bb7cbdbdfddaac59e31bf6b2e94bcf637c
    cd server && pnpm exec vitest run \
      src/__tests__/status-cards.test.ts \
      src/__tests__/plugin-orchestration-apis.test.ts \
      src/__tests__/permissions-upgrade-boundary-routes.test.ts

    RESULT: exit 1 — Test Files 3 failed (3); Tests 3 failed | 53 passed (56)
    Failure signature, identical in all three, and identical to the head's:
      Error: An agent-created task must belong to a project, but this create
      resolved no project: it is a root task (no parent) and names neither
      projectId nor a project/execution workspace to infer one from.
      at assertAgentRootIssueHasProject (src/services/issues.ts:368:9)
      at persist (src/services/issues.ts:9929:9)
    server-12 CI log shows the same for status-cards.test.ts:406
    (`expected 422 to be 201`); verify-7 for
    permissions-upgrade-boundary-routes.test.ts:311.

    # 2. POSITIVE CONTROL — the commit before the guard, same tree otherwise
    git checkout --detach 24597d524fe5cf8962c932f164a9b4dc4c354678  # f519242095~1
    cd server && pnpm exec vitest run <same three files>

    RESULT: exit 0 — Test Files 3 passed (3); Tests 56 passed (56)

    This pair is the causation proof: the reds appear at `f519242095` and are
    absent at its parent, on the same base, with no SPA-9437 code in either run.

    # 3. NEGATIVE CONTROL — my head merged onto the new base
    git checkout --detach 916919bb7c
    git merge --no-ff f17538edf4ed1699d2054bd52b341e05232df4a8
      -> "Automatic merge went well" (exit 0; no conflict)
    cd server && pnpm exec vitest run <same three files>

    RESULT: exit 0 — Test Files 3 passed (3); Tests 56 passed (56)

    My change does not cause the reds and does not fix them. The exemption
    holds on the live base, and CI's failure is inherited, not introduced.

Head-red inventory at `f17538edf4` (run 37097395276, `pull_request` event,
now fully terminal — zero checks `queued`/`in_progress`). Authoritative count
via `check-runs` (NOT `gh pr checks`, which reported 1 and 8 on two
consecutive reads of the same head and is unreliable here):

    gh api repos/Spark-Mojo/paperclip/commits/f17538edf4.../check-runs \
      --paginate --jq '.check_runs[] | select((.conclusion // "") == "failure") | .name' | sort

  **9 reds, and every one is accounted for** (7 REAL base reds + 2 aggregates
  + 1 rule-exempt — the arithmetic is 9 checks total, of which 6 real):

  | # | check                                       | verdict |
  |---|---------------------------------------------|---------|
  | 1 | `ci / policy`                               | REAL base red (re-verified this run, both revs) |
  | 2 | `ci / General tests (workspaces-b)`         | REAL base red — EPIPE unhandled teardown; 1232 tests PASS, only `Errors 1` |
  | 3 | `ci / General tests (server (11/12))`        | REAL base red (new) — plugin-orchestration-apis.test.ts:236, 422 |
  | 4 | `ci / General tests (server (12/12))`        | REAL base red (new) — status-cards.test.ts:406, 422 |
  | 5 | `ci / Verify serialized server suites (6/9)` | REAL base red (new) — permissions-upgrade-boundary-routes.test.ts:311, 422 |
  | 6 | `ci / Verify serialized server suites (7/9)` | REAL base red (new) — same 422 signature |
  | 7 | `ci / e2e`                                  | AGGREGATE — see proof below |
  | 8 | `ci / verify`                               | AGGREGATE — `Fail if any split verify lane failed`, lanes 6/9 and 7/9 |
  | 9 | `review`                                    | EXEMPT BY RULE — vendor `commitperclip`, no key on the fork |

`ci / e2e` — aggregate claim proven, not assumed. All 8 e2e SHARDS are
`success` (`e2e shard (1/8)`..`(8/8)`). Its job log (id 111132424517) is 50
lines and fails on the very FIRST executed line, before any shard result is
consumed:

    Run test "$POLICY_RESULT" = "success"
    env:
      FULL_CI: true
      POLICY_RESULT: failure      <- the inherited ci / policy red
      E2E_SHARDS_RESULT: success
    ##[error]Process completed with exit code 1.

So its failure is derived from #1 alone. It is not an independent exemption
and must not be counted as one.

`ci / policy` re-verified THIS run at both revs, since it names files I edit:

    node scripts/check-no-git-push.mjs   # at 916919bb7c (no SPA-9437 code)
      -> exit 1, 3 offenses, byte-identical output
    node scripts/check-no-git-push.mjs   # at f17538edf4
      -> exit 1, 3 offenses, byte-identical output

Offense count is unchanged at 3, and the check is boolean
(`if (allOffenses.length > 0)`, line 171), so the verdict is identical under
any threshold reading. Critically, the flagged line
`workspace-runtime.ts:4908` is NOT in my diff
(`git diff <base>..f17538edf4 -- server/src/services/workspace-runtime.ts |
grep -E '^[+-].*git push'` -> no match), and the two files the policy names
GREW under my change (workspace-runtime.ts 10148 -> 10337 lines;
workspace-runtime.test.ts 11233 -> 11833 lines) while the reported line
numbers stayed put, which is only consistent with the offenses sitting
outside my hunks. My new `execution-workspaces.ts` helper adds zero
`git push`-matching lines.

My own SPA-9437 acceptance tests, re-run on the NEW base (gates 10-16 green):

    # at merge 74a54c0f69 (916919bb7c + f17538edf4)
    pnpm exec vitest run src/__tests__/workspace-runtime.test.ts \
      -t 'SPA-9437|pushed to origin|unpushed runtime-owned commit'
      -> exit 0 — Test Files 1 passed; Tests 9 passed | 183 skipped (192)
    pnpm exec vitest run src/__tests__/issues-service.test.ts
      -> exit 0 — Test Files 1 passed; Tests 133 passed (133)

The full `workspace-runtime.test.ts` file reports 6 failures on the new base
(all pnpm worktree-provisioning / install-sandbox tests, none SPA-9437). Those
6 are base reds too — same 6 identical test names, `6 failed | 179 passed`,
at `916919bb7c` with no SPA-9437 code present. This is the known gate 13
provisioning-suite red, unchanged in character.

## Head `a73300e388` — base-red closure, re-run 2026-10-03 (run 09549db5 successor)

The head advanced by four commits (all ledger + tests, no production change)
since the section above, and CI is terminal on it. This section records the
base-red evidence for THIS head, re-measured rather than inherited.

### What CI actually builds — the merge commit, not the head

This is the fact the earlier sections were reasoning around, now stated
mechanically. GitHub's `pull_request` event checks out the MERGE commit:

    gh api repos/Spark-Mojo/paperclip/pulls/125 --jq .merge_commit_sha
      -> cab4612b27e20e5e88715ca3d9929d64c5a2a1f5
    gh api .../commits/cab4612b27e.../check-runs  (job 111138454006 log, line 132)
      -> HEAD is now at cab4612 Merge a73300e388a... into 916919bb7cbd...
    parents: 916919bb7cbdbdfddaac59e31bf6b2e94bcf637c   (base side)
             a73300e388a7233d3fe553fbdda35f3339701a34   (this PR)

Consequences, both load-bearing for the exemptions below:

  - Every SPA-9437-specific gate result in this ledger is a property of the
    HEAD SIDE, and every failing assertion lives on the BASE SIDE or in a file
    the base side supplies. The comparison that matters is therefore
    base-side vs merge, not branch vs base.
  - `git merge-base a73300e388 62bab46c6f34` = `694d0fbe002a` — so the
    open-time pin and the live tip share a merge base, and the live tip
    `62bab46c6f` (41 commits past `916919bb7c`) is where a merge lands.

### Causal non-touch, by blob identity at base side vs the CI-built merge

    git rev-parse 916919bb7c:<f>  cab4612b27e:<f>

  | file                                                      | blob (BOTH) |
  |-----------------------------------------------------------|-------------|
  | `server/src/__tests__/status-cards.test.ts`                | `285060b75` |
  | `server/src/__tests__/plugin-orchestration-apis.test.ts`  | `b54fe6e31` |
  | `server/src/__tests__/permissions-upgrade-boundary-routes.test.ts` | `89c00485e` |
  | `packages/adapter-utils/src/server-utils.test.ts`         | `2e47e14c`  |
  | `scripts/check-no-git-push.mjs`                           | `7254f6caf` |

All five byte-identical, so the PR cannot have altered any failing assertion
or the policy check. `server/src/services/issues.ts` DOES differ
(`4d2f0f2ef` -> `192d89a44`) because both sides changed it — this PR adds the
rebind post-commit action, the base side adds the 422 guard — but the guard is
absent from every commit on this branch:

    git grep -c assertAgentRootIssueHasProject a73300e388 -- server/src packages
      -> 0     (present ONLY as prose inside this ledger)

### Base reproduction — re-run, not log-reading

Throwaway worktrees (NOT the card worktree, NOT scratch):
`/tmp/base-red-a` at `916919bb7c` (base side, zero SPA-9437 code) and
`/tmp/base-red-merged` at `cab4612b27e` (exactly what CI built). Both got
their own `pnpm install --frozen-lockfile --ignore-scripts`; symlinking the
card worktree's `node_modules` does not resolve `express` (it lives in
`server/package.json` but links through the root `.pnpm` store).

**(a) The 422 family — all FOUR files, not three.** The earlier record covered
three; `issue-watchdogs-routes.test.ts` (job `Verify serialized server suites
(6/9)`) was unaccounted for. At `916919bb7c`, zero SPA-9437 code:

    vitest run src/__tests__/status-cards.test.ts \
               src/__tests__/plugin-orchestration-apis.test.ts \
               src/__tests__/issue-watchdogs-routes.test.ts \
               src/__tests__/permissions-upgrade-boundary-routes.test.ts

    exit 1 — Test Files 4 failed (4); Tests 4 failed | 12 passed (14)
    every failure: `expected 422 to be 201 // Object.is equality`
    every failure: `at assertAgentRootIssueHasProject (src/services/issues.ts:368:9)`

Same check identity, same test name, same assertion as each head job.

**(b) `workspaces-b` EPIPE.** At `916919bb7c`, base side only:

    vitest run packages/adapter-utils/src/server-utils.test.ts
    exit 1 — Test Files 1 passed (1); Tests 126 passed (126); Errors 1 error
             `Error: write EPIPE` / `Serialized Error: { errno: -32, code: 'EPIPE', syscall: 'write' }`

Identical shape to the head job: every test passes, the file is torn down by
an unhandled error, so the assertion is on the ERROR COUNT, not a test failure.

**(c) `ci / policy`.** Same script at both revs, run this run:

    node scripts/check-no-git-push.mjs   # at 916919bb7c -> exit 1, 3 offenses
    node scripts/check-no-git-push.mjs   # CI reported    -> exit 1, 3 offenses

Output byte-identical once line numbers are normalized: `4908 -> 5121`,
`4610 -> 4625`, `4615 -> 4630` (my hunks add lines; the offense CONTENT is
unchanged). The check is boolean (`if (allOffenses.length > 0)`, line 171) and
the count is unchanged, so the verdict is identical under any threshold.

**(d) Discriminating control on the tree CI built.** At `cab4612b27e`:

    vitest run <the same four files>
    exit 1 — Test Files 4 failed (4); Tests 4 failed | 63 passed (67)
    same four test names, same 422 assertion

Base-only fails 4/4 and base+head fails the same 4/4: my change neither
introduces nor repairs these. This is the pair that makes the exemption a
measured claim rather than an inference.

## Head `9079d79a83` — base side ADVANCED, exemption set re-derived 2026-10-03

**The base moved again and the merge ref was recomputed, so every pin in the
section above is stale for this head.** This supersedes it.

    gh api .../pulls/125 --jq .merge_commit_sha  -> f41eae677d9697f97828186a57ec8169e7c631ab
    parents of that merge:
      62bab46c6f3429a773bbff7dda3e6c33f1167085   (base side — the LIVE TIP now)
      9079d79a83619071c9c669290a55ee52d6c95177   (this PR head)

The base side is no longer `916919bb7c`; it is the live tip `62bab46c6f`, whose
tip commit is `62bab46c6f Merge pull request #140 from
Spark-Mojo/feat/spa-10137-live-fleet-cap`. A NEW red appeared with it.

**The exemption set is not stable across heads**, exactly as warned. The new
check `ci / Verify serialized server suites (5/9)` was green on `a73300e388` and
red on `9079d79a83`. It needed its own reproduction; it does not inherit the
earlier evidence.

### The new red — `openapi-routes.test.ts`, an OpenAPI route-coverage test

This one was NOT assumed to be a base red. It is change-sensitive by
construction (it diffs mounted routes against the spec), so it got the full
treatment:

    # head job 111143235425, lane 5/9
    FAIL @paperclipai/server src/__tests__/openapi-routes.test.ts >
         openapi routes > covers the mounted server routes exactly
    -   "missingInSpec": [],
    +   "missingInSpec": [
    +     "GET /api/instance/settings/fleet-max-concurrent-runs",
    +     "PATCH /api/instance/settings/fleet-max-concurrent-runs",
      ❯ src/__tests__/openapi-routes.test.ts:723:8
    Test Files 1 failed (1); Tests 1 failed | 8 passed (9)

Attribution by blob identity — identical at base side, at the CI-built merge,
and at my head, so the assertion itself is untouched by this PR:

    | rev                                        | blob (all three) |
    |--------------------------------------------|-----------------|
    | `62bab46c6f` (base side)                   | `9e2975386`     |
    | `f41eae677d` (what CI built)               | `9e2975386`     |
    | `9079d79a83` (my head)                     | `9e2975386`     |

    git diff 694d0fbe..9079d79a83 -- server/src/routes   -> EMPTY

The two named routes are mounted by base-side PR #140 (fleet-cap), which is why
the base side reports them missing from the spec and my branch never does.

Reproduction, both throwaway worktrees with their own `pnpm install`:

    # base side ALONE, 62bab46c6f, zero SPA-9437 code
    vitest run src/__tests__/openapi-routes.test.ts
      exit 1 — Test Files 1 failed (1); Tests 1 failed | 8 passed (9)
      same test name, same assertion, same two missingInSpec routes

    # the tree CI BUILT, f41eae677d
    vitest run src/__tests__/openapi-routes.test.ts
      exit 1 — Test Files 1 failed (1); Tests 1 failed | 8 passed (9)

Base fails 1/1, base+head fails the same 1/1: inherited, not introduced.

### Every OTHER red re-proven against the NEW base side `62bab46c6f`

The earlier reproductions were pinned to `916919bb7c`, which is now two merges
back. Re-run at the base side CI actually used this time:

| red | command at `62bab46c6f` | result |
|-----|--------------------------|--------|
| 422 family (4 files) | `vitest run status-cards / plugin-orchestration-apis / issue-watchdogs-routes / permissions-upgrade-boundary-routes` | exit 1 — `4 failed \| 63 passed (67)`, same 4 names |
| `workspaces-b` EPIPE | `vitest run packages/adapter-utils/src/server-utils.test.ts` | exit 1 — `1 passed (1); 126 passed (126); Errors 1 error`, `write EPIPE` |
| `ci / policy` | `node scripts/check-no-git-push.mjs` | exit 1, 3 offenses |
| `ci / policy` at `f41eae677d` | same script | exit 1, 3 offenses — output IDENTICAL modulo line numbers (`diff` of both outputs with `:N:` normalization is empty) |

The policy check script is blob `7254f6caf` at both revs and boolean at line 171,
so the verdict is threshold-independent.

### Red inventory on `9079d79a83` — enumerated from THIS head, mid-flight

As of this write, 41 of 46 checks are complete, 5 in progress
(`e2e shard (7/8)`, `Canary Dry Run`, `Paperclip Runner (rust)`,
`Typecheck + Release Registry`, `Build`). Recorded so far:

    ci / General tests (server (11/12))                              422, reproduced above
    ci / General tests (server (12/12))                              422, reproduced above
    ci / General tests (workspaces-b)                                EPIPE, reproduced above
    ci / policy                                                      3 offenses, reproduced above
    ci / Verify serialized server suites (5/9)                       openapi-routes, NEW, reproduced above
    ci / Verify serialized server suites (6/9)                       422, reproduced above
    ci / Verify serialized server suites (7/9)                       422, reproduced above
    review                                                            vendor commitperclip, exempt by rule
    ci / e2e                                                          aggregate, pending shard 7/8
    ci / verify                                                       aggregate of the split lanes

**This inventory is NOT final and MUST be re-read from a terminal head before
verify is dispatched.** The aggregates cannot be classified until their inputs
are terminal, and a further base advance can add or clear a check — that is
exactly what happened twice already.

### Terminal red inventory at `a73300e388` — 9 reds, all accounted for

    gh api .../commits/a73300e388.../check-runs --paginate \
      --jq '.check_runs[] | select(.conclusion=="failure") | .name' | sort
      -> ci / e2e, ci / General tests (server (11/12)),
         ci / General tests (server (12/12)),
         ci / General tests (workspaces-b), ci / policy, ci / verify,
         ci / Verify serialized server suites (6/9),
         ci / Verify serialized server suites (7/9), review

  | # | check                                       | verdict |
  |---|---------------------------------------------|---------|
  | 1 | `ci / policy`                               | REAL base red — (c) above, 3 offenses both revs |
  | 2 | `ci / General tests (workspaces-b)`         | REAL base red — (b) above, EPIPE, 126 pass + 1 error |
  | 3 | `ci / General tests (server (11/12))`       | REAL base red — plugin-orchestration-apis.test.ts:236, 422 |
  | 4 | `ci / General tests (server (12/12))`       | REAL base red — status-cards.test.ts:406, 422 |
  | 5 | `ci / Verify serialized server suites (6/9)` | REAL base red — issue-watchdogs-routes.test.ts, 422 |
  | 6 | `ci / Verify serialized server suites (7/9)` | REAL base red — permissions-upgrade-boundary-routes.test.ts:311, 422 |
  | 7 | `ci / e2e`                                  | AGGREGATE — derived from #1 (`POLICY_RESULT: failure`) |
  | 8 | `ci / verify`                               | AGGREGATE — `Fail if any split verify lane failed` = #5, #6 |
  | 9 | `review`                                    | EXEMPT BY RULE — vendor `commitperclip`, no key on the fork |

Note `Verify serialized server suites (2/9)` is GREEN on this head (it was red
on `f17538edf4`): its lane is flaky-by-lane, not fixed by me, and it is not
counted as an exemption either way.

`ci / e2e`'s job log (id to be read at merge time; on `f17538edf4` it was
111132424517) fails on its FIRST executed line, before any shard result is
consumed, with `POLICY_RESULT: failure` and `E2E_SHARDS_RESULT: success` — all
8 shards `success`. So #7 derives from #1 alone and is not an independent
exemption.

## Verifier round 1 (FAIL) — disposition, recorded 2026-10-03

The independent verifier returned `VERDICT: FAIL` on head `3bd031e416` with
three substantive findings. Disposition of each, with evidence:

**Finding 6 (out-of-scope behaviour change on the clone path) — UPHELD, then
answered with a control, and the code left unchanged.** The verifier read the
rewritten `routes non-reusable persisted git worktrees` expectation as the
guard replacing a correct cleanup path with a refusal. I built the
`not_a_registered_worktree` fall-through for exactly that reading, ran it,
and it did not fire — which disproved the premise. Measured:

    # fixture: clone nested INSIDE the OLD repo
    git -C origin worktree list --porcelain   -> reports the nested clone path
    git -C c1   worktree list --porcelain    -> reports itself

`inspectManagedGitWorktreeBranch` reads `repoRoot` as the clone's OWN
`--show-toplevel`, not the OLD repo, so `git worktree remove` runs against the
clone and the path IS registered. Two consequences:

  1. The `not_registered` expectation the verifier calls "pre-existing" was
     NEVER produced by this fixture — `listLinkedGitWorktreePaths(repoRoot)`
     returns the clone, so the old code took `wrong_repository_root`, not
     `not_registered`. I did not run base for this; this is the fixture's own
     construction, so treat it as reasoned, not measured, until someone
     reproduces it at `916919bb7c`.
  2. The teardown therefore genuinely cannot apply to this shape, and the
     guard's refusal is CORRECT — the alternative is leaving a directory that
     can never be removed by `git worktree remove`.

So the fall-through was reverted (`git checkout -- workspace-runtime.ts`); the
production code is byte-identical to what the verifier reviewed. What changed
is the misleading comment above the fixture, which claimed the clone is "not
in the OLD repo's linked-worktree list" — untrue for this fixture — and a new
negative-control test.

**New gate 17 (negative control for the guard's boundary).**

    CHECK: timeout 600 pnpm exec vitest run server/src/__tests__/workspace-runtime.test.ts \
      -t 'SPA-9437|unpushed runtime-owned commit|pushed to origin|non-reusable persisted git worktrees'
    EXPECT: exit 0; all 11 selected tests pass
    RESULT: exit 0 — Test Files 1 passed (1); Tests 11 passed | 182 skipped (193)

`still tears down a REGISTERED other-repo worktree (SPA-9437 negative control
for the clone fall-through)` asserts the path IS in the OLD repo's
`git worktree list` BEFORE the call (precondition stated, not assumed) and
that it is afterwards absent from disk AND pruned from the OLD repo. Without
that precondition the test could pass via the fall-through and prove nothing.

Re-run of gate 10 after this change: `vitest run src/__tests__/issues-service.test.ts`
-> exit 0, 133/133 passed. Gate 8 re-run explicitly (not inferred): `tsc
--noEmit --project server/tsconfig.json` exits 1 with 115 pre-existing
diagnostics, and `grep -cE 'workspace-runtime\.ts|issues\.ts|execution-workspaces\.ts'`
over that output is **0** — no diagnostic in any changed file. Gate 9
`git diff --check` -> exit 0.

**Finding 7 (gates 13/14 UNPROVEN) — accepted as stated, left honest.** Not
converted to green. Gate 13's 6 failures are proven base reds; gate 14's
typecheck nonzero is from a missing runner build and 115 pre-existing
diagnostics, none in changed files.

**Finding 8 (reds unprovable as base reds on the wrapper surface) — the
verifier's evidence is incomplete; the required stand-in exists.** The
verifier reported that `pr-read.sh checks` shows no `ci / …` run on
`694d0fbe` or `916919bb7`. That is correct — and it is exactly the clause-4
case ("if the base ref itself has NO CI run … a run on an ANCESTOR of B may
stand in"). The stand-in was not gathered for this round. It is now:

    A = f519242095fac059955387af6f68cc28e1408895   (PR #130 head = the 422 guard)

    git merge-base --is-ancestor f519242095... 916919bb7c   -> exit 0
    gh api .../commits/f519242095.../check-runs --jq .total_count -> 48

A's reds, which is a SUPERSET of every head red:

    ci / e2e, ci / e2e shard (8/8), ci / General tests (server (11/12)),
    ci / General tests (server (12/12)), ci / General tests (workspaces-b),
    ci / policy, ci / verify, ci / Verify serialized server suites (2/9),
    ci / Verify serialized server suites (6/9),
    ci / Verify serialized server suites (7/9), review

Per-check signature match, A job vs head job (same failing test name and same
assertion in each):

  | head check                                  | A job     | head job   | shared failure signature |
  |---------------------------------------------|-----------|------------|-------------------------|
  | `Verify serialized server suites (6/9)`      | 109733735602 | 109865347710 | `issue-watchdogs-routes.test.ts > routes watchdog-discovered product bugs…`, AssertionError |
  | `Verify serialized server suites (7/9)`      | 109733735656 | 109865347673 | `permissions-upgrade-boundary-routes.test.ts > allows same-company route assignment…`, AssertionError |
  | `General tests (server (11/12))`             | 109733735763 | 109865348116 | `plugin-orchestration-apis.test.ts > creates plugin-origin issues…`, `agent_root_issue_requires_project` |
  | `General tests (server (12/12))`             | 109733735686 | 109865348094 | `status-cards.test.ts > attributes API-level authoring…`, AssertionError |

  `General tests (workspaces-b)` A 109733735732 vs head 109865348124: both
  report `Test Files 59 passed (59)` then an uncaught
  `Error: { errno: -32, code: 'EPIPE', syscall: 'write' }`.

  `ci / policy` A 109733735536 vs head 109865347255: both run
  `node ./scripts/check-no-git-push.mjs` and emit the same 3 offenses. Line
  numbers shift (A 4884/4572/4577, head 4908/4610/4615) because the PR adds
  lines, so identity is proven by CONTENT: `scripts/check-no-git-push.mjs` is
  blob `7254f6caf` at BOTH the base tip and the head.

Causal non-touch, by blob identity at base tip vs head:

  | file                                                 | blob (both) |
  |------------------------------------------------------|-------------|
  | `server/src/__tests__/status-cards.test.ts`            | `285060b75` |
  | `server/src/__tests__/plugin-orchestration-apis.test.ts`| `b54fe6e31` |
  | `server/src/__tests__/permissions-upgrade-boundary-routes.test.ts` | `89c00485e` |
  | `scripts/check-no-git-push.mjs`                       | `7254f6caf` |

All four are byte-identical at `916919bb7c` and at the head, so the PR cannot
have altered the failing assertions or the policy check. This is the same
proof pattern SPA-9405 (`4a9f969d07`) and SPA-9283 (`a6e4473b1a`) recorded on
this fork, which is why A was chosen the same way.

**Acceptance (SPA-9359) remains RUNTIME-ONLY and unproven.** The verifier
agreed and correctly noted it is a check-state note, not acceptance.

## Notes

18. Gate re-run ledger for head `a73300e388`, 2026-10-03, all in the foreground
    under `timeout` on the card worktree:

    | gate | command | result |
    |------|---------|--------|
    | 17 | `vitest run server/src/__tests__/workspace-runtime.test.ts -t 'SPA-9437|unpushed runtime-owned commit|pushed to origin|non-reusable persisted git worktrees'` | exit 0 — `Test Files 1 passed (1); Tests 11 passed \| 182 skipped (193)` |
    | 10 | `vitest run server/src/__tests__/issues-service.test.ts` | exit 0 — `Test Files 1 passed (1); Tests 133 passed (133)` |
    | 8  | `tsc --noEmit --project server/tsconfig.json` | exit 1, 111 pre-existing diagnostics; `grep -cE 'workspace-runtime\.ts\|issues\.ts\|execution-workspaces\.ts'` over the output = **0** |
    | 9  | `git diff --check` | exit 0, empty output |

    Gate 8's nonzero exit is unchanged in character from every prior run: the
    diagnostics come from a missing `@paperclipai/paperclip-runner` build plus
    pre-existing implicit-any errors in files this PR does not touch. Zero of
    them land in a changed file, which is the gate's actual assertion.

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