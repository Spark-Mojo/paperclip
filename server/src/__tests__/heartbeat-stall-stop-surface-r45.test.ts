import { randomUUID } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
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
import { STALL_STOP_SURFACE_MARKER } from "../services/stall-stop-surface.js";
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
    `Skipping embedded Postgres stall stop-and-surface R4/R5 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat stall stop-and-surface R4/R5", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-stall-stop-surface-r45-");
    db = createDb(tempDb.connectionString);
    // The engine suppresses ALL scheduling (wakeup writes a
    // "heartbeat.scheduling_suppressed" skipped receipt and returns null)
    // when PAPERCLIP_IN_WORKTREE is truthy — which it is inside this repo's
    // own engine worktrees. Same pattern as the main suite
    // (heartbeat-stall-stop-surface.test.ts lines 74-80).
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

  async function runCount(companyId: string) {
    return db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId))
      .then((rows) => rows.length);
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

  it("R4: two further wakes keep exactly one marker and start no runs after the stop", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedStalledRun({ companyId, agentId, issueId, finishedSecondsAgo: 120 });
    await seedStalledRun({ companyId, agentId, issueId, finishedSecondsAgo: 80 });
    await seedStalledRun({ companyId, agentId, issueId, finishedSecondsAgo: 40 });

    expect(await breakerWake(agentId, issueId)).toBeNull();
    const [notice] = await markerComments(issueId);
    expect(notice).toBeDefined();
    const stopAt = notice!.createdAt;

    const boardCommentId = randomUUID();
    await db.insert(issueComments).values({
      id: boardCommentId,
      companyId,
      issueId,
      authorType: "user",
      authorUserId: "board-user",
      body: "Ping — still waiting.",
    });
    expect(
      await commentWake(agentId, issueId, boardCommentId, { type: "user", id: "board-user" }),
    ).toBeNull();
    expect(await breakerWake(agentId, issueId)).toBeNull();

    expect((await markerComments(issueId)).length).toBe(1);
    expect(await runCount(companyId)).toBe(3);
    const runsAfterStop = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          gt(heartbeatRuns.startedAt, stopAt),
        ),
      );
    expect(runsAfterStop.length).toBe(0);
  });

  it("R5: a bare board comment holds, then a human off-blocked move re-arms the next wake", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedStalledRun({ companyId, agentId, issueId, finishedSecondsAgo: 120 });
    await seedStalledRun({ companyId, agentId, issueId, finishedSecondsAgo: 80 });
    await seedStalledRun({ companyId, agentId, issueId, finishedSecondsAgo: 40 });

    expect(await breakerWake(agentId, issueId)).toBeNull();
    expect(await issueStatus(issueId)).toBe("blocked");

    const boardCommentId = randomUUID();
    await db.insert(issueComments).values({
      id: boardCommentId,
      companyId,
      issueId,
      authorType: "user",
      authorUserId: "board-user",
      body: "Bare board comment — not an unblock.",
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "issue.comment_added",
      entityType: "issue",
      entityId: issueId,
    });
    expect(
      await commentWake(agentId, issueId, boardCommentId, { type: "user", id: "board-user" }),
    ).toBeNull();
    expect(await runCount(companyId)).toBe(3);

    await db
      .update(issues)
      .set({ status: "todo" })
      .where(eq(issues.id, issueId));
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: { _previous: { status: "blocked" }, status: "todo" },
    });

    const rearmed = await breakerWake(agentId, issueId);
    expect(rearmed).not.toBeNull();
    expect(await runCount(companyId)).toBe(4);
  });
});
