# GATES — SPA-9001 (engine: lost review-stage wakes + stranded recovery re-wake)

Solo card — one gate set for whole card. Derived from the card's DoD oracle
(James's yes 2026-09-27: yes to revised (a), one engine change on the live
line, install once together with SPA-8967 + PR #75 through SPA-8892's
checklist). Gates may not be weakened once written.

## Gate 1 — Same-stage / same-participant re-entry wakes the reviewer
- `server/src/routes/issues.ts` `buildExecutionStageWakeup` `stageChanged`
  predicate treats a fresh `lastDecisionId` as a wake-worthy transition (the
  reviewer sent the card back via `request_changes`; the executor resubmitted;
  re-entering the same review stage with the same reviewer must wake the
  reviewer for the resubmission).
- The mirror predicate `becameChangesRequested` (which already checks
  `lastDecisionId`) is unchanged.
- Proof: `pnpm vitest run server/src/__tests__/issue-execution-stage-wakeup-reentry.test.ts`
  exits 0 — **9/9 tests pass** on this branch's head (run 2026-09-27 14:01Z,
  duration 16.24s). Includes "wakes the reviewer when re-entering the same
  review stage with the same reviewer but a fresh lastDecisionId (SPA-9001)"
  and "returns null when nextState is pending but stageId, participant, AND
  lastDecisionId are all unchanged (no spurious wake)".

## Gate 2 — Stranded recovery re-wakes cards whose run was interrupted by a server restart
- `server/src/services/recovery/service.ts` `reconcileStrandedAssignedIssues`
  bypasses the `didAutomaticRecoveryFail` guard for `in_progress` and `todo`
  candidates whose latest run is `errorCode === "server_shutdown_interrupted"`
  AND a terminal `interrupted` run (i.e. an interrupted retry-of-a-retry).
- Bypass only — never weakens the escalation path for non-shutdown failures
  (provider_quota, configuration_incomplete, etc. still escalate).
- Proof: `pnpm vitest run server/src/__tests__/heartbeat-stranded-recovery-server-shutdown-interrupted.test.ts`
  exits 0 — **4/4 tests pass** on this branch's head (run 2026-09-27 14:02Z,
  duration 18.41s). Includes:
  - "re-enqueues an in_progress stranded run whose retry was interrupted by a
    server shutdown (SPA-9001)" — `continuationRequeued: 1`, retry run has
    `retryOfRunId: <interrupted run>` and the expected contextSnapshot.
  - "re-enqueues a todo stranded run whose retry was interrupted by a server
    shutdown (SPA-9001)" — `dispatchRequeued: 1`.
  - "still escalates an in_progress retry failure that is NOT a server shutdown
    (unchanged path)" — confirms the bypass is gated on
    `server_shutdown_interrupted` and does NOT widen to other unsuccessful-
    terminal codes.

## Gate 3 — Stranded recovery re-wakes review-stage cards parked after an interrupted reviewer retry
- Same bypass for the in_review branch: a `participantLatestRun` whose
  `errorCode === "server_shutdown_interrupted"` skips the
  `didAutomaticRecoveryFail(..., EXECUTION_REVIEW_PARTICIPANT_RECOVERY_REASON)`
  escalation and falls through to `enqueueStrandedIssueRecovery`.
- Proof: `pnpm vitest run server/src/__tests__/heartbeat-stranded-recovery-server-shutdown-interrupted.test.ts`
  exits 0 — same 4/4 includes "still re-enqueues an in_review review-participant
  whose retry was interrupted by a server shutdown (SPA-9001)" — review-stage
  card, participant interrupted retry, no live execution path → re-wake instead
  of escalate. Retry run has `currentStageId`/`currentStageType` preserved.

