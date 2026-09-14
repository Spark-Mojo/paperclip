---
title: "Execution Workspace Invariants"
summary: "The three invariants that keep execution workspaces single-owner, fail-loud, and race-free"
---

An execution workspace is the machine's unit of isolated execution: one checkout, one runtime, one agent run. When two open issues can bind the same workspace, runs overwrite each other's state, git operations collide on shared `.git` locks, and the damage is silent until it isn't. This document specifies the three invariants that prevent that class, where each is enforced, and how the evidence for each is verified.

All line references are against the allocator-recurrence integration lineage (`integration/spa-5841-allocator-recurrence-fix` @ `db294ffaf`).

| Invariant | Layer | Enforced by | Fails |
|---|---|---|---|
| R1 — allocator exclusivity | Application policy | `heartbeat.ts` allocator + `execution-workspace-policy.ts` | Refuses the binding, provisions fresh |
| R2 — DB fail-loud constraint | Storage | Partial unique index on `issues.execution_workspace_id` | Aborts the write (and the migrate) |
| R3 — per-repo provisioning mutex | Provisioning runtime | `withWorktreeProvisionLock` in `workspace-runtime.ts` | Serializes or times out |

The layers are defense in depth: R1 is the decision, R2 is the backstop a race that slips past R1 cannot survive, R3 keeps the provisioning itself free of concurrent-write corruption.

## R1 — Allocator exclusivity invariant

**Rule: an execution workspace may be bound to at most one open issue.** Reuse by the *same* issue is fine (that is the point of `reuse_existing`); reuse by a *different* open issue is refused. A workspace bound only to done/cancelled issues is free again.

The allocator implements this in two places:

1. **Held-by-another-open-issue check** — `server/src/services/heartbeat.ts:13919`. When an issue requests an execution workspace, the allocator queries whether any *other* issue (`id ≠ issueId`) with status not in (`done`, `cancelled`) already carries that `execution_workspace_id`.
2. **Refusal → fresh provisioning** — `resolveAllocatorExecutionWorkspaceReuseDecision` (`heartbeat.ts:4359`) consumes that flag. On a cross-issue conflict it marks the reuse decision `inherited_workspace_reuse_unavailable` and the caller clears the reuse intent *before* the policy/provisioning path sees it, so provisioning falls through to `realizeWorkspace()` and provisions a fresh workspace instead of throwing. The run is never blocked by the refusal; it just gets a clean workspace.

The policy helpers the decision rides on live in `server/src/services/execution-workspace-policy.ts`:

- `hasReusableExecutionWorkspaceBinding` — returns `false` when `executionWorkspaceHeldByAnotherOpenIssue` is set, so "reusable" and "held by another open issue" can never both be true.
- `isUnrunnableWorktreeCombo` — the unrunnable-gate reads the same flag, so a cross-issue conflict refuses *even when the binding is only being checked for worktree runnability*, not just at provisioning time. There is no second code path that treats a contested workspace as usable.

**Evidence oracle:** `server/src/__tests__/execution-workspace-policy.test.ts` — 21 tests covering the mode/policy resolution surface, the unrunnable-worktree combos, and the cross-issue reuse refusal (same-issue reuse allowed, other-open-issue refused, done/cancelled holder does not block, refusal held through the unrunnable gate).

## R2 — DB fail-loud constraint

**Rule: the storage layer refuses what the allocator must never allow.** Migration `packages/db/src/migrations/0231_issues_execution_workspace_open_uniq.sql` creates:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS "issues_execution_workspace_id_open_uniq"
ON "issues" USING btree ("execution_workspace_id")
WHERE "execution_workspace_id" IS NOT NULL
  AND "status" NOT IN ('done', 'cancelled');
