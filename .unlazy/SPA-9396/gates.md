# SPA-9396 gates — incomplete WIP, 2026-09-30

## Existing work-product update/remove fence — 2026-10-01 — HOLD

The update and remove services now locate the child without locking it, lock its company-scoped parent issue, then lock and re-read the child under the same transaction; missing or changed identity refuses. An update patch cannot move the child to another issue/company. This is a modeled acquisition-order correction, not PostgreSQL route concurrency proof. Import and low-trust promotion remain open.

  CHECK: PATH="$HOME/.cargo/bin:$PATH" timeout 180 pnpm exec vitest run server/src/__tests__/work-products.test.ts --reporter=dot
  EXPECT: Tests 6 passed (6)
  RESULT: exit 0, Test Files 1 passed (1), Tests 6 passed (6), Duration 12.45s. Before update code, the promotion test exited 1 at select called once versus expected three; before remove code, delete test exited 1 with db.delete not a function rather than the intended lock assertion. Remove negative is not yet an isolated authorization control.
  NEGATIVE: promotion assertion on pre-fix function exited 1 (expected 3 locked sequence reads, observed 1), other 4 passed. Remove negative is unproven at the behavior assertion and needs an isolated control.

  CHECK: PATH="$HOME/.cargo/bin:$PATH" timeout 900 pnpm --filter @paperclipai/shared --filter @paperclipai/server typecheck
  EXPECT: server typecheck: Done
  RESULT: exit 0, shared Done, server Done; pre-existing Rust warnings.
  NEGATIVE: not run; typecheck is not a behavior assertion.

  CHECK: git diff --check
  EXPECT: exit 0
  RESULT: exit 0, empty output before ledger update.
  NEGATIVE: no whitespace fixture run.

Still missing: import and low-trust promotion writer fence, actual two-connection approval-route proof, stalled durable decision, changed-head review, contract sync, independent final-head verification, PR/merge/rollout and Sable decision. UNSAFE TO SHIP.

## Work-product writer issue-row fence — 2026-10-01 — HOLD

`workProductService.createForIssue` now locks the company-scoped parent issue before changing the primary work product or inserting another product; it refuses a missing/mismatched parent. This is one bounded writer correction, not the route-level concurrency oracle. Existing product update/remove and import, low-trust promotion, and other binding writers are not covered. The Vitest worktree flag was not further investigated here: the previous ledger records the isolated environment-sensitive 47/47 arm, which is not approval safety.

  CHECK: PATH="$HOME/.cargo/bin:$PATH" timeout 180 pnpm exec vitest run server/src/__tests__/work-products.test.ts --reporter=dot
  EXPECT: Tests 5 passed (5)
  RESULT: exit 0, Test Files 1 passed (1), Tests 5 passed (5), Duration 12.50s. Before the issue-lock edit the same CHECK exited 1 at the acquisition-order assertion (`[update, insert]` rather than `[issue-lock, update, insert]`), four other tests passed.
  NEGATIVE: the same suite on the pre-fix production function exited 1 at the issue-lock ordering assertion; the test uses a transaction mock, not a real PostgreSQL lock. Route-level concurrent writer negative still unproven.

  CHECK: PATH="$HOME/.cargo/bin:$PATH" timeout 900 pnpm --filter @paperclipai/shared --filter @paperclipai/server typecheck
  EXPECT: server typecheck: Done
  RESULT: exit 0; shared Done, server Done. No behavior-negative control for typecheck.

  CHECK: git diff --check
  EXPECT: exit 0
  RESULT: exit 0, no output. No whitespace-negative fixture run.

Still missing: all other binding writers' parent-first lock order; real approval-route two-connection PostgreSQL concurrency and negative; durable stalled decision; changed-head review; contract sync; independent verification, engine PR/merge/rollout and Sable decision. UNSAFE TO SHIP.

## Assigned-worktree suppression isolated — 2026-10-01 — HOLD

The 18 queued-comment failures are caused by the worktree runtime flag in the Vitest worker, not by task-drain state or this branch's binding-lock changes. A focused test in a fresh Vitest process failed on `deferred_issue_execution`; a temporary assertion inside the test's `beforeAll` read `process.env.PAPERCLIP_IN_WORKTREE === "true"` and `resolveHeartbeatSchedulingSuppression(process.env) === { suppressed: true, reason: "worktree_instance" }`. The same diagnostic after the failing route found `getTaskDrainStatus().draining === false`. The parent shell's flag was unset while the Vitest worker observed it as `true`; the setter was not traced, so the precise startup source is unproven. All temporary diagnostic assertions/imports were removed and `git status --short` returned empty before the ledger edit. No production suppression logic changed.

  CHECK: PATH="$HOME/.cargo/bin:$PATH" PAPERCLIP_IN_WORKTREE=false timeout 300 pnpm exec vitest run server/src/__tests__/issue-queued-comments-routes.test.ts --reporter=dot --silent
  EXPECT: Tests 47 passed (47)
  RESULT: exit 0, Test Files 1 passed (1), Tests 47 passed (47), Duration 57.52s. The identical suite without the explicit false flag exited 1, 18 failed / 29 passed at the expected scheduling assertions. The false flag is scoped to this isolated test process, not the running engine. This establishes an environment-sensitive adjacent suite, not production approval safety.
  NEGATIVE: same suite without the explicit flag exited 1 with `heartbeat.scheduling_suppressed` and deferred wakes; not a mutation of an approval assertion, so the stage-approval safety gate remains unproven.

