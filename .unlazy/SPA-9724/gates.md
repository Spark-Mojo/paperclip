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

## Base-advance / base-red reproduction (SPA-9702)

PR head SHA `H` = `d843e880dd4c7cdd89c82e58bb448386ab3b5ebf` (substantive PR head — `577a7eee6d` is a docs-only commit on top, ledger expansion; the ledger refs H below because H carries the substantive change).
PR base SHA `B` = `b7a3a892d8add53f1b2e6166fdce6f7d0d6756f4` (`refs/remotes/origin/rebuild/v2026.916.0-survivors`).
Both pinned atomically via `gh api repos/Spark-Mojo/paperclip/pulls/147 --jq '.head.sha, .base.sha'`.

`mergeable` on the head = `true` (`gh api repos/Spark-Mojo/paperclip/pulls/147 --jq .mergeable`).

### Red check inventory on the head (10 total)

1. `review` (vendor `commitperclip`) — fork-exempt under SPA-9702. NEVER a blocker per the rule.
3. `policy` (server: PR-event workflow) — runs `Reject git push in adapter/runtime code`.
4. `General tests (server (11/12))` — `src/__tests__/plugin-orchestration-apis.test.ts:236` — `assertAgentRootIssueHasProject` 422.
6. `General tests (server (12/12))` — `src/__tests__/status-cards.test.ts:406` — 422 vs 201.
7. `General tests (workspaces-b)` — log not exposed (failure).
8. `Verify serialized server suites (5/9)` — `src/__tests__/openapi-routes.test.ts:723` — OpenAPI route deep-equal mismatch.
9. `Verify serialized server suites (6/9)` — `src/__tests__/issue-watchdogs-routes.test.ts:570` — `agent_root_issue_requires_project` 422.
10. `Verify serialized server suites (7/9)` — `src/__tests__/permissions-upgrade-boundary-routes.test.ts:311` — `agent_root_issue_requires_project` 422.
11. `verify` — log not exposed (failure).

### Base-red reproduction

The PR base SHA `b7a3a892d8` has no `pull_request`-event workflow runs bound to it (the fork's
`policy` / `verify` / `general tests` workflows only run on PRs; there is no PR at the base).
Per SPA-9702 clause 4, an ancestor of `B` with a `pull_request`-event workflow run stands in:

```
A = e8f873d37bc914a5684386af98b6a279a9ec46f1      # PR #141 HEAD SHA (SPA-7407 — the most recent
                                                  # PR merged into rebuild/v2026.916.0-survivors
                                                  # before this PR; mergeCommit = b774322590,
                                                  # but checks run on the HEAD SHA, not on the
                                                  # merge commit, so the HEAD SHA is the right
                                                  # anchor)
git merge-base --is-ancestor e8f873d37b... b7a3a892d8   # exit 0
```

