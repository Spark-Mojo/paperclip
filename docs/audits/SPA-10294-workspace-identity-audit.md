# SPA-10294 — Workspace/cwd identity guard audit against a per-RUN cwd

**Author:** Ty (Tech Lead) · **Date:** 2026-10-03 · **Card:** SPA-10294 (SPA-9373 item 3)

**Purpose.** Item 3 of SPA-9373 gates the James-gated `enableEphemeralWorktreePerRun`
flag flip. This audit answers the one question the SPA-9454 escalation flagged as
"the one I would not guess at": does any workspace/cwd identity guard break or
silently degrade when the execution workspace becomes a per-RUN worktree instead of
a per-CARD worktree?

**Source of truth (no bare-ref shorthand, no ambient tree).**

| Fact | Value | How derived |
|---|---|---|
| Fork | `Spark-Mojo/paperclip` | charter execution lane |
| Fork default branch | `rebuild/v2026.916.0-survivors` | `gh repo view Spark-Mojo/paperclip --json defaultBranchRef` (read live, never from memory) |
| Audited ref | `refs/remotes/origin/rebuild/v2026.916.0-survivors` @ `b774322590c0aea7241c1016282ff4d49a79b5fb` (2026-10-03T06:42:46Z) | full-ref `git rev-parse` |
| Ambiguity tripwire | **clean** — no `refname ... is ambiguous` on stderr | bare-shorthand law, friction #888 |
| `workspace-runtime.ts` | 10,148 lines @ audited ref | `git show` |
| `heartbeat.ts` | 30,482 lines @ audited ref | `git show` |
| PR #108 (ephemeral worktree per run) | **MERGED**, head `ac9fdc36cf689218c370ef88ce582fe30e283162` | `gh pr view 108` |
| PR #119 (never remove dirty/unpushed run worktree) | **MERGED**, head `0c8693c0f4a5ee235baef5043d5f567a8f5418e2` | `gh pr view 119` |
| Flag read site | `heartbeat.ts:22256-22258` → `realizeExecutionWorkspace({ ephemeralLifecycle: resolvedInstanceSettings.experimental.enableEphemeralWorktreePerRun === true })` | `git grep` |
| Flag default | `false` (`instance-settings.ts:275`, `:316`) | `git show` |
| Live flag value | **NOT AGENT-READABLE** — `GET /api/instance/settings` → `403 {"error":"Board access required"}` for an agent actor | verified this run |

> **Correction to the SPA-9454 framing.** Both prerequisite PRs are MERGED, not open.
> SPA-9454's objective text ("installed 694d0fbe, ahead_by=23/0 vs PR #108 and 12/0 vs
> PR #119") described a pre-merge install position. The *engine code* is landed; the
> flag remains off, which is still the only missing piece for the flag itself.

---

## 1. The three identities — the decomposition the whole audit rests on

Ephemeral mode changes **one** of three independent identities. They are not
interchangeable, and almost every guard in this file keys on a different one.

| # | Identity | Persistent (today) | Ephemeral (proposed) | Source |
|---|---|---|---|---|
| 1 | **Branch** | `<template-rendered>` — per **CARD** | **UNCHANGED, still per card** | `wr.ts:3440-3443`, `branchName` never takes `runIdSegment` |
| 2 | **Directory** | `<parent>/<branchName>` | `<parent>/runs/<runIdSegment>` | `wr.ts:3454-3460` |
| 3 | **Registry entry** (`git worktree list --porcelain`) | one per branch | one per branch ⇒ **at most ONE per card, by git's own rule** | `wr.ts:2809`, `:3672` |

The inline comment at `wr.ts:3449-3453` states the design intent explicitly: *"The
branch is still derived from the template — it is the durable identifier on the
remote; only the local directory shape changes."*

**That is the defect.** Identity 2 changes; identities 1 and 3 do not.

---

## 2. Finding 1 (P1) — ephemeral isolation degrades to per-card reuse, undocumented