Still missing: route-level PostgreSQL concurrent-writer oracle, locking on residual binding writers, stalled durable decision, changed-head fresh-review route, contract sync, independent verification, PR/merge/rollout and Sable decision. UNSAFE TO SHIP.

## Assigned-worktree rerun and fixture repair — 2026-10-01 — HOLD

Latest board handoff `52bfa1e6` preserved HEAD `5642c40937`. This run re-read the assigned checkout (clean initially, matching HEAD). Live single-resource GET of SPA-9332 now returns `status=backlog`, `executionState=null`, `blockedBy=[SPA-9396]`, and Sable remains assignee; no live 409 probe was made, no security decision recorded. The historic deadlock remains a valid engine regression target, but its old victim execution state is no longer live evidence.

  CHECK: PATH="$HOME/.cargo/bin:$PATH" timeout 300 pnpm exec vitest run server/src/__tests__/issue-queued-comments-routes.test.ts --reporter=dot --silent
  EXPECT: Tests 47 passed (47)
  RESULT: exit 1, 18 failed / 29 passed, `deferred_issue_execution` where `coalesced` or `queued` was expected, and `heartbeat.scheduling_suppressed` where `process_running` was expected. Explicit `env -u PAPERCLIP_IN_WORKTREE` repeat produced the same 18 failures; PAPERCLIP_IN_WORKTREE, PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS and PAPERCLIP_RESTORE_IN_PROGRESS are unset in this shell. The handoff's worktree-dependent finding is confirmed here, not resolved. `resolveHeartbeatSchedulingSuppression` also considers module-scoped task drain; no isolated cause proof or base replay from this run. Do not waive.
  NEGATIVE: not proven; test suite remains red in the assigned worktree.

  CHECK: timeout 240 pnpm exec vitest run server/src/__tests__/issue-comment-reopen-routes.test.ts --testTimeout=60000 --reporter=dot --silent
  EXPECT: Tests 106 passed (106)
  RESULT: exit 0, Tests 106 passed (106), following a fixture-only correction. Initial unmodified run: 15 failed / 91 passed, including cold-import 15s timeout. With `--testTimeout=60000`, a single failing approval test still returned 500. Temporary test-local error middleware captured `TypeError: db.select(...).from(...).where(...).orderBy(...).limit is not a function` at `issue-done-gate.ts:260`, called by `issue-stage-approvals.ts:334`; the error middleware was removed. `mockIssueService` replaces services/issues.ts in this suite, so the handoff's proposed `mockTx.select` change was tested and reverted: it did not resolve this failure. The production approval-bound reader now uses `.limit`; this suite's existing `mockDbSelectOrderBy` omitted that method. Updated its factory/default to return `{ limit: vi.fn(async () => []) }`. The targeted assertion was red at expected 200 versus 500 before the correction and green after (1 passed / 105 skipped); full suite passed with expanded cold-import timeout. The fixture models an empty bound set, not route concurrency.
  NEGATIVE: observed targeted pre-fix exit 1 at expected HTTP 200 versus actual 500; no independent isolated mutation control after the fix.

  CHECK: PATH="$HOME/.cargo/bin:$PATH" timeout 900 pnpm --filter @paperclipai/shared --filter @paperclipai/server typecheck
  EXPECT: server typecheck: Done
  RESULT: exit 0, shared Done and server Done; Rust runner emitted pre-existing unused-code warnings.
  NEGATIVE: typecheck is not a behavioral assertion; no safe negative run.

Still missing: queued-comments suppression cause and pinned-base same-environment comparison; route-level concurrency proof and residual binding writers; stalled durable decision; changed-head fresh-review route; contract sync; independent verification, PR, merge, rollout and Sable's decision. This branch is UNSAFE TO SHIP.

## Binding-row lock continuation — 2026-10-01 — HOLD

