# SPA-9578 — gates ledger

Engine card. Repo `Spark-Mojo/paperclip`, worktree on branch
`SPA-9578-coordination-issue-close-guard`, base
`refs/remotes/origin/rebuild/v2026.916.0-survivors` = `13e1ea88eb78a2308191dceff18e4ede84417deb`.

Deliverable: a narrow coordination exception in the card-close done gate
(`server/src/services/issue-done-gate.ts`) so a non-code coordination card can
close while a PR it merely CITES stays open, while every PR-deliverable card
still refuses to close before merge.

James's ruling (interaction `753031a2-b29b-4472-ad02-b525f68887c0`,
`narrow-exception`): "allow a card with an explicit coordination classification
and no PR work product to close, but keep the close guard for every
PR-deliverable card."

Fail-closed rules honoured by every CHECK below: each is a single non-pipeline
command whose exit status is the assertion; every stage is captured with
`out=$(cmd) || exit $?` before `$out` is consumed.

---

## G1 — coordination card with a cited open PR reaches `done`

Outcome: a card classified as a coordination card, with NO `pull_request` work
product, closes even though the PR it cites in prose is open.

CHECK:
```
timeout 900 pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/issue-done-pr-merged-gate.test.ts \
  -t "coordination classification lets a non-code card close with a cited open PR" \
 
```
EXPECT: exit 0 and a line `Tests  1 passed` for the named case.

NEGATIVE (same assertion, bad input — the PR is the card's own deliverable, so
the classification must NOT relax it):
```
timeout 900 pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/issue-done-pr-merged-gate.test.ts \
  -t "a PR-deliverable card cannot use the coordination classification to skip merge" \
 
```
Expected observation: that case asserts a 409 and is expected to PASS (green);
the negative control is the pair below, which proves the assertion REJECTS the
bad input.

---

## G1N — NEGATIVE CONTROL: the classification cannot be self-declared

Outcome: an agent cannot mint the classification itself.

CHECK:
```
timeout 900 pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/issue-done-pr-merged-gate.test.ts \
  -t "coordination classification denied for agent actor" \
 
```
EXPECT: exit 0; the case asserts HTTP 403 from
`PATCH /api/issues/{id}` carrying the field with an agent actor.

NEGATIVE (safe, isolated failing input for the SAME assertion — a board actor
with the same field must SUCCEED, proving the 403 above is discriminating the
actor and not failing everything):
```
timeout 900 pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/issue-done-pr-merged-gate.test.ts \
  -t "coordination classification accepted from a board actor" \
 
```
Observed: exit 0 and `status` reads `done` — the rejection in the CHECK is
specific to the agent actor.

---

## G2 — fail-closed preserved: unknown state still blocks a coordination card

Outcome: the classification relaxes only a positively-`open` cited PR. A
reference whose merge state cannot be verified still refuses.

CHECK:
```
timeout 900 pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/issue-done-pr-merged-gate.test.ts \
  -t "coordination classification does not relax an unverifiable (unknown) cited PR" \
 
```
EXPECT: exit 0; the case asserts `refuse` with
`kind: "unknown_pull_request_state"`.

NEGATIVE: the paired positive case "coordination classification lets a non-code
card close with a cited open PR" — with `state: "open"` the same code path
allows. Same assertion, opposite input, both proven in one run.

---

## G3 — the activity record is written (never silent)

Outcome: an accepted classification writes an `issue.done_gate_coordination_relaxed`
activity row naming the actor, the reason, and the relaxed references.

CHECK:
```
timeout 900 pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/issue-done-pr-merged-gate.test.ts \
  -t "coordination classification records an activity row with actor, reason and relaxed PRs" \
 
```
EXPECT: exit 0; the case reads the `activityLog` row back and asserts
`action`, `actorType`, `details.reason`, and
`details.pullRequests` contain the cited reference.

NEGATIVE: the pre-existing gate test
`-t "override_by_board_recorded: doneOverride closes the card and writes an activity row"`
must keep passing unchanged — proves the new row does not replace or
double-write the existing `issue.done_gate_overridden` row.

