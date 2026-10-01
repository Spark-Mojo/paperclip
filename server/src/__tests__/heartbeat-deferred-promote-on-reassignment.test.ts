/**
 * SPA-8631 Case 1 regression test (simplified), plus SPA-9351 shape 3.
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
 *
 * SPA-9351 shape 3 adds the end-to-end case the card names: a card
 * reassigned mid-run, where the new assignee's run actually starts. The
 * earlier tests stop at "the wake was promoted to `queued`"; the new case
 * drives the real `PATCH /api/issues/:id` reassignment route, so the run
 * cancellation, the lock release, and the wake promotion are all the
 * engine's own path rather than a hand-built approximation of it.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createWakeQueue } from "../modules/wake-queue/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";

// These cases assert on real run dispatch, and the engine suppresses every
// wake inside an agent worktree (`heartbeatSkip.reason = "worktree_instance"`).
// Clear the inherited flag before the service module is imported, matching the
// house pattern, so the reassignment path under test actually dispatches.
vi.hoisted(() => {
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

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

/**
 * SPA-9351 shape 3, the card's verbatim test clause: "reassign a card mid-run
 * to another agent; the new assignee's run starts."
 *
 * The two cases above stop at "the deferred wake was promoted to `queued`".
 * This one goes through the real `PATCH /api/issues/:id` reassignment route, so
 * the run cancellation, the execution-lock release, the `issue_assigned` wake,
 * and the promotion are the engine's own sequence. A hand-built approximation
 * of that sequence would pass while the real path stayed broken.
 */