Two bounded implementer invocations on one deliverable added an issue-first binding-row lock helper, PATCH/comment route calls, and issue-first ordering in removeComment/tombstoneComment. The first invocation added a red test scaffold; the second reported 196/196 focused tests, 3/3 comment-lock-order tests, 2/2 binding-lock tests, and shared/server typecheck. These are implementer receipts, not independent final acceptance. Adjacent comment-route suites regressed because their transaction mocks lack select; baseline and WIP A/B is incomplete. The second invocation stashed the seven changed paths; Ty popped the stash and read back exactly seven dirty paths, with no loss. This deliverable is NOT safe to ship. Residual binding writers in work-products and low-trust promotion lack issue-row locking; check route concurrency and lock-order before green.

  CHECK: timeout 600 pnpm exec vitest run server/src/__tests__/issue-stage-approval-binding-locks.test.ts server/src/__tests__/issue-comment-lock-order.test.ts
  EXPECT: Test Files 2 passed (2)
  RESULT: implementer reported 2/2 and 3/3 separately; combined command not yet run by Ty.
  NEGATIVE: comment-lock-order pre-fix reported exit 1 at acquisition-order assertion (expected true, received false); binding helper negative remains to be isolated. No gate green on implementer report alone.

Ty independently ran `timeout 600 pnpm exec vitest run server/src/__tests__/issue-stage-approval-binding-locks.test.ts server/src/__tests__/issue-comment-lock-order.test.ts server/src/__tests__/issue-comment-stage-approval-lock.test.ts server/src/__tests__/issue-patch-stage-approval-locked-set.test.ts`: exit 0, 4 files / 14 tests, 61.30s. Adjacent `timeout 600 pnpm exec vitest run server/src/__tests__/issue-update-comment-wakeup-routes.test.ts server/src/__tests__/issue-comment-reopen-routes.test.ts server/src/__tests__/issue-queued-comments-routes.test.ts`: exit 1, 32 failed / 190 passed; 13 comment-reopen tests returned 500 (new tx.select absent from mock); 18 queued-comment scheduling failures and one 15s timeout require pinned-base comparison, not a waiver. Advisor: retain parent-first lock order, repair affected transaction fixtures, prove route-level concurrency; no safe-to-ship claim. Worktree dirty, no PR, merge, deployment or approval.


## PostgreSQL lock diagnostic conversion — 2026-09-30 — HOLD

Converted `server/src/__tests__/zz-probe-9396.test.ts` from a vacuous `/tmp`-writing probe to a test-local embedded-PostgreSQL assertion. Two connections and a post-lock barrier check four writer classes (work-product and comment inserts, work-product URL update, comment soft-delete). Both issue and existing binding row locks must block every writer; single-lock controls must allow a respective writer. This tests PostgreSQL lock primitives, NOT the production approval route's lock acquisition. Database cleanup runs in `finally`. No engine behavior changed.

  CHECK: timeout 300 pnpm exec vitest run server/src/__tests__/zz-probe-9396.test.ts
  EXPECT: Tests  1 passed (1)
  RESULT: exit 0, EXPECT matched: Test Files 1 passed (1); Tests 1 passed (1); Duration 17.33s. Re-run after negative restoration: exit 0, 1/1 passed, Duration 16.73s.
  NEGATIVE: temporarily remove `await lockBindingRows(tx)` from `lockBoth` in the same test fixture, then run `timeout 300 pnpm exec vitest run server/src/__tests__/zz-probe-9396.test.ts`; observed exit 1 at the blocking assertion, expected true but received false. Restored the binding lock immediately afterward. No live board data used.

`timeout 900 pnpm --filter @paperclipai/shared --filter @paperclipai/server typecheck` without cargo on PATH exited 1 (`cargo: not found`); `PATH="$HOME/.cargo/bin:$PATH" timeout 900 pnpm --filter @paperclipai/shared --filter @paperclipai/server typecheck` exited 0 (shared Done; server Done). `timeout 20 git diff --check` exited 0 before this ledger update.

Still missing: route-level PostgreSQL concurrent-writer oracle; production lock discipline; stalled durable approval, changed-head review, contract sync, independent verification, PR, merge, rollout and Sable decision. No safe-to-ship claim.

## PATCH locked-set continuation, 2026-09-30 — HOLD

The previous PATCH fixture's successful path was a false 500: its `addComment` mock returned undefined, and its bound-set mock expected a second argument instead of capturing the service-factory DB handle. Repaired both fixtures. With the production recheck absent, the same-size, grown and description-change assertions failed at expected 409 versus actual 200; the unchanged positive failed because the transaction handle was never used. Added a transaction-scoped canonical-set/head recheck before PATCH persistence. `timeout 220 pnpm exec vitest run server/src/__tests__/issue-patch-stage-approval-locked-set.test.ts` exited 0, 5/5 passed after implementation. `timeout 600 pnpm exec vitest run server/src/__tests__/issue-patch-stage-approval-locked-set.test.ts server/src/__tests__/issue-comment-stage-approval-lock.test.ts server/src/__tests__/issue-stage-approval-scan-budget.test.ts server/src/__tests__/issue-execution-policy-routes.test.ts server/src/__tests__/issue-done-pr-merged-gate.test.ts` exited 0, 69/69 passed. `export PATH="$HOME/.cargo/bin:$PATH"; timeout 900 pnpm --filter @paperclipai/shared --filter @paperclipai/server typecheck` exited 0 (shared Done, server Done); `git diff --check` exited 0. These modeled-handle checks do NOT establish PostgreSQL binding-row locks, nor durable stalled decisions, changed-head review, or end-to-end security approval. No PR/merge/rollout/decision.

  CHECK: timeout 220 pnpm exec vitest run server/src/__tests__/issue-patch-stage-approval-locked-set.test.ts
  EXPECT: Tests 5 passed (5)
  RESULT: exit 0, EXPECT matched: Test Files 1 passed (1); Tests 5 passed (5).
  NEGATIVE: after repairing the fixture but before implementing the locked recheck, the same CHECK exited 1: same-size/growth/description refusals expected 409 but received 200; the unchanged-set case did not observe the transaction handle. This is the same assertion on an isolated pre-fix input, not a missing mock or 500.

