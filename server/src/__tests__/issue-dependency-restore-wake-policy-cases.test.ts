/**
 * SPA-18573 — R2 regression cases (A–E) for the restored-blocked wake policy.
 *
 * THIS FILE MUST RUN IDENTICALLY ON THE BASE TREE (35f781ca, before the R1
 * backport) AND ON HEAD (after it). It therefore must NOT import
 * `shouldWakeOnRestoredBlockedDependency` or any other post-R1 symbol — a
 * missing named export would make a vanilla run fail at module load, and a
 * red that never ran its own expectation proves nothing. The policy is
 * exercised BLACK-BOX through the real route (`issueRoutes`) and the real
 * backstop (`recoveryService(...).reconcileResolvedDependencyWakeBackstop`),
 * both of which exist on base.
 *
 * The vanilla-comparison harness
 * (.unlazy/SPA-18573/tests/vanilla-compare.mjs) runs this same file in a base
 * snapshot and on HEAD and publishes the per-case before/after matrix:
 *
 *   case A — agent self-re-blocks its own dependency-ready card: the route must
 *            NOT re-arm an `issue_blockers_resolved` wake. RED on base (base's
 *            inline wake condition still fires), GREEN on HEAD.
 *   case B — a blocker transitions to done: exactly one wake for the blocked
 *            dependent. GREEN on both (non-regression).
 *   case C — the backstop skips an agent self-blocked ready cycle
 *            (`selfBlockedSkipped`) but wakes when a blocker completed or a
 *            workspace finalize succeeded AFTER `blockedTransitionAt`.
 *            RED on base (no counter, and the backstop heals the self-blocked
 *            card), GREEN on HEAD.
 *   case D — a board/user-actor re-block of a ready blocked card, and an
 *            assignee change, still wake. GREEN on both.
 *   case E — characterization: a `claimed` wake row under the dependent's
 *            state key from a DIFFERENT cycle does not dedup the current
 *            cycle. GREEN on both (R1 changed only the policy function).
 *
 * The cases file defines exactly five `it(...)` blocks titled `case A:` …
 * `case E:` — the harness maps titles to case ids by that leading token.
 * Every expected base RED is an ASSERTION failure: post-R1 fields are read
 * defensively (`(result as { selfBlockedSkipped?: number }).selfBlockedSkipped`)
 * so a missing field makes the expectation fail instead of throwing inside the
 * test body.
 */

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, asc, eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueRelations,
  issues,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import {
  ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
  buildIssueBlockersResolvedWakeStateKey,
} from "../services/issue-dependency-wakeups.js";
import { recoveryService } from "../services/recovery/service.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import {
  describeEmbeddedPostgres,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

// A dependency wake dispatches a heartbeat run that calls the server adapter.
// Stub the adapter so an enqueued wake never spawns a real agent session; the
// wake rows themselves stay real (written by heartbeat.wakeup).
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "SPA-18573 dependency wake policy case run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

type Db = ReturnType<typeof createDb>;

/** The fixed blocked-cycle stamp every deterministic fixture anchors on. */
const T0 = new Date("2026-01-01T00:00:00.000Z");

/** Deterministic timestamp `seconds` after T0 (never Date.now()). */
function ts(secondsAfterT0: number): Date {
  return new Date(T0.getTime() + secondsAfterT0 * 1_000);
}

function agentActor(companyId: string, agentId: string, runId?: string): Express.Request["actor"] {
  return {
    type: "agent",
    agentId,
    companyId,
    // The run id is persisted into uuid columns (activity_log.run_id,
    // heartbeat_runs.id lookups), so it must be a bare UUID — a prefixed id
    // fails the Postgres uuid cast and the PATCH 500s. Case A passes the id of
    // the seeded running heartbeat run so assertCheckoutOwner sees the actor
    // holding the issue's run lock.
    runId: runId ?? randomUUID(),
    source: "agent_jwt",
  };
}

