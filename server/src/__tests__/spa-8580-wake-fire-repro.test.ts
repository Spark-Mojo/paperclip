import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companySkills,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRelations,
  issues,
  projects,
  projectWorkspaces,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "SPA-8580 wake-fire test run.",
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres SPA-8580 wake-fire tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// SPA-8580 — two state-change wake-fire surfaces:
//
// (a) blocker resolution wakes `todo` dependents. When a blocker's issue goes
//     `done`, the route emits `issue_blockers_resolved`, and when the
//     workspace-finalize barrier gated that emission the finalize hook re-fires
//     through `reconcileResolvedDependencyWakeBackstop`. That backstop's
//     candidate query only matched `blocked` dependents, so a `todo` dependent
//     whose blocker resolved while its workspace sync-back was still in flight
//     never re-fired. SPA-7489/SPA-7490.
// (b) reassignment wakes the new owner. SPA-8511 (Sable → Abe reassign, run
//     cancelled, new owner never woke): with a stale queued holder from the old
//     owner still named in `issues.executionRunId`, the new owner's
//     `issue_assigned` wake must cancel the stale holder
//     (`lock_released_on_reassignment`) and admit a queued run for the new
//     assignee.
describeEmbeddedPostgres("SPA-8580 state-change wake-fire", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-spa-8580-wake-fire-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "SPA-8580 wake-fire test run.",
      provider: "test",
      model: "test-model",
    }));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const [company] = await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
      status: "active",
    }).returning();
    return company!;
  }

  async function seedAgent(companyId: string, name: string) {
    const [agent] = await db.insert(agents).values({
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    }).returning();
    return agent!;
  }

  async function seedIssue(input: {
    companyId: string;
    title: string;
    status: string;
    assigneeAgentId?: string | null;
    sequence: number;
  }) {
    const [issue] = await db.insert(issues).values({
      companyId: input.companyId,
      title: input.title,
      status: input.status,
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId ?? null,
      responsibleUserId: "responsible-user",
      issueNumber: input.sequence,
      identifier: `SPA-${8580 + input.sequence}`,
    }).returning();
    return issue!;
  }

  // Surface (a): the blocker-resolution backstop must heal a `todo` dependent
  // whose blocker resolved while the blocker's workspace finalize was still in
  // flight. `listWakeableBlockedDependents` admits `todo` dependents; the
  // recovery backstop that re-fires after workspace_finalize must admit the
  // same population, or the dependent never wakes (SPA-7489/SPA-7490).
  it("blocker-resolution backstop wakes a todo dependent (surface a)", async () => {
    const company = await seedCompany();
    const dependentAgent = await seedAgent(company.id, "Dependent");
    const blockerAgent = await seedAgent(company.id, "Blocker");
    const [project] = await db.insert(projects).values({
      companyId: company.id,
      name: "Core",
      status: "in_progress",
    }).returning();
    const projectWorkspaceId = randomUUID();
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId: company.id,
      projectId: project!.id,
      name: "Core workspace",
      status: "active",
      repoUrl: "https://example.com/repo.git",
    });
    const workspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId: company.id,
      projectId: project!.id,
      projectWorkspaceId,
      name: "Blocker workspace",
      mode: "git_worktree",
      strategyType: "git_worktree",
      status: "active",
    });

    const blocker = await seedIssue({
      companyId: company.id,
      title: "Blocker card",
      status: "in_progress",
      assigneeAgentId: blockerAgent.id,
      sequence: 1,
    });
    const dependent = await seedIssue({
      companyId: company.id,
      title: "Dependent card",
      status: "todo",
      assigneeAgentId: dependentAgent.id,
      sequence: 2,
    });

    await db.insert(issueRelations).values({
      companyId: company.id,
      issueId: blocker.id,
      relatedIssueId: dependent.id,
      type: "blocks",
    });

    // The blocker's closing run holds the workspace with a checked-out-but-
    // not-yet-finalized op — the shape that gates the route-time emission,
    // so the finalize hook is the only path left to re-fire the dependent.
    await db
      .update(issues)
      .set({ executionWorkspaceId: workspaceId, updatedAt: new Date() })
      .where(eq(issues.id, blocker.id));
    await db.insert(workspaceOperations).values({
      companyId: company.id,
      executionWorkspaceId: workspaceId,
      issueId: blocker.id,
      phase: "workspace_checkout",
      status: "succeeded",
      startedAt: new Date(Date.now() - 5_000),
      finishedAt: new Date(Date.now() - 4_000),
    });
    await db
      .update(issues)
      .set({ status: "done", updatedAt: new Date() })
      .where(eq(issues.id, blocker.id));

    // Blocker is done but its run has not recorded a successful
    // workspace_finalize yet: the wake is (correctly) still gated.
    await heartbeat.reconcileResolvedDependencyWakes({
      companyId: company.id,
      blockerIssueId: blocker.id,
    });
    const gatedRows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, dependentAgent.id),
          eq(agentWakeupRequests.reason, "issue_blockers_resolved"),
        ),
      );
    expect(gatedRows[0]?.count ?? 0).toBe(0);

    // The run's sync-back lands.
    await db.insert(workspaceOperations).values({
      companyId: company.id,
      executionWorkspaceId: workspaceId,
      issueId: blocker.id,
      phase: "workspace_finalize",
      status: "succeeded",
      startedAt: new Date(),
      finishedAt: new Date(),
    });

    // Same shape as the heartbeat finalize hook:
    //   recovery.reconcileResolvedDependencyWakeBackstop({
    //     blockerIssueId, source: "workspace.finalize", ...
    //   })
    await heartbeat.reconcileResolvedDependencyWakes({
      companyId: company.id,
      blockerIssueId: blocker.id,
    });

    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, dependentAgent.id),
          eq(agentWakeupRequests.reason, "issue_blockers_resolved"),
          sql`${agentWakeupRequests.payload}->>'issueId' = ${dependent.id}`,
        ),
      );
    const count = rows[0]?.count ?? 0;
    // Before the fix the candidate query only matched `blocked` issues, so the
    // todo dependent never woke. The dependent is todo+assigned with its
    // blocker done and finalized: the backstop must fire its wake.
    expect(count).toBeGreaterThan(0);
    // The wake must be admitted for dispatch (a queued run), not merely
    // recorded as a skipped attempt.
    const admitted = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, dependentAgent.id),
          eq(agentWakeupRequests.reason, "issue_blockers_resolved"),
          inArray(agentWakeupRequests.status, ["queued", "claimed", "completed"]),
          sql`${agentWakeupRequests.payload}->>'issueId' = ${dependent.id}`,
        ),
      );
    expect(Number(admitted[0]?.count ?? 0)).toBeGreaterThan(0);
  });

  // Surface (b): an assigneeAgentId flip on a non-backlog card with a stale
  // queued holder from the old owner must admit a queued run for the NEW owner
  // (SPA-8511 — Sable → Abe reassign, run cancelled, new owner never woke).
  it("reassignment to a new agent wakes the new owner (surface b)", async () => {
    const company = await seedCompany();
    const oldAgent = await seedAgent(company.id, "OldOwner");
    const newAgent = await seedAgent(company.id, "NewOwner");

    const issue = await seedIssue({
      companyId: company.id,
      title: "Reassignment target",
      status: "in_progress",
      assigneeAgentId: oldAgent.id,
      sequence: 3,
    });

    // During the handoff the old owner's queued run is still named in
    // issues.executionRunId (SPA-8511 shape: the run was cancelled but the
    // new owner's wake still had to cut through the stale holder).
    const holderRunId = randomUUID();
    const holderWakeupId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: holderWakeupId,
      companyId: company.id,
      agentId: oldAgent.id,
      source: "assignment",
      status: "queued",
      payload: { issueId: issue.id },
    });
    await db.insert(heartbeatRuns).values({
      id: holderRunId,
      companyId: company.id,
      agentId: oldAgent.id,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: holderWakeupId,
      contextSnapshot: { issueId: issue.id, taskId: issue.id, wakeReason: "issue_assigned" },
    });
    await db
      .update(issues)
      .set({
        executionRunId: holderRunId,
        executionAgentNameKey: "oldowner",
        executionLockedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(issues.id, issue.id));

    // Assignee flip to the new owner (PATCH status: todo + assigneeAgentId).
    await db
      .update(issues)
      .set({
        assigneeAgentId: newAgent.id,
        status: "todo",
        updatedAt: new Date(),
      })
      .where(eq(issues.id, issue.id));

    // The new owner's assignment wake must admit — the dispatcher cancels the
    // stale holder (`lock_released_on_reassignment`) and routes the run to the
    // new assignee.
    const wake = await heartbeat.wakeup(newAgent.id, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: issue.id },
      contextSnapshot: { issueId: issue.id, taskId: issue.id, wakeReason: "issue_assigned" },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    expect(wake).not.toBeNull();
    expect(wake?.agentId).toBe(newAgent.id);
    expect(wake?.status).toBe("queued");
  });
});