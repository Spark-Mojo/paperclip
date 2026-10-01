# Gates — SPA-9351 stranded recovery, both shapes

Base: `origin/rebuild/v2026.916.0-survivors` @ `1751e2863`. Engine: `Spark-Mojo/paperclip`.

## Shape 1 — exhausted retries by a since-fixed error (SPA-8692)

Root cause (proven against live DB, 2026-09-29): SPA-8692's last runs carry
`error_code=adapter_failed` with `contextSnapshot.retryReason='transient_failure'`
(the heartbeat bounded-transient lane). `reconcileStrandedAssignedIssues`'s retry gate
is `didAutomaticRecoveryFail(latestRun, "issue_continuation_needed")` and
`summarizeRecentContinuationRetries` hard-breaks unless `retryReason === 'issue_continuation_needed'`,
so the exhausted-retry branch never runs. The card falls through to
`enqueueStrandedIssueRecovery`, which routes a terminal-failed predecessor to
`deps.scheduleRecoveryRetry` — refused, budget spent. Nothing re-wakes.

**Gate 1.1 — a card whose retries were exhausted by the bounded-transient lane is re-woken, not dropped.**
A card with an exhausted retryable failure, no live run, no pending wake and no open
blocker gets exactly one bounded re-wake after the configured delay.
    CHECK: cd server && timeout 900 pnpm vitest run src/services/recovery/exhausted-retry-rewake.test.ts --disable-console-intercept
    EXPECT: STRANDED-RECOVERY-GATES: shape1-rewake

**Gate 1.2 — the re-wake is bounded, episode-scoped, and cannot loop.**
A second sweep over the same failure episode does not re-wake; a non-retryable
classification never re-wakes; the backstop is idempotent under concurrent sweeps and
survives a restart.
    CHECK: cd server && timeout 900 pnpm vitest run src/services/recovery/exhausted-retry-rewake.test.ts --disable-console-intercept
    EXPECT: STRANDED-RECOVERY-GATES: shape1-bounded

**Gate 1.3 — non-retryable failures keep their current escalate-to-blocked behavior.**
    CHECK: cd server && timeout 900 pnpm vitest run src/services/recovery/exhausted-retry-rewake.test.ts --disable-console-intercept
    EXPECT: STRANDED-RECOVERY-GATES: shape1-non-retryable-untouched

## Shape 2 — deferred wake whose blocking run already ended (SPA-9280)

Root cause (proven against live DB): deferrals are only promoted on the run-end event
path. The pre-existing re-drive in `resumeQueuedRuns` (heartbeat.ts:19391) resolves
"latest run" with `heartbeatRuns.agentId = wake.agentId`. SPA-9280's deferral `19ffc589`
is addressed to Dex (`88818f10`) but Dex has **zero** runs on that issue, so `latest` is
undefined and the sweep `continue`s forever. The blocking run is only reachable via
`payload.interruptedRunId` (`e8cee47d` → `cancelled`).

**Gate 2.1 — a deferral whose blocking run is terminal is promoted.**
Resolve `payload.interruptedRunId` (and `executionWait` recovery action) against
`heartbeat_runs.status`; promote through the existing release path.
    CHECK: cd server && timeout 900 pnpm vitest run src/services/deferred-wake-backstop.test.ts --disable-console-intercept
    EXPECT: STRANDED-RECOVERY-GATES: shape2-promote

**Gate 2.2 — the sweep is safe: no promotion when the blocker is live, unresolvable, or a newer run holds the issue.**
Assert the blocking run terminality is proven by the join (not by a NULL `finishedAt`),
and that a newer live execution owner is never displaced.
    CHECK: cd server && timeout 900 pnpm vitest run src/services/deferred-wake-backstop.test.ts --disable-console-intercept
    EXPECT: STRANDED-RECOVERY-GATES: shape2-guards

**Gate 2.3 — the sweep runs at startup and periodically, single-flight, error-isolated.**
    CHECK: cd server && timeout 900 pnpm vitest run src/services/deferred-wake-backstop.test.ts --disable-console-intercept
    EXPECT: STRANDED-RECOVERY-GATES: shape2-scheduled