---

## G4 — no regression in the whole gate suite

Outcome: all pre-existing done-gate cases still pass, including
`:131-163` (attached PR refuses), `:217-243` (comment-only open PR refuses
WITHOUT the classification), `:294-337` (SPA-9323 issue-vs-PR discrimination),
`:386-412` (override activity row), `:509-551` (agent override 403).

CHECK:
```
out=$(timeout 1800 pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/issue-done-pr-merged-gate.test.ts 2>&1) \
  || { printf '%s\n' "$out"; exit 1; }
printf '%s\n' "$out"
printf '%s' "$out" | grep -q "failed" && { echo "GATE FAILED: failures in suite"; exit 1; }
echo "G4 GATE OK"
```
EXPECT: exit 0 and `G4 GATE OK`.

NEGATIVE: run the same command with a deliberately wrong file path — it must
exit nonzero, proving the CHECK is not a vacuous pass-through:
```
timeout 900 pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/no-such-gate-test-file.test.ts
```
Expected observation: nonzero exit, "No test files found".

---

## G5 — typecheck of the touched server package

Outcome: the new field and service input typecheck.

CHECK:
```
out=$(timeout 1800 pnpm --filter @paperclipai/server exec tsc --noEmit 2>&1) || { printf '%s\n' "$out"; exit 1; }
echo "G5 GATE OK"
```
EXPECT: exit 0 and `G5 GATE OK`.

NEGATIVE: introduce a type error in a scratch copy and confirm `tsc --noEmit`
exits nonzero — proving G5 is not a silent no-op:
```
cd "$PAPERCLIP_RUN_SCRATCH_DIR" && printf 'const x: number = "not a number";\n' > bad.ts
timeout 900 "$PWD/../../node_modules/.bin/tsc" --noEmit --skipLibCheck bad.ts
```
Expected observation: nonzero exit, `TS2322`.

---

## Not gates (recorded, not claimed)

- **Live close of SPA-9575** requires the board to submit the classification
  against a DEPLOYED engine. This card proves the behaviour in disposable
  tests; the live close is Steve's call after Dex merges and the engine is
  installed. Not claimed here.
- **No PR #957 merge, no thread resolution, no fixture-timing verdict** — out
  of scope by card contract.

---

## RESULTS (all run 2026-09-30, this worktree, branch SPA-9578-coordination-issue-close-guard)

Environment note: `vitest` here is 4.1.11 and `--reporter=basic` was REMOVED
in v4 — the first attempt failed with `Failed to load custom Reporter from
basic`. Commands above were corrected to drop it. Test paths are relative to
the `server/` package because the CHECK uses `--filter @paperclipai/server`.

### G1 — coordination card closes with a cited open PR
CHECK exit 0.
```
timeout 900 pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/issue-done-pr-merged-gate.test.ts \
  -t "coordination classification lets a non-code card close with a cited open PR"
```
Observed: `Tests  1 passed | 30 skipped (31)`.
Proves both directions in one case: WITHOUT the classification the same cited
PR 957 refuses (`open_pull_requests`), WITH it the card allows and the decision
carries `relaxedPullRequests: [ … number: 957 ]`.

NEGATIVE for the same assertion — an ATTACHED `pull_request` work product plus
the classification:
`vitest run … -t "cannot use the coordination classification to skip merge"` →
`Tests  1 passed | 30 skipped`. That case asserts `refuse`. PASS.

### G1N — the classification cannot be self-declared
CHECK exit 0: `-t "coordination classification denied for agent actor"` →
`Tests  1 passed | 30 skipped`. Asserts HTTP 403 and `error` containing
"Agents cannot classify"; card stays `in_progress`.

NEGATIVE (the 403 must discriminate the ACTOR, not fail every path) exit 0:
`-t "coordination classification accepted from a board actor"` →
`Tests  1 passed | 30 skipped`. A board actor PATCHing the identical field is
NOT 403 and the service decision with the classification is `allow`.