function boardActor(companyId: string): Express.Request["actor"] {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "admin", status: "active" }],
    isInstanceAdmin: false,
    source: "session",
  };
}

/** Mounts the real issue routes behind a fixed actor, with the real error handler. */
function routeApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes(db, {} as any));
  app.use(errorHandler);
  return app;
}

async function seedCompany(db: Db, label: string): Promise<string> {
  const companyId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: `${label} ${companyId}`,
    issuePrefix: `W${companyId.replaceAll("-", "").slice(0, 5).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
    defaultResponsibleUserId: "board-user",
  });
  // The board actor's in-band membership declaration must be mirrored by a
  // real `company_memberships` row: authorization's decidePrincipalGrant (hit
  // on the assignee-change path) resolves the acting user's membership from
  // the DB, not from the actor payload (pattern: board-claim.test.ts).
  await db.insert(companyMemberships).values({
    companyId,
    principalType: "user",
    principalId: "board-user",
    status: "active",
    membershipRole: "admin",
  });
  return companyId;
}

async function seedAgent(db: Db, companyId: string, name: string): Promise<string> {
  const agentId = randomUUID();
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name,
    role: "engineer",
    status: "idle",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  });
  return agentId;
}

async function seedIssue(
  db: Db,
  input: {
    companyId: string;
    title: string;
    status: string;
    assigneeAgentId?: string | null;
    blockedTransitionAt?: Date | null;
    completedAt?: Date | null;
    executionWorkspaceId?: string | null;
  },
): Promise<string> {
  const issueId = randomUUID();
  await db.insert(issues).values({
    id: issueId,
    companyId: input.companyId,
    title: input.title,
    status: input.status,
    priority: "medium",
    assigneeAgentId: input.assigneeAgentId ?? null,
    blockedTransitionAt: input.blockedTransitionAt ?? null,
    completedAt: input.completedAt ?? null,
    executionWorkspaceId: input.executionWorkspaceId ?? null,
    responsibleUserId: "board-user",
  });
  return issueId;
}

/** `issueId` is the BLOCKER, `relatedIssueId` the DEPENDENT (type "blocks"). */
async function seedBlockerEdge(
  db: Db,
  companyId: string,
  blockerIssueId: string,
  dependentIssueId: string,
): Promise<void> {
  await db.insert(issueRelations).values({
    companyId,
    issueId: blockerIssueId,
    relatedIssueId: dependentIssueId,
    type: "blocks",
  });
}

/**
 * The `issue.updated` activity row a real agent self-block would leave behind.
 * `wasBlockedByAssigneeAgent` matches the latest such row at or after
 * `blockedTransitionAt - 5s` whose details carry `status: "blocked"`.
 */
async function seedSelfBlockActivity(
  db: Db,
  input: { companyId: string; agentId: string; issueId: string; at: Date },
): Promise<void> {
  await db.insert(activityLog).values({
    companyId: input.companyId,
    actorType: "agent",
    actorId: input.agentId,
    agentId: input.agentId,
    action: "issue.updated",
    entityType: "issue",
    entityId: input.issueId,
    details: { status: "blocked" },
    createdAt: input.at,
  });
}

async function seedClaimedDependencyWake(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    dependentIssueId: string;
    idempotencyKey: string;
    requestedAt: Date;
  },
): Promise<void> {
  await db.insert(agentWakeupRequests).values({
    companyId: input.companyId,
    agentId: input.agentId,
    source: "automation",
    reason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
    payload: { issueId: input.dependentIssueId },
    status: "claimed",
    requestedAt: input.requestedAt,
    claimedAt: input.requestedAt,
    idempotencyKey: input.idempotencyKey,
    requestedByActorType: "system",
    requestedByActorId: "issue_graph_liveness_backstop",
  });
}

/**
 * The `issue_blockers_resolved` wake rows recorded for one dependent under one
 * expected ready-state key. The PRIMARY filter is the `idempotency_key`
 * column — the state key itself — with `payload ->> 'issueId'` kept only as a
 * secondary cross-check. A skipped wake row RETAINS its idempotency_key but
 * OVERWRITES `reason` with the skip reason, so a reason-based filter is not a
 * sound oracle for "this cycle's wake".
 */
async function listDependencyWakes(
  db: Db,
  input: { companyId: string; dependentIssueId: string; expectedStateKey: string },
) {
  return db
    .select({
      id: agentWakeupRequests.id,
      agentId: agentWakeupRequests.agentId,
      status: agentWakeupRequests.status,
      reason: agentWakeupRequests.reason,
      idempotencyKey: agentWakeupRequests.idempotencyKey,
      requestedAt: agentWakeupRequests.requestedAt,
    })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.idempotencyKey, input.expectedStateKey),
        sql`${agentWakeupRequests.payload} ->> 'issueId' = ${input.dependentIssueId}`,
      ),
    )
    .orderBy(asc(agentWakeupRequests.requestedAt), asc(agentWakeupRequests.id));
}

/**
 * A RECORDING `enqueueWakeup` for the recovery backstop. `heartbeat.wakeup()`
 * returns NULL on every skip branch, so a backstop wired to the real heartbeat
 * service could never increment its `healed` counter in a test fixture. This
 * stub instead records exactly the opts the backstop passes, inserts the
 * `agent_wakeup_requests` row with those fields (status "queued"), and returns
 * a truthy heartbeat-run-shaped object so `healed` increments. Case C tests
 * the backstop's DECISION — decoupled from heartbeat scheduling entirely.
 */
function recordingEnqueueWakeup(db: Db, companyId: string) {
  const calls: {
    agentId: string;
    source: string | undefined;
    triggerDetail: string | undefined;
    reason: string | undefined;
    payload: Record<string, unknown> | null;
    idempotencyKey: string | null;
    requestedByActorType: string | null;
    requestedByActorId: string | null;
  }[] = [];
  const enqueueWakeup = async (
    agentId: string,
    opts?: {
      source?: string;
      triggerDetail?: string;
      reason?: string;
      payload?: Record<string, unknown>;
      idempotencyKey?: string | null;
      requestedByActorType?: string | null;
      requestedByActorId?: string | null;
    },
  ): Promise<{ id: string }> => {
    calls.push({
      agentId,
      source: opts?.source,
      triggerDetail: opts?.triggerDetail,
      reason: opts?.reason,
      payload: opts?.payload ?? null,
      idempotencyKey: opts?.idempotencyKey ?? null,
      requestedByActorType: opts?.requestedByActorType ?? null,
      requestedByActorId: opts?.requestedByActorId ?? null,
    });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: opts?.source ?? "automation",
      triggerDetail: opts?.triggerDetail ?? null,
      reason: opts?.reason ?? "unknown",
      payload: (opts?.payload ?? {}) as Record<string, unknown>,
      status: "queued",
      requestedAt: ts(120),
      idempotencyKey: opts?.idempotencyKey ?? null,
      requestedByActorType: opts?.requestedByActorType ?? "system",
      requestedByActorId: opts?.requestedByActorId ?? null,
    });
    return { id: randomUUID() } as never;
  };
  return { calls, enqueueWakeup };
}

describeEmbeddedPostgres("issue dependency restore wake policy cases", () => {
  const ctx = useEmbeddedPostgres("paperclip-issue-dependency-restore-wake-policy-cases-");

  it(
    "case A: agent self-re-block of a dependency-ready card must not enqueue a restored-blocked wake",
    { timeout: 120_000 },
    async () => {
      const { db } = ctx;
      const companyId = await seedCompany(db, "CaseA");
      const agentX = await seedAgent(db, companyId, "Case A assignee");
      // The stale done edge: the blocker is already resolved, yet it stays in
      // the blocker set the agent re-declares while entering blocked.
      const blockerId = await seedIssue(db, {
        companyId,
        title: "Case A stale done blocker",
        status: "done",
        completedAt: ts(-600),
      });
      const dependentId = await seedIssue(db, {
        companyId,
        title: "Case A dependent",
        status: "in_progress",
        assigneeAgentId: agentX,
      });
      await seedBlockerEdge(db, companyId, blockerId, dependentId);

      // An agent actor PATCHing its own in_progress issue must hold the run
      // lock or the route 409s ("Issue run ownership conflict"):
      // assertCheckoutOwner wants a heartbeat_runs row with status "running"
      // and agentId = actorAgentId, the issue's checkoutRunId/executionRunId
      // pointing at that run, and actor.runId equal to the same id.
      // (Pattern: issue-blocker-diagnostics-routes.test.ts.)
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId: agentX,
        status: "running",
        contextSnapshot: { issueId: dependentId },
      });
      await db
        .update(issues)
        .set({ checkoutRunId: runId, executionRunId: runId })
        .where(eq(issues.id, dependentId));

      // The assignee agent re-blocks its OWN card. The unblockDescriptor is
      // what makes entering blocked legal when no requested blocker is
      // unresolved (the stale edge is done).
      const res = await request(
        routeApp(db, agentActor(companyId, agentX, runId)),
      )
        .patch(`/api/issues/${dependentId}`)
        .send({
          status: "blocked",
          blockedByIssueIds: [blockerId],
          unblockDescriptor: {
            owner: { agentId: agentX },
            action: "waiting on an out-of-band confirmation",
          },
        });
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      // The wake insert is fire-and-forget; drain before asserting.
      await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));

      const dependent = await db
        .select({ status: issues.status, blockedTransitionAt: issues.blockedTransitionAt })
        .from(issues)
        .where(eq(issues.id, dependentId))
        .then((rows) => rows[0]);
      expect(dependent?.status).toBe("blocked");
      expect(dependent?.blockedTransitionAt).not.toBeNull();

      const expectedStateKey = buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: dependentId,
        blockerIssueIds: [blockerId],
        blockedTransitionAt: dependent!.blockedTransitionAt,
      });
      const wakes = await listDependencyWakes(db, {
        companyId,
        dependentIssueId: dependentId,
        expectedStateKey,
      });
      expect(
        wakes,
        "an agent self-block on a dependency-ready card must not re-arm an issue_blockers_resolved wake",
      ).toEqual([]);

      const companyWakeKeys = await db
        .select({ idempotencyKey: agentWakeupRequests.idempotencyKey })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, companyId));
      expect(
        companyWakeKeys.some((row) => row.idempotencyKey === expectedStateKey),
        "no wake row may carry the restored-blocked ready-state key of this cycle",
      ).toBe(false);
    },
  );

  it(
    "case B: a blocker transitioning to done enqueues exactly one wake for the blocked dependent",
    { timeout: 120_000 },
    async () => {
      const { db } = ctx;
      const companyId = await seedCompany(db, "CaseB");
      const agentA = await seedAgent(db, companyId, "Case B assignee");
      const blockerId = await seedIssue(db, {
        companyId,
        title: "Case B blocker",
        status: "todo",
      });
      const dependentId = await seedIssue(db, {
        companyId,
        title: "Case B dependent",
        status: "blocked",
        assigneeAgentId: agentA,
        blockedTransitionAt: T0,
      });
      await seedBlockerEdge(db, companyId, blockerId, dependentId);

      const res = await request(routeApp(db, boardActor(companyId)))
        .patch(`/api/issues/${blockerId}`)
        .send({ status: "done" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));

      const expectedStateKey = buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: dependentId,
        blockerIssueIds: [blockerId],
        blockedTransitionAt: T0,
      });
      const wakes = await listDependencyWakes(db, {
        companyId,
        dependentIssueId: dependentId,
        expectedStateKey,
      });
      expect(wakes, "the blocker-done path must wake the dependent exactly once").toHaveLength(1);
      expect(wakes[0]?.agentId).toBe(agentA);
      expect(wakes[0]?.idempotencyKey).toBe(expectedStateKey);
    },
  );

  it(
    "case C: the backstop skips an agent self-blocked ready cycle but wakes on a later completion or finalize",
    { timeout: 120_000 },
    async () => {
      const { db } = ctx;

      // C1 — the defect: the assignee agent opened this blocked cycle itself
      // (activity row with details.status "blocked" at T0), every blocker was
      // already resolved BEFORE T0, and no wake row exists yet.
      {
        const companyId = await seedCompany(db, "CaseC1");
        const agentId = await seedAgent(db, companyId, "Case C1 assignee");
        const blockerId = await seedIssue(db, {
          companyId,
          title: "Case C1 stale done blocker",
          status: "done",
          completedAt: null,
        });
        const dependentId = await seedIssue(db, {
          companyId,
          title: "Case C1 dependent",
          status: "blocked",
          assigneeAgentId: agentId,
          blockedTransitionAt: T0,
        });
        await seedBlockerEdge(db, companyId, blockerId, dependentId);
        await seedSelfBlockActivity(db, { companyId, agentId, issueId: dependentId, at: T0 });
        const expectedStateKey = buildIssueBlockersResolvedWakeStateKey({
          dependentIssueId: dependentId,
          blockerIssueIds: [blockerId],
          blockedTransitionAt: T0,
        });

        const { calls, enqueueWakeup } = recordingEnqueueWakeup(db, companyId);
        const result = await recoveryService(db, {
          enqueueWakeup,
        }).reconcileResolvedDependencyWakeBackstop({ companyId });

        // Defensive read: the counter only exists after the R1 backstop. On
        // base it is `undefined` and the expectation itself must fail (an
        // assertion failure, never a TypeError inside the test body).
        const selfBlockedSkipped = (result as { selfBlockedSkipped?: number }).selfBlockedSkipped;
        expect(
          selfBlockedSkipped,
          "the backstop must count the self-blocked ready cycle as skipped",
        ).toBe(1);
        expect(result.healed).toBe(0);
        expect(
          calls,
          "the backstop must not enqueue behind a card the assignee agent blocked itself",
        ).toHaveLength(0);
        const wakes = await listDependencyWakes(db, {
          companyId,
          dependentIssueId: dependentId,
          expectedStateKey,
        });
        expect(
          wakes,
          "the backstop must not wake a card the assignee agent blocked itself",
        ).toEqual([]);
      }

      // C2 — same fixture, but the blocker COMPLETED AFTER blockedTransitionAt:
      // the cycle is genuinely unblocked by dependency progress, so the
      // backstop must wake despite the self-block trail.
      {
        const companyId = await seedCompany(db, "CaseC2");
        const agentId = await seedAgent(db, companyId, "Case C2 assignee");
        const blockerId = await seedIssue(db, {
          companyId,
          title: "Case C2 blocker completed after the transition",
          status: "done",
          completedAt: ts(60),
        });
        const dependentId = await seedIssue(db, {
          companyId,
          title: "Case C2 dependent",
          status: "blocked",
          assigneeAgentId: agentId,
          blockedTransitionAt: T0,
        });
        await seedBlockerEdge(db, companyId, blockerId, dependentId);
        await seedSelfBlockActivity(db, { companyId, agentId, issueId: dependentId, at: T0 });
        const expectedStateKey = buildIssueBlockersResolvedWakeStateKey({
          dependentIssueId: dependentId,
          blockerIssueIds: [blockerId],
          blockedTransitionAt: T0,
        });

        const { calls, enqueueWakeup } = recordingEnqueueWakeup(db, companyId);
        const result = await recoveryService(db, {
          enqueueWakeup,
        }).reconcileResolvedDependencyWakeBackstop({ companyId });

        expect(result.healed, "a blocker completed after the cycle start must heal").toBe(1);
        const selfBlockedSkipped = (result as { selfBlockedSkipped?: number }).selfBlockedSkipped;
        expect(selfBlockedSkipped ?? 0).toBe(0);
        expect(calls, "the backstop must enqueue exactly one wake for the healed cycle").toHaveLength(1);
        expect(calls[0]?.agentId).toBe(agentId);
        expect(calls[0]?.reason).toBe(ISSUE_BLOCKERS_RESOLVED_WAKE_REASON);
        expect(calls[0]?.idempotencyKey).toBe(expectedStateKey);
        const wakes = await listDependencyWakes(db, {
          companyId,
          dependentIssueId: dependentId,
          expectedStateKey,
        });
        expect(wakes).toHaveLength(1);
      }

      // C3 — same fixture, but the done blocker carries an execution workspace
      // whose workspace_finalize SUCCEEDED after blockedTransitionAt: the
      // backstop must wake as well.
      {
        const companyId = await seedCompany(db, "CaseC3");
        const agentId = await seedAgent(db, companyId, "Case C3 assignee");
        const projectId = randomUUID();
        await db.insert(projects).values({
          id: projectId,
          companyId,
          name: "Case C3 project",
          status: "in_progress",
        });
        const workspaceId = randomUUID();
        await db.insert(executionWorkspaces).values({
          id: workspaceId,
          companyId,
          projectId,
          mode: "isolated_workspace",
          strategyType: "git_worktree",
          name: "Case C3 workspace",
        });
        const blockerId = await seedIssue(db, {
          companyId,
          title: "Case C3 finalized blocker",
          status: "done",
          completedAt: null,
          executionWorkspaceId: workspaceId,
        });
        const dependentId = await seedIssue(db, {
          companyId,
          title: "Case C3 dependent",
          status: "blocked",
          assigneeAgentId: agentId,
          blockedTransitionAt: T0,
        });
        await seedBlockerEdge(db, companyId, blockerId, dependentId);
        await seedSelfBlockActivity(db, { companyId, agentId, issueId: dependentId, at: T0 });
        await db.insert(workspaceOperations).values({
          companyId,
          executionWorkspaceId: workspaceId,
          issueId: blockerId,
          phase: "workspace_finalize",
          status: "succeeded",
          startedAt: ts(60),
          finishedAt: ts(60),
        });
        const expectedStateKey = buildIssueBlockersResolvedWakeStateKey({
          dependentIssueId: dependentId,
          blockerIssueIds: [blockerId],
          blockedTransitionAt: T0,
        });

        const { calls, enqueueWakeup } = recordingEnqueueWakeup(db, companyId);
        const result = await recoveryService(db, {
          enqueueWakeup,
        }).reconcileResolvedDependencyWakeBackstop({ companyId });

        expect(result.healed, "a post-cycle workspace finalize must heal").toBe(1);
        const selfBlockedSkipped = (result as { selfBlockedSkipped?: number }).selfBlockedSkipped;
        expect(selfBlockedSkipped ?? 0).toBe(0);
        expect(calls, "the backstop must enqueue exactly one wake for the healed cycle").toHaveLength(1);
        expect(calls[0]?.agentId).toBe(agentId);
        expect(calls[0]?.reason).toBe(ISSUE_BLOCKERS_RESOLVED_WAKE_REASON);
        expect(calls[0]?.idempotencyKey).toBe(expectedStateKey);
        const wakes = await listDependencyWakes(db, {
          companyId,
          dependentIssueId: dependentId,
          expectedStateKey,
        });
        expect(wakes).toHaveLength(1);
      }
    },
  );

  it(
    "case D: a board re-block of a ready blocked card and an assignee change still wake",
    { timeout: 120_000 },
    async () => {
      const { db } = ctx;

      // D1 — the board re-blocks an already-blocked ready card (blocker set
      // edited): actorType "user" is not a self-block, so the wake must fire.
      {
        const companyId = await seedCompany(db, "CaseD1");
        const agentA = await seedAgent(db, companyId, "Case D1 assignee");
        const blockerId = await seedIssue(db, {
          companyId,
          title: "Case D1 stale done blocker",
          status: "done",
          completedAt: ts(-600),
        });
        const dependentId = await seedIssue(db, {
          companyId,
          title: "Case D1 dependent",
          status: "blocked",
          assigneeAgentId: agentA,
          blockedTransitionAt: T0,
        });
        await seedBlockerEdge(db, companyId, blockerId, dependentId);

        const res = await request(routeApp(db, boardActor(companyId)))
          .patch(`/api/issues/${dependentId}`)
          .send({
            status: "blocked",
            blockedByIssueIds: [blockerId],
            unblockDescriptor: { owner: "board", action: "board re-block of a ready card" },
          });
        expect(res.status, JSON.stringify(res.body)).toBe(200);

        await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));

        const expectedStateKey = buildIssueBlockersResolvedWakeStateKey({
          dependentIssueId: dependentId,
          blockerIssueIds: [blockerId],
          blockedTransitionAt: T0,
        });
        const wakes = await listDependencyWakes(db, {
          companyId,
          dependentIssueId: dependentId,
          expectedStateKey,
        });
        expect(wakes, "a board re-block of a ready blocked card must wake the assignee").toHaveLength(1);
        expect(wakes[0]?.agentId).toBe(agentA);
        expect(wakes[0]?.idempotencyKey).toBe(expectedStateKey);
      }

      // D2 — entering blocked from todo WITH an assignee change: the wake must
      // be enqueued for the NEW assignee.
      {
        const companyId = await seedCompany(db, "CaseD2");
        const agentA = await seedAgent(db, companyId, "Case D2 previous assignee");
        const agentB = await seedAgent(db, companyId, "Case D2 new assignee");
        const blockerId = await seedIssue(db, {
          companyId,
          title: "Case D2 stale done blocker",
          status: "done",
          completedAt: ts(-600),
        });
        const dependentId = await seedIssue(db, {
          companyId,
          title: "Case D2 dependent",
          status: "todo",
          assigneeAgentId: agentA,
        });
        await seedBlockerEdge(db, companyId, blockerId, dependentId);

        const res = await request(routeApp(db, boardActor(companyId)))
          .patch(`/api/issues/${dependentId}`)
          .send({
            status: "blocked",
            assigneeAgentId: agentB,
            blockedByIssueIds: [blockerId],
            unblockDescriptor: { owner: "board", action: "re-block with reassignment" },
          });
        expect(res.status, JSON.stringify(res.body)).toBe(200);

        await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));

        const dependent = await db
          .select({ blockedTransitionAt: issues.blockedTransitionAt, assigneeAgentId: issues.assigneeAgentId })
          .from(issues)
          .where(eq(issues.id, dependentId))
          .then((rows) => rows[0]);
        expect(dependent?.assigneeAgentId).toBe(agentB);
        const expectedStateKey = buildIssueBlockersResolvedWakeStateKey({
          dependentIssueId: dependentId,
          blockerIssueIds: [blockerId],
          blockedTransitionAt: dependent!.blockedTransitionAt,
        });
        const wakes = await listDependencyWakes(db, {
          companyId,
          dependentIssueId: dependentId,
          expectedStateKey,
        });
        expect(wakes, "an assignee change into blocked must wake the new assignee").toHaveLength(1);
        expect(wakes[0]?.agentId).toBe(agentB);
        expect(wakes[0]?.idempotencyKey).toBe(expectedStateKey);
      }
    },
  );

  it(
    "case E: a claimed wake from a different cycle does not dedup the current cycle (characterization)",
    { timeout: 120_000 },
    async () => {
      const { db } = ctx;

      // E1 — CURRENT behaviour: a `claimed` row under the CURRENT cycle's
      // state key covers the ready state, so the blocker-done path enqueues
      // nothing new and leaves the claimed row untouched.
      {
        const companyId = await seedCompany(db, "CaseE1");
        const agentA = await seedAgent(db, companyId, "Case E1 assignee");
        const blockerId = await seedIssue(db, {
          companyId,
          title: "Case E1 blocker",
          status: "todo",
        });
        const dependentId = await seedIssue(db, {
          companyId,
          title: "Case E1 dependent",
          status: "blocked",
          assigneeAgentId: agentA,
          blockedTransitionAt: T0,
        });
        await seedBlockerEdge(db, companyId, blockerId, dependentId);
        const currentCycleKey = buildIssueBlockersResolvedWakeStateKey({
          dependentIssueId: dependentId,
          blockerIssueIds: [blockerId],
          blockedTransitionAt: T0,
        });
        await seedClaimedDependencyWake(db, {
          companyId,
          agentId: agentA,
          dependentIssueId: dependentId,
          idempotencyKey: currentCycleKey,
          requestedAt: T0,
        });

        const res = await request(routeApp(db, boardActor(companyId)))
          .patch(`/api/issues/${blockerId}`)
          .send({ status: "done" });
        expect(res.status, JSON.stringify(res.body)).toBe(200);

        await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));

        const wakes = await listDependencyWakes(db, {
          companyId,
          dependentIssueId: dependentId,
          expectedStateKey: currentCycleKey,
        });
        expect(wakes, "a claimed wake of the current cycle must suppress a new wake").toHaveLength(1);
        expect(wakes[0]?.idempotencyKey).toBe(currentCycleKey);
        expect(wakes[0]?.status).toBe("claimed");
      }

      // E2 — CURRENT behaviour: a `claimed` row under a DIFFERENT cycle's key
      // (one hour later) does not cover, so the blocker-done path enqueues a
      // NEW wake under the current cycle's key and the old row stays claimed.
      {
        const companyId = await seedCompany(db, "CaseE2");
        const agentA = await seedAgent(db, companyId, "Case E2 assignee");
        const blockerId = await seedIssue(db, {
          companyId,
          title: "Case E2 blocker",
          status: "todo",
        });
        const dependentId = await seedIssue(db, {
          companyId,
          title: "Case E2 dependent",
          status: "blocked",
          assigneeAgentId: agentA,
          blockedTransitionAt: T0,
        });
        await seedBlockerEdge(db, companyId, blockerId, dependentId);
        const laterCycleKey = buildIssueBlockersResolvedWakeStateKey({
          dependentIssueId: dependentId,
          blockerIssueIds: [blockerId],
          blockedTransitionAt: ts(3_600),
        });
        await seedClaimedDependencyWake(db, {
          companyId,
          agentId: agentA,
          dependentIssueId: dependentId,
          idempotencyKey: laterCycleKey,
          requestedAt: ts(3_600),
        });

        const res = await request(routeApp(db, boardActor(companyId)))
          .patch(`/api/issues/${blockerId}`)
          .send({ status: "done" });
        expect(res.status, JSON.stringify(res.body)).toBe(200);

        await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));

        const currentCycleKey = buildIssueBlockersResolvedWakeStateKey({
          dependentIssueId: dependentId,
          blockerIssueIds: [blockerId],
          blockedTransitionAt: T0,
        });
        const fresh = await listDependencyWakes(db, {
          companyId,
          dependentIssueId: dependentId,
          expectedStateKey: currentCycleKey,
        });
        expect(
          fresh,
          "a new wake must be enqueued under the current cycle key",
        ).toHaveLength(1);
        const claimedRows = await listDependencyWakes(db, {
          companyId,
          dependentIssueId: dependentId,
          expectedStateKey: laterCycleKey,
        });
        const claimed = claimedRows[0] ?? null;
        expect(claimed, "the pre-existing different-cycle claimed row must be untouched").toBeDefined();
        expect(claimed?.status).toBe("claimed");
      }
    },
  );
});
