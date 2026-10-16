import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
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
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { runningProcesses } from "../adapters/index.ts";
import { ISSUE_REWAKE_CIRCUIT_BREAKER_NOTICE_PREFIX } from "../services/issue-rewake-throttle.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Issue rewake circuit breaker test run.",
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
    `Skipping embedded Postgres issue rewake circuit breaker tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat issue rewake circuit breaker", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-issue-rewake-circuit-breaker-");
    db = createDb(tempDb.connectionString);
    // Default breaker threshold (3) applies unless a test overrides it.
    heartbeat = heartbeatService(db, { runtimeEnv: {} });
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

  async function seedCompanyAgentIssue(input?: { assigneeUserId?: string | null }) {
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
      title: "Stuck no-progress card",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      assigneeUserId: input?.assigneeUserId ?? null,
      responsibleUserId: "responsible-user",
    });

    return { companyId, agentId, issueId };
  }

  async function seedTerminalRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    status?: string;
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
      status: input.status ?? "succeeded",
      responsibleUserId: "responsible-user",
      createdAt: startedAt,
      startedAt,
      finishedAt,
      contextSnapshot: { issueId: input.issueId, wakeReason: "issue_continuation_needed" },
    });
    return runId;
  }

  function continuationWake(
    hb: ReturnType<typeof heartbeatService>,
    agentId: string,
    issueId: string,
  ) {
    return hb.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_continuation_needed",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "issue_continuation_needed" },
      requestedByActorType: "system",
      requestedByActorId: "test",
    });
  }

  async function latestWakeRequest(agentId: string) {
    return db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(desc(agentWakeupRequests.requestedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function loadIssue(issueId: string) {
    return db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
  }

  async function issueComment_count(issueId: string, bodyPrefix?: string) {
    const rows = await db
      .select({ id: issueComments.id, body: issueComments.body, authorType: issueComments.authorType })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    return bodyPrefix ? rows.filter((row) => row.body.startsWith(bodyPrefix)) : rows;
  }

  it("trips after 3 consecutive no-progress runs: backlog, one comment, no further wake", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    // Seed exactly 3 consecutive no-progress (succeeded, no issue activity)
    // terminal runs, oldest first, all inside the lookback window.
    const runIds = [
      await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 300 }),
      await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 200 }),
      await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 100 }),
    ];

    const wake = await continuationWake(heartbeat, agentId, issueId);
    expect(wake).toBeNull();

    const skipped = await latestWakeRequest(agentId);
    expect(skipped?.status).toBe("skipped");
    expect(skipped?.reason).toBe("issue_rewake_circuit_breaker_tripped");
    const heartbeatSkip = (skipped?.payload as Record<string, unknown> | null)?.heartbeatSkip as
      | Record<string, unknown>
      | undefined;
    expect(heartbeatSkip?.noProgressStreak).toBe(3);
    expect(heartbeatSkip?.runIds).toEqual([runIds[2], runIds[1], runIds[0]]);

    const issueRow = await loadIssue(issueId);
    expect(issueRow?.status).toBe("backlog");
    // Breaker trip preserves the assignee so a human can see who was stuck.
    expect(issueRow?.assigneeAgentId).toBe(agentId);

    const notices = await issueComment_count(issueId, ISSUE_REWAKE_CIRCUIT_BREAKER_NOTICE_PREFIX);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.authorType).toBe("system");

    // No run was started.
    const runCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId))
      .then((rows) => rows[0]?.count ?? 0);
    expect(runCount).toBe(3);

    // A second continuation wake attempt (e.g. a retry of the same stale
    // trigger) does not duplicate the comment and does not resurrect the
    // card, because it is no longer `in_progress`.
    const secondWake = await continuationWake(heartbeat, agentId, issueId);
    expect(secondWake).toBeNull();
    const noticesAfterRetry = await issueComment_count(issueId, ISSUE_REWAKE_CIRCUIT_BREAKER_NOTICE_PREFIX);
    expect(noticesAfterRetry).toHaveLength(1);
    const issueRowAfterRetry = await loadIssue(issueId);
    expect(issueRowAfterRetry?.status).toBe("backlog");
  });

  it("resets the streak when a run in between made issue-visible progress", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 300 });
    const progressRunId = await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 200 });
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      runId: progressRunId,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: issueId,
      createdAt: new Date(Date.now() - 199_000),
    });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 100 });

    const wake = await continuationWake(heartbeat, agentId, issueId);
    // Only 1 no-progress run since the progress run broke the streak, so the
    // breaker does not trip (and the ordinary throttle threshold of 2 is
    // also not yet reached).
    expect(wake).not.toBeNull();

    const issueRow = await loadIssue(issueId);
    expect(issueRow?.status).toBe("in_progress");
    const notices = await issueComment_count(issueId, ISSUE_REWAKE_CIRCUIT_BREAKER_NOTICE_PREFIX);
    expect(notices).toHaveLength(0);
  });

  it("resets on a human comment even during an otherwise no-progress streak", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 300 });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 200 });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 100 });

    // A human comment landed after the last run finished: new issue input,
    // so the next event-free wake is admitted and the breaker never
    // evaluates the streak as tripping.
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "issue.comment_added",
      entityType: "issue",
      entityId: issueId,
    });

    const wake = await continuationWake(heartbeat, agentId, issueId);
    expect(wake).not.toBeNull();

    const issueRow = await loadIssue(issueId);
    expect(issueRow?.status).toBe("in_progress");
    const notices = await issueComment_count(issueId, ISSUE_REWAKE_CIRCUIT_BREAKER_NOTICE_PREFIX);
    expect(notices).toHaveLength(0);
  });

  it("does not count an adapter_failed run toward the no-progress streak", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 400 });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 300 });
    // A failed run breaks the no-progress streak entirely (recovery, not a
    // redundant re-poll) — even though it precedes two more no-progress runs,
    // the streak measured from the newest run backward stops at the failure.
    await seedTerminalRun({ companyId, agentId, issueId, status: "failed", finishedSecondsAgo: 200 });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 100 });

    const wake = await continuationWake(heartbeat, agentId, issueId);
    expect(wake).not.toBeNull();

    const issueRow = await loadIssue(issueId);
    expect(issueRow?.status).toBe("in_progress");
    const notices = await issueComment_count(issueId, ISSUE_REWAKE_CIRCUIT_BREAKER_NOTICE_PREFIX);
    expect(notices).toHaveLength(0);
  });

  it("never trips for a card assigned to a human user", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue({
      assigneeUserId: "a-human-user",
    });

    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 300 });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 200 });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 100 });

    // The breaker must not trip; the ordinary cooldown throttle may still
    // apply (it is a separate, non-destructive mechanism), so only assert on
    // what the breaker itself owns: issue status and the notice comment.
    await continuationWake(heartbeat, agentId, issueId);

    const issueRow = await loadIssue(issueId);
    expect(issueRow?.status).toBe("in_progress");
    const notices = await issueComment_count(issueId, ISSUE_REWAKE_CIRCUIT_BREAKER_NOTICE_PREFIX);
    expect(notices).toHaveLength(0);
    const skipped = await latestWakeRequest(agentId);
    expect(skipped?.reason).not.toBe("issue_rewake_circuit_breaker_tripped");
  });

  it("honors a configured threshold lower than the default", async () => {
    const lowThresholdHeartbeat = heartbeatService(db, {
      runtimeEnv: { PAPERCLIP_ISSUE_REWAKE_CIRCUIT_BREAKER_THRESHOLD: "2" },
    });
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 200 });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 100 });

    const wake = await continuationWake(lowThresholdHeartbeat, agentId, issueId);
    expect(wake).toBeNull();

    const issueRow = await loadIssue(issueId);
    expect(issueRow?.status).toBe("backlog");
    const notices = await issueComment_count(issueId, ISSUE_REWAKE_CIRCUIT_BREAKER_NOTICE_PREFIX);
    expect(notices).toHaveLength(1);
  });
});
