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
`rebuild/v2026.916.0-survivors` at
`fd5cf1d933712867b24e8c1714a1c632fb22490b`. Line numbers are specific to that
commit and drift as the branch advances; re-resolve them before relying on one.

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

**1 — Contested-binding query** (`server/src/services/heartbeat.ts:20848`).
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

**2 — Reuse decision** (`heartbeat.ts:5917`, `heartbeat.ts:5964`).
`resolveExecutionWorkspaceReuseRequestForIssue` (`heartbeat.ts:5870`) returns
`existingExecutionWorkspaceAvailable`, which goes `false` whenever the binding is
contested. The pure helper `resolveAllocatorExecutionWorkspaceReuseDecision`
(`heartbeat.ts:5955`) then reports both
`shouldRestoreExistingWorkspace: false` and `refusedCrossIssueBinding: true` and
logs the refusal at `heartbeat.ts:20886`.

The refusal turns into a fresh workspace because the reuse request is cleared
*before* any downstream policy or provisioning call sees it. The caller wires the
restore callable from the already-nulled workspace
(`heartbeat.ts:21636`), and `provisionExecutionWorkspaceForFreshnessDecision`
(`heartbeat.ts:6029`) short-circuits on a falsy
`shouldRestoreExistingWorkspace` at `heartbeat.ts:6065` — returning
`realizeWorkspace()` without ever calling the restore path. That is what keeps
the run off the `inherited_workspace_reuse_unavailable` throw at
`heartbeat.ts:6108`.

**3 — Policy helper** (`server/src/services/execution-workspace-policy.ts:95`).
`hasReusableExecutionWorkspaceBinding` independently refuses a contested
binding, so the unrunnable-worktree gate cannot be talked into treating a
contested workspace as usable:

```ts
if (issue.executionWorkspaceHeldByAnotherOpenIssue === true) {
  return false;
}
```

`isUnrunnableWorktreeCombo` (`execution-workspace-policy.ts:108`) consumes that
refusal at line 118, so a contested binding is treated as *not* reusable there
too — the refusal holds whichever entry point reads it.

### The sibling refusal: dead bindings (SPA-7090)

R1 is one of two refusals the allocator decision can return. When the binding's
workspace row is not in the live set — `archived`, `cleanup_failed`, `closed`, or
no row at all — the same helper returns `refusedDeadWorkspaceReuse: true`
(`heartbeat.ts:5940`, assigned at `heartbeat.ts:5976`) and logs at
`heartbeat.ts:20896`.

Both refusals fall through to a fresh workspace, but they are distinct failures
with distinct signatures. R1 means *someone else is using it*; a dead binding
means *nobody can restore it*. Only the dead-binding path reports back: the
caller supplies a `staleReuseFallback` payload
(`heartbeat.ts:21629`–`21634`) that the provisioner turns into a
`freshFallbackWarning` naming the dead branch
(`heartbeat.ts:6070`–`6076`), so an operator sees which branch went dead. R1
supplies no such payload — it is an ordinary contention case that should fall
through quietly.

### What R1 is not

**R1 is application policy, not a database uniqueness guarantee.** Nothing in
the schema stops two rows from naming the same `executionWorkspaceId`. R1 is
enforced in the allocator's decision path, and it holds for code that goes
through that path. A future writer that reads the binding column directly,
without routing through the allocator, would not be covered by it.

## R3 — per-repo worktree provisioning serialization

### What it guarantees

