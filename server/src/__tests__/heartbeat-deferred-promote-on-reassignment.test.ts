/**
 * SPA-8631 Case 1 regression test (simplified).
 *
 * Bug: when an agent reassigns a card during its own run, the engine
 * cancels that run (`issue_reassigned`) and queues an `issue_assigned`
 * wake for the new assignee. That wake parks in `deferred_issue_execution`
 * because the prior run still holds `issues.executionRunId`. The card sits
 * `in_progress` with no run for 3-13h until a human resumes it.
 *
 * Fix: every site that clears the issue's execution lock must promote the
 * oldest `deferred_issue_execution` wake for the issue. The regression
 * directly invokes `wakeQueue.releaseIssueExecution` for a cancelled run
 * whose execution lock was already cleared and asserts the deferred wake
 * is promoted to `queued` with a fresh `heartbeat_runs` row.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createWakeQueue } from "../modules/wake-queue/index.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping SPA-8631 reassignment promote tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("SPA-8631 reassignment cancel promotes deferred wake (Case 1)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeEach(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("spa-8631-promote-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await tempDb?.cleanup();
    tempDb = null;
  });

  it(
    "promotes a parked deferred wake when the issue lock has already been cleared by an inline cancel",
    async () => {
      const companyId = randomUUID();
      const oldAgentId = randomUUID();
      const newAgentId = randomUUID();
      const issueId = randomUUID();
      const oldWakeupRequestId = randomUUID();
      const oldRunId = randomUUID();
      const newDeferredWakeupId = randomUUID();
      const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: "local-board",
        status: "active",
        membershipRole: "owner",
      });
      await db.insert(agents).values([
        {
          id: oldAgentId,
          companyId,
          name: "Old",
          role: "engineer",
          status: "idle",
          adapterType: "process",
          adapterConfig: {},
          runtimeConfig: {},
          permissions: {},
        },
        {
          id: newAgentId,
          companyId,
          name: "New",
          role: "engineer",
          status: "idle",
          adapterType: "process",
          adapterConfig: {},
          runtimeConfig: {},
          permissions: {},
        },
      ]);

      // Set up the SPA-5732 fingerprint: a queued run from the old agent,
      // the issue reassigned to the new agent, the issue's execution lock
      // already cleared by the inline cancel path.
      await db.insert(agentWakeupRequests).values({
        id: oldWakeupRequestId,
        companyId,
        agentId: oldAgentId,
        source: "assignment",
        status: "cancelled",
        runId: oldRunId,
      });
      await db.insert(heartbeatRuns).values({
        id: oldRunId,
        companyId,
        agentId: oldAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "cancelled",
        finishedAt: new Date(),
        error: "Execution lock released after issue reassigned to a different agent",
        errorCode: "lock_released_on_reassignment",
        wakeupRequestId: oldWakeupRequestId,
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
        responsibleUserId: "local-board",
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Reassignment strands card",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: newAgentId,
        // Inline cancel already cleared executionRunId — this is the exact
        // state at which the SPA-8631 fix fires.
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });

      // The new assignee's wake is parked in `deferred_issue_execution`.
      await db.insert(agentWakeupRequests).values({
        id: newDeferredWakeupId,
        companyId,
        agentId: newAgentId,
        source: "assignment",
        status: "deferred_issue_execution",
        payload: {
          issueId,
          wakeReason: "issue_assigned",
          _paperclipWakeContext: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
        },
      });

      // Build a minimal wakeQueue that captures only the deps the release
      // path needs. We stub out resolveResponsibleUserId (which is what
      // host.resolveResponsibleUserId ultimately calls back into heartbeat).
      const wakeQueue = createWakeQueue(db, {
        resolveResponsibleUserId: async () => "local-board",
        getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
        resolveSessionBeforeForWakeup: async () => null,
        wakeAdmissionHelpers: {} as never,
        recovery: {
          escalateStrandedAssignedIssue: async () => {},
          escalateStrandedRecoveryIssueInPlace: async () => {},
        },
      });

      // Act: invoke the release path with the cancelled run as input.
      const result = await wakeQueue.releaseIssueExecution({
        companyId,
        runId: oldRunId,
        now: new Date(),
      });

      // The release must have promoted the deferred wake.
      expect(result.outcome.kind).toBe("promoted");
      if (result.outcome.kind !== "promoted") return;

      // The deferred wake must now be `queued` with a fresh heartbeat_runs row.
      const promotedWake = await db
        .select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, newDeferredWakeupId))
        .then((rows) => rows[0]);
      expect(promotedWake?.status).toBe("queued");
      expect(promotedWake?.runId).not.toBeNull();

      const promotedRun = promotedWake?.runId
        ? await db
            .select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status, responsibleUserId: heartbeatRuns.responsibleUserId })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, promotedWake.runId))
            .then((rows) => rows[0])
        : null;
      expect(promotedRun?.agentId).toBe(newAgentId);
      expect(promotedRun?.status).toBe("queued");
      expect(promotedRun?.responsibleUserId).toBe("local-board");

      // The issue's execution lock must now point at the promoted run.
      const issueAfter = await db
        .select({ executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]);
      expect(issueAfter?.executionRunId).toBe(promotedRun?.id);
    },
    60_000,
  );

  it(
    "promotes a parked deferred wake when the cancelled run was a scheduled_retry",
    async () => {
      const companyId = randomUUID();
      const oldAgentId = randomUUID();
      const newAgentId = randomUUID();
      const issueId = randomUUID();
      const oldWakeupRequestId = randomUUID();
      const oldRunId = randomUUID();
      const newDeferredWakeupId = randomUUID();
      const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: "local-board",
        status: "active",
        membershipRole: "owner",
      });
      await db.insert(agents).values([
        {
          id: oldAgentId,
          companyId,
          name: "Old",
          role: "engineer",
          status: "idle",
          adapterType: "process",
          adapterConfig: {},
          runtimeConfig: {},
          permissions: {},
        },
        {
          id: newAgentId,
          companyId,
          name: "New",
          role: "engineer",
          status: "idle",
          adapterType: "process",
          adapterConfig: {},
          runtimeConfig: {},
          permissions: {},
        },
      ]);

      await db.insert(agentWakeupRequests).values({
        id: oldWakeupRequestId,
        companyId,
        agentId: oldAgentId,
        source: "automation",
        status: "cancelled",
        runId: oldRunId,
      });
      // The old run was a `scheduled_retry` — this exercises the
      // `cancelStaleScheduledRetry` path.
      await db.insert(heartbeatRuns).values({
        id: oldRunId,
        companyId,
        agentId: oldAgentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "cancelled",
        finishedAt: new Date(),
        error: "Cancelled because the issue was reassigned before the scheduled retry became due",
        errorCode: "issue_reassigned",
        scheduledRetryAt: new Date(Date.now() - 60_000),
        scheduledRetryAttempt: 1,
        scheduledRetryReason: "execution_lease_not_released",
        wakeupRequestId: oldWakeupRequestId,
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
        responsibleUserId: "local-board",
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Scheduled retry cancel clears lock",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: newAgentId,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });
      await db.insert(agentWakeupRequests).values({
        id: newDeferredWakeupId,
        companyId,
        agentId: newAgentId,
        source: "assignment",
        status: "deferred_issue_execution",
        payload: {
          issueId,
          wakeReason: "issue_assigned",
          _paperclipWakeContext: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
        },
      });

      const wakeQueue = createWakeQueue(db, {
        resolveResponsibleUserId: async () => "local-board",
        getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
        resolveSessionBeforeForWakeup: async () => null,
        wakeAdmissionHelpers: {} as never,
        recovery: {
          escalateStrandedAssignedIssue: async () => {},
          escalateStrandedRecoveryIssueInPlace: async () => {},
        },
      });

      const result = await wakeQueue.releaseIssueExecution({
        companyId,
        runId: oldRunId,
        now: new Date(),
      });

      expect(result.outcome.kind).toBe("promoted");

      const promotedWake = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, newDeferredWakeupId))
        .then((rows) => rows[0]);
      expect(promotedWake?.status).toBe("queued");
    },
    60_000,
  );
});