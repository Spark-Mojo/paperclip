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

## Out of scope (per card)

- 5-minute orphan sweep (SPA-5732 layer B) — DO NOT build.
- New timers / watchdogs (James: shrink machinery) — DO NOT build.
- Upstream vendor filings — DO NOT build (per card).