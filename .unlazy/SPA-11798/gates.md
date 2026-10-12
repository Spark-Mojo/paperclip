# SPA-11798 gates — suppress pre-close deferred-comment reopen

DELIVERABLE: d1 | craft: craft-general (orchestrator-implemented: the subagent had no
  external-directory access to this worktree) | paths: server/src/modules/wake-queue/application/types.ts,
  server/src/modules/wake-queue/application/ports.ts, server/src/modules/wake-queue/adapters/postgres.ts,
  server/src/modules/wake-queue/application/use-cases.ts, server/src/modules/wake-queue/application/use-cases.test.ts,
  server/src/modules/wake-queue/domain/values.ts, server/src/modules/wake-queue/domain/values.test.ts

GATE: g1 | deliverable: d1 | CHECK: pnpm vitest run server/src/modules/wake-queue/application/use-cases.test.ts
  EXPECT: exit 0
  NEGATIVE: surgically remove ONLY the `!preCloseExternalComment &&` term from the shouldReopen
  expression, leaving every other line intact -> "Tests  3 failed | 57 passed (60)", the 3
  failures being exactly the pre-close suppression cases. This surgical form is the control:
  reverting the whole implementation file also perturbs unrelated fake wiring and produced 9
  failures, which proves nothing about the discriminator. Observed, pasted below.

GATE: g2 | deliverable: d1 | CHECK: pnpm vitest run server/src/modules/wake-queue
  EXPECT: exit 0
  NEGATIVE: same stash trick -> exit nonzero with the same 3 failures.

GATE: g3 | deliverable: d1 | CHECK: pnpm tsc --noEmit -p server/tsconfig.json
  EXPECT: exit 0, OR exit 1 with zero errors under server/src/modules/wake-queue
  NEGATIVE: n/a for the delta claim — the pre-existing-error count is the control, re-derived
  by stashing the whole wake-queue diff and re-running (139 before, 139 after).

EVIDENCE: d1 | commit: (amended) | gates: g1 PASS, g2 PASS, g3 PASS (pre-existing-only) | critic: orchestrator-executed | at: 2026-10-12T00:42Z
  g2 `pnpm vitest run server/src/modules/wake-queue` -> exit 0, 7 files / 213 tests passed.
  g2 (final, hardened) -> exit 0, 7 files / 215 tests passed.
  NEGATIVE CONTROL (surgical): deleting only the `!preCloseExternalComment &&` term ->
  `Tests  3 failed | 57 passed (60)`; the 3 failures are exactly "suppresses a stale user
  comment that predates the close ('done')", "(... 'cancelled')", and "suppresses a stale
  board notification exactly at the close instant". All 8 over-suppression guards (post-close,
  mixed pre/post, resumeIntent at the close instant, self-authored, short array, null
  createdAt) stayed GREEN without the term, so the discriminator is not merely inverting an
  assertion.
  CRITIC PASS (orchestrator-executed — the critic subagent was denied external-directory
  access to this worktree, so it returned a NULL result, not a pass; do not read it as one).
  Two real defects were found and fixed before commit:
   1. FAIL-OPEN VACUITY (blocking). The adapter originally returned
      `rows.map(createdAt)`, so a comment id absent from the row read shortened the array and
      `.every()` passed VACUOUSLY — silently suppressing a reopen the guard never justified.
      Fixed: the port now returns `{ commentId, createdAt }[]`, the adapter emits one fact per
      REQUESTED id with `createdAt: null` for any id it could not read, and the caller checks
      BOTH coverage (`facts.length === new Set(deferredCommentIds).size`) and nullability
      before suppressing. Two regression tests pin this ("keeps the reopen when a comment's
      creation instant could not be read", "...is null"). The first of those two tests FAILED
      against my first fix, which had checked only `facts.length === 0` — the test caught my
      own incomplete guard, and the coverage check was added in response.
   2. DUPLICATE-ARG HAZARD. `deferredCommentIds` may repeat; the guard now de-dupes via a Set,
      matching the adapter, so a duplicated id cannot fail the coverage check spuriously.
  Reviewed and accepted as sound: the `pickTerminalAt` placement in domain/values.ts; the
  deliberate rewrite of the pre-existing "reopens a completed task before promoting its
  assignee's human follow-up" test (it asserted the reopen for ANY human comment, which IS
  the defect; it now pins the post-close reopen, and the pre-close case is pinned separately);
  the `<=` boundary (a same-instant notification is treated as pre-close, which is the safe
  direction given the resumeIntent clause is exempt).
  g3 `pnpm tsc --noEmit -p server/tsconfig.json` -> exit 1, 139 errors, ZERO under
  server/src/modules/wake-queue. Verified pre-existing: the same command reports the same 139
  with the entire wake-queue diff stashed. They originate in stale linked @paperclipai/*
  build artifacts in the shared node_modules this worktree symlinks; not this deliverable's.

  NOT COVERED (deliberate follow-up, out of scope here): SPA-10460's second cycle, where the
  closing comment was posted AFTER the `done` write, so createdAt > completedAt and this guard
  cannot suppress it. Advisor named that shape before the work began; it is a distinct defect
  (an agent's own closing receipt arming the deferred queue) and needs its own repro and PR.