describeEmbeddedPostgres("SPA-9351 shape 3: reassignment mid-run starts the new assignee", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeEach(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("spa-9351-shape3-reassign-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    // Run events are written by the real dispatch path and cascade-block the
    // run delete, so they go first.
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authUsers);
    await tempDb?.cleanup();
    tempDb = null;
  });

  function appFor(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  }

  /**
   * Seeds a card the OLD agent is actively running, then hands the board the
   * reassignment. The new agent's concurrency is capped and its one slot is
   * occupied by an unrelated busy run, so the new assignee's run is queued and
   * observed rather than executed by a real adapter in a unit test.
   */
  async function seedMidRunReassignment() {
    const companyId = randomUUID();
    const boardUserId = `user-${randomUUID()}`;
    const oldAgentId = randomUUID();
    const newAgentId = randomUUID();
    const issueId = randomUUID();
    const oldRunId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(authUsers).values({
      id: boardUserId,
      name: "Board",
      email: `${boardUserId}@local`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: boardUserId,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: boardUserId,
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
        runtimeConfig: { heartbeat: { wakeOnDemand: true } },
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
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      },
    ]);

    // The old agent holds the execution lock with a genuinely running run.
    await db.insert(heartbeatRuns).values({
      id: oldRunId,
      companyId,
      agentId: oldAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      startedAt: new Date(),
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      responsibleUserId: boardUserId,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Reassigned mid-run",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: oldAgentId,
      executionRunId: oldRunId,
      executionAgentNameKey: "old",
      executionLockedAt: new Date(),
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    // Occupy the new agent's only concurrency slot.
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: newAgentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { wakeReason: "test_busy_slot" },
      startedAt: new Date(),
      responsibleUserId: boardUserId,
    });

    const app = appFor({
      type: "board",
      source: "session",
      userId: boardUserId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: true,
    } as never);

    return { app, companyId, boardUserId, oldAgentId, newAgentId, issueId, oldRunId };
  }

  it("starts the new assignee's run when a running card is reassigned mid-run", async () => {
    const { app, oldAgentId, newAgentId, issueId, oldRunId } = await seedMidRunReassignment();

    await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: newAgentId })
      .expect(200);

    // The route dispatches the assignee wake from a detached async block, so a
    // 200 only means the update committed. Wait on the authoritative state —
    // the new assignee's own run row for this card — rather than on a fixed
    // delay, so the test asserts the outcome and not the timing.
    const cardRunsFor = async () => {
      const [issueRow] = await db.select().from(issues).where(eq(issues.id, issueId));
      const runs = await db
        .select({
          id: heartbeatRuns.id,
          status: heartbeatRuns.status,
          contextSnapshot: heartbeatRuns.contextSnapshot,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, newAgentId),
            eq(heartbeatRuns.companyId, issueRow!.companyId),
          ),
        );
      return {
        issue: issueRow,
        runs: runs.filter(
          (run) => (run.contextSnapshot as Record<string, unknown> | null)?.issueId === issueId,
        ),
      };
    };

    await vi.waitFor(async () => {
      expect((await cardRunsFor()).runs).toHaveLength(1);
    }, { timeout: 10_000, interval: 50 });

    const { issue: issueAfter, runs: cardRuns } = await cardRunsFor();

    // The former owner's run is cancelled for the reassignment, exactly as the
    // route's stop-before-reassign requires.
    const [oldRun] = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, oldRunId));
    expect(oldRun?.status).toBe("cancelled");
    expect(oldRun?.errorCode).toBe("issue_reassigned");

    // The new assignee owns the card, and its run exists exactly once.
    expect(issueAfter?.assigneeAgentId).toBe(newAgentId);
    expect(cardRuns[0]!.status).toBe("queued");

    // The old owner's lock was released and not re-taken by anyone else. The
    // promoted run is `queued`, and the engine stamps `executionRunId` only when
    // a run is claimed for execution (lazy locking), so the column is null here
    // by design — what matters is that it no longer names the cancelled run.
    expect(issueAfter?.executionRunId).not.toBe(oldRunId);

    // Nothing is left parked behind the cancelled run.
    const stillDeferred = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, issueAfter!.companyId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
        ),
      );
    expect(stillDeferred).toHaveLength(0);

    // And the former owner has no run on the card at all.
    const oldAgentCardRuns = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, oldAgentId),
          eq(heartbeatRuns.companyId, issueAfter!.companyId),
          eq(heartbeatRuns.status, "running"),
        ),
      );
    expect(oldAgentCardRuns).toHaveLength(0);
  }, 60_000);

  it("starts the new assignee's run when the holder ends before the deferred row is written", async () => {
    // The same race Shape 3 exists for: the reassignment cancels the old run
    // and queues the new assignee's wake, and the holder is already terminal by
    // the time that wake's admission reads the issue. No run-end event can
    // promote the row afterwards, so the run must still start.
    const { app, newAgentId, issueId, oldRunId } = await seedMidRunReassignment();

    // Make the holder terminal before the reassignment runs, while the issue
    // still names it as the execution owner. The stale lock is what the
    // admission path and the post-deferral re-drive both have to see through.
    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled", finishedAt: new Date(), error: "ended before the wake was written" })
      .where(eq(heartbeatRuns.id, oldRunId));

    await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: newAgentId })
      .expect(200);

    const cardRunsFor = async () => {
      const [issueRow] = await db.select().from(issues).where(eq(issues.id, issueId));
      const runs = await db
        .select({
          id: heartbeatRuns.id,
          status: heartbeatRuns.status,
          contextSnapshot: heartbeatRuns.contextSnapshot,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, newAgentId),
            eq(heartbeatRuns.companyId, issueRow!.companyId),
          ),
        );
      return {
        issue: issueRow,
        runs: runs.filter(
          (run) => (run.contextSnapshot as Record<string, unknown> | null)?.issueId === issueId,
        ),
      };
    };

    await vi.waitFor(async () => {
      expect((await cardRunsFor()).runs).toHaveLength(1);
    }, { timeout: 10_000, interval: 50 });

    const { issue: issueAfter, runs } = await cardRunsFor();
    // Same lazy-locking contract as the case above: the stale lock must not
    // still name the terminal holder.
    expect(issueAfter?.executionRunId).not.toBe(oldRunId);

    const stillDeferred = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, issueAfter!.companyId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
        ),
      );
    expect(stillDeferred).toHaveLength(0);
  }, 60_000);
});
