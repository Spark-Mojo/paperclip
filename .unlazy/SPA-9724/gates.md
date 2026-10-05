# SPA-9724 gates

## Decision (recorded)

**An armed task watchdog on an issue counts as a live continuation for
`decideSuccessfulRunHandoff`.** Implementation: add a new caller boolean
`hasArmedTaskWatchdog`, a new branch in `decideSuccessfulRunHandoff`, a new
entry in `SUCCESSFUL_RUN_HANDOFF_VALID_PATH_SKIP_REASONS`, and the new
behaviour added at the heartbeat.ts call site so the runtime can prove it
on the wire.

## Behavior change

When an issue has an active, non-exhausted task watchdog (`status = "active"`,
`triggerCount > 0`, i.e. the watchdog has demonstrated it fires for the issue),
`decideSuccessfulRunHandoff` returns `skip` with reason
`"armed task watchdog owns the next action"` instead of enqueueing a
corrective handoff wake that nags the agent for a disposition the watchdog
has already taken over. This is symmetric with the existing
`hasActiveRoutineContinuation` branch: the watchdog is the persistent
mechanism the runtime spawns to recover from this exact class of failed
attempts, and enqueueing a corrective handoff over the top of it cancels
nothing — it just creates the very loop the watchdog was built to break.

## Acceptance contract (verbatim from the card)

1. Decide — in code, with the decision recorded in the repo — whether an armed
   task watchdog on an issue counts as a live continuation for
   `decideSuccessfulRunHandoff`. If yes, add the branch with its own
   `SUCCESSFUL_RUN_HANDOFF_VALID_PATH_SKIP_REASONS` entry and map the caller
   boolean at `heartbeat.ts:13736` to it.
2. Regression tests, in the style of `successful-run-handoff.test.ts`:
   (a) an issue with an enabled, non-exhausted watchdog and otherwise no
       other live path is NOT nagged;
   (b) every one of the twelve existing skip reasons still skips — a change
       that widens credit must not silently widen it past the intended set;
   (c) a watchdog that is disabled, exhausted, or has never fired does NOT
       suppress the handoff.
3. Definition of done:
   `pnpm --filter @paperclipai/server exec vitest run
    src/services/recovery/successful-run-handoff.test.ts`
   exits 0 with the three new cases passing and the existing skip-reason
   coverage intact.

## Out of scope

- Touching the backoff/cap/trip-row guard on PR #110 (SPA-9280) or any file
  that card owns.
- Widening any skip reason beyond watchdog/monitor crediting.
- Changing `nextAction` handling.
- Filing anything in `paperclipai/paperclip`.

## Where-to-look (re-derived at this head)

- `server/src/services/recovery/successful-run-handoff.ts:129-148` — the
  twelve-entry `SUCCESSFUL_RUN_HANDOFF_VALID_PATH_SKIP_REASONS` set and its
  type guard. New entry added here.
- `server/src/services/recovery/successful-run-handoff.ts:462-528` —
  `decideSuccessfulRunHandoff` ordered skip chain. New branch added here.
- `server/src/services/heartbeat.ts:13815-13971` — the call site that maps
  each caller boolean. New boolean added here, and the matching db select
  for `issueWatchdogs` (`status='active' AND trigger_count > 0`) is added
  to the `Promise.all`.
- `server/src/services/heartbeat.ts:13973-13994` — the `decideSuccessfulRunHandoff`
  call site, where the new boolean is passed.
- `packages/db/src/schema/issue_watchdogs.ts` — the entity: `status` ('active'
  means armed), `triggerCount` (must be `> 0` — proves the watchdog has
  fired for this issue; a watchdog that has never fired has no claim on the
  handoff), `lastTriggeredAt`. Unique on `(companyId, issueId)`.

## Behavior contract

When the new boolean is true and no earlier branch fired, return
`{kind: "skip", reason: "armed task watchdog owns the next action"}`.
No `instruction` is built, no `wakeup` is enqueued, and the issue is left
at its current state. This is what `isSuccessfulRunHandoffValidPathSkip`
already does for the other eleven reasons.

## Gates