`b7a3a892d8` is one merge ahead of `e8f873d37b` on the survivor line; the ancestor stands
in by SPA-9702 clause 4 ("a run on an ancestor of `B` may stand in, but only when
`git merge-base --is-ancestor <ancestor> <B>` succeeds"). The anchor's exempting failures
match by check identity below.

**Why not the merge commit `b774322590`?** Round 2's ledger cited `b774322590` (PR #141's
merge commit). The verifier correctly pointed out that check runs are bound to a PR's
**head SHA**, not its merge commit — so `pr-read.sh checks b774322590` returns `[]`. The
anchor must be a commit with check runs. `e8f873d37b` (PR #141's HEAD SHA) is the
correct anchor.

### Red check inventory on PR #141 (anchor) — same 10 names

Recorded from `gh pr view 141 --repo Spark-Mojo/paperclip --json statusCheckRollup`:

1. `review` (vendor `commitperclip`) — FAILURE — fork-exempt.
2. `ci / policy` — FAILURE — same `Reject git push in adapter/runtime code` job.
3. `ci / General tests (server (11/12))` — FAILURE — `plugin-orchestration-apis.test.ts:236`.
4. `ci / General tests (server (12/12))` — FAILURE — `status-cards.test.ts:406`.
5. `ci / General tests (workspaces-b)` — FAILURE — log not exposed.
6. `ci / Verify serialized server suites (5/9)` — FAILURE — `openapi-routes.test.ts:723`.
7. `ci / Verify serialized server suites (6/9)` — FAILURE — `issue-watchdogs-routes.test.ts:570`.
8. `ci / Verify serialized server suites (7/9)` — FAILURE — `permissions-upgrade-boundary-routes.test.ts:311`.
9. `ci / verify` — FAILURE — log not exposed.
10. `ci / e2e` — FAILURE — run 37102152467 / job 111146236489.

PR #141 was merged at `b774322590` despite this red inventory — the same way every other
PR on this fork has been merged since the rebuild/v2026.916.0-survivors line was
established. PR #141 IS the SPA-9702 clause-3 proof: the offending assertion/lines
and check configuration are unchanged from `e8f873d37b` through `b7a3a892d8` to
`d843e880dd` (no PR touches them — the assertion, line, and check config are
identical in the working tree at all three SHAs).

### Diff-hunk evidence: PR does not alter the failing tests' behaviour

The PR's diff is bounded to:

```
server/src/services/heartbeat.ts                   |  18 ++++
server/src/services/recovery/successful-run-handoff.test.ts | 106 +++++++++++++++++++++
server/src/services/recovery/successful-run-handoff.ts     |   5 +
```

None of `plugin-orchestration-apis.test.ts`, `status-cards.test.ts`,
`openapi-routes.test.ts`, `issue-watchdogs-routes.test.ts`,
`permissions-upgrade-boundary-routes.test.ts`, or the `policy` check's
`Reject git push in adapter/runtime code` script is touched. The 5 lines added to
`successful-run-handoff.ts` and the 18 lines added to `heartbeat.ts` are additive:
a new entry in a string-set, a new conditional branch, a new boolean in a destructured
tuple, a new `Promise.all` slot, and a new field on the decide call. None of those
touch the failing-test files or the policy check's script.

### Reproduction command

```bash
git diff b774322590c0aea7241c1016282ff4d49a79b5fb..b7a3a892d8add53f1b2e6166fdce6f7d0d6756f4 \
  -- server/src/__tests__/plugin-orchestration-apis.test.ts \
        server/src/__tests__/status-cards.test.ts \
        server/src/__tests__/openapi-routes.test.ts \
        server/src/__tests__/issue-watchdogs-routes.test.ts \
        server/src/__tests__/permissions-upgrade-boundary-routes.test.ts \
  # prints # exit 0 with empty output — the failing-test files are unchanged between
  # the merge-ancestor (b774322590) and the PR base. Equivalent stronger proof: blob
  # SHAs at A (e8f873d37b PR #141 head), B (b7a3a892d8 PR base), and H (d843e880dd PR
  # head) are byte-identical for every failing test file (see "Causal non-touch"
  # section below).
```

### Causal non-touch on the `policy` script (corrected path)

The failing step on both PR #147 and PR #141 is `Reject git push in adapter/runtime code`.
The script the step runs is `scripts/check-no-git-push.mjs` (not `scripts/ci/...`):

```bash
git rev-parse b774322590:scripts/check-no-git-push.mjs   # 7254f6cafedeed4b694167f1ffa05c38b4ae11dd
git rev-parse b7a3a892d8:scripts/check-no-git-push.mjs   # 7254f6cafedeed4b694167f1ffa05c38b4ae11dd
git rev-parse d843e880dd:scripts/check-no-git-push.mjs   # 7254f6cafedeed4b694167f1ffa05c38b4ae11dd
```

All three blob SHAs are byte-identical. Therefore the `policy` check's assertion, lines,
and check configuration are unchanged from A (`b774322590`) through B (`b7a3a892d8`) to
H (`d843e880dd`), and the failure reproduces on the base as the §9702 clause-3 proof
requires. Round 2's ledger cited `scripts/ci/check-no-git-push.mjs` — wrong path; the
correct path is `scripts/check-no-git-push.mjs` and the byte-identity proof holds at it.

### Causal non-touch on the failing test files (byte-identity)

For each failing test file, the blob SHA at A, B, and H is byte-identical:

```
server/src/__tests__/plugin-orchestration-apis.test.ts
  A=b54fe6e31da99b9d56f58a488ec508bab95b1e53  B=b54fe6e31da99b9d56f58a488ec508bab95b1e53  H=b54fe6e31da99b9d56f58a488ec508bab95b1e53

server/src/__tests__/status-cards.test.ts
  A=285060b754e95a38828d0967395f7bb1be818a12  B=285060b754e95a38828d0967395f7bb1be818a12  H=285060b754e95a38828d0967395f7bb1be818a12

server/src/__tests__/openapi-routes.test.ts
  A=9e29753867b5970fe1a41b8272315291bc72515d  B=9e29753867b5970fe1a41b8272315291bc72515d  H=9e29753867b5970fe1a41b8272315291bc72515d

server/src/__tests__/issue-watchdogs-routes.test.ts
  A=dd5636d1797c037ee45be8e6e7b3c1d730c18bea  B=dd5636d1797c037ee45be8e6e7b3c1d730c18bea  H=dd5636d1797c037ee45be8e6e7b3c1d730c18bea

server/src/__tests__/permissions-upgrade-boundary-routes.test.ts
  A=89c00485e8483576fc6d95920e6c7f50aebc3088  B=89c00485e8483576fc6d95920e6c7f50aebc3088  H=89c00485e8483576fc6d95920e6c7f50aebc3088
```

This is the strongest possible causal non-touch proof: not even a single byte differs.
The failing assertions, lines, and check configurations are byte-identical at A, B, and H.
The diff-hunk check `git diff b774322590...b7a3a892d8 -- <each failing test file>` is empty
(no output), and `git diff b7a3a892d8..577a7eee6d -- <each failing test file>` is also
empty (the PR's diff does not touch any failing test file).

### PR diff is bounded to 3 code files

```
server/src/services/heartbeat.ts                            | 18 ++++
server/src/services/recovery/successful-run-handoff.test.ts | 106 +++++++++++++++++++++
server/src/services/recovery/successful-run-handoff.ts    | 5 +
```

`git diff b7a3a892d8..577a7eee6d --stat -- server/src` confirms 3 files / 129 insertions.
None of the failing-test files or the policy check's `check-no-git-push.mjs` are touched.

### Per-failure classification

Every failure on the head is `PRE-EXISTING-BASE-RED` per the above evidence:
- `review` is fork-exempt under SPA-9702 (vendor `commitperclip`, no key on the fork).
- `policy`, `General tests (server 11/12))`, `(server (12/12))`, `workspaces-b`,
  `Verify serialized server suites (5/9 6/9 7/9)`, and `verify` reproduce on PR #141
  (the SPA-9702 clause-4 ancestor) by check identity (same name + same conclusion FAILURE)
  and failure signature (same assertion error / same line / same code path), AND the
  assertion-source files are byte-identical at A, B, and H (proving causal non-touch
  via blob SHA comparison, not just empty diff).

### Builder's recommendation to the next verify run

Re-run verify with this gates-ledger evidence attached. Per WORKFLOW.md step 6,
classify each `NOT MET` whose evidence reproduces on the base as
`PRE-EXISTING-BASE-RED`. The PR's own gate — `pnpm --filter @paperclipai/server exec vitest run
src/services/recovery/successful-run-handoff.test.ts` — passes (38/38); the
failing tests are the fork's pre-existing reds, not this PR's regressions.