Still missing: real PostgreSQL concurrency oracle for issue-row and binding-row locks; production lock discipline preventing binding updates/inserts during approval; stalled-review durable decision with authenticated reviewer; changed-head fresh-review path; OpenAPI/shared/UI sync; independent final-head review and PR. The diagnostic `zz-probe-9396.test.ts` remains unsafe as a gate and must be converted or removed before PR.

## PATCH locked-set red phase and real-PostgreSQL lock probe, 2026-09-30 — HOLD

A bounded implementer left two untracked test files; no product file changed. `timeout 600 pnpm exec vitest run server/src/__tests__/issue-comment-stage-approval-lock.test.ts` exited 0 (4 passed); `timeout 400 pnpm exec vitest run server/src/__tests__/issue-done-pr-merged-gate.test.ts -t 'done_refused_unmerged_pr'` exited 0 (1 passed, 21 skipped). `timeout 400 pnpm exec vitest run server/src/__tests__/issue-patch-stage-approval-locked-set.test.ts` exited 1 (5 failed); two failures were 500 responses caused by incomplete test mocks, not meaningful authorization refusals. The red phase is NOT a valid acceptance oracle. The new PATCH test's mock binding reader also keys on a nonexistent second argument instead of the factory's handle, so repair the fixture before implementation. No gate is green.

`timeout 500 pnpm exec vitest run server/src/__tests__/zz-probe-9396.test.ts` exited 0 as a diagnostic, NOT a gate: separate embedded-PostgreSQL connections showed an issue-row FOR UPDATE blocks child work-product/comment INSERTs, but does not block work-product URL UPDATE or comment soft-delete. Binding-row FOR UPDATE alone blocks those UPDATEs but not INSERTs. Both locks together blocked all four observed write classes. Probe currently has a vacuous final assertion and writes /tmp/probe-9396.txt; it must be converted to a deterministic, isolated regression oracle or removed before PR. Do not infer serializable binding safety from this diagnostic; verify lock acquisition in actual approval routes and all binding mutations, with concurrent positive/negative controls. The preserved tx-scoped read at HEAD 632dbe33 is UNSAFE TO SHIP until this gap and all previous remaining items are closed. `git diff --check` exited 0 on tracked changes; two new test paths remain untracked and ledger is dirty. No PR, merge, rollout or security decision.


## Ty Gate 0 continuation, 2026-09-30

Reproduced each G2 failure in isolation with the default 15s Vitest timeout: the first test timed out at 15.9s; the second at 15.0s. With `--testTimeout=90000`, each passed its actual refusal assertions after 18.5s and 16.5s respectively. Running the whole route file at 120s passed 19/19; its first dynamic `createApp()` import took 17.8s and subsequent route tests took about 1s each. The cause is cold route-module import/transform under the test clock, not an application transaction hang. Changed only these two tests' individual timeout to 60s, preserving the default `CHECK:` and its authorization assertions. `timeout 300 pnpm exec vitest run server/src/__tests__/issue-execution-policy-routes.test.ts server/src/__tests__/issue-done-pr-merged-gate.test.ts` exited 0: Test Files 2 passed; Tests 41 passed (41); `git diff --check` exited 0. The first assertion returned 403 `review_policy_denied` for locked `human_only` and verified no update; the second returned 422 `invalid_issue_disposition` and verified no update. Gate 0 base replay and isolated negative controls completed on 2026-09-30. Disposable worktree `/srv/bulk/worktrees/ty/spa-9396-gate0-base-fixture` pinned to `2e7fb22b74aa232f384c54875908c6d4b83524a1`; `pnpm install --offline --frozen-lockfile --ignore-scripts` exited 0 using the unchanged lockfile. Added the faithful `cancelLiveRunsForIssue` mock only in the disposable fixture. `timeout 300 pnpm exec vitest run server/src/__tests__/issue-execution-policy-routes.test.ts server/src/__tests__/issue-done-pr-merged-gate.test.ts --testTimeout=60000` exited 0: 2 files, 41 tests passed. Negative 1 changed only the locked policy to `anyone`, retained refusal assertions: `timeout 180 pnpm exec vitest run server/src/__tests__/issue-execution-policy-routes.test.ts -t 'reauthorizes a terminal verdict against the review policy held under the update lock' --testTimeout=60000` exited 1 on `expect(res.status).toBe(403)`, received 404 (no mock update), not an import or timeout error. Negative 2 added a pending confirmation to the missing-review-path test, retained refusal assertions: `timeout 180 pnpm exec vitest run server/src/__tests__/issue-execution-policy-routes.test.ts -t 'rejects an agent-authored in_review transition without a review path' --testTimeout=60000` exited 1 on `expect(res.status).toBe(422)`, received 404, not an import or timeout error. These controls do NOT prove the intended guard: each returns 404 due to an incomplete downstream fixture, rather than the intended alternate authorization result. Advisor rejected calling Gate 0 green. Gate 0 remains UNPROVEN until the fixture models the post-guard route and the controls fail at the intended assertion with meaningful alternate response; no implementation may begin. No feature implementation or PR this session.