## Gate 3 — no regression in the existing recovery surface

    CHECK: cd server && timeout 1800 pnpm vitest run src/services/recovery/ src/modules/wake-queue/ src/__tests__/heartbeat-deferred-promote-on-reassignment.test.ts src/__tests__/issue-recovery-actions.test.ts src/__tests__/recovery-classifiers.test.ts src/services/deferred-wake-backstop.test.ts
    EXPECT: STRANDED-RECOVERY-GATES: no-regression

## Gate 4 — typecheck

    CHECK: timeout 900 pnpm -C server exec tsc --noEmit
    EXPECT: STRANDED-RECOVERY-GATES: typecheck

## Results (run 2026-09-29, Ty)

| Gate | Result |
|---|---|
| 1.1 shape1-rewake | PASS — 32 passed; `shape1-rewake` emitted |
| 1.2 shape1-bounded | PASS — `shape1-bounded` emitted |
| 1.3 shape1-non-retryable-untouched | PASS — `shape1-non-retryable-untouched` emitted |
| 2.1 shape2-promote | PASS — 33 passed; `shape2-promote` emitted |
| 2.2 shape2-guards | PASS — `shape2-guards` emitted |
| 2.3 shape2-scheduled | PASS — `shape2-scheduled` emitted |
| 3 no-regression | PASS — 414 passed / 18 files |
| 4 typecheck | PASS — no errors in touched files |

Vitest intercepts console by default; the gate CHECK commands carry
`--disable-console-intercept` so the markers are actually observable.

## Root causes, re-derived against the live DB (not from the card's claim)

**Shape 1 had THREE gates hiding the card, not one.**
1. `didAutomaticRecoveryFail` and `summarizeRecentContinuationRetries` are both
   hard-gated on `retryReason === "issue_continuation_needed"`; the bounded
   transient lane records `transient_failure`. (The card named this one.)
2. `legacyExecutionNeedsReconciliation` returns true for any run with
   `executionFailureRetryCount >= 2` (`legacy-execution-recovery.ts:45`) — the
   exhausted-budget shortcut. So the run was terminalized behind a board-owned
   `active_run_watchdog` recovery action, with cause
   `legacy_execution_requires_reconciliation`.
3. Every later sweep then stood down at the existing
   `activeRecoveryAction.ownerType === "board"` guard, because a board-owned
   action IS the human-owned continuation path. This is why
   `issue_recovery_actions` showed nothing recent for SPA-8692 in the naive
   reading, and why the card never self-recovered.

Fixing only (1) — the obvious reading of the card — would NOT have recovered
SPA-8692. Found by probing the real sweep; the test asserts the terminalization
no longer happens.

**Shape 2: the blocker lookup, not a missing startup hook, was the defect.**
Dex's comment anticipated "promote deferred wakes when a run ends" and inferred a
missing backstop. The startup/periodic hook was indeed missing, but the two
existing re-drives in `resumeQueuedRuns` would still have skipped SPA-9280:
they resolve the blocker as the wake agent's LATEST run on the issue, and the
wake is addressed to Dex (`88818f10`) who has ZERO runs on SPA-9280 — every
prior run belonged to other agents. The lookup returns nothing and the sweep
`continue`s every tick. The blocking run is only reachable via
`payload.interruptedRunId` (`e8cee47d` -> `cancelled`). Also note the blocking
run is `runtimeMode: legacy`, so the `runtimeMode !== "legacy"` filter was NOT
the skip cause.

## Shape 3 — actionless recovery waits and terminal-before-deferral race

A deferred wake with executionWait.reason=execution_recovery and no recoveryActionId,
or with a terminal interruptedRunId, is freshly admitted immediately after deferral
and at startup/periodic sweep. Current ownership, live execution, real recovery action,
blockers, company/pause/budget and terminal-issue guards remain enforced. Reassignment
mid-run starts the new assignee, with no duplicate dispatch under concurrent sweeps.
    CHECK: timeout 900 pnpm -C server exec vitest run src/services/deferred-wake-backstop.test.ts src/__tests__/heartbeat-deferred-promote-on-reassignment.test.ts --disable-console-intercept
    EXPECT: STRANDED-RECOVERY-GATES: shape3-immediate

## Shape 4 — retry run orphaned by restart

At startup and periodically, an interrupted/orphaned_running_run latest run with no
newer execution, pending wake, blocker or real recovery action gets one re-dispatch.
The persisted episode budget and atomic admission prevent restart loops and concurrent
duplicates. Test restart while a retry is live and prove replacement dispatch.
    CHECK: timeout 900 pnpm -C server exec vitest run src/services/recovery/exhausted-retry-rewake.test.ts --disable-console-intercept
    EXPECT: STRANDED-RECOVERY-GATES: shape4-orphaned-retry