`wr.ts:3454-3460` computes a fresh per-run `worktreePath`. Then `wr.ts:3672` runs:

```ts
const registeredBranchWorktree = await findRegisteredGitWorktreeByBranch(repoRoot, branchName);
if (registeredBranchWorktree) {
  const reusable = await validateReusableWorktree(registeredBranchWorktree);
  if (reusable.validation?.valid) {
    return await reuseExistingWorktree(registeredBranchWorktree, reusable.branchName, reusable.warnings);
  }
```

`findRegisteredGitWorktreeByBranch` matches `refs/heads/<branch>` in the repo root
(`wr.ts:2809`). Because identity 1 is **unchanged**, run *N+1* of the same card
computes a different directory but resolves **the same branch** — and therefore
returns run *N*'s directory via the reuse path, **before any ephemeral check runs**.
There is no `ephemeral` guard on this branch.

**Severity was downgraded from my first read, and I am recording the downgrade
because I proved it.** My first hypothesis was an "identity lie" plus a teardown that
`rm`s a directory another run owns. That is **wrong**: the `reuseExistingWorktree`
return carries `cwd: reusablePath` and `worktreePath: reusablePath` (`wr.ts:3585`),
i.e. the **reused** path, not the computed `runs/<runId>` path. So the persisted
identity is truthful — there is no cross-run `rm`. The real defect is narrower and is
exactly this:

> **Ephemeral isolation silently degrades to reuse-on-dirty, and it is undocumented.**

It is not "every run collides" — it is **every run whose predecessor left a
registered worktree**, which after PR #119's fail-safe is precisely the set of runs
that were **dirty or unpushed**. Those are the exact runs the feature exists to
isolate. The `ephemeralLifecycle: ephemeral` value is still propagated on the reuse
return (`wr.ts:3599`), so the row is *marked* ephemeral while its path is a
**per-card** directory. Any later consumer that trusts `ephemeralLifecycle === true`
to conclude "path is `runs/<runId>`" is wrong.

### The `startsWith` guard that papers over it

`heartbeat.ts:22530-22543` is the **only** consumer that distinguishes the shape, and
it is belt-and-braces:

```ts
if (
  executionWorkspace.ephemeralLifecycle === true
  && executionWorkspace.strategy === "git_worktree"
  && executionWorkspace.worktreePath
  && executionWorkspace.worktreePath.startsWith(`${path.join(resolvedWorkspace.cwd ?? "", ".paperclip", "worktrees", "runs")}`)
  || (
    ... && path.basename(path.dirname(executionWorkspace.worktreePath)) === "runs"
  )
)
```

Two independent shape tests, because the first one (a `.paperclip/worktrees/runs`
prefix under the workspace cwd) does **not** match the real configured
`worktreeParentDir` in the `/srv/bulk` deployment. The second test
(`basename(dirname(path)) === "runs"`) is the one that actually fires — and it is the
same test used by the sweep at `wr.ts:5325`. So the engine has **two** places that
infer ephemeral-ness from path shape instead of trusting the flag it already
persists. The `&&`/`||` precedence (no outer parens on the disjunction) also means the
second clause is not gated on `strategy === "git_worktree"`.

**Capacity consequence.** The flag is the only drain for `/srv/bulk/worktrees`
(measured 433.91 GiB = 217% of the temporary 200 GiB ceiling, growth 2.23 GiB/h).
Turning the flag on as shipped converts *directory* accumulation into *reuse* — which
means the dirty-run population stops draining. **The capacity model is computed
against a flag that will not deliver it.** This is the single most important sentence
in this audit.

---

## 3. Finding 2 (P1) — `git` forbids the "keep the branch, fresh dir per run" fix

The obvious fix — leave identity 1 per-card, force identity 2 per-run — **cannot work**,
and it is git, not policy:

```
$ git worktree add /tmp/.../w1 card-x          # ok
$ git worktree add /tmp/.../w2 card-x
Preparing worktree (checking out 'card-x')
fatal: 'card-x' is already used by worktree at '/tmp/gitlocktest/w1'
```