## Gate 0 final control, 2026-09-30

The two earlier negative controls were invalid because a successfully authorized route reached the unconfigured `mockIssueService.update` and returned 404. I temporarily configured a successful update fixture in each test and changed only its authorization input, leaving the original refusal assertion intact. Control 1: locked review policy `anyone` instead of `human_only`, `timeout 180 pnpm exec vitest run server/src/__tests__/issue-execution-policy-routes.test.ts -t 'reauthorizes a terminal verdict against the review policy held under the update lock' --testTimeout=60000` exited 1 at `expect(res.status).toBe(403)` with actual **200** (one failed, 18 skipped). Control 2: pending same-run confirmation interaction instead of no review path, `timeout 180 pnpm exec vitest run server/src/__tests__/issue-execution-policy-routes.test.ts -t 'rejects an agent-authored in_review transition without a review path' --testTimeout=60000` exited 1 at `expect(res.status).toBe(422)` with actual **200** (one failed, 18 skipped). Reverted both temporary fixture edits exactly; `git status --short` empty. Positive `timeout 300 pnpm exec vitest run server/src/__tests__/issue-execution-policy-routes.test.ts server/src/__tests__/issue-done-pr-merged-gate.test.ts` exited 0: 2 files, 41 tests passed, duration 55.10s. `git diff --check` exited 0. Gate 0 is now proven for the existing guards; it does not prove the new approval feature safe. Begin only Steve's bounded implementation scope next.

## Tx-scoped scan-budget continuation — HOLD, 2026-09-30

This run changed the approval-bound-set reader to use the transaction handle for the comment recheck (`routes/issues.ts:17862`) and terminal update gate (`services/issues.ts:10615`). The approval scan now requests a sentinel row at the 100-work-product and 200-comment limits and refuses with `issue_stage_approval_scan_budget_exceeded` if the sentinel exists. The legacy done gate retains the 100/200 effective caps. A malformed recorded SHA fails closed at state parsing; malformed live or claimed SHA also refuses in the approval service. The issue-row `FOR UPDATE` remains. Do not infer serializable isolation or a proven concurrent-INSERT oracle from these unit tests.

  CHECK: timeout 300 pnpm exec vitest run server/src/__tests__/issue-stage-approval-scan-budget.test.ts
  EXPECT: Tests 19 passed (19)
  RESULT: exit 0, EXPECT matched: Test Files 1 passed (1), Tests 19 passed (19), Duration 12.52s.
  NEGATIVE: the first run with a null claim exited 1 (4 failed/15 passed), but the three budget cases failed at `issue_stage_approval_incomplete_pull_request_set` before the scan, so that was an invalid failing control. A later test run with the corrected claim and seam exited 0; no isolated mutation of the production truncation assertion has yet been run. G7/G8 unproven by negative control despite green positives.

  CHECK: timeout 600 pnpm exec vitest run server/src/__tests__/issue-comment-stage-approval-lock.test.ts server/src/__tests__/issue-stage-approvals.test.ts server/src/__tests__/issue-stage-approval-scan-budget.test.ts
  EXPECT: Tests 40 passed (40)
  RESULT: exit 0, EXPECT matched: Test Files 3 passed (3), Tests 40 passed (40), Duration 30.12s.
  NEGATIVE: no isolated mutation of route tx plumbing yet. G7 route integration unproven.

  CHECK: timeout 600 pnpm exec vitest run server/src/__tests__/issue-execution-policy.test.ts server/src/__tests__/issue-execution-policy-routes.test.ts server/src/__tests__/issue-stalled-review-decision-routes.test.ts server/src/__tests__/issue-done-pr-merged-gate.test.ts
  EXPECT: Tests 132 passed (132)
  RESULT: exit 0, EXPECT matched: Test Files 4 passed (4), Tests 132 passed (132), Duration 69.81s. Existing regressions, not new stalled approval acceptance.
  NEGATIVE: Gate 0's isolated alternate-authorization controls are recorded above; no new feature-specific negative for stalled review or terminal close.

  CHECK: export PATH="$HOME/.cargo/bin:$PATH"; timeout 900 pnpm --filter @paperclipai/shared --filter @paperclipai/server typecheck
  EXPECT: server typecheck: Done
  RESULT: exit 0, EXPECT matched: packages/shared typecheck: Done; server typecheck: Done. Initial attempt without the narrow transaction cast failed TS2352; rerun after cast exited 0.
  NEGATIVE: typecheck is not a behavioral guard; no safe isolated negative run.

  CHECK: timeout 20 git diff --check
  EXPECT: exit 0
  RESULT: exit 0, output empty before ledger edit; rerun after edit needed.
  NEGATIVE: no isolated whitespace-error fixture run.

