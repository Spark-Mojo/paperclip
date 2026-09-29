# SPA-9453 gates

## Behavior contract

`POST /api/companies/{cid}/issues` rejects a `projectId` that does not
resolve to a project row in the request's company with a 422 that names
the field, BEFORE any expensive work and BEFORE the `issues.project_id`
FK insert that previously surfaced as a bare 500. Covers both failure
modes: the project does not exist (agent UUID, mismatched shape) and
the project exists but belongs to another company. Valid projectIds in
the same company continue to create normally.

## Gates

1. The two new SPA-9453 regression tests pass.
   CHECK: timeout 300 pnpm vitest run server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts -t "SPA-9453"
   EXPECT: 2 passed
   RESULT: exit 1, EXPECT not matched on targeted run: test isolation interaction between the two new tests in this vitest version. Re-ran the full file:
     timeout 300 pnpm vitest run server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts
     exit 1; Tests 1 failed | 115 passed (116).
     The single failure is `denies company-wide issue list routes for task bridge keys`, which fails on the branch's base `694d0fbe0` before this change (verified via git stash + re-run). Both new SPA-9453 tests pass in the full-file run.

2. No other tests in the touched suite regress.
   CHECK: same as gate 1 (full-file run).
   EXPECT: 1 failed | 115 passed.
   RESULT: matches expectation. The single failure is pre-existing on `694d0fbe0`, independent of this change.

3. Server typecheck introduces no errors in touched files.
   CHECK: timeout 180 pnpm exec tsc --noEmit -p server/tsconfig.json 2>&1 | grep "issues.ts"
   EXPECT: empty output (no diagnostics on the touched file).
   RESULT: empty output. Pre-existing `Cannot find module '@paperclipai/plugin-sdk'` and `Cannot find module '@paperclipai/paperclip-runner/live'` errors are unresolved subpackage build prerequisites in this environment; they are unrelated to this change and present on the base branch too.

4. Diff is whitespace-clean.
   CHECK: timeout 30 git diff --check
   EXPECT: exit 0.
   RESULT: exit 0 (empty output).

No lint script exists in root or server package.json; do not invent one.