```

It is a *partial* unique index: it constrains only open issues, so a workspace's history may contain any number of done/cancelled rows, but at any instant at most one open row can point at it. This is the same predicate as R1's query, enforced where races cannot slip past: two transactions that both try to bind the same workspace to different open issues lose one with a constraint-name error instead of both succeeding.

Design notes carried in the migration header:

- **Numbering** — the file is numbered `0231`: the integration lineage originally used `0210`, and the first renumber to `0212` collided with upstream `v2026.831.0`'s `0212_onboarding_first_task_unique.sql`. `0231` sits above the upstream `v2026.831.0` max (`0230`), so no future rebase collides. The journal timestamp sits strictly between upstream migrations 0211 and 0212, so it applies on the current release without shadowing any upstream file.
- **Idempotent** — `IF NOT EXISTS`; a database that already carries the index (e.g. from the rolled-back deploy) no-ops.
- **Fails loud on legacy poisoned rows** — if any environment already carries two open issues sharing a workspace, `CREATE UNIQUE INDEX` aborts rather than skipping the corruption. That is intended. The remedy is the SPA-5693-style detach: null the later card's `execution_workspace_id` so it re-allocates a fresh workspace, then re-run migrate.
- **Rollback** — out-of-band `DROP INDEX IF EXISTS issues_execution_workspace_id_open_uniq`; no data loss.

**Evidence oracle:** a fresh database runs `migrate` to exit 0, and a duplicate-OPEN `INSERT` (second open issue reusing a bound workspace) is rejected with the constraint name `issues_execution_workspace_id_open_uniq`.

## R3 — Per-repo worktree provisioning mutex

**Rule: worktree provisioning for the same repository is serialized.** `git worktree add` mutates shared `.git` metadata (`config`, refs, lock files); two concurrent provisions against one repo can collide on `index.lock` / `HEAD.lock` and fail or corrupt. `withWorktreeProvisionLock` (`server/src/services/workspace-runtime.ts:3308`) wraps both provision paths — branch creation (`heartbeat`-driven provision at `workspace-runtime.ts:2907`) and restore (`workspace-runtime.ts:3149`) — with a mutex keyed per repository:

- **Atomic acquisition** — the lock is a file created with `writeFile(..., { flag: "wx" })`: exclusive-create in one syscall. Either the file is ours or it exists; there is no mkdir-then-write window for a contending release to race through.
- **Canonical per-repo key** — the lock file is `worktree-<key>.lock` where the key derives from the canonicalized repo root, so symlinked and real paths of the same repo contend on the same lock (and different repos never do — parallel provisioning across repos proceeds at full speed).
- **Bounded timeout** — default 60 s (`WORKTREE_PROVISION_LOCK_DEFAULT_TIMEOUT_MS`, `workspace-runtime.ts:3240`); a waiter past the deadline throws rather than hanging the run.
- **Stale reclaim** — default 5 min (`WORKTREE_PROVISION_LOCK_DEFAULT_STALE_MS`). The lock payload records `{ pid, createdAt }`; a waiter reclaims when the owner's pid is provably dead (`ESRCH`) — and deliberately *does not* reclaim on `EPERM`, because a process we cannot signal may still be alive.
- **Crash-clean release** — the lock file is removed in `finally`, so a throwing operation does not leak the lock to the next waiter.

**Evidence oracle:** `server/src/__tests__/workspace-runtime-worktree-mutex.test.ts` — 7 tests covering 50-concurrent acquisition on one repo (zero overlap), cross-repo parallelism, symlink/real-path key identity, lock-dir cleanup on throw, bounded-timeout rejection, key stability, and lock-dir override. Complemented by a 50-parallel real `git worktree add` smoke (50 worktrees provisioned, zero lock collisions).

## Interlock: why three layers

Each layer covers a different failure mode:

- **R1 alone** would be correct in the single-process case but cannot see a concurrent write from another server instance.
- **R2** closes that gap at the storage layer — the constraint is the last word, and its abort on a poisoned legacy dataset is the signal that says "fix the data, don't ship the corruption."
- **R3** addresses the failure mode neither above it can prevent: *correct* allocator decisions that nonetheless issue concurrent `git worktree add` calls against one repo when multiple workspaces provision in parallel.

Together: the allocator refuses to double-bind (R1), the database makes double-binding impossible to persist (R2), and the provisioner makes the workspace realization itself safe under parallelism (R3).