One branch, one worktree, unless `--force`/`--detach`. So there is **no world** where
the branch stays per-card and every run gets a fresh directory. Option (B) is dead on
arrival, which is why my initial framing ("force a fresh dir, skip branch-based reuse")
was incomplete.

### Recommendation — (C′): per-run **local** branch, card branch untouched

Derive a per-run branch name for the worktree — `ephemeral/<cardBranchSlug>/<runId>` —
use it for `worktree add`, and **never** report or push it as the card's branch. Then:

- the branch-keyed registry naturally misses (per-run branch ⇒ per-run directory);
- the card's remote branch — what PRs, the board, and other agents read — stays stable;
- it is the same code shape as keying the branch by run, but the per-run name is an
  **implementation detail** instead of the card's observable branch.

### Rejected: `--detach` (fails the run-exit git-hygiene assertion by construction)

A detached HEAD fails DECISION-138 predicate 3 (`git symbolic-ref HEAD` must succeed)
**every single run** ⇒ a fleet-wide stream of `BLOCKED (detached-HEAD)`. The §138-5
N/A carve-out does **not** rescue it: a per-run worktree is a real checkout that
authors a tree, so predicates 1–4 all apply. This is the concrete reason (C′) beats
the detach variant, and it is why the identity must be a **named branch**.

---

## 4. Finding 3 (P1) — the rescue ref is written twice and read zero times

`rescueUnpushedRunWorktreeState` (`wr.ts:5028`, `:5074`) creates a **local** branch
`paperclip/rescue/<runId>/<ts>` before any removal, and is called from both the
startup reaper and the terminal sweep.

```
$ git grep -n "paperclip/rescue" @b7743225 -- server/src ':!server/src/__tests__'
wr.ts:1307:  return sanitizeBranchName(`paperclip/rescue/${issueComponent}/${formatUtcBranchTimestamp()}`);
wr.ts:5028: * to a `paperclip/rescue/<runId>/<ts>` branch BEFORE removal.
wr.ts:5074:  const rescueBranch = `paperclip/rescue/${input.runId}/${input.timestamp}`;
```

Production writes: **two** (`:1307`, `:5074`). Production readers of *that* ref: **zero**.

### Correcting myself — my first pass said "zero readers" and that was wrong

My negative control caught it. A `for-each-ref refs/heads/paperclip/rescue` **does**
exist in the ref, and a reader-shaped code path does exist in production. Stating the
precise truth:

- There **is** a production consumer of rescue refs — but it is a **different, named
  branch family**, reached through an **operator-triggered route**, not the reaper's
  per-run ref:
  `quarantineRestoreDirtyWorkspaceBranch` (`services/execution-workspaces.ts:814`),
  reached via the branch-reconcile route (`routes/execution-workspaces.ts:1093`,
  `:1117`, `:1129`). It renders the ref **onto the board card** — `- Rescue ref:`,
  `- Rescue commit:`, `- Rescued file count:` (`services/execution-workspaces.ts:706-711`)
  — and **wakes the assignee** with `rescueRef` in the payload, so recovery is
  human/agent-visible on the card rather than silent.
- That is genuinely better than "no consumer", and I am recording it rather than
  claiming credit for finding a bigger hole than exists.
- **What is still true, and is the actual defect:** that restore path is keyed on the
  **workspace row's branch**, and its rescue family is `rescue/<issueComponent>/<ts>`
  (`:1307`). The reaper's family is `rescue/<runId>/<ts>` (`:5074`). **Nothing in
  production enumerates `refs/heads/paperclip/rescue/*`**, so the reaper's per-run refs
  are never discovered by any sweep — they are surfaced only if an operator already
  knows the name. The `for-each-ref` occurrences in the ref are all in
  `__tests__`, `.github/workflows/release.yml`, and `.agents/skills/garden-inbox` —
  **never in the engine's production path.**