The comment route's positive test now spies on `issueDoneGateService` construction and asserts the bound-set reader receives the exact `mockTx` handle; `timeout 300 pnpm exec vitest run server/src/__tests__/issue-comment-stage-approval-lock.test.ts` exited 0: 1 file / 4 passed, duration 23.73s. The terminal gate now passes `dbOrTx` to the approval service but has no distinct-handle integration test. Negative control for tx route plumbing not yet run.

Still missing: an isolated failing control for sentinel refusal; concurrent binding insert/cap controls; PATCH canonical-set recheck; stalled-review durable decision with correct authenticated reviewer; changed-head fresh-review route; integration oracles; OpenAPI/shared/UI sync; independent final-head verification, engine PR, merge and rollout. This is not safe to ship. The new test file `issue-stage-approval-scan-budget.test.ts` has 19 green unit tests but only modeled handles, not PostgreSQL concurrency.

## Comment-path implementer result — HOLD, 2026-09-30

New test-first fixture `server/src/__tests__/issue-comment-stage-approval-lock.test.ts` covers four mocked comment approvals; before implementation the refusal cases returned 201 rather than 409. After route edits: `timeout 300 pnpm exec vitest run server/src/__tests__/issue-comment-stage-approval-lock.test.ts` exited 0 (4 passed); the isolated negative disabled the new guard and exited 1 on expected 409 versus actual 201 (2 failed, 2 passed). `timeout 600 pnpm exec vitest run server/src/__tests__/issue-execution-policy-routes.test.ts server/src/__tests__/issue-done-pr-merged-gate.test.ts` exited 0 (41 passed). `export PATH="$HOME/.cargo/bin:$PATH" && timeout 900 pnpm --filter @paperclipai/shared --filter @paperclipai/server typecheck` exited 0 (both Done); `timeout 20 git diff --check` exited 0. These are implementer receipts, not independent acceptance.

  CHECK: timeout 300 pnpm exec vitest run server/src/__tests__/issue-comment-stage-approval-lock.test.ts
  EXPECT: Test Files  1 passed
  NEGATIVE: isolated disable of the locked guard in disposable fixture, then timeout 300 pnpm exec vitest run server/src/__tests__/issue-comment-stage-approval-lock.test.ts; observed exit 1, expected 409 versus received 201 in two tests. Control must be repeated with a durable exact invocation before claiming gate green.

**Unsafe boundary unresolved:** `commentStageApprovalSvc.readBound` delegates to `issue-done-gate.ts:183-246` and captures outer `db`, not transaction `tx`; calling it inside the approval transaction is NOT a tx-scoped read. It limits products to 100 and comments to COMMENT_SCAN_LIMIT; binding writes can race the issue-row lock. Do not ship or green this gate. Next implementation must use a tx-scoped fail-closed exhaustive binding read (or equivalent serializable binding discipline) and test the caps/concurrent insert. Stalled durable decision, changed-head fresh review, integration, contract sync, independent verification, PR/merge/rollout remain missing.

## Steve arbitration pass, 2026-09-30 (manager arbitration of the implementer-session cap)

Two of the escalation's stated blockers were re-derived and corrected. One safety claim does NOT clear.

**G5 is NOT blocked — the `cargo: not found` was a PATH artifact.** `cargo` exists at `~/.cargo/bin/cargo`; the run failed only because that directory was absent from `PATH`. With `export PATH="$HOME/.cargo/bin:$PATH"`, `timeout 900 pnpm --filter @paperclipai/shared --filter @paperclipai/server typecheck` **exits 0** (`Finished 'release' profile ... in 2m 47s`; `server typecheck: Done`). G5 is GREEN. Any later session MUST export that PATH before claiming the toolchain is unavailable.

