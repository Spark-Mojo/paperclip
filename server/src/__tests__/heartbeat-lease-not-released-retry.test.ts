/**
 * SPA-8631 Case 2 regression test.
 *
 * Bug: when a queued run is being skipped only because the previous run's
 * environment lease has not yet been released, the wake ends up
 * `skipped` with `reason: execution_reconciliation_required` and the
 * new assignee never runs.
 *
 * Fix: re-queue the run as `scheduled_retry` with a short backoff. Bound
 * the attempts at `LEASE_NOT_RELEASED_MAX_ATTEMPTS`; after that, surface
 * `recovery_action_required` so the existing recovery surface can take
 * over.
 *
 * The bug text in conversation-continuation.ts:
 *   "The previous execution has not released its environment lease. Wait
 *    for cleanup before continuing this task."
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  environmentLeases,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createPostgresRunDispatchAdapter } from "../modules/run-dispatch/adapters/postgres.ts";
import { getExecutionBlocker } from "../services/execution-blocker.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping SPA-8631 lease-not-released retry tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("SPA-8631 lease-not-released wake re-queues with bounded attempts (Case 2)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeEach(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("spa-8631-lease-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await tempDb?.cleanup();
    tempDb = null;
  });

  async function seedLeaseHeldScenario() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const predecessorRunId = randomUUID();
    const wakeupRequestId = randomUUID();
    const queuedRunId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    // The previous run is terminal but its environment lease is still
    // held — `getExecutionBlocker` returns the lease-not-released cause.
    // The conversationContinuation flag puts the predecessor in the
    // `conversationRunPredicate` filter that `getConversationOwnershipBlocker`
    // uses, so the blocker finds it.
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Lease-not-released queueing",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      status: "claimed",
      runId: predecessorRunId,
    });
    await db.insert(heartbeatRuns).values({
      id: predecessorRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "interrupted",
      finishedAt: new Date(),
      wakeupRequestId,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      resultJson: { conversationContinuation: "continue_conversation_v1" },
    });
    await db.insert(environmentLeases).values({
      companyId,
      issueId,
      heartbeatRunId: predecessorRunId,
      status: "active",
    });
    // A fresh queued run is what `cancelStaleQueuedRun` will reject.
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented" },
    });
    return { companyId, agentId, issueId, predecessorRunId, queuedRunId };
  }

  it(
    "re-queues the queued run as scheduled_retry with attempt=1 when the lease is not yet released",
    async () => {
      const { companyId, queuedRunId, issueId } = await seedLeaseHeldScenario();

      // Sanity: the blocker finds the held lease before the call.
      const blockerBefore = await getExecutionBlocker(db, companyId, issueId);
      expect(blockerBefore?.cause).toBe("execution_owner_active");

      const now = new Date();
      const outcome = await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
        companyId,
        runId: queuedRunId,
        expectedStatus: "queued",
        now,
      });

      expect(outcome).toMatchObject({
        outcome: "rescheduled",
        errorCode: "execution_reconciliation_required",
        attempt: 1,
      });
      if (outcome.outcome !== "rescheduled") return;

      // The run row now sits in `scheduled_retry` with a future dueAt and
      // the bounded attempt counter.
      const rescheduledRun = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, queuedRunId))
        .then((rows) => rows[0]);
      expect(rescheduledRun?.status).toBe("scheduled_retry");
      expect(rescheduledRun?.scheduledRetryAttempt).toBe(1);
      expect(rescheduledRun?.scheduledRetryReason).toBe("execution_lease_not_released");
      expect(rescheduledRun?.scheduledRetryAt).not.toBeNull();
      expect(rescheduledRun?.scheduledRetryAt!.getTime()).toBeGreaterThan(now.getTime());
    },
    60_000,
  );

  it(
    "after MAX_ATTEMPTS arrivals the run is terminally cancelled with recovery_action_required",
    async () => {
      const { companyId, queuedRunId, predecessorRunId, issueId } = await seedLeaseHeldScenario();
      // Seed the run with scheduledRetryAttempt = 5 so the next cancel is
      // attempt #6, which is past the bound (5) and falls through to
      // terminal skip.
      await db
        .update(heartbeatRuns)
        .set({ scheduledRetryAttempt: 5 })
        .where(eq(heartbeatRuns.id, queuedRunId));

      const outcome = await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
        companyId,
        runId: queuedRunId,
        expectedStatus: "queued",
        now: new Date(),
      });

      expect(outcome).toMatchObject({
        outcome: "cancelled",
        errorCode: "execution_reconciliation_required",
      });
      if (outcome.outcome !== "cancelled") return;

      // The reason text signals the recovery surface should pick it up.
      expect(outcome.reason).toMatch(
        /Recovery required: previous execution lease not released after \d+ attempts/,
      );

      // The run row is now terminal.
      const cancelledRun = await db
        .select({ status: heartbeatRuns.status, finishedAt: heartbeatRuns.finishedAt })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, queuedRunId))
        .then((rows) => rows[0]);
      expect(cancelledRun?.status).toBe("cancelled");
      expect(cancelledRun?.finishedAt).not.toBeNull();

      // Release the lease and confirm the blocker clears — once the lease
      // is gone, `getExecutionBlocker` returns null and the next attempt
      // would proceed normally.
      await db
        .update(environmentLeases)
        .set({ releasedAt: new Date(), status: "released" })
        .where(eq(environmentLeases.heartbeatRunId, predecessorRunId));
      expect(await getExecutionBlocker(db, companyId, issueId)).toBeNull();
    },
    60_000,
  );

  it(
    "ignores non-lease execution_reconciliation_required causes (no scheduled_retry)",
    async () => {
      // Set up the same scenario but with cause = `uncertain_provider_action`
      // and nextAction that does NOT match the lease text. The fix must
      // preserve the existing terminal-skip behavior for those causes.
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueId = randomUUID();
      const wakeupRequestId = randomUUID();
      const predecessorRunId = randomUUID();
      const queuedRunId = randomUUID();
      const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId,
        agentId,
        source: "assignment",
        status: "claimed",
        runId: predecessorRunId,
      });
      await db.insert(heartbeatRuns).values({
        id: predecessorRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "interrupted",
        finishedAt: new Date(),
        wakeupRequestId,
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
        resultJson: { conversationContinuation: "continue_conversation_v1" },
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Uncertain provider action",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });
      await db.insert(issueRecoveryActions).values({
        companyId,
        sourceIssueId: issueId,
        kind: "active_run_watchdog",
        status: "active",
        ownerType: "board",
        cause: "uncertain_provider_action",
        fingerprint: predecessorRunId,
        evidence: { runId: predecessorRunId, automaticRecovery: { replay: "blocked" } },
        nextAction: "Provider action could not be verified; manual confirmation required.",
      });
      await db.insert(heartbeatRuns).values({
        id: queuedRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented" },
      });

      const outcome = await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
        companyId,
        runId: queuedRunId,
        expectedStatus: "queued",
        now: new Date(),
      });

      // The non-lease cause keeps the existing terminal-skip behavior.
      expect(outcome).toMatchObject({
        outcome: "cancelled",
        errorCode: "execution_reconciliation_required",
      });
    },
    60_000,
  );
});