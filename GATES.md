# SPA-8957 gates — engine refuses `done` while the card's PR is unmerged

Base: `origin/rebuild/v2026.916.0-survivors` (99ce98980). Fold-in: same single
install as PR #75 + SPA-8967 + SPA-9001 (SPA-8892 checklist).

## Gate 1 — repro of the false-close shape FAILS before the fix
CHECK: `git stash -q && git checkout -q 76e5cc123 && cd server && timeout 600 pnpm vitest run src/__tests__/issue-done-pr-merged-gate.test.ts ; cd .. ; git checkout -q SPA-8957-build-james-yes-2026-09-27-engine-refuses-done-while-the-card-s-pr-is-unmerged-incl-review-approve-path-same-in && git stash pop -q`
EXPECT: `done-before-fix: unmerged PR card closes` reported as FAILING (vitest exits non-zero) at the pre-change tree.

## Gate 2 — same repro PASSES after the change
CHECK: `cd server && timeout 600 pnpm vitest run src/__tests__/issue-done-pr-merged-gate.test.ts`
EXPECT: `Test Files  1 passed` and `done_refused_unmerged_pr` in the output.

## Gate 3 — control: a card with no PR still closes cleanly
CHECK: same vitest run as Gate 2, case `done_allowed_without_pr`
EXPECT: the control case is listed as passing in the same `1 passed` file.

## Gate 4 — review-approve path (SPA-8708/8669/8919 shape) is refused, card stays in_review
CHECK: same vitest run as Gate 2, case `review_approve_comment_held_open`
EXPECT: case passing — approve comment on an unmerged-PR card does NOT close the card.

## Gate 5 — override is explicit, observable, agent-denied
CHECK: same vitest run as Gate 2, cases `override_by_board_recorded` and `override_denied_for_agent`
EXPECT: both cases passing; activity `issue.done_gate_overridden` asserted in the first, 403 in the second.

## Gate 6 — typecheck clean
CHECK: `cd server && timeout 600 pnpm exec tsc --noEmit`
EXPECT: exit 0, no output lines starting with `error TS`.