Prior results above are preserved historical receipts, not verification of the expanded scope.
Shape 3: PASS — parent CHECK exit 0, 60 tests / 2 files passed on 2026-09-29; EXPECT shape3-immediate matched. Module regression: 198 tests passed (implementer receipt). Expanded regression: 439 tests passed (implementer receipt). Full typecheck FAIL — missing plugin-sdk/runner build artifacts plus resulting diagnostics; no scoped PASS substitutes for gate 4.
Shape 4: PASS — parent CHECK exit 0, 70 tests / 1 file passed on 2026-09-29; EXPECT shape4-orphaned-retry matched from DB restart regression. Expanded regression implementer receipt: exit 0, 477 tests / 18 files. Full typecheck remains FAIL; no scoped PASS substitutes for gate 4.

## Hardening — the two budgets are real, and neither outlives its dispatch

Three defects in the four-shape implementation, all re-derived against source:

1. Shape 1 claimed its idempotency key was "the budget" because concurrent
   sweeps race on a partial unique index. No index covered either key
   namespace, so the `23505` catch was dead code and both sweeps dispatched.
2. Shape 4 stamped the episode marker on the orphan run BEFORE the enqueue, so
   a throw or a null left the marker behind, `episodeRewakeCount` read 1, and
   every later sweep stood down — budget consumed, no wake ever queued.
3. The cross-shape suppression query matched ANY run in the company carrying
   an `exhaustedRetryRewakeEpisode` marker: no issue filter, no lineage filter.

The repair: two partial unique indexes on `(company_id, idempotency_key)` for
`exhausted_retry_rewake:%` and `orphaned_retry_rewake:%`; the durable wake
receipt (not a run marker) is the budget in both shapes; historical duplicate
keys are NULLed rather than deleted; the cross-shape query is scoped to the
issue and the orphan's retry lineage.

**Gate H1 — concurrent sweeps admit exactly one dispatch (both shapes).**
Real two-client Postgres races, no claim leases.
    CHECK: timeout 900 pnpm -C server exec vitest run src/services/recovery/exhausted-retry-rewake.test.ts --disable-console-intercept
    EXPECT: STRANDED-RECOVERY-GATES: shape1-receipt-scope-isolated

**Gate H2 — a failed dispatch is retried; a delivered one is not.**
A throw propagates (a real dispatch failure is never swallowed as a lost race)
and leaves no receipt, so the card stays re-claimable; a persisted receipt,
including a `skipped` one, spends the episode.
    CHECK: timeout 900 pnpm -C server exec vitest run src/services/recovery/exhausted-retry-rewake.test.ts --disable-console-intercept
    EXPECT: STRANDED-RECOVERY-GATES: shape1-dispatch-failure-retried

**Gate H3 — one card's recovery never suppresses another.**
Scoped to company + issue + exact episode key; the cross-shape check to issue
+ retry lineage.
    CHECK: timeout 900 pnpm -C server exec vitest run src/services/recovery/exhausted-retry-rewake.test.ts --disable-console-intercept
    EXPECT: STRANDED-RECOVERY-GATES: shape4-episode-scope-isolated

**Gate H4 — the indexes exist, reject the duplicate, and the dedup retains rows.**
Drops the indexes, seeds three rows under one key, runs the migration's dedup
statement, proves the earliest receipt keeps the key and the rest are NULLed
with no row deleted, then recreates both indexes.
    CHECK: timeout 900 pnpm -C packages/db exec vitest run src/stranded-rewake-idempotency-migration.test.ts --disable-console-intercept
    EXPECT: 7 passed

**Gate H5 — migration numbering and safety.**
    CHECK: timeout 300 pnpm -C packages/db exec tsx src/check-migration-numbering.ts && timeout 300 pnpm -C packages/db exec tsx src/check-migration-safety.ts
    EXPECT: Migration safety check passed

**Gate H6 — no regression.**
    CHECK: timeout 1800 pnpm -C server exec vitest run src/services/recovery/ src/modules/wake-queue/ src/__tests__/heartbeat-deferred-promote-on-reassignment.test.ts src/__tests__/issue-recovery-actions.test.ts src/__tests__/recovery-classifiers.test.ts src/services/deferred-wake-backstop.test.ts
    EXPECT: 490 passed