Each gate has an indented `CHECK:` (the verbatim executable command),
`EXPECT:` (a success-only marker in its output), and `NEGATIVE:` (a safe,
isolated failing input).

### Gate 1 — file edit, skip-reason set entry

- `CHECK:` `grep -nE "armed task watchdog owns the next action" server/src/services/recovery/successful-run-handoff.ts`
- `EXPECT:` exit 0 with a line match.
- `NEGATIVE:` `grep -nE "armed task watchdog owns the next action" server/src/services/heartbeat.ts` —
  expect exit 1 (no match; the new reason lives only in the handoff file
  per the architecture).

### Gate 2 — file edit, `decideSuccessfulRunHandoff` new branch

- `CHECK:` `grep -nE "hasArmedTaskWatchdog" server/src/services/recovery/successful-run-handoff.ts`
- `EXPECT:` exit 0 with at least 2 matches (input param + the branch
  body). One match alone would mean the field was typed but never read.
- `NEGATIVE:` `grep -nE "hasArmedTaskWatchdog" server/src/services/issue-list-assignee-filter-routes.test.ts`
  — expect exit 1 (the new field is not added to other files).

### Gate 3 — call site wiring, heartbeat.ts maps the boolean

- `CHECK:` `grep -cE "(hasArmedTaskWatchdog|armedTaskWatchdog)" server/src/services/heartbeat.ts`
- `EXPECT:` exit 0 with count >= 2 (the boolean assignment into the decide
  call + the boolean name inside the destructured tuple from `Promise.all`).
- `NEGATIVE:` `grep -nE "issueWatchdogs" server/src/services/heartbeat.ts`
  before the patch lands in the harness — exit 1 (the watchdog table is not
  yet queried from heartbeat.ts). Measured before the diff at HEAD `b7a3a892d8`:

  ```
  git grep -n issueWatchdogs server/src/services/heartbeat.ts  # exit 1
  ```

  After the diff lands it must exit 0 (the new Promise.all slot queries it).

### Gate 4 — regression test (a): armed watchdog, no other live path

- `CHECK:` `pnpm --filter @paperclipai/server exec vitest run src/services/recovery/successful-run-handoff.test.ts -t "armed task watchdog"`
- `EXPECT:` exit 0 with the test name reported as passing (look for the
  `✓` glyph, or the `passed` count strictly increasing by 1 vs the
  pre-patch baseline of N).
- `NEGATIVE:` rename the test's `expect` to expect `enqueue` and re-run —
  expect exit non-zero and the test name red. Run on a throwaway copy of the
  test file under `/tmp/`, NOT in the repo. The throwaway copy is
  discarded after the negative-control assertion.

### Gate 5 — regression test (b): every one of the twelve existing skip reasons still skips

- `CHECK:` `pnpm --filter @paperclipai/server exec vitest run src/services/recovery/successful-run-handoff.test.ts`
- `EXPECT:` exit 0 with the full suite green (every existing test still
  passes). Counted via the trailing `Tests` summary line — `passed >=
  baseline_passed` (baseline = test count before this patch, recorded
  below as "Baseline").
- `NEGATIVE:` mutate the new branch in `successful-run-handoff.ts` to
  always return `enqueue` regardless of `hasArmedTaskWatchdog`, re-run the
  suite, expect exit non-zero. Run on a throwaway copy of the file under
  `/tmp/`, NOT in the repo. The throwaway copy is discarded after the
  negative-control assertion.

### Gate 6 — regression test (c): disabled / exhausted / never-fired watchdog does NOT suppress

- `CHECK:` `pnpm --filter @paperclipai/server exec vitest run src/services/recovery/successful-run-handoff.test.ts -t "watchdog is disabled"`
- `EXPECT:` exit 0 with the negative-control test passing (the watchdog-
  predicate row expects `enqueue`, not `skip`).
- `NEGATIVE:` flip the boolean expectation in the test from `enqueue` to
  `skip`, re-run, expect exit non-zero. Throwaway copy, discarded.

## Baseline (recorded before any edit)

`pnpm --filter @paperclipai/server exec vitest run src/services/recovery/successful-run-handoff.test.ts`

