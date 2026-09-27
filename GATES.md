# SPA-8957 gates — engine refuses `done` while the card's PR is unmerged

Base: `origin/rebuild/v2026.916.0-survivors` (99ce98980). Fold-in: same single
install as PR #75 + SPA-8967 + SPA-9001 (SPA-8892 checklist).

## Gate 1 — repro of the false-close shape FAILS before the fix
CHECK: `git checkout 76e5cc123 -- server/src/services/issues.ts server/src/routes/issues.ts server/src/modules/active-run-watchdog/adapters/postgres.ts && rm server/src/services/issue-done-gate.ts && cd server && timeout 600 pnpm vitest run src/__tests__/issue-done-pr-merged-gate.test.ts`
EXPECT: `done_refused_unmerged_pr` and `review_approve_comment_held_open` FAIL.
RESULT: PASS — 8 failed / 2 passed. `done_refused_unmerged_pr`: `promise resolved {...} instead of rejecting` (the open-PR card closed). `review_approve_comment_held_open`: `expected 201 to be 409` (approve comment auto-closed the card — the SPA-8708/8669/8919 shape reproduced).

## Gate 2 — same repro PASSES after the change
CHECK: `cd server && timeout 600 pnpm vitest run src/__tests__/issue-done-pr-merged-gate.test.ts`
EXPECT: `Test Files  1 passed`.
RESULT: PASS — `Tests  10 passed (10)`; refusal asserts 409 + `code: issue_done_with_unmerged_pull_request` + PR list.

## Gate 3 — control: a card with no PR still closes cleanly
CHECK: same run, case `done_allowed_without_pr`.
RESULT: PASS — control case passing in the same 10/10 file; `status` reads back `done`.

## Gate 4 — review-approve path (SPA-8708/8669/8919 shape) refused, card stays in_review
CHECK: same run, case `review_approve_comment_held_open`.
RESULT: PASS — real-route POST of an APPROVED review comment returns 409; card status stays `in_review`; zero comments survive the transaction rollback (no orphan approve prose).

## Gate 5 — override explicit, observable, agent-denied
CHECK: same run, cases `override_by_board_recorded` and `override_denied_for_agent`.
RESULT: PASS — board/user override closes the card AND writes an `issue.done_gate_overridden` activity row (reason + gate code asserted); agent PATCH carrying `doneOverride` returns 403 and the card stays open.

## Gate 6 — typecheck clean
CHECK: `cd server && timeout 900 pnpm exec tsc --noEmit`
EXPECT: exit 0.
RESULT: PASS — exit 0, no output.

## Regression sweep (neighbouring suites)
- `issue-execution-policy.test.ts`: 89/89 pass.
- `issue-execution-policy-routes.test.ts`: 2 failures (`terminal verdict ... update lock` timeout, `without a review path`) — reproduced identical on the PRISTINE base 99ce98980 (checked out and re-run): pre-existing, not caused by this change.
- `issue-comment-reopen-routes.test.ts`: 2 failures (`reopen=true no-op` timeout, `binds explicit attachments ... called 2 times`) — reproduced identical on pristine base 99ce98980: pre-existing.
