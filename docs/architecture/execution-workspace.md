---
title: Execution Workspace Invariants
summary: R1 allocator exclusivity and R3 per-repo worktree provisioning serialization
---

Execution workspaces let a run get an isolated git checkout. Two invariants keep
that isolation trustworthy. This page documents what each one guarantees, where
it is enforced, and — equally important — what it does **not** guarantee.

- **R1 — allocator exclusivity.** A workspace bound to a different open issue is
  never reused. The allocator refuses the binding and provisions a fresh one.
- **R3 — per-repo provisioning serialization.** Concurrent `git worktree add`
  calls against the same repository are serialized by an on-disk mutex.

Source of truth for every line reference below: branch
`rebuild/v2026.916.0-survivors` at `6adedbf27b6bf93765fb9be9778826d8baccc9fa`.

## R1 — allocator exclusivity

### What it guarantees

If the execution workspace a run asks to reuse is already bound to a **different
open issue**, that binding is refused. The run does not join the other issue's
workspace; it gets a fresh workspace provisioned instead.

An issue counts as open while its status is anything other than `done` or
`cancelled`. A binding held only by `done`/`cancelled` issues is not contested
and reuse proceeds normally.

This holds even when the requesting issue explicitly opted into
`reuse_existing`. The opt-in expresses a preference to reuse *its own*
workspace; it cannot grant access to someone else's.

### How it is enforced

Three layers, all of which must agree.

**1 — Contested-binding query** (`server/src/services/heartbeat.ts:20779`).
The allocator asks whether any *other* issue in the same company, in a
non-terminal status, already points at the requested workspace:

```ts
const executionWorkspaceHeldByAnotherOpenIssue = requestedExecutionWorkspaceId
  ? Boolean(
      await db
        .select({ id: issues.id })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, run.companyId),
            eq(issues.executionWorkspaceId, requestedExecutionWorkspaceId),
            notInArray(issues.status, ["done", "cancelled"]),
            issueId ? ne(issues.id, issueId) : sql`true`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
    )
  : false;
```

The `ne(issues.id, issueId)` clause is what makes this *exclusivity* rather than
mere occupancy: an issue's own binding never marks it as contested.

**2 — Reuse decision** (`server/src/services/heartbeat.ts:5912`,
`server/src/services/heartbeat.ts:20779`). A contested binding forces
`existingExecutionWorkspaceAvailable` to `false`, and the pure helper
`resolveAllocatorExecutionWorkspaceReuseDecision` returns both
`shouldRestoreExistingWorkspace: false` and `refusedCrossIssueBinding: true`.
Because the reuse request is cleared locally *before* any downstream policy or
provisioning call sees it, the run falls through to
`realizeExecutionWorkspace()` rather than hitting the
`inherited_workspace_reuse_unavailable` throw. A refusal is logged at
`server/src/services/heartbeat.ts:20824`.

**3 — Policy helper** (`server/src/services/execution-workspace-policy.ts:95`).
`hasReusableExecutionWorkspaceBinding` independently refuses a contested
binding, so the unrunnable-worktree gate cannot be talked into treating a
contested workspace as usable:

```ts
if (issue.executionWorkspaceHeldByAnotherOpenIssue === true) {
  return false;
}
```

### What R1 is not

**R1 is application policy, not a database uniqueness guarantee.** Nothing in
the schema stops two rows from naming the same `executionWorkspaceId`. R1 is
enforced in the allocator's decision path, and it holds for code that goes
through that path. A future writer that reads the binding column directly,
without routing through the allocator, would not be covered by it.

## R3 — per-repo worktree provisioning serialization

### What it guarantees

Two runs that provision worktrees in the **same repository** do not run
`git worktree add` concurrently. They take turns behind a per-repository mutex.
Two runs provisioning in **different** repositories are unaffected and proceed
in parallel.

### Lock mechanics

`withWorktreeProvisionLock` (`server/src/services/workspace-runtime.ts:4150`):

| Property | Value | Source |
|---|---|---|
| Lock file | `worktree-<key>.lock` | `workspace-runtime.ts:4157` |
| Acquire | `fs.writeFile(..., { flag: "wx" })` | `workspace-runtime.ts:4172` |
| Bounded wait | 60,000 ms | `workspace-runtime.ts:4082` |
| Stale threshold | 300,000 ms (5 min) | `workspace-runtime.ts:4083` |
| Poll interval | 25 ms | `workspace-runtime.ts:4182` |
| Release | `fs.rm(..., { force: true })` in `finally` | `workspace-runtime.ts:4189` |

