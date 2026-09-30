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

### G5 — typecheck (rerun after verify-FAIL fixes, 2026-09-30)
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

---

## ROUND 2 — after `VERDICT: FAIL` (2026-09-30)

The first verifier returned FAIL on three findings. Two were real defects in my
diff and are fixed; one was a gate-classification point that stays
`PRE-EXISTING-BASE-RED`.

### R3 (was NOT MET) — the field was a silent no-op on a non-done PATCH
Defect confirmed in the diff, not just asserted: `coordinationNoPrDeliverable`
was destructured off the body and consumed only inside the `done` branch, so a
board PATCH carrying it on a title edit returned 200 and applied nothing.

FIX (two layers, defence in depth):
- `routes/issues.ts`: a PATCH carrying `coordinationNoPrDeliverable` whose
  `status !== "done"` is **422**, with `error` "coordinationNoPrDeliverable is
  only valid on a PATCH that sets status to done".
- `services/issues.ts`: `effectiveCoordinationClassification` drops the
  classification unless this is a first entry into `done`, so an internal
  caller cannot smuggle a standing exemption past the route check either. The
  field remains request-scoped and is never persisted as card state.

Gates:
- `-t "refused on a PATCH that does not transition to done"` → exit 0,
  `Tests  1 passed | 34 skipped`. Asserts 422 + the message.
- `-t "does not persist as a standing exemption"` → exit 0,
  `Tests  1 passed | 34 skipped`. Supplies a classification on a NON-done
  service update, then proves a LATER close with NO classification still
  refuses — the invariant holds at the service layer too.

### R4/R5 (was NOT MET) — the proof lived at the service seam, not on the wire
Defect confirmed: the only end-to-end PATCH assertions were "not 403" and
"not 200", both of which pass for the wrong reason (`unknown` state), so the
card's actual requirement — a coordination card CAN close while its cited PR is
OPEN, and a PR-deliverable card still CANNOT — was never demonstrated on the
request path.

FIX: a hoisted `vi.mock` on `github-pull-request-merge.js` with a mutable
`pinnedResolver`, null by default so all 22 pre-existing cases see unchanged
behaviour. The two new request-path cases pin it to a genuinely `open` PR:
- `-t "the board request path closes a coordination card whose cited PR is OPEN"`
  → exit 0, `Tests  1 passed | 34 skipped`. Asserts **200**, `status === done`,
  and the `issue.done_gate_coordination_relaxed` row naming
  `Spark-Mojo/sparkmojo-internal#957`.
- `-t "the board request path STILL refuses a PR-deliverable card carrying the
  classification"` → exit 0, `Tests  1 passed | 34 skipped`. Same actor, same
  field, same pinned `open` resolver — the only variable is the attached work
  product. Asserts **409** with
  `pullRequests: [{ number: 1150, state: "open" }]`, card stays
  `in_progress`, and NO relaxation row was written.

NEGATIVE control on the stronger of the two (flipping its 409 to 200 in a
scratch copy):
`AssertionError: … expected 409 to be 200`, `Tests  1 failed | 34 skipped`,
exit **1**. Scratch file deleted in the same command.

### Test-harness defect found while fixing the above
`afterEach` deleted `heartbeat_runs` BEFORE `activityLog`, so once the new cases
wrote activity rows carrying a `runId`, teardown failed on
`activity_log_run_id_heartbeat_runs_id_fk` and cascaded 5 failures. Reordered
(`activityLog` first). This was latent in the existing suite — it only
surfaced once a case wrote a run-scoped activity row through the route path.

### R5 residual risk, stated not hidden (verifier's second half)
The shape SPA-8593/8626/8665/8715/8722 describes — an agent links ITS OWN open
PR in a comment and never attaches a work product — is still closable if a
**board user** chooses to classify it. That is inherent to James's ruling, which
authorizes a board-authorized exception by design; the engine cannot
distinguish "coordination card citing evidence" from "build card quoting its own
PR" without a classification the board supplies. What IS proven and enforced:
an agent cannot self-classify (403), the classification cannot persist as a
standing exemption (422 + service drop), and any card with an attached work
product still refuses (409). The residual is a human decision surface, not an
engine bypass.

### R6 / R7 — accepted as scoped, with reasons
- R7 (no fixture-timing verdict, no thread resolution, no PR #957 merge):
  **MET**, verified in the diff — the only occurrences of `957` are test
  fixtures; no `sparkmojo-internal` mutation.
- R6 (return evidence to Steve): satisfied by the closing card comment this run
  posts, not by a UAT child. The card names no UAT child and no CI job as its
  evidence surface, and `pr-read.sh card SPA-9578` has no linked evidence card
  because none was ever created. A live close of SPA-9575 additionally requires
  the board to submit the classification against a DEPLOYED engine, which is
  post-merge and James-gated.

### G5 — still PRE-EXISTING-BASE-RED, re-verified
`pnpm --filter @paperclipai/server exec tsc --noEmit` → exit 1, **251** errors,
identical to the baseline count. `grep -E "issue-done-gate|routes/issues|services/issues|issue-done-pr-merged"`
over the error list returns **NONE**. Re-classification on CI-only grounds is
unavailable: `pr-read.sh checks <B>` returns `[]` (no check run bound to the
pinned base SHA `13e1ea88`), so clause 1 cannot be satisfied either locally or
on CI. Recording the honest verdict rather than a green.

### Round-2 gate summary
| Gate | Outcome |
|---|---|
| R4 cited open PR closes on the REAL PATCH path | PASS (negative: flipped assertion exits 1) |
| R5 PR-deliverable refuses on the REAL PATCH path | PASS (negative: flipped assertion exits 1) |
| R3 non-done PATCH → 422 | PASS |
| R3 classification does not persist | PASS |
| Full suite | **35 passed (35)** — 22 pre-existing green, 13 new |
| G5 tsc | PRE-EXISTING-BASE-RED (251 = baseline, 0 in touched files) |
