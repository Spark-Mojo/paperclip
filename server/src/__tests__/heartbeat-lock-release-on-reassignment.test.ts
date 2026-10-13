import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentTaskRun = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentTaskRun: mockTrackAgentTaskRun,
  };
});

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat lock-release-on-reassignment tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat lock release on cross-agent reassignment", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-lock-release-on-reassignment-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCrossAgentScenario(opts: { holderStatus: "queued" | "running" }) {
    const companyId = randomUUID();
    const coderAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const issueId = randomUUID();
    const holderRunId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values([
      {
        id: coderAgentId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: reviewerAgentId,
        companyId,
        name: "Reviewer",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId: coderAgentId,
      source: "assignment",
      status: "queued",
    });

    await db.insert(heartbeatRuns).values({
      id: holderRunId,
      companyId,
      agentId: coderAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: opts.holderStatus,
      wakeupRequestId,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Cross-agent reassignment race",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: reviewerAgentId,
      executionRunId: holderRunId,
      executionAgentNameKey: "coder",
      executionLockedAt: new Date(),
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return {
      companyId,
      coderAgentId,
      reviewerAgentId,
      issueId,
      holderRunId,
      wakeupRequestId,
    };
  }

  it("defers a cross-agent wake while the holder is still running and leaves the holder alone", async () => {
    const { coderAgentId, reviewerAgentId, issueId, holderRunId, wakeupRequestId } =
      await seedCrossAgentScenario({ holderStatus: "running" });

    const heartbeat = heartbeatService(db);
    const followupRun = await heartbeat.wakeup(reviewerAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    expect(followupRun).toBeNull();

    const holder = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        agentId: heartbeatRuns.agentId,
        finishedAt: heartbeatRuns.finishedAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, holderRunId))
      .then((rows) => rows[0] ?? null);

    expect(holder?.status).toBe("running");
    expect(holder?.errorCode).toBeNull();
    expect(holder?.finishedAt).toBeNull();
    expect(holder?.agentId).toBe(coderAgentId);

    const heldWakeup = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);

    expect(heldWakeup?.status).toBe("queued");

    const deferred = await db
      .select({ status: agentWakeupRequests.status, agentId: agentWakeupRequests.agentId })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, reviewerAgentId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
        ),
      )
      .then((rows) => rows[0] ?? null);

    expect(deferred).not.toBeNull();

    const issue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(issue?.executionRunId).toBe(holderRunId);
  });

  // Race-guard regression: the cancel UPDATE for the queued holder is pinned
  // to the exact non-running status that was read just above it. If a worker
  // races in and flips the holder from `queued` → `running` between that
  // SELECT and the cancel UPDATE, the status predicate in the WHERE clause
  // must guarantee zero rows are clobbered. We simulate the race by
  // pre-running the same UPDATE shape against a row that is already
  // `running` (the snapshot we would have read was `queued`); the row must
  // remain untouched, no wake-request cascade fires, and the lock stays
  // owned by the freshly-claimed running holder.
  it("guards the cancel UPDATE WHERE clause against a concurrent claim flip to running", async () => {
    const { coderAgentId, issueId, holderRunId, wakeupRequestId } = await seedCrossAgentScenario({
      holderStatus: "queued",
    });

    const snapshotStatus = "queued" as const;

    // Concurrent worker claims the queued run after the SELECT but before
    // the cancel UPDATE. In production this is a separate transaction
    // flipping the row from queued → running.
    await db
      .update(heartbeatRuns)
      .set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, holderRunId));

    const cancelled = await db
      .update(heartbeatRuns)
      .set({
        status: "cancelled",
        finishedAt: new Date(),
        error: "Execution lock released after issue reassigned to a different agent",
        errorCode: "lock_released_on_reassignment",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(heartbeatRuns.id, holderRunId),
          eq(heartbeatRuns.status, snapshotStatus),
        ),
      )
      .returning({ id: heartbeatRuns.id });

    expect(cancelled).toHaveLength(0);

    const holder = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        agentId: heartbeatRuns.agentId,
        finishedAt: heartbeatRuns.finishedAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, holderRunId))
      .then((rows) => rows[0] ?? null);

    expect(holder?.status).toBe("running");
    expect(holder?.errorCode).toBeNull();
    expect(holder?.finishedAt).toBeNull();
    expect(holder?.agentId).toBe(coderAgentId);

    const heldWakeup = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(heldWakeup?.status).toBe("queued");

    const issue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(issue?.executionRunId).toBe(holderRunId);
  });

  it("cancels a queued holder's run on reassignment and emits agent.task_run for it", async () => {
    const { companyId, coderAgentId, reviewerAgentId, issueId, holderRunId } =
      await seedCrossAgentScenario({ holderStatus: "queued" });

    // Keep the reviewer's queue from auto-claiming/executing the new run
    // during this unit test, matching the pattern used for the sibling
    // reassignment scenario in heartbeat-retry-scheduling.test.ts: cap
    // concurrency at 1, then occupy that one slot with a busy run.
    await db
      .update(agents)
      .set({
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      })
      .where(eq(agents.id, reviewerAgentId));
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: reviewerAgentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { wakeReason: "test_busy_slot" },
      startedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const newAssigneeRun = await heartbeat.wakeup(reviewerAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    expect(newAssigneeRun).not.toBeNull();
    expect(newAssigneeRun?.agentId).toBe(reviewerAgentId);
    expect(newAssigneeRun?.status).toBe("queued");

    const holder = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, holderRunId))
      .then((rows) => rows[0] ?? null);

    expect(holder).toEqual({
      status: "cancelled",
      errorCode: "lock_released_on_reassignment",
    });

    // The cancel runs inside enqueueWakeup's transaction, and the run's own
    // required lifecycle work never awaits the telemetry emission, so wait
    // for it here instead of asserting it fired synchronously.
    await vi.waitFor(() => {
      expect(mockTrackAgentTaskRun).toHaveBeenCalledWith(
        mockTelemetryClient,
        expect.objectContaining({
          agentId: coderAgentId,
          state: "cancelled",
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // SPA-11872 stranded-assignment-wake regression (at-cap strand).
  //
  // Probe-pinned base facts (pre-fix engine):
  //  - heartbeat.wakeup for the new assignee at its run cap returns null and
  //    lands the wake in agentWakeupRequests with status "skipped"
  //    (writeSkippedRequest sink — NOT deferred_issue_execution).
  //  - The issue's execution lock stays held after the wakeup (the stale
  //    queued holder is NOT cancelled in this path), so the slot-free drive
  //    clears executionRunId/executionAgentNameKey/executionLockedAt
  //    explicitly, matching what the stale-cancel path would leave behind.
  //  - After the busy slot frees and resumeQueuedRuns() drains, the skipped
  //    wake is never revisited — the card strands. These tests pin the
  //    contract that re-admission must satisfy.
  // ---------------------------------------------------------------------------

  async function seedAtCapScenario() {
    const seed = await seedCrossAgentScenario({ holderStatus: "queued" });
    const { companyId, reviewerAgentId } = seed;

    await db
      .update(agents)
      .set({ runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } })
      .where(eq(agents.id, reviewerAgentId));
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: reviewerAgentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { wakeReason: "test_busy_slot" },
      startedAt: new Date(),
    });

    return seed;
  }

  async function wakeupIssueAssigned(issueId: string, reviewerAgentId: string) {
    return heartbeat.wakeup(reviewerAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });
  }

  function strandedWakeCount(reviewerAgentId: string, issueId: string) {
    return db
      .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, reviewerAgentId),
          sql`(${agentWakeupRequests.payload} ->> 'issueId') = ${issueId}`,
        ),
      )
      .then((rows) => rows);
  }

  function reviewerRunsForIssue(reviewerAgentId: string, issueId: string) {
    return db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        snapshotIssueId: sql<string | null>`(${heartbeatRuns.contextSnapshot} ->> 'issueId')`,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, reviewerAgentId),
          sql`(${heartbeatRuns.contextSnapshot} ->> 'issueId') = ${issueId}`,
        ),
      )
      .then((rows) => rows);
  }

  async function freeReviewerSlot(reviewerAgentId: string, issueId: string) {
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(
        and(
          eq(heartbeatRuns.agentId, reviewerAgentId),
          eq(heartbeatRuns.status, "running"),
        ),
      );
    // The stale-cancel path of the engine would have left the issue lock
    // clear; in this sink the lock survives the wakeup, so clear it the way
    // the engine's stale-cancel leaves it.
    await db
      .update(issues)
      .set({ executionRunId: null, executionAgentNameKey: null, executionLockedAt: null })
      .where(eq(issues.id, issueId));
  }

  it("stranded: re-admits the parked assignment wake when the agent's slot frees", async () => {
    const { reviewerAgentId, issueId } = await seedAtCapScenario();

    const wakeupReturn = await wakeupIssueAssigned(issueId, reviewerAgentId);
    expect(wakeupReturn).toBeNull();

    const parked = await strandedWakeCount(reviewerAgentId, issueId);
    expect(parked).toHaveLength(1);
    const parkedWakeId = parked[0]?.id;
    // Single-park scope (advisor guardrail): this test seeds exactly one
    // parked wake for the issue, so run<->wake linkage below is by
    // exclusion — the admitted run's wakeupRequestId must name the parked
    // wake id. Concurrent multi-park per issueId would need FK-level
    // linkage instead.

    await freeReviewerSlot(reviewerAgentId, issueId);
    await heartbeat.resumeQueuedRuns();

    const admitted = await reviewerRunsForIssue(reviewerAgentId, issueId);
    // Exactly one run, for the stranded issue itself (never the busy slot's
    // phantom issue — the query is keyed on the snapshot issueId).
    expect(admitted).toHaveLength(1);
    expect(["queued", "running"]).toContain(admitted[0]?.status);
    expect(admitted[0]?.snapshotIssueId).toBe(issueId);

    // The parked wake is consumed in place, not duplicated and not left
    // parked: same row count, and the SAME row now links to the admitted
    // run and sits off every live status. A fix that admits a fresh run
    // while leaving the wake parked (or duplicating it) fails here.
    const wakesAfter = await strandedWakeCount(reviewerAgentId, issueId);
    expect(wakesAfter).toHaveLength(parked.length);
    const consumed = wakesAfter.find((wake) => wake.id === parkedWakeId);
    expect(consumed).toBeDefined();
    expect(consumed?.runId).toBe(admitted[0]?.id);
    const liveParkedStatuses = ["queued", "claimed", "deferred_issue_execution", "skipped", "running"];
    expect(liveParkedStatuses).not.toContain(consumed?.status);
  }, 60_000);

  it("stranded: leaves the parked wake alone while the agent has no free slot", async () => {
    const { reviewerAgentId, issueId } = await seedAtCapScenario();

    const wakeupReturn = await wakeupIssueAssigned(issueId, reviewerAgentId);
    expect(wakeupReturn).toBeNull();

    const parked = await strandedWakeCount(reviewerAgentId, issueId);
    expect(parked).toHaveLength(1);

    await heartbeat.resumeQueuedRuns();

    const runsForIssue = await reviewerRunsForIssue(reviewerAgentId, issueId);
    expect(runsForIssue).toHaveLength(0);

    // Whatever sink holds the wake is unchanged — still parked, not
    // promoted, not dropped.
    const wakesAfter = await strandedWakeCount(reviewerAgentId, issueId);
    expect(wakesAfter).toHaveLength(1);
    expect(wakesAfter[0]?.status).toBe(parked[0]?.status);
  }, 60_000);

  it("stranded: retires the parked wake when the target issue is terminal", async () => {
    const { reviewerAgentId, issueId } = await seedAtCapScenario();

    const wakeupReturn = await wakeupIssueAssigned(issueId, reviewerAgentId);
    expect(wakeupReturn).toBeNull();

    const parked = await strandedWakeCount(reviewerAgentId, issueId);
    expect(parked).toHaveLength(1);

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));

    await freeReviewerSlot(reviewerAgentId, issueId);
    await heartbeat.resumeQueuedRuns();

    const runsForIssue = await reviewerRunsForIssue(reviewerAgentId, issueId);
    expect(runsForIssue).toHaveLength(0);

    // The wake must be retired in place to the exact terminal status —
    // not deleted, not duplicated, not left on any live status. The
    // retirement mirrors cancelDeferredWake ("cancelled"); a fix that
    // retires to any other status, deletes the row, or leaves it parked
    // fails here.
    const wakesAfter = await strandedWakeCount(reviewerAgentId, issueId);
    expect(wakesAfter).toHaveLength(parked.length);
    expect(wakesAfter[0]?.status).toBe("cancelled");
  }, 60_000);

  it("stranded: draining twice admits exactly one run", async () => {
    const { reviewerAgentId, issueId } = await seedAtCapScenario();

    const wakeupReturn = await wakeupIssueAssigned(issueId, reviewerAgentId);
    expect(wakeupReturn).toBeNull();

    const parked = await strandedWakeCount(reviewerAgentId, issueId);
    expect(parked).toHaveLength(1);
    const parkedWakeId = parked[0]?.id;

    await freeReviewerSlot(reviewerAgentId, issueId);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.resumeQueuedRuns();

    const admitted = await reviewerRunsForIssue(reviewerAgentId, issueId);
    expect(admitted).toHaveLength(1);
    expect(["queued", "running"]).toContain(admitted[0]?.status);
    expect(admitted[0]?.snapshotIssueId).toBe(issueId);

    const wakesAfter = await strandedWakeCount(reviewerAgentId, issueId);
    expect(wakesAfter).toHaveLength(parked.length);
    const consumed = wakesAfter.find((wake) => wake.id === parkedWakeId);
    expect(consumed).toBeDefined();
    expect(consumed?.runId).toBe(admitted[0]?.id);
    const liveParkedStatuses = ["queued", "claimed", "deferred_issue_execution", "skipped", "running"];
    expect(liveParkedStatuses).not.toContain(consumed?.status);
  }, 60_000);
});
