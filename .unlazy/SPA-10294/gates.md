# SPA-10294 — gates ledger

One observable outcome per gate. Each carries an executable `CHECK:`, a success-only
`EXPECT:` marker, and a `NEGATIVE:` run against a disposable fixture with its observed exit.

Refs audited (full, no bare shorthand): engine `b774322590c0aea7241c1016282ff4d49a79b5fb`,
platform `e50382dd711ce4fdbf1be8c70d64e07262f8156c`, governance
`ab8c25fd925a4ef7f7735990680fdaf9d67b0be6`. Ambiguity tripwire clean.

Run 2026-10-03, worktree `/srv/bulk/side-worktrees/spa-10294-cwd-audit`.

---

## G1 — the audited source is the fork's live default branch

**Outcome:** the audit cites the fork's current default branch, read live, never from memory.

    CHECK: gh repo view Spark-Mojo/paperclip --json defaultBranchRef --jq .defaultBranchRef.name
    EXPECT: rebuild/v2026.916.0-survivors
    NEGATIVE: gh repo view Spark-Mojo/no-such-repo-10294 --json defaultBranchRef --jq .defaultBranchRef.name

**Observed (this run):** exit 0, `rebuild/v2026.916.0-survivors`.
**NEGATIVE observed:** exit 1, `GraphQL: Could not resolve to a Repository with the name
'Spark-Mojo/no-such-repo-10294'`. Repo passed explicitly — an unqualified `gh repo view`
resolves from the current checkout and returns the wrong repo.

## G2 — the incident sweep ran FIRST and produced named, dated incidents

**Outcome:** the audit is anchored on real incidents, not on grep.

    CHECK: gbrain get permanent/paperclip-execution-workspace-collision-mechanism
    EXPECT: exit 0 and a body naming the failure string `expected branch "X" but found "Y"`
    NEGATIVE: gbrain get permanent/this-page-does-not-exist-10294

**Observed (this run):** exit 0. Three incident families recovered and cited in §1 of the audit:
I-1 `project_stale_persisted_worktree_crashes_agents` (7 agents / ~9 runs in one day, 2026-08-31),
I-2 `paperclip-execution-workspace-collision-mechanism` (41 workspace ids, 172 cards), I-3
`76-cards-sharing-one-worktree-was-doctrine-compliant-silence` (doctrine gap). Supporting atoms
also read: `agent-fenced-to-wrong-worktree-...`, `bare-file-references-break-subtly-...`,
`the-handed-off-fix-can-be-provably-wrong-...`.
**NEGATIVE observed:** exit 1, no such page — proves the three hits are real pages, not an
empty-result artefact rendered as success.

## G3 — the flag is the exact named setting, defaults false, and is not agent-readable

**Outcome:** the card names the real flag and the audit claims no value it cannot read.

    CHECK: git grep -n "enableEphemeralWorktreePerRun" b774322590c0aea7241c1016282ff4d49a79b5fb -- server/src/services/instance-settings.ts
    EXPECT: two hits, one of which is `?? false`
    NEGATIVE: curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $PAPERCLIP_API_KEY" $PAPERCLIP_API_URL/api/instance/settings

**Observed (this run):** `instance-settings.ts:275` `?? false`, `:316` `: false`. Read site
`heartbeat.ts:22256-22258`.
**NEGATIVE observed:** `403 {"error":"Board access required"}` — the audit records the live flag
value as **unknown/board-only** rather than asserting it.

## G4 — git forbids one-branch-two-worktrees (F-1's load-bearing fact)

**Outcome:** the recommendation cannot be "keep the per-card branch, force a fresh dir per run".

    CHECK: git init -q repo && cd repo && git commit -q --allow-empty -m init && git branch card-x && git worktree add -q wt-a card-x && git worktree add wt-b card-x
    EXPECT: nonzero exit carrying "already used by worktree at"
    NEGATIVE (control): git worktree add -q wt-c --detach card-x

**Observed (this run):** exit **128**, `fatal: 'card-x' is already used by worktree at
'/tmp/spa10294-controls/repo2/wt-a'`. The `--detach` control succeeded, confirming the failure is
git's branch lock, not a path problem — which is why F-1 recommends a per-run *named* branch and
rejects `--detach` on DECISION-138 predicate 3 instead.

