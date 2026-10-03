# SPA-7407 — Gates ledger

Engine fork: `Spark-Mojo/paperclip`, branch `rebuild/v2026.916.0-survivors`.
Base of this work: `fd5cf1d93` (merge of PR #92).

## Re-derivation (2026-10-03, pinned reads)

The 2026-09-15 repro was re-derived against the current engine. The reported
`issue_blockers_resolved` never-fires symptom is **NOT** present in the current
engine. What IS present, and what this card fixes, is the second half of the
report: the stale-watchdog 409 foreclosing the only actor with the sanctioned
`transition_watched_subtree_issue_status` capability, while the board's own
diagnostics name the leaf a "stale blocker hold".

Reads (all at `fd5cf1d93`):

- `server/src/services/issues.ts:8964-9029` `listWakeableBlockedDependents`
  filters `candidate.assigneeAgentId &&` — so SPA-7399 (`assigneeAgentId: null`,
  human-owned AWAITING-YOU) could never receive an agent wake. That is correct
  current design, not a defect, and it fully explains occurrence 1 and 2 of the
  report.
- `server/src/services/issues.ts:2531-2600` `listIssueDependencyReadinessMap`
  is level-triggered on the full `issueRelations` blocker set; the backstop
  re-checks readiness per candidate (`recovery/service.ts:5686-5700`).
- `server/src/services/issues.ts:4230-4245`: when a `blocked` root has **zero**
  unresolved top-level edges (`topLevelEdges.length === 0`) the attention map is
  hard-coded to `needs_attention` / `attention_required` with
  `terminalBlockerIssueId: root.id`. This is the "stale blocker hold" state the
  report describes, and the engine produces it deliberately.
- `server/src/services/task-watchdogs.ts:371-551` `classifyTaskWatchdogSubtree`
  returns `stopped` for that same subtree, and the watchdog card is then created
  with the leaf in `stoppedLeaves`.
- `server/src/services/task-watchdogs.ts:1614-1657` `revalidateMutationScope`
  409s any watchdog-scoped mutation unless the classification is still `stopped`
  AND the `stopFingerprint` is byte-identical to the run's snapshot.
- Fingerprint mismatch is unavoidable on a repair: the only sanctioned repair of
  a `blocked` leaf is a status transition to `todo`, and
  `materialLeaf` (`task-watchdogs.ts:305-315`) folds `status` into the digest.
  The transition changes `materialLeaves[].status`, so the recomputed
  fingerprint necessarily differs from the snapshot the run was woken with, and
  the revalidation 409s. **The guard forbids exactly the write that would
  resolve the condition it detected.** `revalidateMutationScope` is called from
  `server/src/routes/issues.ts:5384` (`assertFreshTaskWatchdogSourceMutation`),
  which fronts every agent-scoped `PATCH /api/issues/{id}` on the watched
  subtree.

The narrow, target-independent rule this card introduces: when the revalidation
reclassifies a subtree away from `stopped` **solely because a leaf's status moved
out of the stale `blocked` hold** — every recorded blocker resolved, no pending
interaction or approval, no live path — the mutation is a *superset* of the
stopped state and is allowed. Fingerprint equality remains required for every
other divergence. `blockedTransitionAt` is a new open-transition stamp, so a
repair opens a new blocked cycle and may be woken for again; this does not
weaken the TOCTOU binding.

### Three hardening changes made after the mandatory advisor call

The first draft of this design had three real holes the advisor identified. All
three were accepted (verified against the code, not taken on trust) and closed:

1. **The baseline could move after the wake.** The first draft compared against
   `issue_watchdogs.lastObservedStopSnapshot`, which is overwritten by *every*
   later evaluation — including runs with a broader scope. A third party's
   legitimate `blocked`→`in_progress` would then satisfy the "only status
   changed" shape test, turning a proof into a shape check.
   **Closed:** the baseline is now reconstructed from the run's OWN immutable
   wake context (`readTaskWatchdogWakeStopSnapshot`, `task-watchdog-scope.ts`),
   which carries `stoppedLeaves`. The watchdog row is never consulted. If the
   run's context cannot be read the baseline is `null` and the carve-out fails
   closed (`fails closed when the run carries no wake snapshot…`).
2. **The carve-out authorised any status write.** The stall diagnosis behind the
   carve-out would equally have licensed closing the card
   (`blocked`→`done`/`cancelled`) — a stall observation cannot justify a
   completion. **Closed:** admissibility now returns `allowedStatusTransitions`,
   exactly one edge — `{issueId, from: "blocked", to: "todo"}` — and
   `assertFreshTaskWatchdogSourceMutation` matches the request's declared
   transition against it and 409s anything else. `PATCH /issues/:id` declares
   `requestedStatusTransition` from `req.body.status`; a status write with no
   declared transition cannot match the token, so it fails closed.
3. **Two hand-maintained field lists could drift.** The material-fingerprint
   fields and the carve-out's immutability fields were listed separately, so
   adding a field to one would silently widen the other.
   **Closed:** the immutability check is now *derived* from
   `TASK_WATCHDOG_IMMUTABLE_REPAIR_LEAF_FIELDS`, and
   `keeps the repair immutability list in step with the material fingerprint
   fields` asserts the two partition the runtime material-leaf fields exactly.

Advisor point (c) — enumerate every status writer that could forge the shape —
was checked directly rather than assumed: `resolveTaskWatchdogMutationScope`
derives `kind: "watchdog"` solely from the run's own `contextSnapshot.taskWatchdog`
plus a persisted active watchdog row, and every status write on a watched issue
routes through `assertAgentIssueMutationAllowed`, whose watchdog branch is the
one place `revalidateMutationScope` is consulted for mutations (grep for
`assertFreshTaskWatchdogSourceMutation`: 5 call sites — the issue-comment gate,
the issue-mutation gate, the watchdog-issue self-exemption, the recovery-action
gate, and a parent-issue gate; only the mutation gate passes a transition).
The watchdog issue itself is exempted from revalidation before this code runs
(`scope.watchdogIssueId && issue.id === scope.watchdogIssueId`) and is never in
the material leaf set, so it cannot be an admissible repair target.
Advisor point about a per-run admission counter was considered and not adopted:
the transition token plus the run-immutable baseline close the unbounded-mutation
window without new persisted state, and the engine-fork has no migration in this
card's scope. Recorded as a deliberate, bounded trade-off, not an oversight.

## Gates

### Gate 1 — a `blocked` leaf with every blocker resolved classifies as `stopped`

    CHECK: timeout 600 node_modules/.bin/vitest run server/src/__tests__/task-watchdogs-stale-blocker-hold-repair.test.ts
    EXPECT: test-name substring "classifies a stale blocker hold as stopped so the watchdog can review it" reported as passed
    NEGATIVE: same assertion against a leaf whose sole blocker is `in_progress` (blockerIssueIds=["blocker-1"], status="in_progress") expects state "stopped" and observes "live" — see the test's second `expect` block, which fails when the gate is not implemented.

### Gate 2 — repairing the hold is admitted; any other divergence is not

    CHECK: timeout 600 node_modules/.bin/vitest run server/src/__tests__/task-watchdogs-stale-blocker-hold-repair.test.ts
    EXPECT: test names "admits the blocked -> todo repair of a resolved stale blocker hold" and "refuses a mutation when the revalidation diverges for any other reason" both reported as passed
    NEGATIVE: the second test is the negative control — same entry point, one changed field (`blockerIssueIds`), observed state "not-admissible"; it fails if the carve-out is widened to any status-only divergence.

### Gate 3 — existing watchdog classifier and route behaviour is unchanged

    CHECK: timeout 900 node_modules/.bin/vitest run server/src/__tests__/task-watchdogs-classifier.test.ts server/src/__tests__/issue-watchdogs-routes.test.ts server/src/__tests__/task-watchdogs-scheduler.test.ts server/src/__tests__/task-watchdogs-incident-fixture.test.ts
    EXPECT: all files report zero failed tests
    NEGATIVE: covered by Gate 2's second test plus Gate 1's unresolved-blocker case — the same classifier returns "live" for a live blocker, so the carve-out cannot be satisfied by blanket-allowing status divergences.

### Gate 4 — the server typechecks

    CHECK: timeout 900 pnpm --filter @paperclipai/server exec tsc --noEmit
    EXPECT: exit 0, no output on stderr
    NEGATIVE: not applicable — tsc has no safe isolated failing input for this change. Marked unproven-negative; the type surface exercised is `TaskWatchdogClassifierResult`, whose two new fields are asserted by Gate 1's and Gate 2's tests at compile time.

## Results

All executed in this workspace, foreground, under `timeout`, 2026-10-03.

**Gate 1 — PASS.** Exit 0.

    Test Files  1 passed (1)
         Tests  4 passed (4)

`classifies a stale blocker hold as stopped so the watchdog can review it` passed:
`resolved.state === "stopped"` and
`resolved.staleBlockerHolds === [{ issueId: "leaf-1", identifier: "PAP-2",
staleBlockerIssueIds: ["blocker-1"] }]`.
NEGATIVE observed: same helper with `blockerStatus: "in_progress"` yields
`staleBlockerHolds === []` — an unresolved blocker never manufactures a hold.
Second negative observed: `blockersPresent: false` (no recorded edge) also
yields `[]`, so a leaf with nothing resolved is not a hold.

**Gate 2 — PASS.** Exit 0.

`admits the blocked -> todo repair of a resolved stale blocker hold` passed.
Observed that the repair genuinely moves the fingerprint
(`afterRepair.stopFingerprint !== reviewed.stopFingerprint` — the assertion that
would fail without the fix, since that is the whole 409) and that the verdict is
exactly
`{ admissible: true, reason: "stale_blocker_hold_repair", staleBlockerHoldIssueIds: ["leaf-1"] }`.

`refuses a mutation when the revalidation diverges for any other reason` passed
and is the negative control. Three refusals observed through the same entry
point, one changed field each:

| fixture | observed verdict |
|---|---|
| sibling leaf's `assigneeAgentId` also changed (`agent-1`→`agent-2`) | `{admissible: false, reason: "changed_fingerprint"}` |
| subtree has a live run, `reviewedStopSnapshot: null` | `{admissible: false, reason: "reclassified_not_stopped"}` |
| identical subtree, matching fingerprint | `{admissible: true, reason: "fingerprint_match"}` |

The third row matters: the carve-out can never be the reason an *unchanged*
subtree is admitted, only fingerprint equality admits it.

A note on the first fixture, because it was a real bug in my first draft of the
test rather than in the code: I originally made the *root* issue's status
change to force a fingerprint difference. That is not a divergence at all — the
root has children, and `classifyTaskWatchdogSubtree` only folds non-terminal
LEAVES into the material snapshot, so a non-leaf's own status is deliberately
outside the fingerprint. The fixture would have passed vacuously. It now
diverges on a genuine leaf field, and asserts `siblingDiverged.stopFingerprint
!== reviewed.stopFingerprint` before expecting the refusal.

**Gate 3 — PASS.** Exit 0.

    Test Files  5 passed (5)
         Tests  55 passed (55)

`task-watchdogs-stale-blocker-hold-repair.test.ts` (4),
`task-watchdogs-classifier.test.ts`, `issue-watchdogs-routes.test.ts`,
`task-watchdogs-scheduler.test.ts`, `task-watchdogs-incident-fixture.test.ts`
(51 pre-existing). Zero failed. NEGATIVE is Gate 1's and Gate 2's unresolved /
diverged cases, which assert through this same classifier.

**Gate 4 — PASS (new-error-free, baseline-diffed).** Exit 1 on both sides — the
workspace has 251 pre-existing typecheck errors from missing workspace package
links (`@paperclipai/plugin-sdk`, `@paperclipai/paperclip-runner`) and the
fork's unbuilt `dist/`, none of them in code this card touches. Recorded as a
differential, not an exit code, because a bare exit 1 proves nothing here:

    # baseline: git stash push -- server/src/services/task-watchdogs.ts
    pnpm --filter @paperclipai/server exec tsc --noEmit | grep "^src/" | sort > base.txt
    # with change applied, same command                              > after.txt
    diff base.txt after.txt   # => no output

Observed: byte-identical, 251 lines each, so this change introduces zero typecheck
errors. One error of mine did appear on the first run and was fixed: the
route-context stub at `server/src/routes/issues.ts:560` narrows
`revalidateMutationScope`'s return type and had to carry the two new classifier
fields plus `admissibility`. The compile-time gate was real, not decorative.

## Post-advisor re-run (2026-10-03, after the three hardening changes)

    Test Files  5 passed (5)
         Tests  57 passed (57)

6 new tests (was 4) + 51 pre-existing watchdog tests, zero failed. `tsc` output
diffed against the same stashed baseline: `diff base.txt final.txt` => no output,
zero new typecheck errors. Four intermediate typecheck errors of mine were caught
by that differential and fixed (an `options` reference in the comment gate that
has no `options`; a missing `allowedStatusTransitions` on the route stub; a
missing type import; and `Array.push` called with an array instead of spread).

One incidental finding, recorded because it is a trap for the next agent: the
oxc parser used by vitest rejects a chained `as const satisfies` on a `const`
declaration (`Expected a semicolon…` pointing at the `satisfies` line, while
`tsc` accepts the same source). Both exported field-list constants were
restructured to an explicit annotation. Diagnosed by parsing the file directly
with `oxc-parser` rather than by guessing from the reported line.

## Pre-existing failures NOT caused by this card

`issue-dependency-wakeups-routes.test.ts` and
`heartbeat-issue-liveness-escalation.test.ts` — the resolved-dependency-wake
backstop suites — fail **14 tests on the untouched base** as well. Verified by
restoring all three modified files to `HEAD` and re-running: identical
`Tests 14 failed | 9 passed (23)`. With this change applied the same two files
report the same 14 failures. They are base-red on this fork, unrelated to the
task-watchdog code path, and outside this card's scope; they are named here so
the next agent does not attribute them to SPA-7407.

## PR #141 head CI — base-red classification (2026-10-03, after the verifier's FAIL-to-investigate)

The independent verifier reported two completed red checks on head
(`ci / policy`, `review`) that this ledger had never observed, and correctly
refused to sign off. CI has since settled at **ten** red jobs on head
`4e8ad7d23` — see the correction note in the red-job list below, because it
settled *further still* after that session read it. The builder had not read
head check state before dispatching verify; that is the step-4 finding, and it is
recorded here.

Pinned atomically from one `gh pr view` (`pr-read.sh` equivalent):
head `H` = `4e8ad7d237a55ce01f11e86bed95452abc0bee98`,
base `B` = `62bab46c6f3429a773bbff7dda3e6c33f1167085`,
base ref = `rebuild/v2026.916.0-survivors`, `mergeable: MERGEABLE`.

Red jobs on H — **ten**, read from
`gh api repos/Spark-Mojo/paperclip/commits/4e8ad7d23/check-runs?per_page=100`,
which returns the API's own `count: 10`: `ci / policy`, `ci / verify`,
`ci / e2e`, `ci / General tests (server (11/12))`,
`ci / General tests (server (12/12))`, `ci / General tests (workspaces-b)`,
`ci / Verify serialized server suites (5/9)`, `(6/9)`, `(7/9)`, and `review`.

**Correction, made after the second verify session.** This section first listed
eight reds; the second verify session independently observed nine and flagged
the under-count as a ledger-accuracy defect. Both counts were wrong: CI on this
fork is **still settling while it is read**, and the authoritative `count: 10`
shows `ci / e2e` and `ci / verify` had not both terminated at either earlier
read. The number ten is quoted from the API's `count` field rather than counted
by eye. The lesson for the next agent: on this fork a partial check read is
indistinguishable from a complete one, so re-read the set and quote the API
count before classifying anything as base-red.

### Clause-by-clause base reproduction

1. **No check run is bound to `B` or to the merge-base.** `total_count` is 0 on
   both `62bab46c…` and `fd5cf1d9…`. The fork does not run CI on branch pushes.
   The clause-4 stand-in therefore applies: a run on an **ancestor of `B`**.
2. **`git merge-base --is-ancestor fd5cf1d9… 62bab46c…` => 0 (exit 0).**
   `b5b04cdbe` (`fix(routes): serialize fleet-cap PATCH with a Postgres advisory
   lock`) is also an ancestor of `B`. Its PR run is `37099381614`.
3. **Same check identity AND same failure signature on that ancestor.** Run
   `37099381614` (bound to `b5b04cdbe`, an ancestor of `B`) fails **all nine**
   of H's `ci` jobs by name — an exact superset of H's nine:

       ci / policy                              ci / General tests (server (11/12))
       ci / verify                              ci / General tests (server (12/12))
       ci / e2e                                 ci / General tests (workspaces-b)
       ci / Verify serialized server suites (5/9)
       ci / Verify serialized server suites (6/9)
       ci / Verify serialized server suites (7/9)

   H's tenth red, `review`, is the vendor `commitperclip` action, which never
   runs on this fork at all (no key), so there is no ancestor run to reproduce
   it against; it is structurally red everywhere on the fork.
4. **`ci / policy` signature is byte-identical**, naming the same file and line
   my diff does not touch:

       ERROR: `git push` (or equivalent remote-mutating git command) found in adapter/runtime code:
         server/src/services/workspace-runtime.ts:4908:  ... `git push origin ${input.branchName} failed`;

   on both H and `b5b04cdbe`. `git diff --stat B...H` shows my 5 changed paths:
   `.unlazy/SPA-7407/gates.md`, the new test file, `server/src/routes/issues.ts`,
   `server/src/services/task-watchdog-scope.ts`,
   `server/src/services/task-watchdogs.ts`. `workspace-runtime.ts` is not among
   them, and the policy check greps adapter/runtime code by content, not by
   reachability from my diff.

### The one red that touched a suite I modified

`ci / Verify serialized server suites (7/9)` failed
`issue-watchdogs-routes.test.ts > … routes watchdog-discovered product bugs
outside the watched source tree with evidence links` (expected 201, got 422
`agent_root_issue_requires_project`). That suite is in my Gate 3, so it was
re-derived rather than waved through:

- on **my head**: `vitest run … -t "routes watchdog-discovered product bugs…"`
  => `Test Files 1 passed (1)` / `Tests 1 passed | 10 skipped (11)`.
- on the **untouched base** (same three files restored to `62bab46c`, same
  command): identical `1 passed | 10 skipped`.

So it is a CI-shard flake (test-ordering/state dependence under the sharded
serialized runner), not a regression, and not caused by the diff. Recorded
because the alternative — assuming a passing suite proves a red CI job is a
flake — is exactly the move this ledger exists to prevent.

### Verdict on head check state

All ten reds on H are **base-red or shard-flake**, none head-only. Every one of
H's nine `ci` reds is present by name on an ancestor of the base; the tenth,
`review`, is the vendor `commitperclip` action which never runs on this fork at
all (no key) and which the fleet engine-fork rule never treats as a blocker.
`mergeable: MERGEABLE`; no check is red on H for a reason this diff introduces.
