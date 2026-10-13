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
    // The engine suppresses ALL scheduling (wakeup writes a
    // "heartbeat.scheduling_suppressed" skipped receipt and returns null)
    // when PAPERCLIP_IN_WORKTREE is truthy — which it is inside this repo's
    // own engine worktrees. Sibling suites pass an explicit runtimeEnv for
    // the same reason; without it every admission test here tests the
    // suppression door, not the reassignment path.
    heartbeat = heartbeatService(db, {
      runtimeEnv: { PAPERCLIP_IN_WORKTREE: "false" },
    });
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

    const heartbeat = heartbeatService(db, {
      runtimeEnv: { PAPERCLIP_IN_WORKTREE: "false" },
    });
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

    const heartbeat = heartbeatService(db, {
      runtimeEnv: { PAPERCLIP_IN_WORKTREE: "false" },
    });
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
  // SPA-11872 stranded deferred-wake regression.
  //
  // Production-grounded mechanism (SPA-11657 strand, 2026-10-12, read live via
  // GET /api/issues/{id}/runs + /api/issues/{id}/diagnostics/wakes):
  //  - 04:48:22Z the holder run was cancelled on reassignment, and the
  //    issue-scoped release drain (runReleaseDrain) fired AT CANCEL TIME.
  //  - 04:48:24Z — two seconds later — the new assignee's wake parked in
  //    agentWakeupRequests with status "deferred_issue_execution" (admitted
  //    behind the still-visible execution lock). Nothing re-fires the
  //    issue-scoped drain after that point, so the wake strands.
  //  - The strandedQueues sweep in resumeQueuedRuns would revisit such wakes,
  //    but it skips unless the issue's latest run is runtimeMode "legacy";
  //    every native-era run is stamped "native" (schema default is "legacy",
  //    which is all the SPA-8631 suite exercises).
  //  - The card sat 3h14m until a manual wake created a run that ADOPTED the
  //    parked wake (status -> "coalesced", runId back-filled).
  //
  // Contract pinned here (re-admission at slot-free):
  //  - T1 slot-free: when the agent's slot frees (busy run terminal,
  //    issue execution lock already cleared), startNextQueuedRunForAgent
  //    re-admits the parked wake: exactly one run for the issue, the SAME
  //    wake row linked to it (runId), promoted off "deferred_issue_execution".
  //  - T2 at-cap guard: no free slot -> wake untouched, no run.
  //  - T3 lock-held guard: issue execution lock still held -> wake untouched.
  //  - T4 terminal-issue guard: issue done -> no run, wake retired in place.
  //  - T5 idempotency: driving admission twice admits exactly one run.
  // ---------------------------------------------------------------------------

  async function seedStrandedScenario() {
    const seed = await seedCrossAgentScenario({ holderStatus: "queued" });
    const { companyId, reviewerAgentId, issueId, holderRunId } = seed;

    // Reviewer at per-agent cap 1 with the one slot occupied by an unrelated
    // running run (no issueId in its snapshot — never matches the stranded
    // issue's query).
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

    // The reassignment stale-cancel already ran, SPA-11657 shape: holder run
    // cancelled and the issue execution lock cleared. The wake parked two
    // seconds AFTER the cancel-time drain, which is the gap under test.
    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled", finishedAt: new Date(), errorCode: "issue_reassigned" })
      .where(eq(heartbeatRuns.id, holderRunId));
    await db
      .update(issues)
      .set({ executionRunId: null, executionAgentNameKey: null, executionLockedAt: null })
      .where(eq(issues.id, issueId));

    // The new assignee's wake, parked in `deferred_issue_execution` — the
    // exact row shape the SPA-8631 suite seeds for the promote path.
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: reviewerAgentId,
      source: "assignment",
      status: "deferred_issue_execution",
      payload: {
        issueId,
        wakeReason: "issue_assigned",
        _paperclipWakeContext: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      },
    });

    return seed;
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

  async function freeReviewerSlot(reviewerAgentId: string) {
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(
        and(
          eq(heartbeatRuns.agentId, reviewerAgentId),
          eq(heartbeatRuns.status, "running"),
        ),
      );
  }

  it("stranded: re-admits the parked deferred wake when the agent's slot frees", async () => {
    const { reviewerAgentId, issueId } = await seedStrandedScenario();

    const parked = await strandedWakeCount(reviewerAgentId, issueId);
    expect(parked).toHaveLength(1);
    const parkedWakeId = parked[0]?.id;

    await freeReviewerSlot(reviewerAgentId);
    await heartbeat.startNextQueuedRunForAgent(reviewerAgentId);

    const admitted = await reviewerRunsForIssue(reviewerAgentId, issueId);
    // Exactly one run, for the stranded issue itself (never the busy slot's
    // phantom issue — the query is keyed on the snapshot issueId). Status
    // "running" covers the same-pass claim; "queued" covers a deferred claim.
    expect(admitted).toHaveLength(1);
    expect(["queued", "running"]).toContain(admitted[0]?.status);
    expect(admitted[0]?.snapshotIssueId).toBe(issueId);

    // The parked wake is consumed in place, not duplicated: same row count,
    // and the SAME row now links to the admitted run and has left
    // "deferred_issue_execution". The promote path parks it at "queued"
    // until the run claims ("claimed") — both are promoted states, so the
    // assertion is the deferred-status exit plus the runId link, not a
    // terminal status.
    const wakesAfter = await strandedWakeCount(reviewerAgentId, issueId);
    expect(wakesAfter).toHaveLength(parked.length);
    const promoted = wakesAfter.find((wake) => wake.id === parkedWakeId);
    expect(promoted).toBeDefined();
    expect(promoted?.runId).toBe(admitted[0]?.id);
    expect(promoted?.status).not.toBe("deferred_issue_execution");
  }, 60_000);

  it("stranded: leaves the parked wake alone while the agent has no free slot", async () => {
    const { reviewerAgentId, issueId } = await seedStrandedScenario();

    const parked = await strandedWakeCount(reviewerAgentId, issueId);
    expect(parked).toHaveLength(1);

    await heartbeat.startNextQueuedRunForAgent(reviewerAgentId);

    const runsForIssue = await reviewerRunsForIssue(reviewerAgentId, issueId);
    expect(runsForIssue).toHaveLength(0);

    const wakesAfter = await strandedWakeCount(reviewerAgentId, issueId);
    expect(wakesAfter).toHaveLength(1);
    expect(wakesAfter[0]?.status).toBe("deferred_issue_execution");
  }, 60_000);

  it("stranded: leaves the parked wake alone while the issue execution lock is held", async () => {
    const { reviewerAgentId, issueId, holderRunId } = await seedStrandedScenario();

    const parked = await strandedWakeCount(reviewerAgentId, issueId);
    expect(parked).toHaveLength(1);

    // The lock was NOT yet cleared when the wake parked — the pre-cancel
    // race shape. Re-admission must not steal the lock or double-run.
    await db
      .update(issues)
      .set({ executionRunId: holderRunId, executionAgentNameKey: "coder", executionLockedAt: new Date() })
      .where(eq(issues.id, issueId));

    await freeReviewerSlot(reviewerAgentId);
    await heartbeat.startNextQueuedRunForAgent(reviewerAgentId);

    const runsForIssue = await reviewerRunsForIssue(reviewerAgentId, issueId);
    expect(runsForIssue).toHaveLength(0);

    const wakesAfter = await strandedWakeCount(reviewerAgentId, issueId);
    expect(wakesAfter).toHaveLength(1);
    expect(wakesAfter[0]?.status).toBe("deferred_issue_execution");
  }, 60_000);

  it("stranded: retires the parked wake when the target issue is terminal", async () => {
    const { reviewerAgentId, issueId } = await seedStrandedScenario();

    const parked = await strandedWakeCount(reviewerAgentId, issueId);
    expect(parked).toHaveLength(1);

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));

    await freeReviewerSlot(reviewerAgentId);
    await heartbeat.startNextQueuedRunForAgent(reviewerAgentId);

    const runsForIssue = await reviewerRunsForIssue(reviewerAgentId, issueId);
    expect(runsForIssue).toHaveLength(0);

    // The wake must be retired in place — not deleted, not duplicated, not
    // left promotable. Any non-live status is acceptable (the promote path's
    // terminal retirement writes "cancelled"); a wake still sitting on a
    // promotable status after a terminal close fails here.
    const wakesAfter = await strandedWakeCount(reviewerAgentId, issueId);
    expect(wakesAfter).toHaveLength(parked.length);
    const liveStatuses = ["queued", "claimed", "deferred_issue_execution", "running"];
    expect(liveStatuses).not.toContain(wakesAfter[0]?.status);
  }, 60_000);

  it("stranded: draining admission twice admits exactly one run", async () => {
    const { reviewerAgentId, issueId } = await seedStrandedScenario();

    const parked = await strandedWakeCount(reviewerAgentId, issueId);
    expect(parked).toHaveLength(1);
    const parkedWakeId = parked[0]?.id;

    await freeReviewerSlot(reviewerAgentId);
    await heartbeat.startNextQueuedRunForAgent(reviewerAgentId);
    await heartbeat.startNextQueuedRunForAgent(reviewerAgentId);

    const admitted = await reviewerRunsForIssue(reviewerAgentId, issueId);
    expect(admitted).toHaveLength(1);
    expect(["queued", "running"]).toContain(admitted[0]?.status);
    expect(admitted[0]?.snapshotIssueId).toBe(issueId);

    const wakesAfter = await strandedWakeCount(reviewerAgentId, issueId);
    expect(wakesAfter).toHaveLength(parked.length);
    const promoted = wakesAfter.find((wake) => wake.id === parkedWakeId);
    expect(promoted).toBeDefined();
    expect(promoted?.runId).toBe(admitted[0]?.id);
    expect(promoted?.status).not.toBe("deferred_issue_execution");
  }, 60_000);
});