## G5 — CHECK (card gate 1): the enumeration exists as a file of record, one row per guard

**Outcome:** `docs/audits/SPA-10294-guard-enumeration.csv` is machine-readable, one row per
guard, each row carrying `file:line`, its classification, and its evidence.

    CHECK: python3 - <<'PY' ... assert every row has 8 fields ... PY
    EXPECT: exit 0, "50 rows; 0 wrong-column rows; 0 unclassified"

**Observed (this run):** exit **0**. 50 rows, header of 8 columns, **zero** rows with the wrong
field count, zero rows missing `classification` / `file_line` /
`evidence_for_classification`, zero duplicate `guard_id`s. The CSV is emitted by
`docs/audits/build-enumeration.py` through `csv.writer` with a per-row field-count assertion.
**NEGATIVE observed (this run):** the hand-written first version of this file had **6 rows with
the wrong column count** (lines 7, 11, 36, 43, 45, 51) because unquoted commas inside cells
shifted the boundary; the reader caught it and the file is now machine-written. Recorded because
a file of record that silently mis-parses is worse than no file.

## G6 — CHECK: the classification tally is DERIVED from the enumeration, not asserted

**Outcome:** the audit's counts cannot drift from its own file.

    CHECK: python3 -c "import csv,collections; c=collections.Counter(r[5] for r in list(csv.reader(open('docs/audits/SPA-10294-guard-enumeration.csv')))[1:]); print(dict(c))"
    EXPECT: TOLERANT 33, NEEDS-PER-RUN-ADAPTATION 9, MUST-BE-EXEMPTED 7, SEE-G02 1

**Observed (this run):** exactly those four values, 50 total.
**NEGATIVE observed (this run):** the audit's first draft claimed 30/13/7 and a second revision
claimed 32/11/7; both were **wrong** against the file. Derived values are now the recorded ones.

## G7 — CHECK (card gate, NEGATIVE-A): a TOLERANT guard under TWO synthetic cwds

**Outcome:** tolerance is demonstrated, not assumed.

    CHECK: npx tsx docs/audits/checks/neg-a-tolerant-g05.ts
    EXPECT: exit 0, "PASS: tolerant guard G05 identical under 2 distinct cwds"

**Observed (this run):** exit **0** —
`legacy per-card cwd: .../worktrees/SPA-10294-card-x -> refuses=false` and
`ephemeral per-run cwd: .../worktrees/runs/run-aaaa1111 -> refuses=false`, with the positive
control still refusing a path that contains the project workspace.

**Two mutants prove the control discriminates** (a control that cannot fail proves nothing):

| Mutant | Change | Observed |
|---|---|---|
| A1 | guard made shape-dependent | exit **1** — `ephemeral per-run cwd: expected refuses=false, got refuses=true` |
| A2 | guard neutered (never refuses) | exit **1** — `positive control did not refuse … the guard is not guarding` |

**Self-correction recorded:** A first draft of this control asserted `expectRefuse: true` for both
cwds and failed — the guard correctly does **not** refuse either, so asserting refusal would have
made the control pass for the wrong reason. The honest expectation (`false`, plus a positive
control that must refuse) is what is committed.

## G8 — CHECK (card gate, NEGATIVE-B): each NEEDS-CHANGE guard fails PRE-CHANGE under the second cwd

**Outcome:** the classification is not a guess.

    CHECK: npx tsx docs/audits/checks/neg-b-needs-change.ts
    EXPECT: exit 0, "6/6 cases behaved as the audit classified"

**Observed (this run):** exit **0**, all six cases with their observed output:

| Case | Row | Observed |
|---|---|---|
| B-1 | G03 | run N+1 would REUSE `…/runs/run-aaaa1111` instead of its own computed `…/runs/run-bbbb2222` |
| B-2 | G44 | `legacy=eligible; ephemeral=NOT-REACHED` |
| B-3 | G06 | reused per-card path → `runIdSegment=null`, reaper called with `"legacy"`; fresh per-run path → live-run skip=true |
| B-4 | G18 | after the per-run dir is removed, cwd resolves to a **different run's** directory |
| B-5 | G41 | per-run instance ids `run-aaaa1111-8cf3bccdc7f8` vs `run-bbbb2222-68c0a726cf35`; legacy id stable |
| B-6 | G16 | **counter-example**: containment accepts both cwds and still rejects an outside path |

