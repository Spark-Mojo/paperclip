import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  agentRuntimeState,
  budgetPolicies,
  companies,
  companyMemberships,
  companySkills,
  costEvents,
  createDb,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issueRecoveryActions,
  issueTreeHoldMembers,
  issueTreeHolds,
  issues,
  projects,
  projectWorkspaces,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Acknowledged liveness escalation.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: vi.fn(),
  };
});

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

import { heartbeatService } from "../services/heartbeat.ts";
import { attentionService } from "../services/attention.ts";
import { issueService } from "../services/issues.ts";
import { runningProcesses } from "../adapters/index.ts";
import {
  buildIssueBlockersResolvedWakeStateKey,
  buildIssueBlockersResolvedWakeStateKeyWithoutCycle,
} from "../services/issue-dependency-wakeups.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue liveness escalation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat resolved dependency wake reconciliation", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-issue-liveness-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_IN_WORKTREE", "false");
  });

  afterEach(async () => {
    // Dependency reconciliation heals missing wakes by enqueuing an
    // on-demand wake, which dispatches a heartbeat run fire-and-forget (see
    // startNextQueuedRunForAgent → executeRun in the heartbeat service). That
    // background run keeps writing rows (workspace_operations, heartbeat_run_events)
    // after the awaited call resolves. Deterministically await those in-flight
    // executions before clearing tables — otherwise an escaping heartbeat_run_events
    // insert can land between the events delete and the heartbeat_runs delete and
    // trip the run_events → runs foreign key.
    await heartbeatService(db).drainActiveRunExecutions();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    runningProcesses.clear();
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(costEvents);
    await db.delete(workspaceOperations);
    await db.delete(issueComments);
    await db.delete(issueTreeHoldMembers);
    await db.delete(issueTreeHolds);
    await db.delete(issueRelations);
    await db.delete(issueRecoveryActions);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  async function seedBlockedChain(opts: {
    outsideLookback?: boolean;
    blockerStatus?: string;
    blockerAssigneeAgentId?: "coder" | "manager" | null;
  } = {}) {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const blockedIssueId = randomUUID();
    const blockerIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
        permissions: {},
      },
    ]);

    const issueTimestamp = opts.outsideLookback === true
      ? new Date(Date.now() - 25 * 60 * 60 * 1000)
      : new Date(Date.now() - 60 * 60 * 1000);
    await db.insert(issues).values([
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked parent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: coderId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        createdAt: issueTimestamp,
        updatedAt: issueTimestamp,
      },
      {
        id: blockerIssueId,
        companyId,
        title: "Missing unblock owner",
        status: opts.blockerStatus ?? "todo",
        priority: "medium",
        assigneeAgentId: opts.blockerAssigneeAgentId === "coder"
          ? coderId
          : opts.blockerAssigneeAgentId === "manager"
            ? managerId
            : null,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
        createdAt: issueTimestamp,
        updatedAt: issueTimestamp,
      },
    ]);

    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    return { companyId, managerId, coderId, blockedIssueId, blockerIssueId };
  }

  async function seedResolvedDependencyBackstopFixture(opts: {
    workspaceState?: "none" | "not_finalized" | "finalized";
    assignee?: "agent" | null;
  } = {}) {
    const workspaceState = opts.workspaceState ?? "none";
    const companyId = randomUUID();
    const agentId = randomUUID();
    const ownerUserId = randomUUID();
    const blockedIssueId = randomUUID();
    const blockerIssueId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: ownerUserId,
      membershipRole: "owner",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Priya",
      role: "engineer",
      status: "idle",
      adapterType: "test_adapter",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    if (workspaceState !== "none") {
      await db.insert(projects).values({
        id: projectId,
        companyId,
        name: "Synthetic dependency project",
        status: "in_progress",
      });
      await db.insert(projectWorkspaces).values({
        id: projectWorkspaceId,
        companyId,
        projectId,
        name: "Synthetic workspace",
        sourceType: "git_worktree",
      });
      await db.insert(executionWorkspaces).values({
        id: executionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Synthetic execution workspace",
        providerType: "git_worktree",
      });
    }

    await db.insert(issues).values([
      {
        id: blockedIssueId,
        companyId,
        projectId: workspaceState === "none" ? null : projectId,
        title: "Synthetic blocked dependent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: opts.assignee === null ? null : agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: blockerIssueId,
        companyId,
        projectId: workspaceState === "none" ? null : projectId,
        title: "Synthetic completed blocker",
        status: "done",
        priority: "medium",
        executionWorkspaceId: workspaceState === "none" ? null : executionWorkspaceId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    if (workspaceState === "not_finalized") {
      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        issueId: blockerIssueId,
        phase: "adapter_execute",
        status: "succeeded",
        startedAt: new Date(Date.now() - 60_000),
      });
    } else if (workspaceState === "finalized") {
      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        issueId: blockerIssueId,
        phase: "workspace_finalize",
        status: "succeeded",
        startedAt: new Date(),
      });
    }

    return { companyId, agentId, blockedIssueId, blockerIssueId, executionWorkspaceId };
  }

  it("runs exactly one bounded review-path recovery before surfacing a stalled decision", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Review Recovery Co",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Review Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "PAP-14994 fingerprint",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const heartbeat = heartbeatService(db);
    const followUpRun = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: {
        issueId,
        interactionId: "superseded-confirmation",
        reviewPathLost: true,
        reviewPathConsumedRef: "superseded-confirmation",
      },
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_commented",
        interactionId: "superseded-confirmation",
        reviewPathLost: true,
        reviewPathConsumedRef: "superseded-confirmation",
      },
    });
    expect(followUpRun).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();

    const recoveryWakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.reason, "issue_review_path_lost"),
      ));
    expect(recoveryWakes).toHaveLength(1);
    expect(recoveryWakes[0]).toMatchObject({
      status: "completed",
      payload: expect.objectContaining({
        issueId,
        reviewPathConsumedRef: "superseded-confirmation",
        reviewPathRecoveryAttempt: 1,
        maxReviewPathRecoveryAttempts: 1,
      }),
    });

    const attention = await issueService(db)
      .listReviewAttention(companyId, [{ id: issueId, companyId, status: "in_review" }]);
    expect(attention.get(issueId)).toMatchObject({ state: "stalled", paths: [] });

    const feed = await attentionService(db).list(companyId, { userId: "responsible-user" });
    expect(feed.items.find((item) => item.subject.id === issueId)).toMatchObject({
      sourceKind: "review",
      decisionVerbs: expect.arrayContaining([
        expect.objectContaining({ id: "choose_review_path", label: "Choose review path" }),
      ]),
    });
  });

  it("keeps resolved dependency wake reconciliation active", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([blockedIssueId]);

    const wake = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);

    expect(wake?.reason).toBe("issue_blockers_resolved");
    expect(wake?.idempotencyKey).toBe(
      buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    );
    expect(["queued", "claimed", "completed"]).toContain(wake?.status);

    const events = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.blockers_resolved_wake_emitted")));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      entityId: blockedIssueId,
      details: expect.objectContaining({ source: "issue_graph_liveness.backstop" }),
    });
  });

  it("replays a crash-window todo dependent past 501 earlier dependency candidates exactly once", async () => {
    const { companyId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const earlierIds = Array.from({ length: 501 }, (_, index) =>
      `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`);
    const deferredAgentId = randomUUID();
    await db.insert(agents).values({
      id: deferredAgentId, companyId, name: "Deferred agent", role: "engineer",
      status: "idle", adapterType: "test_adapter", adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: false } }, permissions: {},
    });
    await db.insert(issues).values(earlierIds.map((id, index) => ({
      id, companyId, title: `Earlier todo ${index}`, status: "todo",
      priority: "medium", assigneeAgentId: deferredAgentId, issueNumber: index + 4,
      identifier: `R-EARLIER-${index + 4}`,
    })));
    await db.insert(issueRelations).values(earlierIds.map((id) => ({
      companyId, issueId: blockerIssueId, relatedIssueId: id, type: "blocks" as const,
    })));
    const child = spawn(process.execPath, [
      "--import", "tsx", "--input-type=module", "-e",
      `import { createDb, issues } from '@paperclipai/db';
       import { eq } from 'drizzle-orm';
       const db = createDb(process.env.REPLAY_DATABASE_URL);
       await db.update(issues).set({ status: 'todo', blockedTransitionAt: new Date() }).where(eq(issues.id, process.env.REPLAY_ISSUE_ID));
       process.stdout.write('TRANSITION_COMMITTED\\n');
       setInterval(() => {}, 1000);`,
    ], {
      cwd: new URL("../../", import.meta.url).pathname,
      env: { ...process.env, REPLAY_DATABASE_URL: tempDb!.connectionString, REPLAY_ISSUE_ID: blockedIssueId },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const childExit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    let errors = "";
    child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
    const barrier = new Promise<void>((resolve, reject) => {
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("TRANSITION_COMMITTED\n")) resolve();
      });
      child.on("error", reject);
      child.on("exit", (code) => reject(new Error(`transition process exited before barrier (${code}): ${errors}`)));
    });
    const bounded = async <T>(promise: Promise<T>, label: string) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out: ${errors}`)), 20_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      await bounded(barrier, "transition barrier");
    } finally {
      child.kill("SIGKILL");
      await bounded(childExit, "transition process exit");
    }
    expect((await db.select().from(issues).where(eq(issues.id, blockedIssueId)))[0]?.status).toBe("todo");
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(0);

    const heartbeat = heartbeatService(db);
    const firstPass = await heartbeat.reconcileResolvedDependencyWakes();
    expect(firstPass.checked).toBe(500);
    expect(firstPass.candidateLimitSkipped).toBeGreaterThan(0);
    expect(firstPass.issueIds).not.toContain(blockedIssueId);
    const restartedHeartbeat = heartbeatService(db);
    const restartedFirstPass = await restartedHeartbeat.reconcileResolvedDependencyWakes();
    expect(restartedFirstPass.issueIds).not.toContain(blockedIssueId);
    const passes = await Promise.all([
      restartedHeartbeat.reconcileResolvedDependencyWakes(),
      restartedHeartbeat.reconcileResolvedDependencyWakes(),
    ]);
    expect(passes.flatMap((pass) => pass.issueIds)).toContain(blockedIssueId);
    await heartbeatService(db).drainActiveRunExecutions();
    const wakes = await db.select().from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "issue_blockers_resolved")));
    expect(wakes.filter((wake) => (wake.payload as { issueId?: string }).issueId === blockedIssueId)).toHaveLength(1);
    expect(wakes[0]?.runId).not.toBeNull();
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(runs.filter((run) => run.wakeupRequestId === wakes[0]?.id)).toHaveLength(1);
    expect(runs.filter((run) => (run.contextSnapshot as { wakeReason?: string })?.wakeReason === "issue_blockers_resolved")).toHaveLength(1);
    expect(runs.filter((run) => (run.contextSnapshot as { wakeReason?: string })?.wakeReason === "finish_successful_run_handoff")).toHaveLength(1);
    expect(mockAdapterExecute).toHaveBeenCalledTimes(runs.length);
    expect(wakes[0]?.idempotencyKey).toBe(buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId: blockedIssueId, blockerIssueIds: [blockerIssueId],
      blockedTransitionAt: (await db.select().from(issues).where(eq(issues.id, blockedIssueId)))[0]?.blockedTransitionAt,
    }));
  }, 60_000);

  it("replays a todo dependent only after its blocker workspace finalizes", async () => {
    const { companyId, blockedIssueId, blockerIssueId, executionWorkspaceId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "not_finalized" });
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, blockedIssueId));
    expect((await heartbeatService(db).reconcileResolvedDependencyWakes()).healed).toBe(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toHaveLength(0);
    await db.insert(workspaceOperations).values({
      companyId, executionWorkspaceId, issueId: blockerIssueId,
      phase: "workspace_finalize", status: "succeeded", startedAt: new Date(),
    });
    expect((await heartbeatService(db).reconcileResolvedDependencyWakes()).issueIds).toContain(blockedIssueId);
  });

  it("rechecks reassignment and re-block before replaying a todo dependent", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    await db.update(issues).set({ status: "todo", assigneeAgentId: null }).where(eq(issues.id, blockedIssueId));
    expect((await heartbeatService(db).reconcileResolvedDependencyWakes()).healed).toBe(0);
    await db.update(issues).set({ assigneeAgentId: agentId }).where(eq(issues.id, blockedIssueId));
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, blockerIssueId));
    expect((await heartbeatService(db).reconcileResolvedDependencyWakes()).healed).toBe(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toHaveLength(0);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockerIssueId));
    expect((await heartbeatService(db).reconcileResolvedDependencyWakes()).issueIds).toContain(blockedIssueId);
  });

  it.each(["todo", "cancelled"] as const)("does not replay a todo dependent with a %s blocker", async (status) => {
    const { companyId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, blockedIssueId));
    await db.update(issues).set({ status }).where(eq(issues.id, blockerIssueId));
    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();
    expect(result.healed).toBe(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toHaveLength(0);
  });

  it("heals a blocked dependent whose done blocker has no workspace finalize obligation", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([blockedIssueId]);

    const wake = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);

    expect(wake?.reason).toBe("issue_blockers_resolved");
    expect(wake?.idempotencyKey).toBe(
      buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    );
    expect(["queued", "claimed", "completed"]).toContain(wake?.status);

    const events = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.blockers_resolved_wake_emitted")));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ entityId: blockedIssueId });
  });

  it("reconciles a resolved blocked dependency after the assignee-null window closes", async () => {
    const { agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none", assignee: null });
    const heartbeat = heartbeatService(db);

    const beforeAssignment = await heartbeat.reconcileResolvedDependencyWakes();

    expect(beforeAssignment.healed).toBe(0);
    expect(beforeAssignment.checked).toBe(0);

    await db
      .update(issues)
      .set({ assigneeAgentId: agentId, updatedAt: new Date() })
      .where(eq(issues.id, blockedIssueId));

    const afterAssignment = await heartbeat.reconcileResolvedDependencyWakes();

    expect(afterAssignment.healed).toBe(1);
    expect(afterAssignment.issueIds).toEqual([blockedIssueId]);

    const wake = await db
      .select({
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);
    expect(wake).toMatchObject({
      reason: "issue_blockers_resolved",
      idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    });
  });

  async function seedExecutionWait(status: "active" | "resolved" = "resolved") {
    const fixture = await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId: fixture.companyId, sourceIssueId: fixture.blockedIssueId,
      kind: "active_run_watchdog", ownerType: "board", returnOwnerAgentId: fixture.agentId,
      cause: "legacy_execution_requires_reconciliation", status,
      evidence: status === "resolved" ? { automaticRecovery: { replay: "blocked" } } : {},
      fingerprint: randomUUID(), nextAction: "Check the stopped execution before resuming.",
    }).returning();
    return { ...fixture, action: action! };
  }

  it.each(["active", "resolved"] as const)("keeps repeated wakes behind a %s execution hold run-free, then resumes once", async (status) => {
    const { companyId, agentId, blockedIssueId, action } = await seedExecutionWait(status);
    const heartbeat = heartbeatService(db);
    // Different producers and wake keys must not create new attempts or notices.
    await Promise.all(Array.from({ length: 6 }, (_, i) => heartbeat.wakeup(agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_continuation_needed",
      requestedByActorType: "system", requestedByActorId: "wait-regression",
      idempotencyKey: `producer-${i}`, payload: { issueId: blockedIssueId },
      contextSnapshot: { issueId: blockedIssueId },
    })));
    for (let i = 0; i < 3; i++) {
      // Recreate the service to prove the wait is durable across scheduler restarts.
      expect((await heartbeatService(db).reconcileResolvedDependencyWakes()).healed).toBe(0);
    }
    const waits = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({
      status: "skipped", runId: null, reason: "execution_reconciliation_required", coalescedCount: 8,
      payload: { issueId: blockedIssueId, executionWait: { recoveryActionId: action.id } },
    });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(0);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect(await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.blockers_resolved_wake_emitted"),
    ))).toHaveLength(0);

    mockAdapterExecute.mockImplementationOnce(async () => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockedIssueId));
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
        summary: "Finished the dependency-ready task.", provider: "test", model: "test-model" };
    });
    await db.update(issueRecoveryActions).set({ status: "resolved", evidence: {} }).where(eq(issueRecoveryActions.id, action.id));
    expect((await heartbeat.reconcileResolvedDependencyWakes()).healed).toBe(1);
    expect((await heartbeat.reconcileResolvedDependencyWakes()).healed).toBe(0);
    await heartbeat.drainActiveRunExecutions();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(1);
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  });

  it("rechecks every gate after an execution hold clears", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId, action } = await seedExecutionWait();
    const wake = () => heartbeatService(db).wakeup(agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_continuation_needed",
      requestedByActorType: "system", requestedByActorId: "wait-regression",
      payload: { issueId: blockedIssueId }, contextSnapshot: { issueId: blockedIssueId },
    });
    await wake();
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, blockerIssueId));
    await db.update(issueRecoveryActions).set({ evidence: {} }).where(eq(issueRecoveryActions.id, action.id));
    await wake();
    await wake();
    const waits = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(waits).toHaveLength(2);
    expect(waits.find((row) => row.reason === "issue_dependencies_blocked")?.coalescedCount).toBe(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(0);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockerIssueId));
    expect((await heartbeatService(db).reconcileResolvedDependencyWakes()).healed).toBe(1);
  });

  it("preserves distinct comments through a hold and adopts them on the next eligible wake", async () => {
    const { companyId, agentId, blockedIssueId, action } = await seedExecutionWait();
    const heartbeat = heartbeatService(db);
    const commentIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const [comment] = await db.insert(issueComments).values({
        companyId, issueId: blockedIssueId, authorUserId: "board-user", body: `Follow-up ${i}`,
      }).returning();
      commentIds.push(comment!.id);
      expect(await heartbeat.wakeup(agentId, {
        source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
        requestedByActorType: "user", requestedByActorId: "board-user",
        payload: { issueId: blockedIssueId, commentId: comment!.id },
        contextSnapshot: { issueId: blockedIssueId, wakeReason: "issue_commented", wakeCommentId: comment!.id },
      })).toBeNull();
    }
    const deferred = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(deferred).toHaveLength(2);
    expect(deferred.every((row) => row.status === "deferred_issue_execution" && row.runId === null)).toBe(true);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(0);
    await db.update(issueRecoveryActions).set({ evidence: {} }).where(eq(issueRecoveryActions.id, action.id));
    const resumed = await heartbeat.wakeup(agentId, {
      source: "on_demand", triggerDetail: "manual", reason: "issue_resumed",
      requestedByActorType: "user", requestedByActorId: "board-user",
      payload: { issueId: blockedIssueId }, contextSnapshot: { issueId: blockedIssueId },
    });
    expect(resumed?.contextSnapshot?.wakeCommentIds).toEqual(commentIds);
    const receipts = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(receipts.filter((row) => row.status === "coalesced")).toHaveLength(2);
  });

  it("retries a resolved dependency wake when the prior wake was skipped as stale", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    // The route-time wake writes the level-triggered state key. A skip records a
    // `skipped` row with that key. `skipped` is not an in-flight status, so the
    // backstop must still re-emit for the same ready state.
    const idempotencyKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId: blockedIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIssueId,
        blockerIssueIds: [blockerIssueId],
      },
      status: "skipped",
      finishedAt: new Date(),
      error: "Cancelled because issue assignee changed before the queued run could start",
      idempotencyKey,
    });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.existingWakeSkipped).toBe(0);

    const wakes = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "issue_blockers_resolved")))
      .orderBy(agentWakeupRequests.requestedAt);

    expect(wakes).toHaveLength(2);
    expect(wakes.map((wake) => wake.status)).toContain("skipped");
    expect(wakes.every((wake) => wake.idempotencyKey === idempotencyKey)).toBe(true);
    expect(wakes.some((wake) => ["queued", "claimed", "completed"].includes(wake.status))).toBe(true);
  });

  it("waits for workspace finalize before healing a resolved blocked dependent", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId, executionWorkspaceId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "not_finalized" });
    const heartbeat = heartbeatService(db);

    const beforeFinalize = await heartbeat.reconcileResolvedDependencyWakes();

    expect(beforeFinalize.healed).toBe(0);
    expect(beforeFinalize.notReadySkipped).toBe(1);

    const wakesBeforeFinalize = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakesBeforeFinalize).toHaveLength(0);

    await db.insert(workspaceOperations).values({
      companyId,
      executionWorkspaceId,
      issueId: blockerIssueId,
      phase: "workspace_finalize",
      status: "succeeded",
      startedAt: new Date(),
    });

    const afterFinalize = await heartbeat.reconcileResolvedDependencyWakes();

    expect(afterFinalize.healed).toBe(1);
    expect(afterFinalize.issueIds).toEqual([blockedIssueId]);

    const wake = await db
      .select({
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);
    expect(wake).toMatchObject({
      reason: "issue_blockers_resolved",
      idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    });
  });

  it("does not duplicate an existing dependency wake keyed to any resolved blocker", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const secondBlockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: secondBlockerIssueId,
      companyId,
      title: "Second completed blocker",
      status: "done",
      priority: "medium",
      issueNumber: 3,
      identifier: "R-MULTI-3",
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: secondBlockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    const readiness = await issueService(db).getDependencyReadiness(blockedIssueId);
    const blockerIdNotUsedByBackstop = readiness.blockerIssueIds.find((id) => id !== blockerIssueId);
    if (!blockerIdNotUsedByBackstop) {
      throw new Error("Expected a second blocker id in dependency readiness");
    }
    expect(blockerIdNotUsedByBackstop).toBe(secondBlockerIssueId);
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIdNotUsedByBackstop,
      },
      status: "queued",
      idempotencyKey: `issue_blockers_resolved:${blockedIssueId}:${blockerIdNotUsedByBackstop}`,
    });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(0);
    expect(result.existingWakeSkipped).toBe(1);

    const wakes = await db
      .select({
        id: agentWakeupRequests.id,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "issue_blockers_resolved")));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.idempotencyKey).toBe(
      `issue_blockers_resolved:${blockedIssueId}:${blockerIdNotUsedByBackstop}`,
    );
  });

  it("heals a multi-blocker dependent when only a completed wake for an earlier blocker exists", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const secondBlockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: secondBlockerIssueId,
      companyId,
      title: "Earlier completed blocker",
      status: "done",
      priority: "medium",
      issueNumber: 3,
      identifier: "R-MULTI-3",
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: secondBlockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    // An earlier partial resolution left a `completed` per-edge wake. The bug was
    // that this stale wake suppressed the wake for the current ready state. The
    // level-triggered dedup keys on the full blocker set, so this completed wake
    // no longer strands the dependent.
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: secondBlockerIssueId,
      },
      status: "completed",
      finishedAt: new Date(),
      idempotencyKey: `issue_blockers_resolved:${blockedIssueId}:${secondBlockerIssueId}`,
    });

    const readiness = await issueService(db).getDependencyReadiness(blockedIssueId);
    expect(readiness.isDependencyReady).toBe(true);

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([blockedIssueId]);
    expect(result.existingWakeSkipped).toBe(0);

    const stateKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId: blockedIssueId,
      blockerIssueIds: readiness.blockerIssueIds,
    });
    const healedWake = await db
      .select({ status: agentWakeupRequests.status, idempotencyKey: agentWakeupRequests.idempotencyKey })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.idempotencyKey, stateKey)))
      .then((rows) => rows[0] ?? null);
    expect(healedWake).not.toBeNull();
    expect(["queued", "claimed", "completed"]).toContain(healedWake?.status);

    // A second reconciliation pass finds the state-key wake and stays bounded:
    // it heals nothing more and never enqueues a second wake for the same state.
    const secondPass = await heartbeatService(db).reconcileResolvedDependencyWakes();
    expect(secondPass.healed).toBe(0);

    const stateKeyWakes = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.idempotencyKey, stateKey)));
    expect(stateKeyWakes).toHaveLength(1);
  });

  it("heals a blocked dependent after a terminal reset when a previous-cycle old-key wake exists", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const previousCycleWakeAt = new Date("2026-07-01T12:00:00.000Z");
    const blockedTransitionAt = new Date("2026-08-01T12:00:00.000Z");
    await db
      .update(issues)
      .set({ blockedTransitionAt, updatedAt: blockedTransitionAt })
      .where(eq(issues.id, blockedIssueId));
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIssueId,
        blockerIssueIds: [blockerIssueId],
      },
      status: "completed",
      finishedAt: previousCycleWakeAt,
      requestedAt: previousCycleWakeAt,
      idempotencyKey: buildIssueBlockersResolvedWakeStateKeyWithoutCycle({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([blockedIssueId]);
    expect(result.existingWakeSkipped).toBe(0);

    const cycleKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId: blockedIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt,
    });
    const healedWake = await db
      .select({ status: agentWakeupRequests.status, idempotencyKey: agentWakeupRequests.idempotencyKey })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.idempotencyKey, cycleKey)))
      .then((rows) => rows[0] ?? null);
    expect(healedWake).not.toBeNull();
    expect(["queued", "claimed", "completed"]).toContain(healedWake?.status);

    const secondPass = await heartbeatService(db).reconcileResolvedDependencyWakes();
    expect(secondPass.healed).toBe(0);

    const cycleKeyWakes = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.idempotencyKey, cycleKey)));
    expect(cycleKeyWakes).toHaveLength(1);
  });

  it("does not re-heal when a completed old-key wake is from the current blocked cycle", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const blockedTransitionAt = new Date("2026-08-01T12:00:00.000Z");
    const sameCycleWakeAt = new Date("2026-08-01T12:00:01.000Z");
    await db
      .update(issues)
      .set({ blockedTransitionAt, updatedAt: blockedTransitionAt })
      .where(eq(issues.id, blockedIssueId));
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIssueId,
        blockerIssueIds: [blockerIssueId],
      },
      status: "completed",
      finishedAt: sameCycleWakeAt,
      requestedAt: sameCycleWakeAt,
      idempotencyKey: buildIssueBlockersResolvedWakeStateKeyWithoutCycle({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(0);
    expect(result.existingWakeSkipped).toBe(1);
  });

  it("counts null dependency wake returns as deferred instead of enqueue failures", async () => {
    const { companyId, agentId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    await db
      .update(agents)
      .set({
        runtimeConfig: { heartbeat: { wakeOnDemand: false, maxConcurrentRuns: 1 } },
      })
      .where(eq(agents.id, agentId));

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(0);
    expect(result.deferredOrFailed).toBe(1);
    expect(result.enqueueFailed).toBe(0);

    const skippedWake = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
      })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId)))
      .then((rows) => rows[0] ?? null);
    expect(skippedWake).toMatchObject({
      status: "skipped",
      reason: "heartbeat.wakeOnDemand.disabled",
    });
  });

  // SPA-10513, slice 1. An idle agent with an assigned `todo` card should pull
  // it instead of sitting on it until a human nudges the board. The pull is
  // metered by the fleet cap, is idempotent per dispatch state, and must never
  // reach parked/backlog, blocked, user-assigned, or already-running work.
  describe("idle todo pull (SPA-10513)", () => {
    const CANARY_ENV_VAR = "PAPERCLIP_IDLE_TODO_PULL";

    async function seedIdleTodoPullFixture(opts: {
      wakeOnDemand?: boolean;
      maxConcurrentRuns?: number;
      fleetMaxConcurrentRuns?: number;
    } = {}) {
      const companyId = randomUUID();
      const ownerUserId = randomUUID();
      const idleAgentId = randomUUID();
      const issuePrefix = `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
        fleetMaxConcurrentRuns: opts.fleetMaxConcurrentRuns ?? null,
      });
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: ownerUserId,
        membershipRole: "owner",
        status: "active",
      });
      await db.insert(agents).values({
        id: idleAgentId,
        companyId,
        name: "Idle Worker",
        role: "engineer",
        status: "idle",
        adapterType: "test_adapter",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            wakeOnDemand: opts.wakeOnDemand ?? true,
            maxConcurrentRuns: opts.maxConcurrentRuns ?? 1,
          },
        },
        permissions: {},
      });

      return { companyId, ownerUserId, idleAgentId, issuePrefix };
    }

    // Priority then age: a `high` card must beat an older `medium` one, and two
    // same-priority cards are taken oldest-first. One test asserts the whole
    // ordering because the card requirement is a single ordered rule.
    it("idle todo pull takes the highest-priority then oldest eligible assigned card", async () => {
      const { companyId, idleAgentId, issuePrefix } = await seedIdleTodoPullFixture();
      const mediumOldId = randomUUID();
      const mediumNewId = randomUUID();
      const highOldId = randomUUID();
      const mediumOldCreatedAt = new Date("2026-01-01T00:00:00.000Z");
      const mediumNewCreatedAt = new Date("2026-02-01T00:00:00.000Z");

      await db.insert(issues).values([
        {
          id: mediumOldId,
          companyId,
          title: "Older medium card",
          status: "todo",
          priority: "medium",
          assigneeAgentId: idleAgentId,
          issueNumber: 1,
          identifier: `${issuePrefix}-1`,
          createdAt: mediumOldCreatedAt,
          updatedAt: mediumOldCreatedAt,
        },
        {
          id: mediumNewId,
          companyId,
          title: "Newer medium card",
          status: "todo",
          priority: "medium",
          assigneeAgentId: idleAgentId,
          issueNumber: 2,
          identifier: `${issuePrefix}-2`,
          createdAt: mediumNewCreatedAt,
          updatedAt: mediumNewCreatedAt,
        },
        {
          id: highOldId,
          companyId,
          title: "Old but high priority card",
          status: "todo",
          priority: "high",
          assigneeAgentId: idleAgentId,
          issueNumber: 3,
          identifier: `${issuePrefix}-3`,
          createdAt: new Date("2025-12-01T00:00:00.000Z"),
          updatedAt: mediumOldCreatedAt,
        },
      ]);

      const result = await heartbeatService(db, {
        runtimeEnv: { [CANARY_ENV_VAR]: "true" },
      }).pullIdleAgentTodoIssues();

      expect(result.pulled).toBe(1);
      expect(result.issueIds).toEqual([highOldId]);

      const pulledWake = await db
        .select({
          status: agentWakeupRequests.status,
          payload: agentWakeupRequests.payload,
        })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.agentId, idleAgentId),
            eq(agentWakeupRequests.reason, "idle_todo_pull"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      expect(pulledWake).not.toBeNull();
      expect(pulledWake?.payload).toMatchObject({ issueId: highOldId });

      // Exactly one card is pulled per idle agent per sweep: the agent has one
      // free slot, so the remaining todo cards stay queued for later sweeps.
      const allPullWakes = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.agentId, idleAgentId),
            eq(agentWakeupRequests.reason, "idle_todo_pull"),
          ),
        );
      expect(allPullWakes).toHaveLength(1);

      // Re-running the sweep while the pull is still live must not dispatch a
      // second run for the same card (idempotence on the live dispatch path).
      // The agent's single slot is now consumed by the first pull, so the
      // second pass stands down on the meter rather than dispatching again.
      const secondPass = await heartbeatService(db, {
        runtimeEnv: { [CANARY_ENV_VAR]: "true" },
      }).pullIdleAgentTodoIssues();
      expect(secondPass.pulled).toBe(0);
      expect(
        secondPass.capExhausted +
          secondPass.livePathSkipped +
          secondPass.duplicateSkipped,
      ).toBeGreaterThanOrEqual(1);

      const afterSecondPass = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.agentId, idleAgentId),
            eq(agentWakeupRequests.reason, "idle_todo_pull"),
          ),
        );
      expect(afterSecondPass).toHaveLength(1);
    });

    it("idle todo pull is default-off and reversible when the canary env is unset", async () => {
      const { companyId, idleAgentId, issuePrefix } = await seedIdleTodoPullFixture();
      const todoIssueId = randomUUID();
      await db.insert(issues).values({
        id: todoIssueId,
        companyId,
        title: "Unclaimed todo card",
        status: "todo",
        priority: "medium",
        assigneeAgentId: idleAgentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });

      const result = await heartbeatService(db).pullIdleAgentTodoIssues();

      expect(result.enabled).toBe(false);
      expect(result.pulled).toBe(0);
      expect(result.checked).toBe(0);

      const wakes = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, companyId));
      expect(wakes).toHaveLength(0);
    });

    it("idle todo pull skips parked backlog, blocked, user-assigned and active-run cards", async () => {
      const { companyId, ownerUserId, idleAgentId, issuePrefix } =
        await seedIdleTodoPullFixture({ maxConcurrentRuns: 2 });
      const backlogParkedId = randomUUID();
      const blockedId = randomUUID();
      const userAssignedId = randomUUID();
      const activeRunId = randomUUID();
      const activeRunTodoId = randomUUID();
      const eligibleId = randomUUID();
      const blockerId = randomUUID();

      await db.insert(issues).values([
        {
          id: backlogParkedId,
          companyId,
          title: "Parked in backlog",
          status: "backlog",
          priority: "critical",
          assigneeAgentId: idleAgentId,
          issueNumber: 1,
          identifier: `${issuePrefix}-1`,
        },
        {
          id: blockedId,
          companyId,
          title: "Blocked by an open blocker",
          status: "blocked",
          priority: "critical",
          assigneeAgentId: idleAgentId,
          issueNumber: 2,
          identifier: `${issuePrefix}-2`,
        },
        {
          id: userAssignedId,
          companyId,
          title: "Owned by a human",
          status: "todo",
          priority: "critical",
          assigneeUserId: ownerUserId,
          issueNumber: 3,
          identifier: `${issuePrefix}-3`,
        },
        {
          id: activeRunId,
          companyId,
          title: "Already running",
          status: "in_progress",
          priority: "critical",
          assigneeAgentId: idleAgentId,
          issueNumber: 4,
          identifier: `${issuePrefix}-4`,
        },
        {
          id: activeRunTodoId,
          companyId,
          title: "Todo card already covered by a live run",
          status: "todo",
          priority: "high",
          assigneeAgentId: idleAgentId,
          issueNumber: 5,
          identifier: `${issuePrefix}-5`,
        },
        {
          id: eligibleId,
          companyId,
          title: "Genuinely idle todo card",
          status: "todo",
          priority: "low",
          assigneeAgentId: idleAgentId,
          issueNumber: 6,
          identifier: `${issuePrefix}-6`,
        },
        {
          id: blockerId,
          companyId,
          title: "Open blocker for the blocked card",
          status: "todo",
          priority: "medium",
          assigneeAgentId: null,
          issueNumber: 7,
          identifier: `${issuePrefix}-7`,
        },
      ]);
      await db.insert(issueRelations).values({
        companyId,
        issueId: blockerId,
        relatedIssueId: blockedId,
        type: "blocks",
      });
      // A live `running` run naming a `todo` card is the active-run duplicate
      // guard: the card looks idle by status alone but already has an
      // execution path, so it must never be pulled again.
      await db.insert(heartbeatRuns).values({
        companyId,
        agentId: idleAgentId,
        invocationSource: "automation",
        status: "running",
        contextSnapshot: { issueId: activeRunTodoId },
      });

      const result = await heartbeatService(db, {
        runtimeEnv: { [CANARY_ENV_VAR]: "true" },
      }).pullIdleAgentTodoIssues();

      // Backlog, blocked, human-owned and already-running cards are all skipped,
      // and only the low-priority genuinely idle card is pulled.
      expect(result.pulled).toBe(1);
      expect(result.issueIds).toEqual([eligibleId]);
      expect(result.livePathSkipped).toBe(1);
      // The backlog, blocked and human-owned cards never reach the candidate
      // set at all, and the unassigned blocker is not an agent's work, so the
      // only candidates are the live-run card and the genuinely idle card.
      expect(result.checked).toBe(2);

      const pulledPayloads = await db
        .select({ payload: agentWakeupRequests.payload })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.reason, "idle_todo_pull"),
          ),
        );
      expect(pulledPayloads).toHaveLength(1);
      expect(pulledPayloads[0]?.payload).toMatchObject({ issueId: eligibleId });
    });

    it("idle todo pull respects per-agent concurrency and the fleet cap", async () => {
      const { companyId, idleAgentId, issuePrefix } = await seedIdleTodoPullFixture({
        maxConcurrentRuns: 1,
      });
      const runningIssueId = randomUUID();
      const todoIssueId = randomUUID();
      await db.insert(issues).values([
        {
          id: runningIssueId,
          companyId,
          title: "Card consuming the agent's only slot",
          status: "in_progress",
          priority: "medium",
          assigneeAgentId: idleAgentId,
          issueNumber: 1,
          identifier: `${issuePrefix}-1`,
        },
        {
          id: todoIssueId,
          companyId,
          title: "Todo card with no free slot",
          status: "todo",
          priority: "medium",
          assigneeAgentId: idleAgentId,
          issueNumber: 2,
          identifier: `${issuePrefix}-2`,
        },
      ]);
      // A live running run fills the agent's single concurrency slot, so the
      // metered pull must stand down even though a todo card is eligible.
      await db.insert(heartbeatRuns).values({
        companyId,
        agentId: idleAgentId,
        invocationSource: "automation",
        status: "running",
        contextSnapshot: { issueId: runningIssueId },
      });

      const result = await heartbeatService(db, {
        runtimeEnv: { [CANARY_ENV_VAR]: "true" },
      }).pullIdleAgentTodoIssues();

      expect(result.pulled).toBe(0);
      expect(result.capExhausted).toBe(1);

      const wakes = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, companyId));
      expect(wakes).toHaveLength(0);
    });
  });

  // SPA-10513, slice 3. Closing the LAST blocker of a blocked dependent must
  // hand that dependent back to the queue: the card moves blocked -> todo and
  // its assignee is woken exactly once. The wake alone was not enough — a
  // dependent left in `blocked` with every blocker done is invisible to the
  // idle-pull sweep (which only reads `todo`), so the card silently never
  // drains. The transition must be narrow: an open blocker, an unfinished
  // workspace finalize obligation, a backlog park, a conversation container, a
  // terminal card, and a non-agent assignee all keep their current status.
  describe("last blocker auto-unblock (SPA-10513)", () => {
    const CANARY_ENV_VAR = "PAPERCLIP_AUTO_UNBLOCK_READY_DEPENDENTS";

    async function seedAutoUnblockFixture(opts: {
      workspaceState?: "none" | "not_finalized";
      dependentStatus?: string;
      dependentAssignee?: "agent" | null;
    } = {}) {
      const workspaceState = opts.workspaceState ?? "none";
      const companyId = randomUUID();
      const agentId = randomUUID();
      const ownerUserId = randomUUID();
      const blockedIssueId = randomUUID();
      const blockerIssueId = randomUUID();
      const projectId = randomUUID();
      const projectWorkspaceId = randomUUID();
      const executionWorkspaceId = randomUUID();
      const issuePrefix = `U${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: ownerUserId,
        membershipRole: "owner",
        status: "active",
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Priya",
        role: "engineer",
        status: "idle",
        adapterType: "test_adapter",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      });

      if (workspaceState !== "none") {
        await db.insert(projects).values({
          id: projectId,
          companyId,
          name: "Synthetic auto-unblock project",
          status: "in_progress",
        });
        await db.insert(projectWorkspaces).values({
          id: projectWorkspaceId,
          companyId,
          projectId,
          name: "Synthetic workspace",
          sourceType: "git_worktree",
        });
        await db.insert(executionWorkspaces).values({
          id: executionWorkspaceId,
          companyId,
          projectId,
          projectWorkspaceId,
          mode: "isolated_workspace",
          strategyType: "git_worktree",
          name: "Synthetic execution workspace",
          providerType: "git_worktree",
        });
      }

      await db.insert(issues).values([
        {
          id: blockedIssueId,
          companyId,
          projectId: workspaceState === "none" ? null : projectId,
          title: "Synthetic blocked dependent",
          status: opts.dependentStatus ?? "blocked",
          priority: "medium",
          unblockDescriptor: { owner: { agentId }, action: "Wait for the blocker" },
          assigneeAgentId: opts.dependentAssignee === null ? null : agentId,
          issueNumber: 1,
          identifier: `${issuePrefix}-1`,
        },
        {
          id: blockerIssueId,
          companyId,
          projectId: workspaceState === "none" ? null : projectId,
          title: "Synthetic completed blocker",
          status: "done",
          priority: "medium",
          executionWorkspaceId: workspaceState === "none" ? null : executionWorkspaceId,
          issueNumber: 2,
          identifier: `${issuePrefix}-2`,
        },
      ]);
      await db.insert(issueRelations).values({
        companyId,
        issueId: blockerIssueId,
        relatedIssueId: blockedIssueId,
        type: "blocks",
      });

      if (workspaceState === "not_finalized") {
        await db.insert(workspaceOperations).values({
          companyId,
          executionWorkspaceId,
          issueId: blockerIssueId,
          phase: "adapter_execute",
          status: "succeeded",
          startedAt: new Date(Date.now() - 60_000),
        });
      }

      return {
        companyId,
        agentId,
        ownerUserId,
        blockedIssueId,
        blockerIssueId,
        executionWorkspaceId,
        issuePrefix,
      };
    }

    function autoUnblockHeartbeat() {
      return heartbeatService(db, { runtimeEnv: { [CANARY_ENV_VAR]: "true", PAPERCLIP_IDLE_TODO_PULL: "true" } });
    }

    async function dependentStatusById(issueIds: string[]) {
      const rows = await db
        .select({ id: issues.id, status: issues.status })
        .from(issues)
        .where(inArray(issues.id, issueIds));
      return new Map(rows.map((row) => [row.id, row.status]));
    }

    it("last blocker auto-unblock moves a blocked dependent to todo and wakes it once", async () => {
      const { companyId, agentId, blockedIssueId, blockerIssueId } =
        await seedAutoUnblockFixture();

      const result = await autoUnblockHeartbeat().autoUnblockReadyDependents(blockerIssueId);

      expect(result.enabled).toBe(true);
      expect(result.unblocked).toBe(1);
      expect(result.issueIds).toEqual([blockedIssueId]);
      expect(result.deferredOrFailed).toBe(0);

      const flipped = await db
        .select({ status: issues.status, blockedTransitionAt: issues.blockedTransitionAt, unblockDescriptor: issues.unblockDescriptor })
        .from(issues)
        .where(eq(issues.id, blockedIssueId))
        .then((rows) => rows[0] ?? null);
      expect(flipped?.status).toBe("todo");
      // Leaving `blocked` clears the blocked-cycle stamp, which is the epoch the
      // wake idempotency key binds to.
      expect(flipped?.blockedTransitionAt).toBeNull();
      expect(flipped?.unblockDescriptor).toBeNull();

      const wakes = await db
        .select({
          reason: agentWakeupRequests.reason,
          idempotencyKey: agentWakeupRequests.idempotencyKey,
          payload: agentWakeupRequests.payload,
        })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.agentId, agentId),
          ),
        );
      expect(wakes).toHaveLength(1);
      expect(wakes[0]?.reason).toBe("issue_blockers_resolved");
      expect(wakes[0]?.idempotencyKey).toBe(
        buildIssueBlockersResolvedWakeStateKey({
          dependentIssueId: blockedIssueId,
          blockerIssueIds: [blockerIssueId],
        }),
      );
      expect(wakes[0]?.payload).toMatchObject({
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIssueId,
      });

      // A second sweep over the same final blocker state is a no-op: the card is
      // already `todo`, so there is nothing to transition and the level-keyed
      // wake already covers this ready state.
      const repeat = await autoUnblockHeartbeat().autoUnblockReadyDependents(blockerIssueId);
      expect(repeat.unblocked).toBe(0);
      expect(repeat.issueIds).toEqual([]);

      const wakesAfterRepeat = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, companyId));
      expect(wakesAfterRepeat).toHaveLength(1);

      const statusAfterRepeat = await db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, blockedIssueId))
        .then((rows) => rows[0] ?? null);
      expect(statusAfterRepeat?.status).toBe("todo");
    });

    it("last blocker auto-unblock leaves open blockers, backlog parks, terminal, conversation and non-agent dependents unchanged", async () => {
      const {
        companyId,
        agentId,
        ownerUserId,
        blockedIssueId,
        blockerIssueId,
        issuePrefix,
      } = await seedAutoUnblockFixture();
      const eligibleId = randomUUID();
      const openBlockerDependentId = randomUUID();
      const cancelledBlockerDependentId = randomUUID();
      const cancelledBlockerId = randomUUID();
      const backlogParkDependentId = randomUUID();
      const terminalDependentId = randomUUID();
      const conversationDependentId = randomUUID();
      const userOwnedDependentId = randomUUID();
      const unassignedDependentId = randomUUID();
      const openBlockerId = randomUUID();
      const conversationBlockerId = randomUUID();

      await db.insert(issues).values([
        {
          id: eligibleId,
          companyId,
          title: "Another blocked dependent on the same done blocker",
          status: "blocked",
          priority: "medium",
          assigneeAgentId: agentId,
          issueNumber: 3,
          identifier: `${issuePrefix}-3`,
        },
        {
          id: openBlockerDependentId,
          companyId,
          title: "Dependent with one blocker still open",
          status: "blocked",
          priority: "medium",
          assigneeAgentId: agentId,
          issueNumber: 4,
          identifier: `${issuePrefix}-4`,
        },
        {
          id: openBlockerId,
          companyId,
          title: "Still-open blocker",
          status: "in_progress",
          priority: "medium",
          issueNumber: 5,
          identifier: `${issuePrefix}-5`,
        },
        {
          id: cancelledBlockerDependentId,
          companyId,
          title: "Dependent with a cancelled blocker",
          status: "blocked",
          priority: "medium",
          assigneeAgentId: agentId,
          issueNumber: 12,
          identifier: `${issuePrefix}-12`,
        },
        {
          id: cancelledBlockerId,
          companyId,
          title: "Cancelled blocker",
          status: "cancelled",
          priority: "medium",
          issueNumber: 13,
          identifier: `${issuePrefix}-13`,
        },
        {
          id: backlogParkDependentId,
          companyId,
          title: "Dependent parked in backlog",
          status: "backlog",
          priority: "medium",
          assigneeAgentId: agentId,
          issueNumber: 6,
          identifier: `${issuePrefix}-6`,
        },
        {
          id: terminalDependentId,
          companyId,
          title: "Terminal dependent on a done blocker",
          status: "done",
          priority: "medium",
          assigneeAgentId: agentId,
          issueNumber: 7,
          identifier: `${issuePrefix}-7`,
        },
        {
          id: conversationDependentId,
          companyId,
          title: "Conversation container blocked by the done blocker",
          status: "blocked",
          priority: "medium",
          assigneeAgentId: agentId,
          conversationAgentId: agentId,
          conversationUserId: ownerUserId,
          conversationState: "waiting",
          issueNumber: 8,
          identifier: `${issuePrefix}-8`,
        },
        {
          id: userOwnedDependentId,
          companyId,
          title: "Human-owned dependent",
          status: "blocked",
          priority: "medium",
          assigneeUserId: ownerUserId,
          issueNumber: 9,
          identifier: `${issuePrefix}-9`,
        },
        {
          id: unassignedDependentId,
          companyId,
          title: "Unassigned dependent",
          status: "blocked",
          priority: "medium",
          issueNumber: 10,
          identifier: `${issuePrefix}-10`,
        },
        {
          id: conversationBlockerId,
          companyId,
          title: "Second completed blocker for the conversation container",
          status: "done",
          priority: "medium",
          issueNumber: 11,
          identifier: `${issuePrefix}-11`,
        },
      ]);
      await db.insert(issueRelations).values([
        {
          companyId,
          issueId: blockerIssueId,
          relatedIssueId: eligibleId,
          type: "blocks",
        },
        {
          companyId,
          issueId: openBlockerId,
          relatedIssueId: openBlockerDependentId,
          type: "blocks",
        },
        {
          companyId,
          issueId: blockerIssueId,
          relatedIssueId: cancelledBlockerDependentId,
          type: "blocks",
        },
        {
          companyId,
          issueId: cancelledBlockerId,
          relatedIssueId: cancelledBlockerDependentId,
          type: "blocks",
        },
        {
          companyId,
          issueId: blockerIssueId,
          relatedIssueId: backlogParkDependentId,
          type: "blocks",
        },
        {
          companyId,
          issueId: blockerIssueId,
          relatedIssueId: terminalDependentId,
          type: "blocks",
        },
        {
          companyId,
          issueId: blockerIssueId,
          relatedIssueId: conversationDependentId,
          type: "blocks",
        },
        {
          companyId,
          issueId: blockerIssueId,
          relatedIssueId: userOwnedDependentId,
          type: "blocks",
        },
        {
          companyId,
          issueId: blockerIssueId,
          relatedIssueId: unassignedDependentId,
          type: "blocks",
        },
        {
          companyId,
          issueId: conversationBlockerId,
          relatedIssueId: conversationDependentId,
          type: "blocks",
        },
      ]);

      const result = await autoUnblockHeartbeat().autoUnblockReadyDependents(blockerIssueId);

      expect(result.unblocked).toBe(2);
      expect(result.issueIds.sort()).toEqual([blockedIssueId, eligibleId].sort());

      const statuses = await dependentStatusById([
        blockedIssueId,
        eligibleId,
        openBlockerDependentId,
        cancelledBlockerDependentId,
        backlogParkDependentId,
        terminalDependentId,
        conversationDependentId,
        userOwnedDependentId,
        unassignedDependentId,
      ]);
      expect(["todo", "in_progress"]).toContain(statuses.get(blockedIssueId));
      expect(["todo", "in_progress"]).toContain(statuses.get(eligibleId));
      // An open blocker still owns its dependent.
      expect(statuses.get(openBlockerDependentId)).toBe("blocked");
      expect(statuses.get(cancelledBlockerDependentId)).toBe("blocked");
      // A backlog park is a human parking surface, never auto-released.
      expect(statuses.get(backlogParkDependentId)).toBe("backlog");
      // A terminal card is never reopened by a dependency edge.
      expect(statuses.get(terminalDependentId)).toBe("done");
      // A conversation container's turn lifecycle is authoritative.
      expect(statuses.get(conversationDependentId)).toBe("blocked");
      // Human-owned and unassigned cards have no agent to hand work back to.
      expect(statuses.get(userOwnedDependentId)).toBe("blocked");
      expect(statuses.get(unassignedDependentId)).toBe("blocked");

      const wakes = await db
        .select({ payload: agentWakeupRequests.payload })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, companyId));
      const wokenIssueIds = wakes.map((wake) =>
        (wake.payload as { issueId?: unknown } | null)?.issueId,
      );
      expect(wokenIssueIds.sort()).toEqual([blockedIssueId, eligibleId].sort());
    });

    it("last blocker auto-unblock waits for workspace finalize before flipping status", async () => {
      const { companyId, agentId, blockedIssueId, blockerIssueId, executionWorkspaceId } =
        await seedAutoUnblockFixture({ workspaceState: "not_finalized" });

      const beforeFinalize = await autoUnblockHeartbeat().autoUnblockReadyDependents(
        blockerIssueId,
      );

      expect(beforeFinalize.unblocked).toBe(0);
      expect(beforeFinalize.checked).toBe(0);

      const beforeStatuses = await dependentStatusById([blockedIssueId]);
      expect(beforeStatuses.get(blockedIssueId)).toBe("blocked");
      expect(
        await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)),
      ).toHaveLength(0);

      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        issueId: blockerIssueId,
        phase: "workspace_finalize",
        status: "succeeded",
        startedAt: new Date(),
      });

      const afterFinalize = await autoUnblockHeartbeat().autoUnblockReadyDependents(
        blockerIssueId,
      );

      expect(afterFinalize.unblocked).toBe(1);
      expect(afterFinalize.issueIds).toEqual([blockedIssueId]);

      const afterStatuses = await dependentStatusById([blockedIssueId]);
      expect(afterStatuses.get(blockedIssueId)).toBe("todo");

      const wakes = await db
        .select({ reason: agentWakeupRequests.reason })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId));
      expect(wakes).toHaveLength(1);
      expect(wakes[0]?.reason).toBe("issue_blockers_resolved");
    });

    it("last blocker auto-unblock refuses to transition without the idle todo recovery gate", async () => {
      const { companyId, blockedIssueId, blockerIssueId } = await seedAutoUnblockFixture();
      const result = await heartbeatService(db, {
        runtimeEnv: { [CANARY_ENV_VAR]: "true" },
      }).autoUnblockReadyDependents(blockerIssueId);

      expect(result.enabled).toBe(false);
      expect((await dependentStatusById([blockedIssueId])).get(blockedIssueId)).toBe("blocked");
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toHaveLength(0);
    });

    it("last blocker auto-unblock is default-off and reversible when the canary env is unset", async () => {
      const { companyId, blockedIssueId, blockerIssueId } = await seedAutoUnblockFixture();

      const result = await heartbeatService(db).autoUnblockReadyDependents(blockerIssueId);

      expect(result.enabled).toBe(false);
      expect(result.unblocked).toBe(0);
      expect(result.checked).toBe(0);
      expect(result.issueIds).toEqual([]);

      const statuses = await dependentStatusById([blockedIssueId]);
      expect(statuses.get(blockedIssueId)).toBe("blocked");
      expect(
        await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)),
      ).toHaveLength(0);
    });
  });

});
