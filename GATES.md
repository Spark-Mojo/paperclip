# GATES — SPA-8631: Reassignment strands cards — promote deferred wake on lock release + retry lease-skipped wake

Base branch: `rebuild/v2026.916.0-survivors` (fork head `ab1eea690`).
Branch: `SPA-8631-reassignment-promote-leased` (this worktree).

## Build shape

Two cases per card description, no new timers / watchdogs:

- **Case 1 (`deferred_issue_execution` park has no timer release):** every site that
  clears an issue's execution lock / `executionRunId` must promote the oldest
  `deferred_issue_execution` wake for that issue. Currently only
  `releaseIssueExecutionAndPromote` does this. `cancelStaleScheduledRetry` (in
  `enqueueWakeup`) clears `executionRunId` to null without promoting, and the
  PATCH `/issues/:id` reassign cancel path cancels the prior run via
  `heartbeat.cancelRun(...)` without promoting.
- **Case 2 (`execution_reconciliation_required` then skipped):** when the only
  reason a wake is skipped is the prior run's environment lease has not yet been
  released, re-queue with short `scheduled_retry` backoff, bounded to N=5
  attempts (5s, 10s, 20s, 40s, 80s = ~155s total). After N attempts, surface a
  recovery-required reason text so the existing recovery surface takes over.

## Gates

### G1 — TypeScript clean (no NEW errors vs base)
- **CHECK-BASELINE:** `cd server && pnpm exec tsc --noEmit 2>&1 | grep -c "error TS"` — record count on `origin/rebuild/v2026.916.0-survivors` (expect 140 pre-existing errors, all unrelated to this card — vendor module import issues from missing built deps and unrelated strict-mode findings).
- **CHECK-AFTER:** same command after build, with diff vs baseline.
- **EXPECT:** count does not increase. The added files compile clean under TS 7 (this branch is on `^7.0.2`); no diagnostic on `src/services/heartbeat.ts`, `src/routes/issues.ts`, `src/services/legacy-execution-recovery.ts`, `src/modules/run-dispatch/adapters/postgres.ts`, `src/modules/wake-queue/application/use-cases.ts`, or any new file under `src/__tests__/heartbeat-deferred-promote-on-reassignment.test.ts` / `src/__tests__/heartbeat-lease-not-released-retry.test.ts`.

### G2 — Case 1: deferred-wake promotion at the inline lock-clear sites
- **CHECK:** `cd server && pnpm exec vitest run src/__tests__/heartbeat-deferred-promote-on-reassignment.test.ts`
- **EXPECT:** exit 0, both tests pass:
  - "promotes a parked deferred wake when the issue lock has already been cleared by an inline cancel" — the cross-agent stale-holder cancel path (errorCode `lock_released_on_reassignment`)
  - "promotes a parked deferred wake when the cancelled run was a scheduled_retry" — the `cancelStaleScheduledRetry` path (errorCode `issue_reassigned`)

### G3 — Case 2: lease-not-released re-queue with bounded attempts
- **CHECK:** `cd server && pnpm exec vitest run src/__tests__/heartbeat-lease-not-released-retry.test.ts`
- **EXPECT:** exit 0, all three tests pass:
  - "re-queues the queued run as scheduled_retry with attempt=1 when the lease is not yet released" — first attempt
  - "after MAX_ATTEMPTS arrivals the run is terminally cancelled with recovery_action_required" — bound reached
  - "ignores non-lease execution_reconciliation_required causes (no scheduled_retry)" — `uncertain_provider_action` etc. keep terminal-skip behavior

### G4 — Existing heartbeat reassignment / lease tests still pass
- **CHECK:** `cd server && pnpm exec vitest run src/__tests__/heartbeat-lock-release-on-reassignment.test.ts src/__tests__/heartbeat-process-recovery.test.ts src/__tests__/heartbeat-retry-scheduling.test.ts -t "waits for a terminal predecessor"`
- **EXPECT:** exit 0, every test in every file passes.

### G5 — Full server test sweep (regression floor)
- **CHECK:** `cd server && pnpm exec vitest run`
- **EXPECT:** exit 0, total pass count > 0, total fail count == 0.

### G6 — PR opened on the fork (not draft)
- **CHECK:** `gh pr list --repo Spark-Mojo/paperclip --head SPA-8631-reassignment-promote-leased --state open --json number,isDraft,url`
- **EXPECT:** exactly one PR, `isDraft: false`, `url` present and pointing at `Spark-Mojo/paperclip`.

### G7 — Sign-off bound to PR head (verifier-driven)
- **CHECK:** verifier subagent returns `VERDICT: PASS` (per `WORKFLOW.md` step 4).
- **EXPECT:** verifier posts `<!-- requirements-signoff:v1 head=<sha> verdict=pass -->` on the PR, bound to the source HEAD; auto-merge arms on green.

## SPA-8655 regression (PR #70 not merge-approved at `e2b1623f`)