### G2 — fail-closed survives: `unknown` still blocks
CHECK exit 0: `-t "does not relax an unverifiable"` → `Tests  1 passed | 30 skipped`.
Asserts `refuse` with `kind: "unknown_pull_request_state"` while the
classification is supplied.

NEGATIVE — proof the assertion discriminates rather than passing vacuously: a
scratch copy of the suite with this one expectation flipped to `allow`:
```
cp server/src/__tests__/issue-done-pr-merged-gate.test.ts \
  server/src/__tests__/zz-scratch-negative.test.ts   # then flip only that expectation
timeout 900 pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/zz-scratch-negative.test.ts -t "does not relax an unverifiable"
```
Observed exit **1**: `AssertionError: expected { outcome: 'refuse', … } to match
object { outcome: 'allow' }`. The scratch file was deleted in the same command;
`git status --porcelain` after shows only the four intended modified files plus
`.unlazy/SPA-9578/`.

### G3 — the activity record is written
CHECK exit 0: `-t "coordination classification records an activity row"` →
`Tests  1 passed | 30 skipped`. Reads the `activityLog` row back and asserts
`action = issue.done_gate_coordination_relaxed`, `actorType = user`, and
`details` containing `gate`, `scope: prose_cited_pull_requests_only`, the
verbatim `reason`, and the relaxed reference `Spark-Mojo/sparkmojo-internal#957`.

NEGATIVE: the pre-existing `-t "override_by_board_recorded"` case passes
unchanged inside G4's full-suite run — the new row does not replace or
double-write `issue.done_gate_overridden`.

### G4 — no regression in the whole suite
CHECK exit 0:
```
out=$(timeout 1700 pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/issue-done-pr-merged-gate.test.ts 2>&1) || exit 1
printf '%s\n' "$out" | grep -E "Tests  |Test Files  "
```
Observed: `Test Files  1 passed (1)` / `Tests  31 passed (31)`.
Baseline before the change was `22 passed`; after, `31 passed` — 22 pre-existing
cases all still green (including `:131-163` attached-PR refuses, `:217-243`
comment-only open PR refuses, `:294-337` SPA-9323 discrimination, `:386-412`
override activity row, `:509-551` agent override 403) plus 9 new cases.

NEGATIVE: wrong path
`vitest run src/__tests__/no-such-gate-test-file.test.ts` → exit **1**,
`No test files found, exiting with code 1`. The CHECK is not a pass-through.

### G5 — typecheck
CHECK:
`timeout 1700 pnpm --filter @paperclipai/server exec tsc --noEmit` → exit 1.

**Base-red, not a regression — proven by stash comparison.** The run reports
251 errors, all pre-existing missing-build-dependency noise on this fork
(`Cannot find module '@paperclipai/plugin-sdk'`, `'@paperclipai/paperclip-runner'`,
`err is of type 'unknown'` in untouched `routes/plugins.ts`). With my four
files stashed the same command reports **the same 251 errors**, and
`grep -E "issue-done-gate|routes/issues|services/issues|issue-done-pr-merged"`
over the error list returns **NONE** — zero errors in any file this card
touches. `git stash pop` restored the diff; `git status --porcelain` confirms
the four intended files.

NEGATIVE: this CHECK cannot be shown to discriminate on the fork's current
dependency state (the build-dep errors mask any signal), so G5 is recorded
**PRE-EXISTING-BASE-RED** for `tsc` as a whole, with the per-file zero-error
grep as the positive signal. Marking it green would be a lie; the honest claim
is "no new type error in any touched file", which CI will re-derive on a tree
with deps built.

### Gate summary
| Gate | Outcome |
|---|---|
| G1 coordination card closes with cited open PR | PASS |
| G1N agent denied / board accepted | PASS |
| G2 `unknown` stays fail-closed | PASS (negative control exits 1 as required) |
| G3 activity row | PASS |
| G4 full suite 31/31, no regression | PASS (negative: wrong path exits 1) |
| G5 tsc | PRE-EXISTING-BASE-RED (251 pre-existing, 0 in touched files, identical count with diff stashed) |