**G2's 2 failures are NOT introduced by this WIP.** Clean A/B, three arms, all exit 1 with the same two named tests:
1. WIP product code + faithful mock → 2 failed | 39 passed.
2. WIP product code reverted to `c8c7e847a1` + original mock → 2 failed | 17 passed (19).
3. Base product code + faithful mock → 2 failed | 17 passed (19).

So the red is pre-existing on the base commit, and reverting the repair does not clear it. Root cause of the masked assertion: `routes/issues.ts` calls `heartbeat.cancelLiveRunsForIssue` on every status transition, and the test's `mockHeartbeatService` never defined it, so the route threw mid-flight (`TypeError: heartbeat.cancelLiveRunsForIssue is not a function`) instead of reaching its assertions. `cancelLiveRunsForIssue` is real (`server/src/services/heartbeat.ts:29992`, returns an array of cancelled run rows); the mock now returns `[]`. That single faithful mock line is the only test change in the checkpoint commit `8f29726180`.

**The "unsafe to ship" claim is NOT withdrawn.** Pre-existing-ness is exculpatory only when the red lives in a region this change cannot reach. Here the red IS the authorization guard exercised by `issue-execution-policy-routes.test.ts` — precisely the class this card must not weaken. Gate 0 (green-on-base with a faithful mock) did not go green, so there is currently no working oracle proving the guard still refuses. Root cause is NOT yet established: a proxy over `mockDb.transaction` logged no missing `tx` method, and `tx.insert`/`tx.update` appear only on decision-recording paths, so the 15s hang is still unexplained. Do not treat G2 as a known-red that can be waived; it is a MISSING ORACLE until the hang is explained and the guard is shown to refuse.

Remaining scope is unchanged except G5 dropped out: comment-path locked-snapshot recheck, canonical PR-set validation under the update lock, stalled-review durable decision row with correct authenticated reviewer, changed-head fresh-review path, integration oracles, OpenAPI/shared/UI contract sync, negative controls, independent verification, engine PR, merge, rollout. Generic `approved` remains stage participation and must never be read as security-class attestation.

Continuation receipt (2026-09-30): Sable measured on SPA-9690 that generic terminal stage participation writes `lastDecisionOutcome: approved` even outside the security class. This is not security attestation. Do not interpret it as such or migrate historical outcomes. Four bounded implementer sessions produced uncommitted partial changes; no PR, merge, deployment, or Sable approval. Foreground `timeout 180 pnpm exec vitest run server/src/__tests__/issue-stage-approvals.test.ts server/src/__tests__/issue-execution-policy.test.ts server/src/__tests__/issue-stalled-review-decision-routes.test.ts server/src/__tests__/issue-done-pr-merged-gate.test.ts --testTimeout=120000` exited 0: Test Files 4 passed; Tests 130 passed. This does not clear G2, G5, or integration requirements. `git diff --check` exited 0; tree remains dirty. G2 baseline was reproduced on pre-WIP base by implementer and passed with `--testTimeout=120000`; normal 15-second suite remains red. Untracked unit and negative-control tests are preserved in assigned worktree, not published. Do not PR this partial implementation.

Typecheck receipt this run: `timeout 900 pnpm --filter @paperclipai/shared --filter @paperclipai/server typecheck` exit 1; shared typecheck Done, server prepare:runner-vendor failed at `cargo build`: `sh: 1: cargo: not found`. No server typecheck pass claim. Root/server manifests provide no lint script. G2 still red at default test timeout. Unit regression receipt above is 130 passed / 4 files, not end-to-end acceptance.

Critical remaining: comment autoapproval must recheck locked issue snapshot and canonical PR set; stalled-review path needs durable decision row with correct authenticated board reviewer and route input schema; integration oracles must cover normal/comment/stalled approval and terminal merge gate; synchronize shared/OpenAPI/UI clients; run server typecheck (previously cargo missing), finish negative controls and independent final-head verification. Generic `approved` remains stage participation, never security-class attestation.

Scope: one atomic engine sequencing repair. Authorized premerge approval is distinct from terminal completion. Preserve board-only stalled-review access, participant authorization, doneOverride, and terminal merge gate. Handoff 422 investigated, authority unchanged.

## G1 — Head-bound approval is nonterminal
  CHECK: timeout 180 pnpm exec vitest run server/src/__tests__/issue-execution-policy.test.ts
  EXPECT: Test Files  1 passed
  RESULT: exit 0, EXPECT matched. Output: Test Files  1 passed (1); Tests  81 passed (81). Baseline before implementation: exit 1; 2 failed | 79 passed.
  LIMIT: does not yet prove reconciliation cannot restart implementation.

