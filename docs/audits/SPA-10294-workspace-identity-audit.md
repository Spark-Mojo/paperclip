# SPA-10294 — Workspace/cwd identity guard audit against a per-RUN cwd

**Author:** Ty (Tech Lead) · **Date:** 2026-10-03 · **Card:** SPA-10294 (SPA-9373 item 3)
**Enforcement boundary:** this is a **flag-on prerequisite**. `enableEphemeralWorktreePerRun`
must not be enabled until §7 is satisfied.

**Supersedes:** the first pass of this audit (also in PR #142, commit `10ecd561f9`) covered
two engine files only. The verifier returned FAIL on six of seven requirements for exactly
that reason. This revision adds the incident sweep, the adapter surface, both skills surfaces,
the per-guard enumeration, and two behavioural controls.

---

## Source of truth (full refs, no bare-ref shorthand, no ambient tree)

| Fact | Value | How derived |
|---|---|---|
| Engine fork | `Spark-Mojo/paperclip` | charter execution lane |
| Fork default branch | `rebuild/v2026.916.0-survivors` | `gh repo view Spark-Mojo/paperclip --json defaultBranchRef` (read live) |
| Engine audited ref | `b774322590c0aea7241c1016282ff4d49a79b5fb` | `git rev-parse` of the full PR base ref |
| Platform audited ref | `e50382dd711ce4fdbf1be8c70d64e07262f8156c` | `refs/remotes/origin/main` in `spark-mojo-platform` |
| Governance audited ref | `ab8c25fd925a4ef7f7735990680fdaf9d67b0be6` | `refs/remotes/origin/main` in `sparkmojo-internal` |
| Ambiguity tripwire | clean — no `refname ... is ambiguous` on stderr | friction #888 / SPA-9348 |
| Flag default | `false` (`instance-settings.ts:275` `?? false`, `:316` `: false`) | `git grep` on the pinned engine ref |
| Live flag value | **NOT AGENT-READABLE** — `GET /api/instance/settings` → `403 {"error":"Board access required"}` | verified this run |

---

## 1. The incident sweep (card requirement 1) — done FIRST, as required

A guard with a known incident behind it is worth ten guards found by grep. The sweep found
**three distinct incident families**, and the shape of all three is the same shape the flag
creates.

### I-1 — Stale persisted worktree path kills every wake on the card

> *"Paperclip persists an execution workspace path per issue. When that worktree is later
> removed or its branch renamed on disk, the stored pointer is never invalidated, so every
> subsequent wake onto that card dies at launch"* — gbrain
> `claude-memory/users-jamesilsley-github-spark-mojo-platform/project_stale_persisted_worktree_crashes_agents`
>
> **Measured 2026-08-31: 7 agents, ~9 runs burned in one day**, across 3 distinct paths in two
> different parent directories. *"so it is systemic, not one bad card. It took down **Dex**,
> which stops the whole merge lane."*

Failure messages are the two the flag produces:
`Persisted git worktree "<path>" is not reusable (path is not registered in git worktree list)`
and `Execution workspace git worktree expected branch "X" but found "Y"`.

**Why this is the exact failure the flip multiplies.** Today the pointer is stale *once* and a
human repairs it. Under the flag, `wr.ts:3458-3460` mints a **new** path every run, so the
persisted pointer is stale *by construction on the next run*. James's word for this is
"implode": the agent is launched into a directory whose identity no longer matches what the
card's own metadata claims, and it fails at the first `git` call.

### I-2 — Workspace identity collision hands two cards the same directory

> gbrain `permanent/paperclip-execution-workspace-collision-mechanism` (2026-09-01):
> *"41 distinct `execution_workspace_id` values, each bound to 2-23 different open cards
> simultaneously (172 cards total) ... two unrelated cards got silently handed the same
> physical git worktree directory on the same day"*, producing
> `WorkspaceRuntimeValidationFailure: Execution workspace git worktree expected branch "X" but found "Y"`.

The engine has a reproducer-grade description of the second variant too, in
`platform/pm-team/build-machine/spa-458/.../step-2-incident-records`: SPA-5836's manual
re-pin *"did not hold; ... two minutes later the run ... failed workspace validation with
reasonCode=not_registered"*.

### I-3 — The doctrine gap: no rule, therefore no failure

> gbrain `atoms/2026-08-19/76-cards-sharing-one-worktree-was-doctrine-compliant-silence-0db484`:
> *"Worktree assignment guidance is completely absent from all three runtime sources ... That
> means 76 cards sharing a single worktree ... violated no rule because no rule exists. The
> failure was a doctrine gap, not an execution error."*

**This is the row that decides how the flip must be rolled out.** The skills surfaces are
where an agent reads its own workspace contract. If a skill states the contract in terms of a
stable directory, the flip does not produce a clean error — it produces an agent that follows
a correct rule and reaches the wrong conclusion. That is the "implode" mode.

### Supporting incidents (not workspace-identity, but the same blast radius)

- `atoms/2026-09-08/agent-fenced-to-wrong-worktree-blocks-the-task-before-any-mo-5feda7` —
  *"the entire run was spent discovering an access mismatch"*: the cost of a cwd-identity
  failure is a **whole run**, not a retry.
- `atoms/2026-07-28/bare-file-references-break-subtly-when-worktrees-change` — *"a bare
  filename ... resolves relative to the current working directory"*. Under the flag every
  relative instruction in every skill re-resolves per run.
- `atoms/2026-09-07/the-handed-off-fix-can-be-provably-wrong-trace-the-guard-cha-129813` —
  an agent that changed a system without reading the guard chain first *"would have spent
  1.6 GB of disk and risked corrupting an in-flight run for zero effect"*. This is why §4
  classifies the provisioning-script guards (G41, G42) as must-be-exempted rather than
  proposing edits: they are a second, undocumented subsystem with its own invariants.

---

## 2. The decomposition the whole audit rests on

Ephemeral mode changes **one** of three independent identities.

| # | Identity | Today (per-card) | Under the flag | Source |
|---|---|---|---|---|
| 1 | **Branch** | template-rendered, per **CARD** | **UNCHANGED, still per card** | `wr.ts:3436-3443` |
| 2 | **Directory** | `<parent>/<branchName>` | `<parent>/runs/<runIdSegment>` | `wr.ts:3458-3460` |
| 3 | **Instance id** (`provision-worktree.sh`) | `basename(worktree_cwd)` + path hash | **per run** | `scripts/provision-worktree.sh:19-31` |

The engine's own inline comment at `wr.ts:3449-3453` states identity 1 is *"still derived from
the template — it is the durable identifier on the remote; only the local directory shape
changes."* So identity 3 moving is **not in the design's model at all**, and it is the most
expensive of the three. Row **G41** is the finding that follows from that omission.

---

## 3. The enumeration (card requirements 2 and 4)

**File of record: [`SPA-10294-guard-enumeration.csv`](./SPA-10294-guard-enumeration.csv)** —
50 rows, one per guard, each carrying `file:line`, its classification, the evidence for that
classification, and its per-run verdict. Zero unclassified rows; every row in the two
non-tolerant buckets names the control that demonstrates it.

Every row is on one of the four surfaces the card names, plus the platform repo's own GC
sweeper (G44-G47), which is on the flag's critical path and was not in the card's list of four.

**Classification counts (derived, not asserted — gate `G9`):**

| Classification | Rows | Meaning |
|---|---|---|
| `TOLERANT` | 36 | Already correct under a per-run cwd. No action. |
| `NEEDS-PER-RUN-ADAPTATION` | 7 | Intent is right, mechanism assumes stability. |
| `MUST-BE-EXEMPTED` | 7 | Identity cannot hold per-run; pretending otherwise is the bug. |

Total 50, in exactly the three classes the card defines, **zero unclassified rows**, and
**every row in the last two buckets cites a behavioural control** (gate `G8`).

These counts are **derived from the CSV by `docs/audits/build-enumeration.py` plus the readers
in gates `G6`/`G9`**, not hand-tallied. My first pass wrote 30/13/7, the derivation said 32/11/7,
a second revision said 33/9/7, and the final derivation says **36/7/7** after four guards were
reclassified on control evidence (§6). The derived numbers are the recorded ones. The CSV is
machine written through `csv.writer` with a per-row field-count assertion, so a comma inside a
cell can no longer shift a column boundary — the hand-written first version had six rows with
the wrong field count, which the reader caught.

**Surface coverage:**

| Surface | Rows |
|---|---|
| Engine (`server/`, `packages/paperclip-runner`, `scripts/`) | 20 |
| Adapter `adapter-opencode-local` (+ the `adapter-utils` helpers it owns) | 13 |
| Fleet skills — `sm-*` fleet-contract skills, platform GC/verify scripts, fleet-context laws | 12 |
| `sparkmojo-paperclip` skill (governance repo, template v40) | 5 |

The card names four surfaces; these are them, split at the repo boundary so the provenance of
every `file:line` is unambiguous. The platform repo's own GC and verify scripts (G44-G47, G49)
are counted under fleet skills because those scripts **are** the fleet's mechanical guards, and
the flag's capacity path runs straight through G44.

---

## 4. The findings that matter (expanded from the enumeration)

Everything below is a row in the CSV with the full evidence. This section states only what a
reader must not have to reconstruct.

### F-1 (G03, P1) — ephemeral isolation degrades to reuse-on-dirty, so the flag delivers no capacity relief

`wr.ts:3458-3460` computes a per-run path. Then `wr.ts:3672`:

```
const registeredBranchWorktree = await findRegisteredGitWorktreeByBranch(repoRoot, branchName);
```

matches on `refs/heads/<branch>`. **Identity 1 is unchanged**, so run *N+1* resolves **run N's
directory** and returns it through `reuseExistingWorktree` — before any ephemeral check. There
is no `ephemeral` guard on that path. The reuse return carries `cwd`/`worktreePath` =
**reused** path (`wr.ts:3585`), so there is no identity lie and no cross-run `rm`; the defect is
narrower and worse for planning:

> After PR #119 the population that *leaves* a registered worktree is precisely the
> **dirty/unpushed** runs — the exact runs the feature exists to isolate. Turning the flag on as
> shipped converts *directory* accumulation into *reuse*. **The 200 GiB capacity model is
> computed against a flag that will not deliver it.**

Demonstrated pre-change: control **B-1**.

`git` forbids the naive fix — one branch, one worktree:

```
$ git worktree add wt-b card-x
fatal: 'card-x' is already used by worktree at '.../wt-a'     (exit 128)
```

So the fix is a **per-run local branch** (`ephemeral/<cardBranchSlug>/<runId>`), card branch
untouched, **named not detached** — a detached HEAD fails DECISION-138 predicate 3 every run and
§138-5 does not rescue it, because a per-run worktree authors a tree.

### F-2 (G41 + G42, P1) — the provisioning script mints a new **instance** per run, and its self-heal guard becomes vacuous

Not on the card's four surfaces, and not in the first pass. `scripts/provision-worktree.sh:19-31`:

```bash
worktree_instance_id="$(WORKTREE_CWD="$worktree_cwd" node <<'EOF'
... basename(resolvedWorkspacePath) + sha256(resolvedWorkspacePath)[0:12]
```

The **instance id is a hash of the directory path.** Under the flag the directory is
`runs/<runId>`, so every run gets a new instance id, a new instance root, a new embedded
Postgres data dir, new ports, and a new master key (`write_fallback_worktree_config`).
Demonstrated pre-change: control **B-5** (`run-aaaa1111-8cf3bccdc7f8` vs
`run-bbbb2222-68c0a726cf35`).

Compounding it, **G07**: `workspace-instance-cleanup.ts:225-231` refuses cleanup when
`instanceId !== expectedInstanceId`, and `expectedInstanceId` comes from
`workspace.metadata[WORKTREE_INSTANCE_ROOT_METADATA_KEY]` (`wr.ts:4605-4608`) — which per-run
worktrees do not have. So every ephemeral worktree falls to the refusal branch and its instance
artifacts are **never reclaimed**.

And **G42**: the script's own self-heal check
(`existing_worktree_config_is_usable` — the worktree's own `.paperclip/.env` must point at its
own config) is *trivially true* for a fresh per-run directory. It stops guarding.

### F-3 (G44, P1) — the capacity sweeper cannot see `runs/`, so the flag's purpose is unmet on day one

`scripts/machine/worktree_gc.py:415-421` (platform repo):

```python
for root, dirs, _ in os.walk(BASE, onerror=on_walk_error):
    if not root.endswith("/.paperclip/worktrees"):
        continue
    for d in sorted(dirs):          # IMMEDIATE children only
        bad = path_ok(full, root)   # requires os.path.dirname(full) == worktrees_dir
```

`runs/` is a **subdirectory**, so it is never a candidate and every ephemeral worktree is
invisible to GC. Demonstrated pre-change: control **B-2** (`legacy=eligible; ephemeral=NOT-REACHED`).
This is the row that makes F-1's capacity consequence mechanical rather than theoretical.

### F-4 (G18 + G06, P1) — two places that silently target a *different run's* directory

**G18 — `native-workspace-finalizer.ts:97`:**

```ts
const cwd = workspace?.providerRef ?? workspace?.cwd ?? previous?.cwd ?? null;
```

The `previous?.cwd` fallback was harmless when every run of a card shared one directory. Under
the flag the finalizer runs **after** the per-run directory is removed, so `providerRef`/`cwd`
can be empty and it finalizes **the previous run's directory**. Demonstrated: control **B-4**.

**G06 — `wr.ts:5325-5327`:**

```ts
const isEphemeralShape = path.basename(path.dirname(workspacePath)) === "runs";
const runIdSegment = isEphemeralShape ? path.basename(workspacePath) : null;
```

Under F-1's reuse path, `workspacePath` is a **per-card** path while `ephemeralLifecycle` is
`true`. The shape test says *legacy*, so `runIdSegment` becomes the literal string `"legacy"` and
**the live-run protection cannot apply to it**. The in-file comment claims *"the legacy
`/<branch>/` shape has no run-id component to gate against"* — false for the ephemeral+reuse
combination. Demonstrated: control **B-3**.

The same disagreement appears at `heartbeat.ts:22530-22543`, which infers ephemeral-ness from
path **shape** while the engine already persists the flag (**G10**).

### F-5 (G43, P2) — per-run install storm

`provision-worktree.sh` computes a pnpm install fingerprint against the **worktree's own**
`.paperclip/` and relinks `node_modules` from the base workspace. Per-run directories mean a full
`pnpm install --prod=false` per run, or a cache keyed by the card instead of the run. Intent
(a run has working `node_modules`) survives; the mechanism must change.

### What survives intact — stated explicitly, because it bounds the blast radius

- **G05** the destructive-path guard (`wr.ts:4684-4694`) is pure `path.resolve` containment, cwd-agnostic — **exercised against two synthetic cwds, identical verdict, positive control still refuses** (control **A**).
- **G01** `inspectManagedGitWorktreeBranch` is a pure function of `(path, repoRoot, expectedBranchName)`; it never reads `process.cwd()`.
- **G02** the parent-dir containment guard holds — `path.join` collapses `..` before the check sees it (B-8).
- **G04** git's branch lock survives even the engine's detached-`--git-dir` delete (B-7), so cleanup cannot delete a branch a live per-run worktree holds.
- **G09** the pre-dispatch branch gate (`heartbeat.ts:3522-3536`) is handed the run's own realized path and branch — a per-run cwd is exactly what it expects.
- **G16** codex working-directory containment is **relative** to `PAPERCLIP_WORKSPACE_CWD`, so it tracks the run (control **B-6**, deliberately included as a discriminating counter-example).
- **G21/G22/G26/G28/G29** every skills-level guard asserts a **branch** or a **repo top level**, both of which are stable across per-run cwds.
- **G49** DECISION-138's exit assertion runs in the run's own worktree and reads no remembered path. This very card's ledger passed it under a harness-allocated per-card worktree.

---

## 5. The behavioural controls (card gate requirements)

Both controls live in [`docs/audits/checks/`](./checks/) and are **transcriptions of the audited
source expressions**, not paraphrases, so a reviewer can diff them against `b7743225`.

| Control | Command | Observed |
|---|---|---|
| **A** — tolerant guard, two synthetic cwds | `npx tsx docs/audits/checks/neg-a-tolerant-g05.ts` | `PASS`, exit 0 — identical verdict under both, positive control still refused |
| **B** — every needs-change / must-be-exempted row, pre-change | `npx tsx docs/audits/checks/neg-b-needs-change.ts` | `15/15 cases behaved as the audit classified`, exit 0 |

Control B has **15 cases covering all 14 rows** in the two non-tolerant buckets (G23 and G48
share B-11; G08 is G03 seen from the evidence builder and shares B-1), plus one **tolerant
counter-example** (B-6) that must NOT fail.

**Both controls were proved to discriminate.** A control that cannot fail proves nothing.
Disabling an *assertion* proves nothing either — the assertion is not what observed the
defect — so every mutant below either **inverts the transcribed guard** or **applies the actual
fix**. All fourteen inverted the verdict:

| Mutant | Change | Observed |
|---|---|---|
| A1 | guard made shape-dependent | exit **1** — `expected refuses=false, got refuses=true` |
| A2 | guard neutered (never refuses) | exit **1** — `positive control did not refuse … not guarding` |
| B2 | **the G18 fix applied** (drop `previous?.cwd`) | exit **1** — `B-4/G18 … fallback=null` |
| B4 | **the G44 fix applied** (GC descends into `runs/`) | exit **1** — `MUTATED: the walk DID reach the ephemeral dir` |
| B9 | G44's guard inverted (`!==` → `===`) | exit **1** — `B-2/G44 … nested-path` |
| B11 | **the G04 claim simulated** (delete got through) | exit **1** — `B-7/G04` |
| B13 | G30's `\|\| true` removed | exit **1** — `B-9/G30 … fixture assumption wrong` |
| B14 | G43's fingerprint made card-scoped (**the fix**) | exit **1** — `B-10/G43 … shared fingerprint` |
| B17 | G07's `rootMismatch` → `false` (**the fix**) | exit **1** — `B-13/G07` |
| B18 | G10 trusts the flag instead of the shape (**the fix**) | exit **1** — `B-14/G10` |
| B19 | G36's hint repointing made cwd-split tolerant (**the fix**) | exit **1** — `B-12/G36` |
| B20 | G23/G48's sweep recognition dropped | exit **1** — `B-11/G23+G48` |
| B21 | B-8's lexical check widened to catch unresolved `..` | exit **1** — `B-8/G02 … NOT DISCRIMINATING` |
| B22 | B-15's planted drift replaced with a self-consistent env | exit **1** — `B-15/G42` |

**Two controls caught my own errors, and both corrections are recorded because a ledger that
only records successes is not a ledger:**

- **B-3 initially failed, and the guard was right.** I had passed the wrong live-run id to the
  fixture, so the fresh per-run path was not protected and the case looked like a
  misclassification. The fixture was wrong; the classification was correct.
- **B-2 initially could not fail.** Its reachability test compared a *path* against *names*, so
  applying the G44 fix left it green. Rewritten to compare reachability properly, then re-proved
  with mutant B4.
- My first attempt at a control (transcribed as `.mjs`) **crashed with a syntax error** — TS type
  annotations in a `.mjs` file. Recorded because "the control ran" was never true for it.

---

## 6. Classification errors — cases where the classification is wrong

The card says: *"for each guard classified needs change, demonstrate the **pre-change** guard
fails or misbehaves under the second cwd. If it does not fail, the classification is wrong — say
so."*

**Four guards were reclassified against my own first pass, on control evidence:**

1. **G04 — I claimed a defect and the control FAILED TO FIND ONE.** I asserted that
   `deleteGitBranchAtVerifiedTip`'s detached `--git-dir` sidesteps git's worktree lock. Control
   **B-7** shows git refuses through *both* paths with the identical `used by worktree` error,
   because the branch-lock check consults the repository's recorded worktrees rather than the
   invoking git-dir. **Reclassified NEEDS-PER-RUN-ADAPTATION → TOLERANT**, and B-7 is retained
   in the failure set precisely so a reviewer can watch it hunt a bug that is not there.
2. **G02 — I claimed a traversal blindness that does not exist.** I asserted the parent-dir
   containment guard was blind to a traversal run id. `sanitizeBranchName` does preserve `/`,
   but `path.join` **collapses `..` lexically**, so all five crafted run ids normalise to
   `runs/…` and the check holds (B-8). The real residual gap is that the check is *lexical*, so a
   pre-existing `runs/` symlink is not covered — and B-8 proves that by disagreement with the
   canonical test. **Reclassified → TOLERANT** with the lexical-only gap recorded.
3. **G47** (`check-root-gates-files.sh`, the `GATES.md` root-namespace ban) is **TOLERANT**. Top-level
   anchoring is relative to the resolved repo root, which does not move. **Reclassified → TOLERANT.**
4. **G23 + G48 — I claimed the documented side-worktree escape becomes unenumerated. It does
   the opposite.** From a per-run cwd `../<new-dir>` lands at `<parent>/runs/<name>` — still
   inside `runs/`, and therefore **now recognised** by the shape test that a per-card cwd's side
   worktree failed (B-11). The rule gets *safer* under the flag, not less safe. Reclassified to
   needs-adaptation **for documentation only**.

**G20** was a deliberate cross-listing carrying no independent verdict — a fourth classification
the card does not define. It is now stated in its own right (TOLERANT, covered by the same
control as G02), so every row is in exactly one of the three defined classes.

**B-6 is a classification error I am reporting against myself:** `codex-boundaries.ts` is
**TOLERANT**, and it sits in the failure control *deliberately*, to prove the control rejects a
guard that does not actually break. A control containing only failing cases cannot distinguish
"found a bug" from "always fails".

---

## 7. What must be true before the flag flips

1. **Per-run local branch** (F-1): `ephemeral/<cardSlug>/<runId>`, card branch untouched, named
   not detached (DECISION-138 predicate 3).
2. **The provisioning instance id must stop being path-derived** (F-2), or be explicitly exempted
   with a stated per-run cost. This is the largest unpriced item in the whole audit.
3. **The GC sweeper must descend into `runs/`** (F-3). Without it the flag's purpose is unmet
   regardless of 1.
4. **Discovery for the reaper's rescue refs** — `paperclip/rescue/<runId>/<ts>` is written twice
   (`wr.ts:1307`, `:5074`) and **nothing in production enumerates it**; an operator restore path
   exists only for the *workspace-row* branch family (`execution-workspaces.ts:814` →
   `routes/execution-workspaces.ts:1093`, which renders the ref on the card and wakes the
   assignee — genuinely better than silent loss, and recorded as such).
5. **A test that proves run *N+1* gets its own directory** while the card branch stays stable.
   Its absence is why F-1 shipped undetected.
6. **The two `previous?.cwd` / "legacy" fallbacks removed** (F-4).
7. **The skills surfaces re-read under a per-run cwd** — §1/I-3 is the doctrine gap, and no code
   change fixes a doctrine gap. Rows G23/G48 need their example paths restated (B-11 shows the
   behaviour *changes* — side work becomes sweepable where it was not); G30's teardown needs a
   per-run-aware removal (B-9); G21/G22/G26/G27/G28/G29/G50 need no change, and saying so is as
   important as saying what does.
8. **James present for the flip.** The flag is not agent-readable; I will not touch it.

## 8. Scope statement — read-only, and the boundaries held

No engine file, no adapter file, no skill file was modified. The diff is two new documents, a
generator, two control scripts, and the ledger. No live worktree under `/srv/bulk/worktrees` was removed,
pruned, or written. The flag, the ceiling script (SPA-10292) and the policy checker (SPA-10293)
are untouched.

**Findings that need a ruling are filed as their own cards, not decided here:** the
path-derived instance id (F-2) is an architecture question about what a *card's* instance is,
and the skills re-read (7.7) is a doctrine change across the fleet. Neither is mine to decide.