## Gate 4 — No regressions on existing review-participant / stranded-recovery paths
- `pnpm vitest run server/src/__tests__/heartbeat-process-recovery.test.ts`
  exits 0 — **143/143 tests pass** on this branch's head (run 2026-09-27
  13:54Z, duration 92.80s). Existing tests preserved:
  - retries a pending execution-review participant once (6066)
  - skips blocked-empty parking for failed execution-review recovery (6157)
  - re-enqueues an already stranded execution-review participant (5793)
  - retries a pending execution-review participant when another agent has
    active issue run (5987)
  - dispatches assigned todo work with no prior run as a normal assignment
    wake (5537)
  - re-enqueues assigned todo work when the last issue run died and no wake
    remains (5710)
- `pnpm vitest run server/src/__tests__/issue-recovery-actions.test.ts
  server/src/__tests__/recovery-observability.test.ts
  server/src/__tests__/recovery-stale-issue-lock-sweep.test.ts
  server/src/__tests__/recovery-classifiers.test.ts` exits 0 — **66/66 tests
  pass** (run 2026-09-27 13:59Z).
- `pnpm vitest run server/src/__tests__/issue-execution-policy.test.ts
  server/src/__tests__/issue-review-policy.test.ts` exits 0 — **82/82 tests
  pass** (run 2026-09-27 14:00Z).
- `pnpm vitest run server/src/__tests__/issue-stalled-review-decision-routes.test.ts
  server/src/__tests__/issue-review-attention.test.ts` exits 0 — **22/22 tests
  pass** (run 2026-09-27 14:00Z).

## Gate 5 — `buildExecutionStageWakeup` behavior matches the predicate contract
- Empty/unchanged executionState (both null) → null (test: "returns null when
  nextState is null")
- pending → pending, same stage, same participant, same lastDecisionId → null
  (test: "returns null when nextState is pending but stageId, participant, AND
  lastDecisionId are all unchanged (no spurious wake)")
- pending → pending, same stage, same participant, DIFFERENT lastDecisionId
  → wake (NEW: SPA-9001) (test: "wakes the reviewer when re-entering the same
  review stage with the same reviewer but a fresh lastDecisionId (SPA-9001)")
- pending → pending, same stage, DIFFERENT participant → wake (unchanged)
  (test: "still wakes the reviewer when the participant changes")
- changes_requested → pending (becameChangesRequested + stageChanged) → wake
  for executor + wake for new reviewer (test: "still wakes the reviewer when
  leaving changes_requested" and "wakes the executor when becoming
  changes_requested")
- pending → pending, DIFFERENT stageId → wake (unchanged) (test: "still wakes
  the reviewer when the stageId changes")
- proof: `pnpm vitest run server/src/__tests__/issue-execution-stage-wakeup-reentry.test.ts`
  exits 0 — 9/9.

## Gate 6 — No new types or imports in production code
- `server/src/services/recovery/service.ts` edit adds one private helper
  `isServerShutdownInterruptedRun` (uses already-imported
  `UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES`); three call sites updated
  to AND the bypass.
- `server/src/routes/issues.ts` edit is one `export` keyword + a predicate
  extension line plus a comment block — no new imports.
- `pnpm exec tsc --noEmit -p server/tsconfig.json` produces no errors in
  `server/src/routes/issues.ts` or `server/src/services/recovery/service.ts`.
  Pre-existing errors in `server/src/app.ts`, `server/src/routes/plugins.ts`,
  `server/src/services/activity-log.ts` (all about missing
  `@paperclipai/plugin-sdk`) are unchanged from origin/master and unrelated
  to SPA-9001.

## Verification commands (run from repo root)
```
timeout 120 pnpm exec tsc --noEmit -p server/tsconfig.json
timeout 120 pnpm vitest run server/src/__tests__/issue-execution-stage-wakeup-reentry.test.ts
timeout 180 pnpm vitest run server/src/__tests__/heartbeat-stranded-recovery-server-shutdown-interrupted.test.ts
timeout 600 pnpm vitest run server/src/__tests__/heartbeat-process-recovery.test.ts
```