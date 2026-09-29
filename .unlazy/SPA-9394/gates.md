# SPA-9394 gates

## Behavior contract

Protect every entry other than the ownership marker, without Git/extension heuristics or recursive scans. This covers standalone deliverables, nested worktrees, clean/pushed repositories, links and empty directories. Marker-only scratch remains disposable. Enumeration errors fail closed as content_check_failed. Ownership and live-process guards retain precedence. Existing heartbeat lifecycle event emits warn with reason and retained directory; recovery guidance is included in the cleanup result payload.

Retention: no automatic age-based reaper for protected data. Ty/operator must recover content into a durable workspace, remove the recovered scratch entries, then retry ownership-checked cleanup after writers stop. Retained scratch remains on tmp storage and can be evicted by the OS; this is not durable backup. Conservative retention may accumulate caches; manual evacuation is deliberate rather than guessing what is disposable.

Read SPA-9011 live (backlog): R2 concerns registered execution-workspace cleanup; this change only protects unregistered run scratch and does not settle or supersede its R1/R2 decisions. PR #119's releaseRunExecutionWorkspace remains disjoint from scratch cleanup at survivor base 1751e28631.

## Gates

1. Content survives cleanup, errors retain, marker-only cleanup and ownership/process guards remain correct.
   CHECK: timeout 120 pnpm exec vitest run server/src/services/run-scratch.test.ts
   EXPECT: Test Files  1 passed
   RESULT: exit 0, EXPECT matched: Test Files  1 passed (1); Tests 14 passed (14). Red-first receipt: 7 failed / 6 passed before implementation. Added late-write protection test; marker-only deletion now uses unlink + nonrecursive rmdir, restoring marker exclusively on failure.

2. Server typecheck introduces no errors.
   CHECK: timeout 900 pnpm --filter @paperclipai/server typecheck
   EXPECT: exit 0
   RESULT: exit 1, EXPECT not matched: unchanged runner build prerequisite fails `sh: 1: cargo: not found`. Standard command remains blocked by environment. Supplemental CHECK: timeout 600 pnpm --filter @paperclipai/plugin-sdk ensure-build-deps && timeout 180 pnpm --filter @paperclipai/server exec tsc --noEmit. Supplemental RESULT: exit 0; no diagnostics. No typecheck gate weakened.

3. Diff is whitespace-clean.
   CHECK: timeout 30 git diff --check
   EXPECT: exit 0
   RESULT: exit 0, EXPECT matched (empty output).

No lint script exists in root or server package.json; do not invent one.

## CI comparison (2026-09-29)

Every red context on the FINAL head, with its receipt and its disposition. No claim of a fully green suite.

Final head `00874461cdb9cfbb5640358344ef533e07466c52`, run 36567732689. `gh api repos/Spark-Mojo/paperclip/commits/00874461/check-runs?per_page=100` reports 48 check runs, 7 failures:

- `ci / General tests (server (9/12))` — `execution-control-reconciliation.test.ts:114` expected 0 capture calls, received 1. PROVEN FLAKE, NOT A REGRESSION. The first push on this branch, head `c9d3af144aa09c59ab100183208b5ff18a90a3a0` (run 36561673658, job 109383803104), ran the same shard 9/12 with the same 64 of 660 suites and it was GREEN. Between those two heads the only changed file is this ledger: `git diff --name-only c9d3af14 00874461` returns one path, `.unlazy/SPA-9394/gates.md`, and `git rev-parse c9d3af14:server` and `git rev-parse 00874461:server` both return `6ef40c3ecd5759670912a97c718d0a00d44813a9`. Identical source tree, opposite outcome. Mechanism: `execution-control-reconciliation.ts:245` fires `void reportRunFailure(...)` unawaited, whose capture awaits a DB read (`run-failure-report.ts:71-83`); the test snapshots `mockCaptureRunFailure.mock.calls.length` without draining the first sweep's in-flight report, so a late first-sweep capture is read as a second-sweep capture. The changed `run-scratch.test.ts` executed in that same shard and passed: `src/services/run-scratch.test.ts (14 tests) 33ms`. Local receipt, 5 consecutive runs of `timeout 180 pnpm exec vitest run server/src/services/execution-control-reconciliation.test.ts`: exit 0 each, `Tests  2 passed (2)`.
- `ci / General tests (workspaces-b)` — EPIPE in `server/src/services/adapter-utils/server-utils.test.ts`, unchanged by this diff. Red on the survivor-base predecessor too.
- `ci / Verify serialized server suites (2/9)` — red on the survivor-base predecessor too.
- `ci / e2e` — red on the survivor-base predecessor too.
- `ci / policy` — `node ./scripts/check-no-git-push.mjs` fails on `server/src/services/workspace-runtime.ts:4884` and `server/src/__tests__/workspace-runtime.test.ts:4572,4577`. Both files have zero diff from survivor base `1751e28631`. Red on `c9d3af14` and on predecessor `9e9a05ed`, so it predates this branch.
- `ci / verify` — the aggregate gate. Its log shows `GENERAL_TESTS_RESULT: failure` cascading from the shard-9 flake; it asserts nothing of its own.
- `review` — the vendor `commitperclip` action, no key configured on this fork.

Survivor-base predecessor PR #118 head `9e9a05ede909f2646a49ed99aa564a7d4bd5b256` (run 36546551412) fails the same six: `review`, `ci / policy`, `workspaces-b`, `serialized 2/9`, `verify`, `e2e`. The base tip `1751e28631` itself has zero check runs; absence of checks is not a green baseline, so every "baseline" claim above rests on a named predecessor run, not on silence.

Green at the final head and load-bearing for this card: `ci / Typecheck + Release Registry` (job 109403766541), all 12 `chat` and `workspaces-a` shards, `ci / Build`, `ci / Docker context integrity`, all 9 `Runner` contexts, all 8 `e2e shard` contexts, and 11 of 12 `server` shards including the one carrying `run-scratch.test.ts`.

Gate 2 note: CI's typecheck gate runs `pnpm run typecheck:build-gaps`, not the ledger's literal `CHECK` command. It executes the server build and server `tsc` successfully, which satisfies the substantive oracle "server typecheck introduces no errors". The local standard command's failed receipt (exit 1, `sh: 1: cargo: not found`) stands unaltered; it is an environment prerequisite failure, not a code failure, and is not replaced by the CI receipt.

Verifier history: attempt 1 exhausted its step budget with no verdict; attempt 2 returned FAIL on the ground that this CI paragraph claimed all 12 server shards green while shard 9 was red. That claim was read as a contradiction of the final head. The paragraph above is the corrected record: the all-green run named here is the first push, and the shard-9 flip is now attributed to identical-source flake rather than to a source change, with the tree-hash proof attached.