**Atomic acquisition.** The `wx` flag makes creation exclusive: the file is
ours in a single syscall, or it already exists and we wait. This deliberately
avoids a `mkdir`-then-`writeFile` sequence, where a contending release could
delete the directory between our two syscalls.

**Canonical key** (`workspace-runtime.ts:4098`). Repo identity is a SHA-256 of
the realpath, truncated to 16 hex characters. Symlinked paths, relative
segments, and trailing slashes collapse to one key. `realpathSync.native` is
tried first, then `realpathSync`, then plain `path.resolve` — the mutex stays
usable in environments where the path does not yet exist.

**Lock directory** (`workspace-runtime.ts:4085`), first match wins:

1. explicit `options.lockDir`
2. `PAPERCLIP_WORKTREE_LOCK_DIR`
3. `$PAPERCLIP_HOME/locks` — this scoping is what keeps concurrent test
   processes, each with their own `PAPERCLIP_HOME`, from serializing against
   each other or against a live dev server sharing `~/.paperclip`
4. `~/.paperclip/locks`

**Bounded timeout.** Waiting is capped at 60 s. On expiry the waiter throws
rather than blocking a run indefinitely:

```
Timed out waiting for worktree provision lock at <path> (timeout 60000ms)
```

**Stale reclaim** (`workspace-runtime.ts:4117`). A waiter that finds `EEXIST`
attempts reclaim before waiting. The lock is removed when its owner PID is dead,
**or** when it is older than the stale threshold:

| Probe result | Reclaim? | Why |
|---|---|---|
| `kill(pid, 0)` succeeds | no | holder is alive |
| `ESRCH` | yes | no such process — holder is dead |
| `EPERM` | no | process exists, we merely lack rights to signal it |
| lock older than 5 min | yes | bounded even when the PID is recycled or the payload is unparseable |

The `EPERM` row matters: treating "cannot signal" as "dead" would let a waiter
delete a live holder's lock. If the payload is unreadable, reclaim falls back to
the file's mtime against the stale threshold.

### Where the lock is taken

The mutex covers **two** sites at this head:

| Site | Line | Enclosing function |
|---|---|---|
| Fresh branch creation (`worktree add -b <branch> <path> <baseRef>`) | `workspace-runtime.ts:3623` | `realizeExecutionWorkspace` |
| Restore of a persisted workspace | `workspace-runtime.ts:3900` | `ensurePersistedExecutionWorkspaceAvailable` |

### Known R3 coverage gap: the `existingBranch` path

`realizeExecutionWorkspace` performs a `git worktree add <path> <branch>` for a
pinned `existingBranch` at `workspace-runtime.ts:3553`, inside the block spanning
lines 3549–3605. That block runs **before** the mutex opens at line 3623, so
**this path is not serialized**.

The consequence is bounded and specific: when a strategy pins `existingBranch`,
concurrent provisioning of the same branch in the same repository is not
mutually excluded. Contention on that path can surface git's own
`worktree add` refusal rather than a queued retry.

Every other `worktree add` in the file — lines 3647, 3904, 3954, 3988 — is inside
a wrapped region.

## Verifying these claims

Both invariants have focused test suites at the head named above.

```bash
# R1 policy helpers + allocator refusal, and R3 mutex
pnpm vitest run \
  server/src/__tests__/execution-workspace-policy.test.ts \
  server/src/__tests__/workspace-runtime-worktree-mutex.test.ts
# 2 files, 40 tests passed

# R1 allocator decision, filtered to the cross-issue cases
pnpm vitest run server/src/__tests__/heartbeat-workspace-session.test.ts -t "cross-issue"
# 1 file, 2 passed | 153 skipped
```

The R1 cross-issue cases that pin the semantics above are named
`refuses cross-issue reuse when another open issue already holds the workspace`,
`refuses cross-issue reuse even when only the unrunnable-worktree gate reads it`,
and `treats reuse as runnable when another issue holding the workspace is done or
cancelled` (`execution-workspace-policy.test.ts:550`, `:562`, `:578`).

## Out of scope

**R2 — the database-level partial unique index on open issues' execution
workspace — is not documented here.** It was retired on 2026-09-08 and needs a
separate plan against the rebuild base. Nothing on this page should be read as
claiming that uniqueness is enforced at the storage layer; see [What R1 is
not](#what-r1-is-not).
