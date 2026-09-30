# SPA-9396 gates — incomplete WIP, 2026-09-30

## Ty Gate 0 continuation, 2026-09-30

Reproduced each G2 failure in isolation with the default 15s Vitest timeout: the first test timed out at 15.9s; the second at 15.0s. With `--testTimeout=90000`, each passed its actual refusal assertions after 18.5s and 16.5s respectively. Running the whole route file at 120s passed 19/19; its first dynamic `createApp()` import took 17.8s and subsequent route tests took about 1s each. The cause is cold route-module import/transform under the test clock, not an application transaction hang. Changed only these two tests' individual timeout to 60s, preserving the default `CHECK:` and its authorization assertions. `timeout 300 pnpm exec vitest run server/src/__tests__/issue-execution-policy-routes.test.ts server/src/__tests__/issue-done-pr-merged-gate.test.ts` exited 0: Test Files 2 passed; Tests 41 passed (41); `git diff --check` exited 0. The first assertion returned 403 `review_policy_denied` for locked `human_only` and verified no update; the second returned 422 `invalid_issue_disposition` and verified no update. Gate 0 base replay and isolated negative controls completed on 2026-09-30. Disposable worktree `/srv/bulk/worktrees/ty/spa-9396-gate0-base-fixture` pinned to `2e7fb22b74aa232f384c54875908c6d4b83524a1`; `pnpm install --offline --frozen-lockfile --ignore-scripts` exited 0 using the unchanged lockfile. Added the faithful `cancelLiveRunsForIssue` mock only in the disposable fixture. `timeout 300 pnpm exec vitest run server/src/__tests__/issue-execution-policy-routes.test.ts server/src/__tests__/issue-done-pr-merged-gate.test.ts --testTimeout=60000` exited 0: 2 files, 41 tests passed. Negative 1 changed only the locked policy to `anyone`, retained refusal assertions: `timeout 180 pnpm exec vitest run server/src/__tests__/issue-execution-policy-routes.test.ts -t 'reauthorizes a terminal verdict against the review policy held under the update lock' --testTimeout=60000` exited 1 on `expect(res.status).toBe(403)`, received 404 (no mock update), not an import or timeout error. Negative 2 added a pending confirmation to the missing-review-path test, retained refusal assertions: `timeout 180 pnpm exec vitest run server/src/__tests__/issue-execution-policy-routes.test.ts -t 'rejects an agent-authored in_review transition without a review path' --testTimeout=60000` exited 1 on `expect(res.status).toBe(422)`, received 404, not an import or timeout error. These controls do NOT prove the intended guard: each returns 404 due to an incomplete downstream fixture, rather than the intended alternate authorization result. Advisor rejected calling Gate 0 green. Gate 0 remains UNPROVEN until the fixture models the post-guard route and the controls fail at the intended assertion with meaningful alternate response; no implementation may begin. No feature implementation or PR this session.

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