Two runs that provision worktrees in the **same repository** do not run
`git worktree add` concurrently *on the paths that take the lock* (see
[Where the lock is taken](#where-the-lock-is-taken) — one `worktree add` path is
unserialized and is called out below). Two runs provisioning in **different**
repositories are unaffected and proceed in parallel.

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
the realpath, truncated to 16 hex characters (`workspace-runtime.ts:4114`).
Symlinked paths, relative segments, and trailing slashes collapse to one key.
`realpathSync.native` is tried first, then `realpathSync`, then plain
`path.resolve` — the mutex stays usable in environments where the path does not
yet exist.

**Lock directory** (`workspace-runtime.ts:4085`), first match wins:

1. explicit `options.lockDir`
2. `PAPERCLIP_WORKTREE_LOCK_DIR`
3. `$PAPERCLIP_HOME/locks` — this scoping is what keeps concurrent test
   processes, each with their own `PAPERCLIP_HOME`, from serializing against
   each other or against a live dev server sharing `~/.paperclip`
4. `~/.paperclip/locks`

**Bounded timeout.** Waiting is capped at 60 s. On expiry the waiter throws
rather than blocking a run indefinitely
(`workspace-runtime.ts:4179`):

```
Timed out waiting for worktree provision lock at <path> (timeout 60000ms)
```

**Stale reclaim** (`workspace-runtime.ts:4117`). A waiter that finds `EEXIST`
attempts reclaim before waiting (`workspace-runtime.ts:4176`). The lock is
removed when its owner PID is dead, **or** when it is older than the stale
threshold:

| Probe result | Reclaim? | Why |
|---|---|---|
| `kill(pid, 0)` succeeds | no | holder is alive |
| `ESRCH` | yes | no such process — holder is dead |
| `EPERM` | no | process exists, we merely lack rights to signal it |
| lock older than 5 min | yes | bounded even when the PID is recycled or the payload is unparseable |

The `EPERM` row matters: treating "cannot signal" as "dead" would let a waiter
delete a live holder's lock. If the payload is unreadable, reclaim falls back to
the file's mtime against the stale threshold.

### Release is not ownership-checked

The `finally` block removes the lock file unconditionally
(`workspace-runtime.ts:4189`). There is no ownership-token check: the releasing
holder does not verify that the lock it is deleting is still the one it
acquired. Stale reclaim has the same property — a lock can be removed by age
while its PID is still alive. The two are bounded by the same reclaim-then-wait
protocol rather than by ownership, so the practical effect is that a holder
running longer than 5 minutes can have its lock reclaimed, and a late release
then removes whatever lock now occupies that filename. This is stated here
because it is a real property of the mechanism, not an endorsement of it.

### Where the lock is taken

The mutex covers **two** sites at this head:

| Site | Lock span | Enclosing function |
|---|---|---|
| Fresh branch creation (`worktree add -b <branch> <path> <baseRef>`) and the existing-branch reuse retry inside it | `workspace-runtime.ts:3623`–`3675` | `realizeExecutionWorkspace` (declared line 3263) |
| Restore of a persisted workspace (attach, origin restore, base-ref fallback) | `workspace-runtime.ts:3900`–`4025` | `ensurePersistedExecutionWorkspaceAvailable` (declared line 3708) |

The five `worktree add` call sites at `workspace-runtime.ts` lines 3627, 3647,
3904, 3954 and 3988 are all inside one of those two spans. The sixth, at line
3553, is not.

### Known R3 coverage gap: the `existingBranch` path

`realizeExecutionWorkspace` performs a `git worktree add <path> <branch>` for a
pinned `existingBranch` at `workspace-runtime.ts:3553`, inside the block spanning
lines 3549–3605. That block runs **before** the mutex opens at line 3623, so
**this path is not serialized**.

The consequence is bounded and specific: when a strategy pins `existingBranch`,
concurrent provisioning of the same branch in the same repository is not
mutually excluded. Contention on that path can surface git's own
`worktree add` refusal rather than a queued retry.

## Verifying these claims

Both invariants have focused test suites at the head named above.

```bash
# R1 policy helpers + R3 mutex
pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/execution-workspace-policy.test.ts \
  src/__tests__/workspace-runtime-worktree-mutex.test.ts
# 2 files, 40 tests passed

# R1 allocator decision, filtered to the cross-issue cases
pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/heartbeat-workspace-session.test.ts -t "cross-issue"
# 1 file, 2 passed | 161 skipped
```

The R1 cross-issue cases that pin the semantics above are named
`refuses cross-issue reuse when another open issue already holds the workspace`,
`refuses cross-issue reuse even when only the unrunnable-worktree gate reads it`,
and `treats reuse as runnable when another issue holding the workspace is done or
cancelled` (`execution-workspace-policy.test.ts:550`, `:562`, `:578`).

## Out of scope

**R2 — the database-level partial unique index on open issues' execution
workspace — is not documented here.** It was retired on 2026-09-08 and needs a
separate plan against the rebuild base. The index does not exist on this branch
(no `0231_issues_execution_workspace_open_uniq.sql` migration); the only
surviving trace is a historical row in `doc/FORK-PATCHES.md`. Nothing on this page
should be read as claiming that uniqueness is enforced at the storage layer; see
[What R1 is not](#what-r1-is-not).