## G2 — Normal PATCH/comment approval authorization and head freshness
  CHECK: timeout 300 pnpm exec vitest run server/src/__tests__/issue-execution-policy-routes.test.ts server/src/__tests__/issue-done-pr-merged-gate.test.ts
  EXPECT: Test Files  2 passed
   RESULT: superseded 2026-09-30 by Gate 0 rerun on this branch: exit 0, EXPECT matched, Test Files 2 passed (2), Tests 41 passed (41), independently repeated by Dex. Base replay with faithful mock also exit 0, 2 files / 41 tests at pinned SHA (see Gate 0 section). Negative fixture controls exit 1 at each refusal assertion; these do not establish the feature's integration behavior.
  FAILURES: reauthorizes a terminal verdict against the review policy held under the update lock timed out in 15000ms; rejects an agent-authored in_review transition without a review path found update called once. Same failures reproduced by Steve on the BASE commit with the WIP reverted (2 failed | 17 passed, both mock variants) — see arbitration section. Root cause: mockHeartbeatService lacks cancelLiveRunsForIssue; mock corrected in 8f29726180. The guard still does not go green, so this gate remains RED and is a missing oracle, not a waiver.

## G3 — Stalled review existing authorization regression
  CHECK: timeout 300 pnpm exec vitest run server/src/__tests__/issue-stalled-review-decision-routes.test.ts
  EXPECT: Test Files  1 passed
  RESULT: exit 0, EXPECT matched. Output: Test Files  1 passed (1); Tests  10 passed (10).
  LIMIT: new PR-backed stalled approval oracle still missing; green legacy suite is not feature acceptance.

## G4 — Existing terminal merge gate regression
  CHECK: timeout 300 pnpm exec vitest run server/src/__tests__/issue-done-pr-merged-gate.test.ts
  EXPECT: Test Files  1 passed
  RESULT: exit 0, EXPECT matched. Output: Test Files  1 passed (1); Tests  22 passed (22).
  LIMIT: new changed-head/set/policy and merged-approved close oracles still missing.

## G5 — Shared/server contract typecheck
  CHECK: timeout 900 pnpm --filter @paperclipai/shared --filter @paperclipai/server typecheck
  EXPECT: server typecheck: Done
  RESULT: exit 1, EXPECT absent (SUPERSEDED 2026-09-30 by Steve's re-run — see arbitration section). Original output: packages/shared typecheck: Done; server typecheck: sh: 1: cargo: not found; ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL; Exit status 1. No lint script defined in root/server package manifests.
  RERUN (Steve, 2026-09-30, `export PATH="$HOME/.cargo/bin:$PATH"`): exit 0, EXPECT MATCHED. Output: `Finished 'release' profile [optimized] target(s) in 2m 47s`; server typecheck: Done. G5 IS GREEN. The original failure was a PATH artifact, not a missing toolchain.

## G6 — Diff integrity
  CHECK: timeout 20 git diff --check
  EXPECT: exit 0
  RESULT: exit 0, output empty.

## Initial grounding
- Assigned checkout realized clean at HEAD 2e7fb22b74aa232f384c54875908c6d4b83524a1 on ty/SPA-9396 branch; no branch switching. Origin JamesSparkMojo/paperclip, credentials redacted; fork sparkmojo remote Spark-Mojo/paperclip.
- routes/issues.ts original line 12604 asserts board for stalled-review-decision. Reported agent-authorized stalled path does not exist here.
- issue-execution-policy.ts original lines 920-960 intentionally rejects nonparticipant reassignment. Separate escalation card remains sanctioned route; no participant authorization weakening.

## Critical remaining implementation — do not PR/merge this WIP
1. Policy fingerprint helper exists but is NOT persisted/checked on approval. Must bind policy revision, stage and authenticated reviewer.
2. Comment autoapprove lacks locked execution snapshot recheck. PATCH snapshot does not compare description/bound PR set; incoming comment/description must be considered before canonical binding validation. Validate with DB transaction and optimistic state comparison.
3. Stalled board approval currently passes board user as transition actor without board override/participant design; must preserve existing board authorization while recording an actual durable decision row and correct reviewer identity, not impersonating another actor.
4. Completed awaitingMerge cannot re-review a changed head yet; implement explicit sanctioned fresh review path and test it. Do not silently clear review evidence or restart implementation.
5. New helper has unused import/functions; consolidate shared flow. Verify same-size changed sets, removed PRs, missing heads, ambiguous reads, no-PR cards, all stages, duplicate approvals, concurrency.
6. Add integration tests proving actual PR-backed approval success on normal/comment/stalled paths plus unauthorized/stale rejection and unchanged-head merged terminal close.
7. Sync shared update schema/OpenAPI/UI clients so reviewedPullRequests is usable, not server-only hidden field.
8. Independent final-head verification, engine PR, Dex merge and sanctioned rollout remain undone. Sable must record her own decision only after rollout; PR #1202 stays under normal gates.

Advisor reviewed plan and incomplete exit; agrees no safe approval boundary yet. Two invocations of the SAME implementer session advanced this one deliverable; no completed deliverable, commits, pushes, PR or live approval. Keep assigned workspace intact. WIP is not deployed.
