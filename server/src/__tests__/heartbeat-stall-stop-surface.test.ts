import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import {
  STALL_STOP_SURFACE_HELD_REASON,
  STALL_STOP_SURFACE_MARKER,
  STALL_STOP_SURFACE_TRIPPED_REASON,
  isHumanStatusChangeReset,
} from "../services/stall-stop-surface.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Stall stop-and-surface test run.",
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
    `Skipping embedded Postgres stall stop-and-surface tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat stall stop-and-surface", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-stall-stop-surface-");
    db = createDb(tempDb.connectionString);
    // The engine suppresses ALL scheduling (wakeup writes a
    // "heartbeat.scheduling_suppressed" skipped receipt and returns null)
    // when PAPERCLIP_IN_WORKTREE is truthy — which it is inside this repo's
    // own engine worktrees. Same bypass as
    // heartbeat-lock-release-on-reassignment.test.ts lines 61-66.
    heartbeat = heartbeatService(db, {
      runtimeEnv: { PAPERCLIP_IN_WORKTREE: "false" },
    });
  }, 20_000);

  afterEach(async () => {
    runningProcesses.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.delete(environmentLeases);
        await db.delete(issueComments);
        await db.delete(issues);
        await db.delete(heartbeatRunEvents);
        await db.delete(activityLog);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentRuntimeState);
        await db.delete(agents);
        await db.delete(environments);
        await db.delete(executionWorkspaces);
        await db.delete(companySkills);
        await db.delete(companies);
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAgentIssue() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
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
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stalled model stream mission",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });

    return { companyId, agentId, issueId };
  }

  async function seedStalledRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    finishedSecondsAgo: number;
  }) {
    const runId = randomUUID();
    const finishedAt = new Date(Date.now() - input.finishedSecondsAgo * 1000);
    const startedAt = new Date(finishedAt.getTime() - 5_000);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      status: "failed",
      errorCode: "model_stream_stalled",
      responsibleUserId: "responsible-user",
      createdAt: startedAt,
      startedAt,
      finishedAt,
      contextSnapshot: { issueId: input.issueId, wakeReason: "issue_assigned" },
    });
    return runId;
  }

  function breakerWake(agentId: string, issueId: string) {
    return heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_continuation_needed",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "issue_continuation_needed" },
      requestedByActorType: "system",
      requestedByActorId: "test",
    });
  }

  function commentWake(
    agentId: string,
    issueId: string,
    commentId: string,
    actor: { type: "user" | "system"; id: string },
  ) {
    return heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId },
      contextSnapshot: {
        issueId,
        wakeReason: "issue_commented",
        wakeCommentId: commentId,
      },
      requestedByActorType: actor.type,
      requestedByActorId: actor.id,
    });
  }

  function deferredCommentWake(agentId: string, issueId: string) {
    return heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "deferred_comment_wake",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "deferred_comment_wake" },
      requestedByActorType: "system",
      requestedByActorId: "test",
    });
  }

  async function runCount(companyId: string) {
    return db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId))
      .then((rows) => rows.length);
  }

  async function latestWakeReason(agentId: string) {
    return db
      .select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(desc(agentWakeupRequests.requestedAt))
      .limit(1)
      .then((rows) => rows[0]?.reason ?? null);
  }

  async function markerComments(issueId: string) {
    const rows = await db
      .select({
        authorType: issueComments.authorType,
        body: issueComments.body,
        createdAt: issueComments.createdAt,
      })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    return rows.filter(
      (row) =>
        row.authorType === "system" && row.body.startsWith(STALL_STOP_SURFACE_MARKER),
    );
  }

  async function issueStatus(issueId: string) {
    return db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]?.status ?? null);
  }

  it("R1: three same-code stalls hold the breaker, comment, and deferred-comment wakes with zero runs started", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedStalledRun({ companyId, agentId, issueId, finishedSecondsAgo: 120 });
    await seedStalledRun({ companyId, agentId, issueId, finishedSecondsAgo: 80 });
    await seedStalledRun({ companyId, agentId, issueId, finishedSecondsAgo: 40 });

    expect(await breakerWake(agentId, issueId)).toBeNull();

    const boardCommentId = randomUUID();
    await db.insert(issueComments).values({
      id: boardCommentId,
      companyId,
      issueId,
      authorType: "user",
      authorUserId: "board-user",
      body: "Any update on this card?",
    });
    expect(
      await commentWake(agentId, issueId, boardCommentId, { type: "user", id: "board-user" }),
    ).toBeNull();

    expect(await deferredCommentWake(agentId, issueId)).toBeNull();

    expect(await runCount(companyId)).toBe(3);
    expect(await latestWakeReason(agentId)).toBe(STALL_STOP_SURFACE_HELD_REASON);
  });

  it("binding: two same-code stalls still start a run on a breaker wake", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedStalledRun({ companyId, agentId, issueId, finishedSecondsAgo: 120 });
    await seedStalledRun({ companyId, agentId, issueId, finishedSecondsAgo: 40 });

    const wake = await breakerWake(agentId, issueId);
    expect(wake).not.toBeNull();
    expect(await runCount(companyId)).toBe(3);
  });

  it("R2: three same-code stalls spread beyond the 6h window still hold the breaker", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedStalledRun({ companyId, agentId, issueId, finishedSecondsAgo: 25000 });
    await seedStalledRun({ companyId, agentId, issueId, finishedSecondsAgo: 20000 });
    await seedStalledRun({ companyId, agentId, issueId, finishedSecondsAgo: 15000 });

    expect(await breakerWake(agentId, issueId)).toBeNull();
    expect(await runCount(companyId)).toBe(3);
  });

  it("R2: a mid-streak human todo→in_progress resets the streak so the next wake starts a run", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    await db
      .update(issues)
      .set({ status: "todo" })
      .where(eq(issues.id, issueId));

    await seedStalledRun({ companyId, agentId, issueId, finishedSecondsAgo: 300 });
    await seedStalledRun({ companyId, agentId, issueId, finishedSecondsAgo: 200 });
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: { _previous: { status: "todo" }, status: "in_progress" },
      createdAt: new Date(Date.now() - 100_000),
    });
    await seedStalledRun({ companyId, agentId, issueId, finishedSecondsAgo: 50 });

    const wake = await breakerWake(agentId, issueId);
    expect(wake).not.toBeNull();
    expect(await runCount(companyId)).toBe(4);
  });

  it("R2: an agent-authored status change does not reset the streak — the stop still holds", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedStalledRun({ companyId, agentId, issueId, finishedSecondsAgo: 300 });
    await seedStalledRun({ companyId, agentId, issueId, finishedSecondsAgo: 200 });
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: randomUUID(),
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: { _previous: { status: "todo" }, status: "in_progress" },
    });
    await seedStalledRun({ companyId, agentId, issueId, finishedSecondsAgo: 50 });

    expect(await breakerWake(agentId, issueId)).toBeNull();
    expect(await runCount(companyId)).toBe(3);
    expect(await latestWakeReason(agentId)).toBe(STALL_STOP_SURFACE_TRIPPED_REASON);
  });

  it("R3: after the trip the issue reads blocked with exactly one marker comment", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedStalledRun({ companyId, agentId, issueId, finishedSecondsAgo: 120 });
    await seedStalledRun({ companyId, agentId, issueId, finishedSecondsAgo: 80 });
    await seedStalledRun({ companyId, agentId, issueId, finishedSecondsAgo: 40 });

    expect(await breakerWake(agentId, issueId)).toBeNull();

    expect(await issueStatus(issueId)).toBe("blocked");
    expect((await markerComments(issueId)).length).toBe(1);
  });

  it("pure units: isHumanStatusChangeReset admits only real human transitions", () => {
    expect(isHumanStatusChangeReset("user", "todo", "in_progress")).toBe(true);
    expect(isHumanStatusChangeReset("agent", "todo", "in_progress")).toBe(false);
    expect(isHumanStatusChangeReset("user", "todo", "todo")).toBe(false);
    expect(isHumanStatusChangeReset("user", null, "in_progress")).toBe(false);
    expect(isHumanStatusChangeReset("user", "todo", null)).toBe(false);
    expect(isHumanStatusChangeReset(null, "todo", "in_progress")).toBe(false);
  });
});
