import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
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
import { instanceSettingsService } from "../services/instance-settings.ts";
import { ISSUE_REWAKE_CIRCUIT_BREAKER_NOTICE_PREFIX } from "../services/issue-rewake-throttle.ts";
import { FINISH_SUCCESSFUL_RUN_HANDOFF_REASON } from "../services/recovery/successful-run-handoff.ts";

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

  function handoffWake(
    hb: ReturnType<typeof heartbeatService>,
    agentId: string,
    issueId: string,
  ) {
    return hb.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: FINISH_SUCCESSFUL_RUN_HANDOFF_REASON,
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: FINISH_SUCCESSFUL_RUN_HANDOFF_REASON },
      requestedByActorType: "system",
      requestedByActorId: "heartbeat",
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

  // --- Audit finding #1 (PR #211): finish_successful_run_handoff must also
  // be gated by the breaker, without changing the cooldown throttle's timing
  // for that reason. Production (measured 10-16): SPA-12493 alternated
  // 62 issue_continuation_needed / 58 finish_successful_run_handoff wakes.

  it("trips a loop driven only by finish_successful_run_handoff wakes", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    const runIds = [
      await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 300 }),
      await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 200 }),
      await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 100 }),
    ];

    const wake = await handoffWake(heartbeat, agentId, issueId);
    expect(wake).toBeNull();

    const skipped = await latestWakeRequest(agentId);
    expect(skipped?.reason).toBe("issue_rewake_circuit_breaker_tripped");
    const heartbeatSkip = (skipped?.payload as Record<string, unknown> | null)?.heartbeatSkip as
      | Record<string, unknown>
      | undefined;
    expect(heartbeatSkip?.noProgressStreak).toBe(3);
    expect(heartbeatSkip?.runIds).toEqual([runIds[2], runIds[1], runIds[0]]);

    const issueRow = await loadIssue(issueId);
    expect(issueRow?.status).toBe("backlog");
    const notices = await issueComment_count(issueId, ISSUE_REWAKE_CIRCUIT_BREAKER_NOTICE_PREFIX);
    expect(notices).toHaveLength(1);
  });

  it("does not apply the cooldown throttle's timing to finish_successful_run_handoff wakes below the breaker threshold", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    // 2 no-progress runs reach the ordinary throttle's own threshold
    // (ISSUE_REWAKE_NO_PROGRESS_THRESHOLD = 2) — for an ordinary throttled
    // reason this would be held back by the escalating cooldown. The
    // breaker's threshold (default 3) is not reached yet either. A handoff
    // wake is never an ordinary throttle candidate, so it must proceed
    // immediately — its timing is unchanged by this fix.
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 200 });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 100 });

    const wake = await handoffWake(heartbeat, agentId, issueId);
    expect(wake).not.toBeNull();

    const latest = await latestWakeRequest(agentId);
    expect(latest?.reason).not.toBe("issue_rewake_throttled");
    expect(latest?.reason).not.toBe("issue_rewake_circuit_breaker_tripped");
  });

  // --- Audit finding #2 (PR #211): delegation (a child issue doing the real
  // work, or a subagent commenting/acting on this issue under its own run
  // id) must veto a trip the breaker would otherwise make.

  it("never trips a parent that creates a child issue during each no-progress run", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    for (const finishedSecondsAgo of [300, 200, 100]) {
      const runId = await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo });
      const childId = randomUUID();
      const runStartedAt = new Date(Date.now() - finishedSecondsAgo * 1000 - 5_000);
      await db.insert(issues).values({
        id: childId,
        companyId,
        parentId: issueId,
        title: `Delegated child for run ${runId}`,
        status: "todo",
        priority: "medium",
        responsibleUserId: "responsible-user",
      });
      // The primary progress check only looks at activity against THIS
      // issue's own id under the orchestrator's sampled run ids — a row
      // scoped to the CHILD issue's id is exactly what it misses.
      await db.insert(activityLog).values({
        companyId,
        actorType: "agent",
        actorId: agentId,
        agentId,
        runId,
        action: "issue.child_created",
        entityType: "issue",
        entityId: childId,
        createdAt: new Date(runStartedAt.getTime() + 1_000),
      });
    }

    // The breaker must not trip (and must not touch the card) once the
    // child-delegation evidence is present. The ordinary cooldown throttle
    // is a separate, non-destructive mechanism that may still hold this
    // particular wake back on its own schedule — that is unrelated to this
    // fix, so only the breaker's own effects are asserted here (same
    // pattern as the human-assignee case above).
    await continuationWake(heartbeat, agentId, issueId);

    const issueRow = await loadIssue(issueId);
    expect(issueRow?.status).toBe("in_progress");
    const notices = await issueComment_count(issueId, ISSUE_REWAKE_CIRCUIT_BREAKER_NOTICE_PREFIX);
    expect(notices).toHaveLength(0);
    const skipped = await latestWakeRequest(agentId);
    expect(skipped?.reason).not.toBe("issue_rewake_circuit_breaker_tripped");
  });

  it("never trips when a subagent comments on this issue under its own run id each cycle", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const subagentId = randomUUID();
    await db.insert(agents).values({
      id: subagentId,
      companyId,
      name: "SubagentHelper",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    for (const finishedSecondsAgo of [300, 200, 100]) {
      await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo });
      const orchestratorStartedAt = new Date(Date.now() - finishedSecondsAgo * 1000 - 5_000);
      const subagentRunId = randomUUID();
      // During the orchestrator's own run in the same cycle (strictly
      // before it finishes), so this never reads as "new input after the
      // last run finished" for the ordinary throttle either — it is purely
      // delegated work the primary, run-id-scoped progress check cannot see.
      const subagentAt = new Date(orchestratorStartedAt.getTime() + 2_000);
      await db.insert(heartbeatRuns).values({
        id: subagentRunId,
        companyId,
        agentId: subagentId,
        invocationSource: "assignment",
        status: "succeeded",
        responsibleUserId: "responsible-user",
        createdAt: subagentAt,
        startedAt: subagentAt,
        finishedAt: subagentAt,
        contextSnapshot: { issueId, wakeReason: "delegated_subtask" },
      });
      // Not under any of the orchestrator's own sampled run ids, so the
      // primary (runId-scoped) progress check never sees it.
      await db.insert(activityLog).values({
        companyId,
        actorType: "agent",
        actorId: subagentId,
        agentId: subagentId,
        runId: subagentRunId,
        action: "issue.comment_added",
        entityType: "issue",
        entityId: issueId,
        createdAt: subagentAt,
      });
    }

    await continuationWake(heartbeat, agentId, issueId);

    const issueRow = await loadIssue(issueId);
    expect(issueRow?.status).toBe("in_progress");
    const notices = await issueComment_count(issueId, ISSUE_REWAKE_CIRCUIT_BREAKER_NOTICE_PREFIX);
    expect(notices).toHaveLength(0);
    const skipped = await latestWakeRequest(agentId);
    expect(skipped?.reason).not.toBe("issue_rewake_circuit_breaker_tripped");
  });

  // --- Audit finding #3 (PR #211): a human holding the conversation seat
  // (conversationUserId) is human-owned exactly like a direct assignee.

  it("never trips for a card with a human in the conversation seat", async () => {
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
    try {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
      // issues_conversation_identity_check requires conversationAgentId and
      // conversationUserId together, conversationAgentId === assigneeAgentId,
      // assigneeUserId null, and an active/waiting conversationState.
      await db
        .update(issues)
        .set({
          conversationAgentId: agentId,
          conversationUserId: "a-conversation-human",
          conversationState: "active",
        })
        .where(eq(issues.id, issueId));

      await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 300 });
      await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 200 });
      await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 100 });

      await continuationWake(heartbeat, agentId, issueId);

      const issueRow = await loadIssue(issueId);
      expect(issueRow?.status).toBe("in_progress");
      const notices = await issueComment_count(issueId, ISSUE_REWAKE_CIRCUIT_BREAKER_NOTICE_PREFIX);
      expect(notices).toHaveLength(0);
      const skipped = await latestWakeRequest(agentId);
      expect(skipped?.reason).not.toBe("issue_rewake_circuit_breaker_tripped");
    } finally {
      await instanceSettingsService(db).updateExperimental({ enableAgentChat: false });
    }
  });

  // --- Audit finding #4 (PR #211): notice dedup is keyed on this trip's
  // marker (the newest counted run), not a bare global prefix, so a later
  // genuine trip posts its own fresh notice.

  it("posts a fresh notice for a second, later trip after a human resume breaks the first streak", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    const firstStreakRunIds = [
      await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 300 }),
      await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 200 }),
      await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 100 }),
    ];

    const firstWake = await continuationWake(heartbeat, agentId, issueId);
    expect(firstWake).toBeNull();
    let issueRow = await loadIssue(issueId);
    expect(issueRow?.status).toBe("backlog");
    let notices = await issueComment_count(issueId, ISSUE_REWAKE_CIRCUIT_BREAKER_NOTICE_PREFIX);
    expect(notices).toHaveLength(1);

    // A duplicate evaluation of the exact same streak (e.g. a retried stale
    // trigger) must still dedupe to the one notice already posted.
    const duplicateWake = await continuationWake(heartbeat, agentId, issueId);
    expect(duplicateWake).toBeNull();
    notices = await issueComment_count(issueId, ISSUE_REWAKE_CIRCUIT_BREAKER_NOTICE_PREFIX);
    expect(notices).toHaveLength(1);

    // Human resume: the card is moved back to in_progress. The first
    // streak's runs are retired (their work is done; a human engaged and
    // moved it forward) so the second evaluation measures a genuinely new
    // streak rather than accumulating across the resume boundary.
    await db.delete(heartbeatRuns).where(inArray(heartbeatRuns.id, firstStreakRunIds));
    await db
      .update(issues)
      .set({ status: "in_progress", updatedAt: new Date() })
      .where(eq(issues.id, issueId));
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "issue.comment_added",
      entityType: "issue",
      entityId: issueId,
      createdAt: new Date(Date.now() - 50_000),
    });

    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 40 });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 30 });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 20 });

    const secondWake = await continuationWake(heartbeat, agentId, issueId);
    expect(secondWake).toBeNull();

    issueRow = await loadIssue(issueId);
    expect(issueRow?.status).toBe("backlog");
    notices = await issueComment_count(issueId, ISSUE_REWAKE_CIRCUIT_BREAKER_NOTICE_PREFIX);
    expect(notices).toHaveLength(2);
    // The two notices are distinct per-trip markers, not the same comment.
    expect(new Set(notices.map((notice) => notice.body)).size).toBe(2);
  });

  // --- Re-audit of 5ed094d4 (PR #211 second pass).
  //
  // Fix A: veto clause (b) self-matched — issue.successful_run_handoff_required
  // and file-resource reads are both logged under the STUCK run's own id,
  // so isNotNull(runId) always matched and the veto fired on the loop's own
  // bookkeeping. Restricted to (b1) a different run's activity by a
  // non-assignee actor, or (b2) a comment by a non-assignee actor.
  //
  // A second "comment-only" streak tier was built here and then reverted:
  // see the REJECTED note on evaluateIssueRewakeThrottle in
  // issue-rewake-throttle.ts for the production numbers that ruled it out
  // (cards legitimately waiting on CI/review also comment every cycle, and
  // no threshold told them apart from a genuinely stuck loop).

  it("does not veto a no-progress trip on file_resource_list or successful_run_handoff_required rows logged under a counted run's own id", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    const runIds = [
      await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 300 }),
      await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 200 }),
      await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 100 }),
    ];
    // The orchestrator's own file-resource read, logged under its OWN run
    // id (the real shape: actorType is the calling agent, i.e. the
    // assignee itself).
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      runId: runIds[0],
      action: "issue.file_resource_list",
      entityType: "issue",
      entityId: issueId,
      createdAt: new Date(Date.now() - 299_000),
    });
    // The heartbeat's own handoff-required notice, logged under the SAME
    // stuck run's own id (the real shape: actorType "system", actorId
    // "heartbeat" — this is the exact self-match the audit found).
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "heartbeat",
      agentId,
      runId: runIds[1],
      action: "issue.successful_run_handoff_required",
      entityType: "issue",
      entityId: issueId,
      createdAt: new Date(Date.now() - 199_000),
    });

    const wake = await continuationWake(heartbeat, agentId, issueId);
    expect(wake).toBeNull();

    const skipped = await latestWakeRequest(agentId);
    expect(skipped?.reason).toBe("issue_rewake_circuit_breaker_tripped");

    const issueRow = await loadIssue(issueId);
    expect(issueRow?.status).toBe("backlog");
    const notices = await issueComment_count(issueId, ISSUE_REWAKE_CIRCUIT_BREAKER_NOTICE_PREFIX);
    expect(notices).toHaveLength(1);
  });

  it("still trips a loop driven only by finish_successful_run_handoff wakes after the re-audit fixes", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 300 });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 200 });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 100 });

    const wake = await handoffWake(heartbeat, agentId, issueId);
    expect(wake).toBeNull();

    const skipped = await latestWakeRequest(agentId);
    expect(skipped?.reason).toBe("issue_rewake_circuit_breaker_tripped");

    const issueRow = await loadIssue(issueId);
    expect(issueRow?.status).toBe("backlog");
    const notices = await issueComment_count(issueId, ISSUE_REWAKE_CIRCUIT_BREAKER_NOTICE_PREFIX);
    expect(notices).toHaveLength(1);
  });
});