So the accurate severity is: **P1 — the reaper's rescue refs have no discovery
mechanism.** Not "no consumer exists anywhere"; "no *enumeration* exists, so per-run
refs are orphaned the moment the run that made them ends."

I previously recorded this as "residual risk the canary settles". On audit that
framing is wrong and I am upgrading it. And under ephemeral mode the rescue ref becomes
**per-run**, i.e. a *second* accumulation axis the 200 GiB `du` gate **cannot see** —
you would trade unbounded directory growth for unbounded ref growth in the repo, and
the reaper touches neither.

The count of rescue refs in live repo roots is 0 today. That is because the flag is
**off**, not because the path is safe — it is untested in anger.

---

## 5. Finding 4 (P2) — the two `process.cwd()` uses are recorder fields, not guards

The item-3 sweep of the two files found 34 cwd-identity comparisons. Only two are bare
`process.cwd()` fallbacks, and **both are benign**:

- `wr.ts:4565` — `cwd: workspacePath ?? input.projectWorkspace?.cwd ?? process.cwd()` on
  a teardown-command **recorder** field. A cosmetic label, not an identity decision.
- `wr.ts:4701` — same shape on a `cleanupAction: "remove_local_fs"` recorder field.

Neither guards anything, and neither is weakened by a per-run cwd. **No P1 here.**

## 6. Finding 5 (PASS — no change needed) — the destructive-path guard is cwd-independent

`wr.ts:4686-4692`, the guard that refuses to `fs.rm` a path containing the project
workspace:

```ts
const resolvedWorkspacePath = path.resolve(workspacePath);
const containsProjectWorkspace = projectWorkspaceCwd
  ? (resolvedWorkspacePath === projectWorkspaceCwd ||
     projectWorkspaceCwd.startsWith(`${resolvedWorkspacePath}${path.sep}`))
  : false;
if (containsProjectWorkspace) { warnings.push(`Refusing to remove path ...`); }
```

Path-containment on `path.resolve`, never `process.cwd()`. A per-run cwd is
`…/runs/<runId>`, strictly **inside** the parent dir, so `projectWorkspaceCwd` can never
be a parent of it and the guard's direction is unchanged. **This guard survives the
flag flip intact** — worth stating explicitly, because it is the one that would have
been catastrophic to lose.

PR #119's own fail-safe (`wr.ts:4769-4800` doc block) is likewise branch- and
cwd-agnostic: it keys on `git status --porcelain --untracked-files=all` **inside the
worktree** plus push outcome, and treats a failing `git status` as dirty (fail-closed).
Per-run cwd does not weaken it.

---

## 7. The flag does not flip until

1. **(C′) implemented and tested** — per-run local branch, card branch untouched, named
   branch (not detached, or DECISION-138 predicate 3 fails fleet-wide).
2. **A test that proves run *N+1* gets its own directory** while the card branch stays
   stable. This is the assertion that is missing today and whose absence is why
   Finding 1 shipped undetected.
3. **A discovery mechanism for the reaper's rescue refs** — Finding 3. A dirty unpushed
   run's work must be *recoverable by someone who can find it*, not merely *preserved*.
   An operator-invoked restore path exists for the workspace-row branch family; a
   per-run ref needs enumeration to be reachable at all.
4. **The push-vs-policy change (SPA-9454 item 2) lands WITH the canary**, not before.
5. **James present for the flip.** `GET /api/instance/settings` is `403` for an agent
   actor, consistent with "James gated". I will not touch the flag.

## 8. Scope statement — this audit is read-only

No engine file was modified. The two facts asserted from local reproduction are git's
own behaviour (`worktree add` branch lock, `--detach`) and were proven in a scratch
repo under run scratch, not by touching a live checkout. No worktree under
`/srv/bulk/worktrees` was removed, pruned, or read-modified. The capacity ceiling and
the flag value are **not** mine (SPA-10299, interaction `2e7c9f76`, pending).