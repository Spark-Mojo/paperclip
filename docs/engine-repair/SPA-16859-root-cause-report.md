# SPA-16859 root-cause report: legacy-execution recovery-action create/settle loop

Report-only leaf; no product behaviour changed. Evidence log:
`docs/engine-repair/SPA-16859-repro-output.log` (verbatim copy of
`/tmp/spa16859/SPA-16859-repro-output.log`).

## 1. Reproduction summary

- Fixture: one card, legacy run (`runtimeMode: "legacy"`),
  `paperclip_runner` agent, run status `failed`
  (`server/src/services/__tests__/legacy-execution-loop-repro.test.ts:48-82`).
- Driver: N=3 cycles, each cycle runs
  `terminalizeLegacyExecution`
  (`server/src/services/legacy-execution-recovery.ts:64-174`)
  then `settleUnrecoverableExecutions`
  (`server/src/services/execution-recovery-resolution.ts:310-573`).
- Result: row count 1->2->3; fresh UUID per cycle; same fingerprint
  `legacy-execution:<runId>` on every row.
- All 3 rows `status: resolved` with
  `evidence.automaticRecovery.replay: "blocked"` and no
  `executionReconciliation`; 3x `activityLog`
  `issue.execution_recovery_settled` rows.
- CYCLE lines (log lines 8 / 11 / 14):
  - `CYCLE 1 actions=1 ids=e0ebcbb2-... fingerprints=legacy-execution:38da2129-...`
  - `CYCLE 2 actions=2 ids=e0ebcbb2-...,626e2f2f-... fingerprints=legacy-execution:38da2129-...,legacy-execution:38da2129-...`
  - `CYCLE 3 actions=3 ids=e0ebcbb2-...,626e2f2f-...,18ca0d85-... fingerprints=(x3 same fingerprint)`
- Final assertions (test lines 112-138) confirm: length 3, 3 distinct
  UUIDs, all resolved + `replay: "blocked"`, no `executionReconciliation`,
  no `workspaceRestoreFailure`, 3 settled activity-log rows.

## 2. Settling branch

- Boundary: the main per-candidate `automatic_disposition` branch,
  `settleUnrecoverableExecutions`, per-candidate transaction at
  `execution-recovery-resolution.ts:404-564`.
- Evidence write at lines 520-526:
  `automaticRecovery: { policy: "preserve_without_replay_v1", runId,
  replay: "blocked", actionOutcome: "unknown", recordedAt }`.
- Activity log at lines 530-543:
  `persistActivity(... action: "issue.execution_recovery_settled" ...)`.
- The conversation-hold fold branch (lines 317-353) does NOT apply: the
  fixture uses `paperclip_runner`, not a conversation adapter, so it
  fails the predicate at `conversation-continuation.ts:65-85`
  (run must be conversation-continuation eligible, e.g.
  `conversationContinuation` policy / interrupted / listed error codes).

## 3. Root-cause verdict: CONFIRMED (creator skip-guard / settler evidence-key mismatch)

- Creator skip-guard: `legacy-execution-recovery.ts:133-147`. It skips the
  re-insert only when a RESOLVED row matches either disjunct:
  (a) `evidence.executionReconciliation.runId == run.id`, OR
  (b) `evidence.runId == run.id` AND
  `workspaceRestoreFailure == 'restore_unsafe_archive'` AND
  `evidence.automaticRecovery.replay == 'blocked'`.
- The settler's main branch writes `automaticRecovery.replay="blocked"`
  (lines 520-526) but never writes `executionReconciliation` — contrast
  the operator path `markExecutionReconciliation` (lines 136-200), which
  is what the guard's first disjunct recognizes.
- The fixture (and the 6 production cards) has no
  `workspaceRestoreFailure`, so disjunct (b) can never match either.
- Therefore neither disjunct matches a settler-resolved row: the guard
  misses, and each `terminalize` re-inserts one fresh
  `legacy-execution:<runId>` row. The run re-update at lines 90-106 also
  succeeds again each cycle since the run status stays `failed`.
- Net effect: one fresh row per 30s sweep cycle = the loop on the 6 cards.

## 4. Fix direction (next WORK leaf — NOT implemented here)

- Make the guard recognize settler-resolved rows, e.g. treat
  `automaticRecovery.policy == 'preserve_without_replay_v1'` +
  `replay == 'blocked'` + `runId` match as reconciled regardless of
  `workspaceRestoreFailure`; or reuse/update the resolved row instead of
  inserting a new one.
- Still missing after this leaf: the fix + a regression test.
