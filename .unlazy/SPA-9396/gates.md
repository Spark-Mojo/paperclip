# SPA-9396 gates — incomplete WIP, 2026-09-30

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
  RESULT: exit 1, EXPECT absent. Output: Test Files  1 failed | 1 passed (2); Tests  2 failed | 39 passed (41).
  FAILURES: reauthorizes a terminal verdict against the review policy held under the update lock timed out in 15000ms (line 265); rejects an agent-authored in_review transition without a review path found update called once (line 337). Same failures reproduced twice; advisor consulted before any further fix. Do not assume mock-only defects.

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
  RESULT: exit 1, EXPECT absent. Output: packages/shared typecheck: Done; server typecheck: sh: 1: cargo: not found; ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL; Exit status 1. No typecheck pass claim for server. No lint script defined in root/server package manifests.

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