### Hardening results (run 2026-09-29, implementer session)

| Gate | CHECK exit | EXPECT matched |
|---|---|---|
| H1 shape1/shape4 concurrent admission | 0 | yes — `shape1-receipt-scope-isolated` |
| H2 failed dispatch retried | 0 | yes — `shape1-dispatch-failure-retried` |
| H3 cross-card isolation | 0 | yes — `shape4-episode-scope-isolated` |
| H4 indexes + real dedup | 0 | yes — 7 passed |
| H5 numbering + safety | 0 | yes — "Migration safety check passed" |
| H6 no regression | 0 | yes — 490 passed / 18 files |
| full db package suite | 0 | yes — 162 passed / 45 files |
| `packages/db` typecheck | 0 | no diagnostics |

Server file: 83 passed / 1 file, all seven markers emitted.

Final parent receipts (2026-09-29): regression CHECK exit 0, 490 passed / 18 files; all shape markers matched. DB migration CHECK exit 0, 7 passed; DB typecheck exit 0. Migration numbering/safety exit 0; safety marker matched.

Server canonical `pnpm -C server run typecheck` FAIL: runner build requires cargo, unavailable (`cargo: not found`). After the command built runner TypeScript and `pnpm --filter @paperclipai/plugin-sdk ensure-build-deps` built SDK declarations, the exact Gate 4 CHECK `timeout 900 pnpm -C server exec tsc --noEmit` exited 0 with no diagnostics. Gate 4 PASS; canonical preparation limitation remains recorded.

**Residual limitation, stated rather than claimed away:** `enqueueWakeup` runs
outside the budget transaction, so a crash between the decision and the insert
leaves the episode unspent and re-claimable. That is the safe direction — no
stranded card, no lost dispatch — but it is retry-until-success, not
exactly-once. The unique index bounds duplicate dispatches; it cannot bound a
permanently broken wake queue.

## Terminal lease remediation (manager direction 2026-09-29)

**Gate L1 — every terminal transition releases its environment leases safely.**
Succeeded, failed, cancelled, interrupted/orphaned paths use existing runtime cleanup; retained/native safeguards remain enforced.
    CHECK: timeout 900 pnpm -C server exec vitest run src/services/terminal-environment-leases.test.ts --disable-console-intercept
    EXPECT: LEASE-GATES: terminal-release

**Gate L2 — startup and periodic sweeps reclaim only proven terminal owners.**
Unknown, queued/running, cross-company or changed ownership are never reclaimed; expiry alone never authorizes cleanup. Driver failures are isolated and retryable.
    CHECK: timeout 900 pnpm -C server exec vitest run src/services/terminal-environment-leases.test.ts --disable-console-intercept
    EXPECT: LEASE-GATES: sweep-guards

**Gate L3 — local ephemeral acquisition gets a finite expiry without destroying live owners.**
    CHECK: timeout 900 pnpm -C server exec vitest run src/services/terminal-environment-leases.test.ts --disable-console-intercept
    EXPECT: LEASE-GATES: finite-expiry

**Gate L4 — restart during a live retry releases its orphan lease and automatically dispatches a bounded replacement.**
    CHECK: timeout 900 pnpm -C server exec vitest run src/services/terminal-environment-leases.test.ts --disable-console-intercept
    EXPECT: LEASE-GATES: restart-replacement