PR #70 regressed the signoff e2e shard: `tests/e2e/signoff-policy.spec.ts` 3 tests failed
twice in CI (`changes requested: reviewer bounces back to executor`,
`comment required: approval without comment fails`, `review-only policy: reviewer approval
completes execution`) with `invokeHeartbeat` 3s-poll timeout — no issue-bound run for the new
assignee. Reproduced locally on `e2b1623f` against base `ab1eea690` (base: 13/13 pass, head:
repeat failures), A/B starting from identical HTTP flows.

### Root cause

The `legacy-execution-recovery` exclusion added in `e2b1623f`
(`issue_reassigned` / `lock_released_on_reassignment` → `false`) was global. Its intended effect
was one call site —the wake-queue release pre-drain, so a reassignment cancel releases into the
deferred-wake drain. But it also flipped the recovery/retry schedulers that gate on the same
predicate (`enqueueProcessLossRetry` and `scheduleBoundedRetryForRun`): a run cancelled
`issue_reassigned` during a signoff handoff no longer reads as "needs reconciliation", so the
process-loss retry path scheduled a **fresh replacement run for the OLD assignee** right inside
the reassignment window. That replacement run entered the execution path (`queued` → `running`,
adapter echo-success), and the wake-queue admission
(`decideWakeAdmission` → `availableActiveExecutionRunPresent`) then **parked the NEW assignee's
stage wake** (`execution_review_requested`) as `deferred_issue_execution` behind an
old-assignee run. The old run's release pre-drains as `released` (succeeded) with no drain, so
the parked wake is never promoted — stranded until a human or an unrelated wake. Exactly one
deferred-wake park per handoff, hence exactly 3 failing tests, deterministically.

Answer to the card's design-floor question: **nothing** re-claims the parked wake after the lease
clears when no new wake arrives — the same "parked forever" gap Case-1 was built for, now
suffered by the next wake in the queue. With the retry leg removed (below) the wake never parks.

### Fix (this PR's head)

1. **Revert the global exclusion in `legacy-execution-recovery.ts`** to base semantics — a
   reassignment-cancelled run is terminal: no process-loss retry, no bounded retry, terminalized
   as before. This kills the old-assignee replacement run that parked the new wake.
2. **Scope the SPA-8631 Case-1 exemption to the wake-queue pre-drain only**
   (`wake-queue/adapters/postgres.ts`): the release still proceeds to the deferred-wake drain
   for `issue_reassigned` / `lock_released_on_reassignment` cancels, preserving Case-1's
   promotion of the new assignee's parked wake (its unit tests stay green).
3. **Drain guard (`wake-queue/application/use-cases.ts`):** the drain never promotes a plain
   issue-execution wake for an agent who is no longer the issue's owner (finishing run cancelled
   for reassignment with the wake same-agent, or wake-agent differing from the current assignee)
   — cancels it as obsolete instead of launching a former-owner run.

The DOD oracle (the signoff e2e shard) is green 1/1 locally so far with the fix; the targeted
unit suites run green (below).

## Captured actuals (SPA-8655 fix verification)

- **A/B evidence, signoff-policy e2e, local, runner box** (fake HOME for the doctor's
  managed-install shim check; `PAPERCLIP_PLAYWRIGHT_CHANNEL=chrome`):
  - `ab1eea690` (base): 5/5 pass — happy path 17.7s, changes-requested 1.2s, comment-required
    785ms, non-participant 939ms, review-only 1.3s.
  - `e2b1623f` (head, un-fixed): 3/5 fail (changes-requested, comment-required, review-only);
    happy path + non-participant pass — matches CI's failure set exactly.
  - head + SPA-8655 fix: 5/5 pass — happy path 18.3s, changes-requested 3.9s, comment-required
    825ms, non-participant 907ms, review-only 1.1s. Repeat run: 5/5 pass (12.0s, 1.8s, 754ms,
    912ms, 1.1s).
- **Unit suites** (`cd server && pnpm exec vitest run`):
  - `heartbeat-deferred-promote-on-reassignment.test.ts` + `heartbeat-lease-not-released-retry.test.ts` + `heartbeat-process-recovery.test.ts`: 3 files, 329 tests, exit 0.
  - `wake-queue/application/use-cases.test.ts` + `heartbeat-lock-release-on-reassignment.test.ts`: 2 files, 53 tests, exit 0.
- **Full shard (4/8) scope locally**: 13/14 pass; the only failure was
  `archived-company-url.spec.ts` (15s `page.waitForURL` browser timeout while the same server
  was serving 4 specs + vite optimizer) — passes in isolation (20.0s) and passed on both CI runs
  of #70; not related to this diff (browser-only, waits on URL redirect UI).
- DB-level mechanism verified via instrumented server logs (wake-queue admission facts +
  wake-queue drain runner) on the failing head build: reviewer stage wake deferred with
  `availableActiveExecutionRunPresent=true`, `activeRunAgent` = old assignee, `activeRunStatus`
  `running`; drain candidate logs show the old-assignee wake consumed by the retry leg.

## Out of scope (per card)

- 5-minute orphan sweep (SPA-5732 layer B) — DO NOT build.
- New timers / watchdogs (James: shrink machinery) — DO NOT build.
- Upstream vendor filings — DO NOT build (per card).