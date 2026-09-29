import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping SPA-9001 reopen reassignment tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * SPA-9001 reopen (2026-09-28): SPA-5893 shape. A running agent reassigns the
 * card mid-run; the engine cancels its run (`issue_reassigned`) and enqueues
 * the new assignee's wake. Three coupled defects stranded the card for 30 min:
 *
 * 1. The new assignee's wake admission raced the cancelled run's environment
 *    lease release (skip at 02:21:41.119, release at 02:21:41.177) and was
 *    terminally skipped `execution_reconciliation_required`.
 * 2. A deferred wake parked for the OLD agent (board manual wake) never
 *    drained and was never re-routed to the new assignee.
 * 3. The periodic stranded sweep counted that stale former-agent deferred
 *    wake as an "active execution path" and skipped the card every interval.
 */
describeEmbeddedPostgres("SPA-9001 reopen: reassignment-cancel strands the new assignee", () => {
  let db: ReturnType<typeof createDb> | null = null;
  let cleanup: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    if (!embeddedPostgresSupport.supported) return;
    const started = await startEmbeddedPostgresTestDatabase("paperclip-spa-9001-reopen-");
    db = createDb(started.connectionString);
    cleanup = started.cleanup;
  }, 120_000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  afterEach(async () => {
    if (!db) return;
    await db.delete(environmentLeases);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function seedSpa5893Shape() {
    if (!db) throw new Error("db not initialized");
    const companyId = randomUUID();
    const oldAgentId = randomUUID();
    const newAgentId = randomUUID();
    const issueId = randomUUID();
    const cancelledRunId = randomUUID();
    const oldWakeId = randomUUID();
    const now = new Date();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: oldAgentId,
        companyId,
        name: "SteveOld",
        role: "engineer",
        status: "idle",
        adapterType: "opencode_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: newAgentId,
        companyId,
        name: "TyNew",
        role: "engineer",
        status: "idle",
        adapterType: "opencode_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    // Cancelled reassignment run (conversation adapter, pid dead, lease already
    // released — the exact post-cancel state of ca724ca2).
    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId,
      agentId: oldAgentId,
      source: "automation",
      reason: "issue_status_changed",
      status: "cancelled",
      runId: cancelledRunId,
      finishedAt: now,
    });
    await db.insert(heartbeatRuns).values({
      id: cancelledRunId,
      companyId,
      agentId: oldAgentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "cancelled",
      errorCode: "issue_reassigned",
      error: "Cancelled before issue reassignment",
      finishedAt: now,
      wakeupRequestId: sql`(select id from agent_wakeup_requests where run_id = ${cancelledRunId} limit 1)`,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_status_changed" },
      resultJson: {
        stopReason: "cancelled",
        executionCancellation: { state: "acknowledged", acknowledgedAt: now.toISOString() },
        reassignmentStopConfirmed: true,
      },
      responsibleUserId: "responsible-user",
    });
    // Released lease for the cancelled run (as at 02:21:41.177).
    await db.insert(environmentLeases).values({
      id: randomUUID(),
      companyId,
      heartbeatRunId: cancelledRunId,
      provider: "local",
      leasePolicy: "ephemeral",
      status: "expired",
      releasedAt: now,
    });

    // The issue: reassigned to the new agent, todo, no hold, no blocker.
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Reassigned mid-run",
      status: "todo",
      priority: "medium",
      assigneeAgentId: newAgentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    // Defect 2 fixture: board manual wake for the OLD agent, parked deferred
    // while the old run was active (SPA-5893 wake fe633ff2).
    await db.insert(agentWakeupRequests).values({
      id: oldWakeId,
      companyId,
      agentId: oldAgentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "issue_execution_deferred",
      status: "deferred_issue_execution",
      requestedByActorType: "user",
      requestedByActorId: "local-board",
      payload: {
        issueId,
        mutation: "update",
        _paperclipWakeContext: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      },
    });

    return { companyId, oldAgentId, newAgentId, issueId, cancelledRunId, oldWakeId };
  }

  it("stranded sweep re-enqueues a todo card whose only deferred wake belongs to a former assignee (SPA-9001 fix C)", async () => {
    if (!db) throw new Error("db not initialized");
    const { agentId: _old, issueId } = await seedSpa5893Shape();
    const heartbeat = heartbeatService(db);

    // Before the fix, hasActiveExecutionPath saw the old agent's deferred wake
    // and the sweep skipped the card every interval. With fix C the sweep must
    // reach the todo re-enqueue branch for the CURRENT assignee.
    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toContain(issueId);
    const outcome = result.dispatchRequeued > 0 || result.assignmentDispatched > 0;
    expect(outcome).toBe(true);
  });

  it("hasActiveExecutionPath ignores a former assignee's deferred wake but keeps the current assignee's (SPA-9001 fix C)", async () => {
    if (!db) throw new Error("db not initialized");
    const { companyId, oldAgentId, newAgentId, issueId } = await seedSpa5893Shape();

    // With only the former assignee's deferred wake present, the sweep must
    // treat the card as stranded (re-enqueue), not skip on "active execution
    // path" — that skip is exactly the 30-minute blindness on SPA-5893.
    const heartbeat = heartbeatService(db);
    const before = await heartbeat.reconcileStrandedAssignedIssues();
    expect(before.issueIds).toContain(issueId);

    // Now park a deferred wake for the CURRENT assignee: the sweep must skip.
    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId,
      agentId: newAgentId,
      source: "assignment",
      reason: "issue_execution_deferred",
      status: "deferred_issue_execution",
      payload: { issueId, mutation: "update", wakeReason: "issue_assigned" },
    });
    const after = await heartbeat.reconcileStrandedAssignedIssues();
    expect(after.issueIds).not.toContain(issueId);
  });

  it("issue update reassignment re-routes the former assignee's deferred wake to the new assignee (SPA-9001 fix B)", async () => {
    if (!db) throw new Error("db not initialized");
    const { companyId, oldAgentId, newAgentId, issueId, oldWakeId } = await seedSpa5893Shape();

    // Simulate the SPA-5893 PATCH order: the card is (re)assigned to the new
    // agent through issueService.update while the old agent's deferred wake is
    // parked. Use a direct service update on a fresh issue to exercise the
    // ownership-change hook.
    const { issueService } = await import("../services/issues.ts");
    const svc = issueService(db as never);
    // Reassign an already-created issue from old to new through the service.
    await db.update(issues).set({ assigneeAgentId: oldAgentId }).where(eq(issues.id, issueId));
    await svc.update(issueId, { assigneeAgentId: newAgentId } as never);

    const rerouted = await db
      .select({ agentId: agentWakeupRequests.agentId, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, oldWakeId))
      .then((rows) => rows[0] ?? null);
    expect(rerouted?.agentId).toBe(newAgentId);
    expect((rerouted?.payload as Record<string, unknown>)?.reassignment).toMatchObject({
      originalAgentId: oldAgentId,
    });

    // The sweep must no longer be blinded: the deferred wake now belongs to
    // the current assignee, so the card is skipped (its wake is a live path).
    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.issueIds).not.toContain(issueId);
  });

  it("re-routing honors agentSpecific payloads by leaving them untouched (SPA-9001 fix B)", async () => {
    if (!db) throw new Error("db not initialized");
    const { oldAgentId, newAgentId, issueId } = await seedSpa5893Shape();
    const specificWakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: specificWakeId,
      companyId: (await db.select({ companyId: issues.companyId }).from(issues).where(eq(issues.id, issueId)).then((r) => r[0]!.companyId)),
      agentId: oldAgentId,
      source: "automation",
      reason: "issue_execution_deferred",
      status: "deferred_issue_execution",
      payload: { issueId, agentSpecific: true },
    });

    const { issueService } = await import("../services/issues.ts");
    const svc = issueService(db as never);
    await db.update(issues).set({ assigneeAgentId: oldAgentId }).where(eq(issues.id, issueId));
    await svc.update(issueId, { assigneeAgentId: newAgentId } as never);

    const untouched = await db
      .select({ agentId: agentWakeupRequests.agentId })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, specificWakeId))
      .then((rows) => rows[0] ?? null);
    expect(untouched?.agentId).toBe(oldAgentId);
  });

  it("lease release re-enqueues a wake that was skipped racing this run's lease (SPA-9001 fix A)", async () => {
    if (!db) throw new Error("db not initialized");
    const { companyId, newAgentId, issueId, cancelledRunId } = await seedSpa5893Shape();

    // Defect 1 fixture: the new assignee's wake, terminally skipped by the
    // lease-race (SPA-5893 wake d737e913).
    const suppressedWakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: suppressedWakeId,
      companyId,
      agentId: newAgentId,
      source: "assignment",
      reason: "execution_reconciliation_required",
      status: "skipped",
      error: "The previous execution has not released its environment lease. Wait for cleanup before continuing this task.",
      finishedAt: new Date(),
      payload: {
        issueId,
        mutation: "update",
        interruptedRunId: cancelledRunId,
        executionWait: { reason: "execution_recovery", recoveryActionId: null },
      },
    });

    const heartbeat = heartbeatService(db);
    // The cancelled run's lease release is the retry trigger: call the same
    // internal entrypoint the release tail uses. It is not exported, so drive
    // it through releaseEnvironmentLeasesForRun's public wrapper on the run.
    await (heartbeat as unknown as { releaseEnvironmentLeasesForRun: (input: {
      runId: string; companyId: string; agentId: string; status: string | null | undefined;
    }) => Promise<void> }).releaseEnvironmentLeasesForRun({
      runId: cancelledRunId,
      companyId,
      agentId: newAgentId,
      status: "cancelled",
    });

    // A queued/running run for the new assignee must exist (the retry went
    // through normal admission, which now finds no lease blocker).
    const retryRun = await db
      .select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, newAgentId), sql`${heartbeatRuns.id} != ${cancelledRunId}`))
      .then((rows) => rows[0] ?? null);
    expect(retryRun).not.toBeNull();
    expect(retryRun?.agentId).toBe(newAgentId);
    expect(["queued", "running", "scheduled_retry"]).toContain(retryRun?.status);

    // The new run's wake payload must trace the retry lineage.
    const retryWake = await db
      .select({ payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.runId, retryRun!.id))
      .then((rows) => rows[0] ?? null);
    expect(retryWake?.payload).toMatchObject({
      issueId,
      leaseReleaseRetryOfRunId: cancelledRunId,
    });
  });
});