**Gate S1 — generated snapshot delta is completely enumerated against actual predecessor.**
Keep both snapshots. Compare prevId to predecessor id, assert unchanged schema objects exactly equal and enumerate/assert all delta including both partial unique indexes. Missing predecessor fails closed.
    CHECK: timeout 300 node --input-type=module -e 'import fs from "node:fs"; import assert from "node:assert/strict"; const d="packages/db/src/migrations/meta/"; const a=JSON.parse(fs.readFileSync(d+"0282_snapshot.json")); const b=JSON.parse(fs.readFileSync(d+"0283_snapshot.json")); assert.equal(b.prevId,a.id); assert.equal(b.id,"77da1aa7-cdc7-4f81-8353-d3e15a39c4e9"); for(const prefix of ["exhausted_retry_rewake","orphaned_retry_rewake"]){const name=`agent_wakeup_requests_${prefix}_idempotency_uq`; const indexes=b.tables["public.agent_wakeup_requests"].indexes; assert.equal(a.tables["public.agent_wakeup_requests"].indexes[name],undefined); assert.deepEqual(indexes[name],{name,columns:[{expression:"company_id",isExpression:false,asc:true,nulls:"last"},{expression:"idempotency_key",isExpression:false,asc:true,nulls:"last"}],isUnique:true,where:`"agent_wakeup_requests"."idempotency_key" LIKE '\''${prefix}:%'\''`,concurrently:false,method:"btree",with:{}}); delete indexes[name]; console.log(`ASSERTED INDEX: ${name}`);} b.id=a.id; b.prevId=a.prevId; assert.deepEqual(b,a); console.log("UNCHANGED SCHEMA OBJECTS: exactly equal"); console.log("SNAPSHOT-DELTA: verified");'
    EXPECT: SNAPSHOT-DELTA: verified

Results (2026-09-29 continuation): S1 CHECK exit 0, EXPECT matched. Output:
```
ASSERTED INDEX: agent_wakeup_requests_exhausted_retry_rewake_idempotency_uq
ASSERTED INDEX: agent_wakeup_requests_orphaned_retry_rewake_idempotency_uq
UNCHANGED SCHEMA OBJECTS: exactly equal
SNAPSHOT-DELTA: verified
```
Complete delta: these two added index objects plus snapshot id and prevId. Actual predecessor 0282 exists, id=8379f41b-a61d-4864-8287-f0b7034e540c; 0283 prevId equals that id. All other objects exactly equal after removing only the asserted additions and normalizing only id/prevId in memory. Files unchanged.

Historical pre-child state: L1-L4 NOT RUN / implementation absent. Final fourth implementer invocation failed before execution: `opencode-go/glm-5.3-flash: rate limit — [429]: Go usage limit exceeded (HTTP 429)`, task ses_f12442aeeffeu2VYc1yLfTCMLc. No fifth session or unchanged verification retry.

Continuation 2026-09-29: child PR #124 at 6316c15b01 was applied with `git cherry-pick --no-commit 869f5d0773 6316c15b01` onto parent PR #122 head 3e97164809, with zero merge conflicts. Combined foreground suite (L1-L4 + recovery + startup feedback) initially exited 1: 511 passed, 3 failed / 20 files. Startup mock lacked `reconcileStaleDeferredWakes`, added by parent; this stopped three tests before the new lease calls. Added three mock methods to the existing startup test. Targeted startup suite then exited 0, 20 passed / 1 file. Exact `timeout 900 pnpm -C server exec tsc --noEmit` exited 0. Recheck after mock repair: L1-L4 verbose test exit 0, four `LEASE-GATES:` test titles matched, 4 passed / 1 file; combined recovery + startup regression exit 0, 510 passed / 19 files; DB migration exit 0, 7 passed / 1 file; DB tsc exit 0; server tsc exit 0. No commit/push or independent verification on an integration head. CI lint command not identified. Local staged integration still needs git authorization, final-head review, merge and live acceptance.

## CI merge readback race correction (2026-09-30)

**Gate R1 — a legitimately claimed wake with a linked running run counts as promoted, while an unlinked or negative-status wake does not.**
    CHECK: timeout 240 pnpm -C server exec vitest run src/services/deferred-wake-backstop.test.ts --disable-console-intercept --reporter=dot
    EXPECT: Tests  58 passed (58)
    NEGATIVE: timeout 180 env CI=true pnpm -C server exec vitest run src/services/deferred-wake-backstop.test.ts --disable-console-intercept --reporter=dot (on disposable clean PR head 2726509ba71c72580175c2ba0a5e1482deb56a23 plus only the trigger-driven race test, without the readback predicate change); expected nonzero with `expected +0 to be 1` in `recognizes a promoted wake claimed before the backstop reads it`.
    RESULT: CHECK exit 0 at 2026-09-30 16:04 UTC; 58/58, EXPECT matched. NEGATIVE: historical disposable RED receipt from 2026-09-30 04:48 UTC, exit 1 / expected 1 got 0; not independently re-run in this heartbeat, so gate remains unproven under the current foreground-negative requirement until reproduced.

**Gate R2 — server types and patch integrity.**
    CHECK: timeout 900 pnpm -C server exec tsc --noEmit && git diff --check
    EXPECT: exit 0 with no diagnostics
    NEGATIVE: timeout 30 node --input-type=module -e 'import assert from "node:assert/strict"; assert.equal(false, true)' (isolated assertion-control only; does not validate the TypeScript assertion itself).
    RESULT: CHECK exit 0 at 2026-09-30; no diagnostics, EXPECT matched. NEGATIVE unproven for same assertion.

Unresolved: exact CI merge shard on original commit had two fixture-teardown deadlocks after race correction; six agent-hire-ai-connections failures were also observed and not base-classified. A new head CI run and independent sign-off remain necessary. Prior gate results above are historical, not refreshed for final head.

## Base integration candidate (2026-09-30, not committed)

PR #122 head `68ee39e2d23f951da7c85fbaa32bd5f98d191a1f` is DIRTY against the live fork base `05f3a88e16477cc33033e0d180c8bd4baa64efd1`; GitHub's PR `baseRefOid` response was stale at `1751e28631af0409f1bc6fe821cb41379d5970cb`. The latter has no 9282 snapshot and is not a valid target for the manager's 9283 instruction. The side worktree is based on `refs/remotes/sparkmojo/rebuild/v2026.916.0-survivors` pinned at `05f3a88e16477cc33033e0d180c8bd4baa64efd1`. The 24-file diff was reapplied without source conflicts; the journal conflict was resolved by retaining base's journal and appending 9283. The SQL, test reference and snapshot were restamped to 9283. The 9283 snapshot chains to 9282 (`70d41d4f-6714-441e-afe6-16a8410a9360`) and retains base's heartbeat-run-events cascading FK. Original PR branch and head were not changed.

**Gate M — appended migration and complete generated snapshot delta against the live target.**
    CHECK: timeout 300 pnpm -C packages/db exec tsx src/check-migration-numbering.ts && timeout 300 pnpm -C packages/db exec tsx src/check-migration-safety.ts
    EXPECT: Migration safety check passed
    NEGATIVE: timeout 30 node .github/scripts/check-pr-migration-order.mjs 05f3a88e16477cc33033e0d180c8bd4baa64efd1 68ee39e2d23f951da7c85fbaa32bd5f98d191a1f
    RESULT: NEGATIVE exit 1; `::error title=Migration numbers must follow the target branch` and `renumber ... starting at 9283`. CHECK unproven: `pnpm -C packages/db exec tsx` exits 1, `Command "tsx" not found`, because this fresh worktree has no installed dependencies. Snapshot structural comparison against 9282 exited 0 with `SNAPSHOT-DELTA: verified against 9282`, and a prior run showed the only other difference before correction was the base's heartbeat event FK cascade; this is not a substitute for the migration and test gates. The gate's positive must run against a committed candidate SHA, not only an uncommitted worktree.

R1 and R2 NEGATIVE controls above remain unproven. The exact CI merge-shard teardown deadlocks remain unresolved. No final-head CI or independent sign-off exists. No commit, push, merge, install or live acceptance was performed for this candidate.

## 2026-09-30 continuation — provisional side-worktree receipts

Live `git ls-remote sparkmojo refs/heads/rebuild/v2026.916.0-survivors` and `git rev-parse refs/remotes/sparkmojo/rebuild/v2026.916.0-survivors` both returned `05f3a88e16477cc33033e0d180c8bd4baa64efd1`. `timeout 600 pnpm install --frozen-lockfile --ignore-scripts --offline` exit 0 prepared dependencies only in the side worktree; it did not migrate a live DB or modify the PR.

Gate M candidate CHECK `timeout 300 pnpm -C packages/db exec tsx src/check-migration-numbering.ts && timeout 300 pnpm -C packages/db exec tsx src/check-migration-safety.ts` exit 0; output `Migration safety check passed: 20 historical finding(s) covered by baseline (1 stale baseline id(s) ignored).` Snapshot comparison against the actual `9282_snapshot.json` asserted `prevId` equals predecessor id, enumerated and deep-equalled the two partial unique indexes, then deep-equalled the remainder; exit 0, `SNAPSHOT-DELTA: verified against 9282`. These are provisional checks of the uncommitted candidate, NOT a passing PR-head migration-order gate. The existing command `node .github/scripts/check-pr-migration-order.mjs <base> <head>` reads git trees only and cannot check this candidate before it has a commit. Its NEGATIVE was re-run under `timeout 60` against base `05f3a88e16477cc33033e0d180c8bd4baa64efd1` and old PR head `68ee39e2d23f951da7c85fbaa32bd5f98d191a1f`: exit 1, `::error title=Migration numbers must follow the target branch`, `renumber ... starting at 9283`.

Focused teardown baseline: `timeout 240 pnpm -C server exec vitest run src/services/deferred-wake-backstop.test.ts --disable-console-intercept --reporter=dot` exit 0, 58/58, but logs `heartbeat execution setup failed: Issue not found` after fixture cleanup. This is not a clean teardown proof. Experimental `afterEach` awaiting each service's `drainActiveRunExecutions()` before deletes exited 1 (17 failed, 41 passed): first drain hit Vitest's 30-second hook timeout, later teardown hit `company_skills_company_id_companies_id_fk` and `agent_task_sessions_last_run_id_heartbeat_runs_id_fk`. The experiment was fully reverted; `git diff -- server/src/services/deferred-wake-backstop.test.ts` was empty afterward. Drain alone is not a safe fix. The two merge-shard deadlocks and R1/R2 failing controls remain unproven; do not call the candidate verified. R2 side-worktree `timeout 30 pnpm -C server exec tsc --noEmit` exited 2 due to absent built SDK/runner declarations. `timeout 30 pnpm -C server exec tsc --ignoreConfig ... /dev/null` panicked in TypeScript-Go (`ScriptKind must be specified`): an invalid negative fixture, NOT an assertion control. R1 attempted `timeout 30 node -e 'const fs=require("node:fs"),assert=require("node:assert/strict");const text=fs.readFileSync("server/src/services/deferred-wake-backstop.test.ts","utf8");assert.ok(/expect\\(result\\.promoted\\)\\.toBe\\(99\\)/.test(text),"R1 false promotion assertion rejected: expected 99");'` exits 1 but checks the text, not the runtime promotion assertion; it is NOT a valid gate negative. Side-worktree `timeout 30 pnpm -C server exec tsc --noEmit` exit 2 after `--ignore-scripts` dependency preparation: missing built `@paperclipai/paperclip-runner/live` and `@paperclipai/plugin-sdk` declarations cascade into TS errors. This is not a typecheck PASS. No lint command has been identified.

## 2026-09-30 assignment continuation — teardown diagnosis (not a green gate)

Live fork base `refs/heads/rebuild/v2026.916.0-survivors` remains `05f3a88e16477cc33033e0d180c8bd4baa64efd1` (`timeout 30 git ls-remote sparkmojo refs/heads/rebuild/v2026.916.0-survivors`, exit 0). Uncommitted side candidate `timeout 300 pnpm -C packages/db exec tsx src/check-migration-numbering.ts && timeout 300 pnpm -C packages/db exec tsx src/check-migration-safety.ts` exited 0 with `Migration safety check passed: 20 historical finding(s) covered by baseline (1 stale baseline id(s) ignored).` This does not establish a committed PR-head migration-order PASS.

`timeout 240 pnpm -C server exec vitest run src/services/deferred-wake-backstop.test.ts --disable-console-intercept --reporter=dot` without teardown changes exited 0, 58/58, but multiple `heartbeat execution setup failed: Issue not found` messages occurred after the test's fixture delete. That is a real async teardown hazard, not green teardown evidence. The production post-commit dispatch at `heartbeat.ts:9938-9964` starts a run; the test's two `afterEach` blocks delete `heartbeat_runs` and `issues` without waiting. A diagnostic change using the existing `drainHeartbeatRunsToQuiescence` helper before deletes was tested with the same foreground command: exit 1, 17 failed / 41 passed. The first actionable failure was FK `agent_task_sessions_last_run_id_heartbeat_runs_id_fk` during `delete from heartbeat_runs`; subsequent tests failed to seed because cleanup did not finish. This narrows the cleanup defect: quiescence alone does not remove session references to promoted runs. The diagnostic edit was reverted exactly (`git diff -- server/src/services/deferred-wake-backstop.test.ts` empty); no production source was modified. Next isolation must use a fixture-owned session cleanup before deleting runs, then assert quiet teardown in an isolated test; do not use blind `TRUNCATE CASCADE` on potentially shared data. R1/R2 negatives remain unproven.

## Acceptance (per the card)

SPA-8692 and SPA-9280 were deliberately left untouched. They recover
automatically once the fix is installed on the live engine; that is a
post-merge observation, not claimed here.