Expected baseline = the existing test count for that file. Run it once
before any edit to record. Then Gate 5 uses that as the floor.

## Run results

### Pre-edit baseline (HEAD `b7a3a892d8`, no patch applied)

- `pnpm --filter @paperclipai/server exec vitest run src/services/recovery/successful-run-handoff.test.ts` →
  `Tests  33 passed (33)` (baseline count = 33).
- `grep -nE "armed task watchdog owns the next action" server/src/services/recovery/successful-run-handoff.ts` →
  exit 1 (no match). Gate 1 NEGATIVE.
- `grep -nE "hasArmedTaskWatchdog" server/src/services/heartbeat.ts` →
  exit 1 (no match). Gate 3 NEGATIVE.
- `git grep -n issueWatchdogs server/src/services/heartbeat.ts` →
  exit 1 (no match). Gate 3 NEGATIVE.

### Post-edit (patch applied at this head)

- Gate 1 — `grep -nE "armed task watchdog owns the next action" server/src/services/recovery/successful-run-handoff.ts` →
  exit 0, 2 matches (lines 142, 519).
- Gate 1 NEGATIVE — `grep -nE "armed task watchdog owns the next action" server/src/services/heartbeat.ts` →
  exit 1. New reason lives only in the handoff file.
- Gate 2 — `grep -cE "hasArmedTaskWatchdog" server/src/services/recovery/successful-run-handoff.ts` →
  count 2 (input param + branch body). PASS.
- Gate 2 NEGATIVE — `grep -nE "hasArmedTaskWatchdog" server/src/__tests__/issue-list-assignee-filter-routes.test.ts` →
  exit 1. New field not added to unrelated files.
- Gate 3 — `grep -cE "(hasArmedTaskWatchdog|armedTaskWatchdog)" server/src/services/heartbeat.ts` →
  count 2 (destructured tuple + decide call). PASS.
- Gate 3 NEGATIVE (pre-patch baseline) — `git grep -n issueWatchdogs server/src/services/heartbeat.ts` →
  exit 1. Now exits 0 (Promise.all slot added).
- Gate 4 — `pnpm --filter @paperclipai/server exec vitest run src/services/recovery/successful-run-handoff.test.ts -t "armed task watchdog"` →
  exit 0, `Tests  5 passed | 33 skipped (38)` (5 = the four watchdog tests in the new describe + one already-existing "task watchdog" substring match). PASS.
- Gate 4 NEGATIVE — flipped the (a) test's `expect` from `skip`/`armed task watchdog owns the next action`
  to `enqueue`/`targetAgentId: "agent-1"` on a throwaway copy under `/tmp/spa-9724-neg/`, restored
  immediately, re-ran:
  `Tests  1 failed | 37 skipped (38)`. The change is detected. PASS (negative-control proves the test catches
  regressions).
- Gate 5 — `pnpm --filter @paperclipai/server exec vitest run src/services/recovery/successful-run-handoff.test.ts` →
  exit 0, `Tests  38 passed (38)` (33 baseline + 5 new = 38). All twelve pre-existing skip reasons and the new
  one pass. PASS.
- Gate 5 NEGATIVE — mutated the new branch in `successful-run-handoff.ts` to
  `if (false as boolean && input.hasArmedTaskWatchdog) {` on a throwaway copy, restored immediately, re-ran:
  `Tests  2 failed | 36 passed (38)`. The two watchdog-priority tests fail when the branch is disabled, which
  is exactly what the negative-control asserts. PASS.
- Gate 6 — `pnpm --filter @paperclipai/server exec vitest run src/services/recovery/successful-run-handoff.test.ts -t "watchdog is disabled"` →
  exit 0, `Tests  1 passed | 37 skipped (38)`. PASS.
- Gate 6 NEGATIVE — flipped the disabled-watchdog test's `expect` from `enqueue` to `skip` on a throwaway
  copy, restored immediately, re-ran:
  `Tests  1 failed | 37 skipped (38)`. The change is detected. PASS.

### Summary

All 6 gates pass. The 5 acceptance commands are mechanical exits 0; the negative controls each
demonstrate exit non-zero when their gate's targeted assertion is broken.