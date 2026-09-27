import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  createDb,
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

const describeIfPostgres = describeEmbeddedPostgres;

describeIfPostgres("SPA-9001 stranded-recovery re-wake for server_shutdown_interrupted runs", () => {
  let db: ReturnType<typeof createDb> | null = null;
  let cleanup: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    if (!embeddedPostgresSupport.supported) return;
    const started = await startEmbeddedPostgresTestDatabase("paperclip-spa-9001-");
    db = createDb(started.connectionString);
    cleanup = started.cleanup;
  }, 120_000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  afterEach(async () => {
    if (!db) return;
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function seedInterruptedRetryFixture(input: {
    status: "in_progress" | "todo" | "in_review";
    errorCode: string;
    runRetryReason: string;
    contextSnapshot?: Record<string, unknown>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    // Initial interrupted run from server shutdown — errorCode marks it as
    // an infrastructure event, not a recovery-attempt failure.
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "interrupted",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_continuation_needed",
        retryReason: input.runRetryReason,
        ...(input.contextSnapshot ?? {}),
      },
      errorCode: input.errorCode,
      error: "Interrupted by graceful server shutdown (SIGTERM); retry queued for restart recovery",
      startedAt: now,
      finishedAt: now,
      updatedAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stranded after restart",
      status: input.status,
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId, runId };
  }

  it("re-enqueues an in_progress stranded run whose retry was interrupted by a server shutdown (SPA-9001)", async () => {
    if (!db) throw new Error("db not initialized");
    const { agentId, issueId, runId } = await seedInterruptedRetryFixture({
      status: "in_progress",
      errorCode: "server_shutdown_interrupted",
      runRetryReason: "issue_continuation_needed",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const retryRun = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), sql`${heartbeatRuns.id} != ${runId}`))
      .then((rows) => rows[0] ?? null);
    expect(retryRun).toMatchObject({
      retryOfRunId: runId,
    });
    expect(["queued", "running", "scheduled_retry"]).toContain(retryRun?.status);
    expect(retryRun?.contextSnapshot).toMatchObject({
      issueId,
      retryOfRunId: runId,
      scheduledRetryAttempt: 1,
    });
    expect(retryRun?.scheduledRetryReason).toBe("transient_failure");
  });

  it("re-enqueues a todo stranded run whose retry was interrupted by a server shutdown (SPA-9001)", async () => {
    if (!db) throw new Error("db not initialized");
    const { agentId, issueId, runId } = await seedInterruptedRetryFixture({
      status: "todo",
      errorCode: "server_shutdown_interrupted",
      runRetryReason: "assignment_recovery",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const retryRun = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), sql`${heartbeatRuns.id} != ${runId}`))
      .then((rows) => rows[0] ?? null);
    expect(retryRun).toMatchObject({
      retryOfRunId: runId,
    });
    expect(["queued", "running", "scheduled_retry"]).toContain(retryRun?.status);
    expect(retryRun?.contextSnapshot).toMatchObject({
      issueId,
      retryOfRunId: runId,
      scheduledRetryAttempt: 1,
    });
    expect(retryRun?.scheduledRetryReason).toBe("transient_failure");
  });

  it("still escalates an interrupted in_progress retry with unknown outcome that is NOT a server shutdown (unchanged path)", async () => {
    if (!db) throw new Error("db not initialized");
    const { issueId } = await seedInterruptedRetryFixture({
      status: "in_progress",
      errorCode: "adapter_failed",
      runRetryReason: "issue_continuation_needed",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    // On rebuild/v2026.916.0-survivors an interrupted run whose outcome is
    // unknown (no bootstrap evidence) is held by legacy-execution
    // reconciliation and escalates instead of requeueing. The SPA-9001 bypass
    // is gated on server_shutdown_interrupted only, so this path must be
    // unchanged: escalated, no silent requeue.
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);
  });

  it("still re-enqueues an in_review review-participant whose retry was interrupted by a server shutdown (SPA-9001)", async () => {
    if (!db) throw new Error("db not initialized");
    const companyId = randomUUID();
    const reviewerAgentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const stageId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "MiraReviewer",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: reviewerAgentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "interrupted",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "execution_review_participant_recovery",
        retryReason: "execution_review_participant_recovery",
        currentStageId: stageId,
        currentStageType: "review",
      },
      errorCode: "server_shutdown_interrupted",
      error: "Interrupted by graceful server shutdown (SIGTERM); retry queued for restart recovery",
      startedAt: now,
      finishedAt: now,
      updatedAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review-stage stranded after restart",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: reviewerAgentId,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: reviewerAgentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: null,
      },
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.reviewParticipantRequeued).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const retryRun = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, reviewerAgentId), sql`${heartbeatRuns.id} != ${runId}`))
      .then((rows) => rows[0] ?? null);
    expect(retryRun).toMatchObject({
      retryOfRunId: runId,
    });
    expect(["queued", "running", "scheduled_retry"]).toContain(retryRun?.status);
    expect(retryRun?.contextSnapshot).toMatchObject({
      issueId,
      retryOfRunId: runId,
      currentStageId: stageId,
      currentStageType: "review",
      scheduledRetryAttempt: 1,
    });
    expect(retryRun?.scheduledRetryReason).toBe("transient_failure");
  });
});