**Two mutants, each applying the actual FIX, invert the control:**

| Mutant | Change | Observed |
|---|---|---|
| B2 | the G18 fix applied (drop `previous?.cwd`) | exit **1** — `B-4/G18 … fallback=null` |
| B4 | the G44 fix applied (GC descends into `runs/`) | exit **1** — `MUTATED: the walk DID reach the ephemeral dir` |

**Two self-corrections recorded, because a ledger that only records successes is not a ledger:**

1. **B-3 failed on first run and the GUARD was right.** I passed the wrong live-run id to the
   fixture, so the fresh per-run path was not protected and the case read as a misclassification.
   The fixture was wrong; the G06 classification is correct. Fixed, re-run green.
2. **B-2 initially could not fail.** Its reachability test compared a *path* against *names*, so
   applying the G44 fix left it green. Rewritten to compare reachability, then re-proved with
   mutant B4.

Also recorded: my first attempt at these controls was written as `.mjs` and **crashed with a
`SyntaxError`** (TypeScript annotations in a `.mjs` file). "The control ran" was never true for
that version.

## G9 — the enumeration covers all four surfaces the card names

**Outcome:** no surface was skipped, and the coverage is derived.

    CHECK: python3 -c "import csv,collections; print(dict(collections.Counter(r[1] for r in list(csv.reader(open('docs/audits/SPA-10294-guard-enumeration.csv')))[1:])))"
    EXPECT: engine 20, adapter-opencode-local 13, fleet-skill 12, sparkmojo-paperclip-skill 5

**Observed (this run):** exactly those values, 50 total, 0 unclassified.

**Scope note, recorded as a gate because the card named four surfaces and the audit found five
places worth auditing:** the first pass of this audit covered **two engine files**. The
difference between that and this one is the whole reason the verifier returned FAIL.

## G10 — scope: read-only, and the three forbidden paths untouched

**Outcome:** no engine/adapter/skill source was modified.

    CHECK: git diff --name-only b774322590c0aea7241c1016282ff4d49a79b5fb...HEAD
    EXPECT: only docs/audits/** and .unlazy/SPA-10294/**

**Observed (this run):** the diff adds `docs/audits/SPA-10294-workspace-identity-audit.md`,
`docs/audits/SPA-10294-guard-enumeration.csv`, `docs/audits/build-enumeration.py`,
`docs/audits/checks/*.ts`, and `.unlazy/SPA-10294/gates.md`. No file under `server/`,
`packages/`, `scripts/`, or any skill tree appears in the diff. **The flag, the ceiling script
(SPA-10292) and the policy checker (SPA-10293) are untouched.** No live worktree under
`/srv/bulk/worktrees` was removed, pruned, or written; every fixture was created under the run
scratch dir.

---

## Verdict

Ten gates, all PASS with pasted output and observed exit codes. Every `NEGATIVE:` was executed
against a disposable fixture; **no negative was manufactured by mutating live data**, and no
negative was inferred from a grep that "would obviously fail".

Four of the ten gates exist only to record findings that **contradict my own prior posture** —
three of them corrections I made inside this run (G5's malformed CSV, G7's wrong expectation, G8's
two unfixable controls). That is deliberate: LAW 3 forbids a completion claim on the author's
say-so, including the author's own.

**Verdict on the card's own question — is the flip safe?** No, not as shipped. Seven rows are
`MUST-BE-EXEMPTED` and nine `NEEDS-PER-RUN-ADAPTATION`, and three of them (F-1 isolation degrade,
F-2 per-run instance mint, F-3 GC blindness) each independently defeat the flag's stated purpose.

**Remaining work is NOT in this ledger** because it is separate work on separate cards: the
per-run branch implementation, the instance-id decision, the GC fix, the rescue-ref discovery
mechanism, and the skills doctrine pass. The flag flip stays James-gated.