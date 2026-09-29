# SPA-9381 gates

Scope: exact approved scratch-dir clause in both default templates, regression coverage only. Runtime registration warning remains SPA-9011; teardown guard remains SPA-9394. Explicit card contract authorizes rebuild/v2026.916.0-survivors PR base instead of generic main-only rule (advisor reconciled).

## G1 Both prompt templates preserve the approved clause byte-identically
    CHECK: timeout 120 pnpm exec vitest run packages/adapter-utils/src/server-utils.test.ts -t 'restricts run scratch directories to disposable temporary files'
    EXPECT: 2 passed
Result: exit 0; EXPECT matched.

## G2 Adapter package typechecks
    CHECK: timeout 120 pnpm --filter @paperclipai/adapter-utils typecheck
    EXPECT: tsc --noEmit (exit 0)
Result: exit 0; EXPECT matched.

## G3 Diff has no whitespace errors
    CHECK: timeout 30 git diff --check
    EXPECT: empty output (exit 0)
Result: exit 0; EXPECT matched.

## G4 PR uses authorized survivor base and independent final-head verification
    CHECK: timeout 30 gh pr view --repo Spark-Mojo/paperclip --json baseRefName,headRefOid,url
    EXPECT: rebuild/v2026.916.0-survivors
Result: exit 0; EXPECT matched. PR #121 reports baseRefName rebuild/v2026.916.0-survivors and source head c590ee9450e9ebcd3965fe3a8c11e40fbdfe425d. Independent verification is required after the final ledger commit; no sign-off claimed here.

Test-first receipt: G1 before implementation exited 1 with 2 failed (agent and conversation); after implementation exited 0 with 2 passed | 122 skipped. G2 output: tsc --noEmit, exit 0. G3 empty output, exit 0.

## Baseline / blast radius
Command: git grep -n 'temporary scratch files' refs/remotes/origin/rebuild/v2026.916.0-survivors
Output at 1751e28631: only packages/adapter-utils/src/server-utils.ts lines 276 and 293; no test asserts on the old sentence.
No lint script in root or adapter-utils package.json. Focused package typecheck is the available static gate.
Fork check/base comparison: gh pr view 121 --repo Spark-Mojo/paperclip --json statusCheckRollup showed ci / Select trusted runner and review IN_PROGRESS, no red completed check at inspection. gh api repos/Spark-Mojo/paperclip/commits/1751e28631af0409f1bc6fe821cb41379d5970cb/check-runs returned no check rows. No base-failure exemption claimed without evidence; review is never a blocker under card policy. allow_auto_merge read from gh api repos/Spark-Mojo/paperclip = false.
