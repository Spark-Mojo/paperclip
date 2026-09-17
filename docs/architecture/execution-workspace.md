---
title: "Execution Workspace Invariants"
summary: "The allocator-exclusivity and per-repository locking invariants that keep execution workspaces isolated"
---

An execution workspace is an isolated checkout and runtime for one issue's agent runs. Two PR #37 survivor invariants prevent separate issues from sharing a live workspace and prevent concurrent provisioning from colliding in one Git repository.

All source references and evidence below are validated against PR #37 head `aa80df4f2f1da7d95bf72e732736a1ca6c461e19` (`rebuild/v2026.831.1-survivors`).

| Invariant | Layer | Enforcement | Failure behavior |
|---|---|---|---|
| R1 — allocator exclusivity | Application policy | `heartbeat.ts` allocator and `execution-workspace-policy.ts` | Refuse cross-issue reuse and provision fresh |
| R3 — per-repository provisioning mutex | Provisioning runtime | `withWorktreeProvisionLock` in `workspace-runtime.ts` | Serialize or time out |

## R1 — Allocator exclusivity

**Rule: the allocator cannot reuse an execution workspace held by a different open issue.** The same issue can reuse its own binding. A different issue cannot reuse that workspace while its holder has any status other than `done` or `cancelled`. This is application policy, not a database uniqueness guarantee.

The allocator checks this rule at two points in `server/src/services/heartbeat.ts`:

1. Each point queries for a different issue in the same company with the requested `execution_workspace_id` and an open status. The checks run in initial allocation near line 14592 and in the transaction-backed path near line 18640.
2. In initial allocation, `resolveAllocatorExecutionWorkspaceReuseDecision` refuses the cross-issue binding. The caller clears the reuse request before downstream policy sees it, avoids the `inherited_workspace_reuse_unavailable` error, and falls through to `realizeWorkspace` for fresh provisioning.
3. In the transaction-backed path, `resolveExecutionWorkspaceReuseRequestForIssue` marks the contested workspace unavailable before the result reaches `isUnrunnableWorktreeCombo`.

The shared helpers in `server/src/services/execution-workspace-policy.ts` preserve the same decision:

- `hasReusableExecutionWorkspaceBinding` returns false when `executionWorkspaceHeldByAnotherOpenIssue` is true.
- `isUnrunnableWorktreeCombo` uses that result, so a contested binding cannot be treated as an available reusable workspace through the worktree-policy path.

**Evidence oracle:** `server/src/__tests__/execution-workspace-policy.test.ts` verifies cross-issue refusal and the unrunnable-worktree gate. `server/src/__tests__/heartbeat-workspace-session.test.ts` directly covers the allocator decision helper for same-issue reuse, cross-issue refusal, and terminal-holder recycling. These are helper-level tests; they do not prove a database uniqueness constraint or a full allocation integration path.

## R3 — Per-repository worktree provisioning mutex

**Rule: fresh worktree provisioning for the same repository is serialized.** `git worktree add` mutates shared Git metadata. Concurrent writers in one repository can collide on lock files or leave an unusable checkout.

`withWorktreeProvisionLock` in `server/src/services/workspace-runtime.ts` protects the fresh branch-creation path:

- **Atomic acquisition** — it creates `worktree-<key>.lock` with `writeFile(..., { flag: "wx" })`; only one contender can create the file.
- **Canonical repository key** — the key hashes the real path when available and otherwise the resolved absolute path. Symlinked paths, relative segments, and trailing slashes therefore resolve to one lock identity.
- **Bounded wait** — the default timeout is 60 seconds. A waiter throws `Timed out waiting for worktree provision lock` instead of hanging indefinitely.
- **Stale reclaim** — lock payloads record the owner PID and creation time. A waiter removes a lock whose process is not alive or whose age exceeds the default five-minute stale limit. `ESRCH` means dead; `EPERM` is treated as alive.
- **Release after failure** — the lock file is removed in `finally` when the holder still owns it.

The mutex wraps fresh `git worktree add -b` provisioning near line 3553. It does **not** wrap the existing-branch attachment path near line 3488; `doc/FORK-PATCHES.md` records that uncovered path as a known R3 limitation rather than claiming full coverage.

**Evidence oracle:** `server/src/__tests__/workspace-runtime-worktree-mutex.test.ts` contains seven tests for same-repository serialization across 50 contenders, cross-repository parallelism, symlink and real-path identity, cleanup after a thrown operation, timeout behavior, stable key derivation, and lock-directory override.

## Interlock

R1 protects ownership: a different open issue cannot inherit the live binding. R3 protects realization: fresh worktree creation for one repository cannot run concurrently. They address different failure modes and neither substitutes for the other.

R2 is intentionally outside this survivor contract. The database uniqueness constraint from the retired integration carrier is not present on PR #37 and requires a separate plan on the rebuild base.
