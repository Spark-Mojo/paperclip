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

Final head `e8f50527c9a5ab81b9f22fb15dd47ebaf022d2aa`, run 36573397612. `gh api repos/Spark-Mojo/paperclip/commits/e8f50527/check-runs?per_page=100` reports 48 check runs, 7 failures: `ci / General tests (workspaces-b)`, `ci / Verify serialized server suites (2/9)`, `ci / e2e`, `ci / e2e shard (7/8)`, `ci / policy`, `ci / verify`, `review`.

Green at this head and load-bearing for this card: `ci / General tests (server (9/12))`, `ci / Typecheck + Release Registry` (the server build and server `tsc` both succeed), `ci / Build`, `ci / Docker context integrity`, all 12 `chat` and `workspaces-a` shards, all 9 `Runner` contexts, and 7 of 8 `e2e shard` contexts.

### The shard-9 flip is a flake, proven across three runs of one identical `server/` tree

`ci / General tests (server (9/12))` failed at head `00874461` and passed at heads on either side of it, with no source change in between:

- `c9d3af144aa09c59ab100183208b5ff18a90a3a0` (run 36561673658, job 109383803104) — GREEN.
- `00874461cdb9cfbb5640358344ef533e07466c52` (run 36567732689, job 109403767546) — RED.
- `e8f50527c9a5ab81b9f22fb15dd47ebaf022d2aa` (run 36573397612) — GREEN.

`git rev-parse <sha>:server` returns `6ef40c3ecd5759670912a97c718d0a00d44813a9` for all three. The only file that differs across all three heads is this ledger: `git diff --name-only c9d3af14 e8f50527` returns `.unlazy/SPA-9394/gates.md` alone. Each run reports the same partition, `[test:run] general-server shard 9/12 running 64 of 660 suites`, so the failing suite is not newly admitted to the shard either. Identical bytes, three different outcomes.

The failure is `execution-control-reconciliation.test.ts:114` — "reports zero events for a repeated sweep over the same already-failed run" — expected 0 capture calls, received 1. Mechanism: `execution-control-reconciliation.ts:245` fires `void reportRunFailure(db, terminalRunToReport)` unawaited, whose capture awaits a DB read (`run-failure-report.ts:71-83`); the test snapshots `mockCaptureRunFailure.mock.calls.length` without draining the first sweep's in-flight report, so a late first-sweep capture is counted as a second-sweep capture. That is a pre-existing race in unchanged code, not a consequence of this diff. Local receipt, 5 consecutive runs of `timeout 180 pnpm exec vitest run server/src/services/execution-control-reconciliation.test.ts`: exit 0 each, `Tests  2 passed (2)`. This diff's own suite ran in the same shard and passed on the red run: `src/services/run-scratch.test.ts (14 tests) 33ms`.

### The remaining reds predate this branch

- `ci / policy` — `node ./scripts/check-no-git-push.mjs` fails on `server/src/services/workspace-runtime.ts:4884` and `server/src/__tests__/workspace-runtime.test.ts:4572,4577`. Both files have zero diff from survivor base `1751e28631`. Red on `c9d3af14` and on survivor-base predecessor `9e9a05ed`, so it predates this branch.
- `ci / General tests (workspaces-b)` — EPIPE in `server/src/services/adapter-utils/server-utils.test.ts`, unchanged by this diff. Red on the predecessor too.
- `ci / Verify serialized server suites (2/9)` — red on the predecessor too.
- `ci / e2e` — red on the predecessor too.
- `ci / e2e shard (7/8)` — also red on `c9d3af14`, the first push of this branch.
- `ci / verify` — the aggregate gate; its log carries `GENERAL_TESTS_RESULT: failure` and `POLICY_RESULT: failure` cascading from the two above. It asserts nothing independently.
- `review` — the vendor `commitperclip` action, no key configured on this fork.

Survivor-base predecessor PR #118 head `9e9a05ede909f2646a49ed99aa564a7d4bd5b256` (run 36546551412) fails the same six. The base tip `1751e28631` itself has zero check runs; absence of checks is not a green baseline, so every "baseline" claim above rests on a named predecessor run, not on silence.

Gate 2 note: CI's typecheck gate runs `pnpm run typecheck:build-gaps`, not the ledger's literal `CHECK` command. It executes the server build and server `tsc` successfully, which satisfies the substantive oracle "server typecheck introduces no errors". The local standard command's failed receipt (exit 1, `sh: 1: cargo: not found`) stands unaltered; it is an environment prerequisite failure, not a code failure, and is not replaced by the CI receipt.

Verifier history: attempt 1 exhausted its step budget with no verdict. Attempt 2 returned FAIL because the CI paragraph named run 36561673658 — the FIRST push, not the head under review — as if it were the final head, and read the all-green claim as contradicted by a red shard 9. Both were ledger defects, not code defects. The paragraph above is the corrected record: it names the head actually under review, itemizes every red context with its receipt, and carries the three-run tree-hash proof that shard 9 is flake.
