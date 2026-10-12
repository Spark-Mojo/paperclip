import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueAttachments,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issues,
  nativeRunFinalizations,
  statusDecisions,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  CONTINUATION_CHAIN_STOP_EVENT_PREFIX,
  DEFAULT_MAX_CONSECUTIVE_NON_ADVANCING_CONTINUATIONS,
  DEFAULT_MAX_CONTINUATION_CHAIN_DEPTH,
} from "../services/recovery/continuation-chain-budget.ts";
import { recoveryService } from "../services/recovery/service.ts";

// The shipped defaults. If these move, move them here with them: every
// threshold assertion in this file is written against them.
const MAX_CONSECUTIVE = DEFAULT_MAX_CONSECUTIVE_NON_ADVANCING_CONTINUATIONS;
const MAX_DEPTH = DEFAULT_MAX_CONTINUATION_CHAIN_DEPTH;

const CONTINUATION_SOURCE = "issue.productive_terminal_continuation_recovery";
const CONTINUATION_REASON = "issue_continuation_needed";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres continuation-chain budget tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("continuation chain budget (stranded-recovery sweep)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  /** Monotonic clock so `latestRunForIssue`'s `createdAt DESC` ordering is total. */
  let tick = 0;

  // Timestamps must sit inside the sweep's own `hasRecentVisibleProgress`
  // window, which is measured against the real clock — a fixture dated in the
  // past reads as "no recent progress" and escalates before the chain budget is
  // ever reached. Backdated by a fixed offset and stepped forward so
  // `latestRunForIssue`'s `createdAt DESC` ordering stays total.
  const now = () => new Date(Date.now() - 600_000 + tick++ * 1_000);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-continuation-chain-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(nativeRunFinalizations);
    await db.delete(statusDecisions);
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(issueAttachments);
    await db.delete(issueThreadInteractions);
    await db.delete(issueRelations);
    await db.delete(agentWakeupRequests);
    await db.delete(agentTaskSessions);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * The real recovery service over the real schema, with one substituted
   * collaborator: `enqueueWakeup`. It writes what production writes — a
   * `heartbeat_runs` row carrying the wake's `contextSnapshot` (source,
   * retryReason, issueId) and the predecessor link — and returns the row, so
   * the service's own `retryOfRunId` backfill runs against it for real. Nothing
   * about the chain, the budget, or the escalation is stubbed.
   */
  function recoveryForTest() {
    return recoveryService(db, {
      enqueueWakeup: async (agentId, options = {}) => {
        const [agent] = await db
          .select({ companyId: agents.companyId })
          .from(agents)
          .where(eq(agents.id, agentId));
        if (!agent) throw new Error(`Missing test recovery wake agent ${agentId}`);
        const payload = (options.payload ?? {}) as Record<string, unknown>;
        const contextSnapshot = (options.contextSnapshot ?? {}) as Record<string, unknown>;
        const runId = randomUUID();
        const at = now();
        await db.insert(heartbeatRuns).values({
          id: runId,
          companyId: agent.companyId,
          agentId,
          invocationSource: options.source ?? "on_demand",
          triggerDetail: options.triggerDetail ?? null,
          status: "queued",
          retryOfRunId: (payload.retryOfRunId as string | null) ?? null,
          contextSnapshot,
          createdAt: at,
          startedAt: at,
          updatedAt: at,
        });
        const [row] = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, runId));
        return row;
      },
    });
  }

  /**
   * A stranded `in_progress` issue whose newest run is a successful productive
   * continuation — the exact shape the SPA-11628 chain had — plus, when asked,
   * a human/on-demand root (no `retryOfRunId`, no continuation context) so the
   * ancestry walk terminates at it instead of at the issue's history.
   */
  async function seedStrandedContinuationIssue(input?: {
    rootLivenessState?: string;
    rootIsChainMember?: boolean;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const at = now();

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
      name: "OpenCodeCoder",
      role: "engineer",
      status: "idle",
      adapterType: "opencode_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    // The run lands BEFORE the issue: `issues.checkout_run_id` is a foreign key
    // onto `heartbeat_runs`.
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "system",
      status: "succeeded",
      retryOfRunId: null,
      livenessState: input?.rootLivenessState ?? "advanced",
      contextSnapshot: input?.rootIsChainMember
        ? {
            issueId,
            taskId: issueId,
            wakeReason: CONTINUATION_REASON,
            retryReason: CONTINUATION_REASON,
            source: CONTINUATION_SOURCE,
          }
        : { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      createdAt: at,
      startedAt: at,
      finishedAt: at,
      updatedAt: at,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Transport cannot issue the required PATCH",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      assigneeUserId: null,
      checkoutRunId: runId,
      executionRunId: null,
      executionState: null,
      monitorNextCheckAt: null,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: at,
    });

    return { companyId, agentId, issueId, rootRunId: runId };
  }

  async function latestRunForIssue(companyId: string, issueId: string) {
    const rows = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Runs that carry this lane's continuation context — i.e. chain members. */
  async function chainMemberRunCount(companyId: string, issueId: string) {
    const rows = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
        ),
      );
    return rows.filter(
      (row) =>
        (row.contextSnapshot as Record<string, unknown> | null)?.source ===
        CONTINUATION_SOURCE,
    ).length;
  }

  /**
   * Plays the agent: the run the sweep just queued finishes with the next
   * liveness state, and posts the narration comment that counted as "visible
   * progress". That comment is not decoration — it is why the sweep's existing
   * `hasRecentVisibleProgress` exemption kept SPA-11628's chain alive for 25
   * runs instead of escalating. Without it this fixture never reaches the
   * budget at all and would prove nothing.
   */
  async function finishRunAs(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    runId: string;
    livenessState: string;
  }) {
    const at = now();
    await db
      .update(heartbeatRuns)
      .set({
        status: "succeeded",
        livenessState: input.livenessState,
        startedAt: at,
        finishedAt: at,
        updatedAt: at,
      })
      .where(
        and(
          eq(heartbeatRuns.id, input.runId),
          eq(heartbeatRuns.agentId, input.agentId),
        ),
      );
    await db.insert(issueComments).values({
      companyId: input.companyId,
      issueId: input.issueId,
      authorAgentId: input.agentId,
      authorType: "agent",
      createdByRunId: input.runId,
      body: `Attempt ${tick}: still blocked on the same PATCH; reporting status and retrying.`,
      createdAt: at,
      updatedAt: at,
    });
  }

  async function systemCommentCount(issueId: string) {
    const rows = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, issueId),
          eq(issueComments.authorType, "system"),
        ),
      );
    return rows.length;
  }

  async function chainStopReceiptCount(companyId: string) {
    const rows = await db
      .select({ id: heartbeatRunEvents.id })
      .from(heartbeatRunEvents)
      .where(
        and(
          eq(heartbeatRunEvents.companyId, companyId),
          eq(heartbeatRunEvents.eventType, "lifecycle"),
          sql`${heartbeatRunEvents.message} like ${`${CONTINUATION_CHAIN_STOP_EVENT_PREFIX}%`}`,
        ),
      );
    return rows.length;
  }

  async function issueStatus(issueId: string) {
    const rows = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);
    return rows[0]?.status ?? null;
  }

  type Round = {
    requeued: number;
    stopped: number;
    escalated: number;
    skipped: number;
    members: number;
    issueStatus: string | null;
  };

  async function sweepOnce(
    recovery: ReturnType<typeof recoveryForTest>,
    fixture: { companyId: string; issueId: string },
  ): Promise<Round> {
    const result = await recovery.reconcileStrandedAssignedIssues();
    return {
      requeued: result.continuationRequeued,
      stopped: result.continuationChainStopped,
      escalated: result.escalated,
      skipped: result.skipped,
      members: await chainMemberRunCount(fixture.companyId, fixture.issueId),
      issueStatus: await issueStatus(fixture.issueId),
    };
  }

  /**
   * Drives the real sweep round after round, extending the chain by one link per
   * round, and stops as soon as the sweep refuses to extend it. Returns the
   * per-round results so a test can assert exactly where the chain ended.
   */
  async function driveChain(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    livenessStates: string[];
  }) {
    const recovery = recoveryForTest();
    const rounds: Round[] = [];
    for (const livenessState of input.livenessStates) {
      const before = await chainMemberRunCount(input.companyId, input.issueId);
      const round = await sweepOnce(recovery, input);
      rounds.push(round);
      if (round.members === before) break; // the sweep refused to extend the chain
      const latest = await latestRunForIssue(input.companyId, input.issueId);
      if (!latest) break;
      await finishRunAs({
        companyId: input.companyId,
        agentId: input.agentId,
        issueId: input.issueId,
        runId: latest.id,
        livenessState,
      });
    }
    return rounds;
  }

  it("stops an automatic continuation chain at the budget and escalates exactly once", async () => {
    const fixture = await seedStrandedContinuationIssue();

    const rounds = await driveChain({
      ...fixture,
      livenessStates: Array.from({ length: MAX_CONSECUTIVE + 3 }, () => "blocked"),
    });

    // Every round under the budget queued exactly one successor.
    expect(rounds.slice(0, MAX_CONSECUTIVE).map((round) => round.requeued)).toEqual(
      Array.from({ length: MAX_CONSECUTIVE }, () => 1),
    );
    // The trip round escalates instead of queueing another run.
    const trip = rounds[MAX_CONSECUTIVE];
    expect(trip.requeued).toBe(0);
    expect(trip.stopped).toBe(1);
    expect(trip.escalated).toBe(1);
    expect(trip.issueStatus).toBe("blocked");
    expect(await chainMemberRunCount(fixture.companyId, fixture.issueId)).toBe(
      MAX_CONSECUTIVE,
    );
    expect(await chainStopReceiptCount(fixture.companyId)).toBe(1);

    // Later sweeps over the exhausted chain change nothing at all.
    const recovery = recoveryForTest();
    const commentsAtStop = await systemCommentCount(fixture.issueId);
    expect(commentsAtStop).toBeGreaterThan(0);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const after = await sweepOnce(recovery, fixture);
      expect(after.requeued).toBe(0);
      expect(after.stopped).toBe(0);
      expect(after.escalated).toBe(0);
      expect(after.members).toBe(MAX_CONSECUTIVE);
    }
    expect(await chainMemberRunCount(fixture.companyId, fixture.issueId)).toBe(
      MAX_CONSECUTIVE,
    );
    expect(await systemCommentCount(fixture.issueId)).toBe(commentsAtStop);
    expect(await chainStopReceiptCount(fixture.companyId)).toBe(1);
  }, 30_000);

  it("refuses silently, without a second escalation, when the spent chain is re-entered", async () => {
    const fixture = await seedStrandedContinuationIssue();

    const rounds = await driveChain({
      ...fixture,
      livenessStates: Array.from({ length: MAX_CONSECUTIVE + 1 }, () => "blocked"),
    });
    expect(rounds[MAX_CONSECUTIVE].stopped).toBe(1);
    const commentsAfterStop = await systemCommentCount(fixture.issueId);

    // The card goes back to `in_progress` with the SAME newest run — no fresh
    // dispatch, no new root. The durable receipt must make the sweep refuse
    // silently rather than minting a successor or commenting again.
    await db
      .update(issues)
      .set({ status: "in_progress" })
      .where(eq(issues.id, fixture.issueId));

    const recovery = recoveryForTest();
    const reentry = await sweepOnce(recovery, fixture);

    expect(reentry.requeued).toBe(0);
    expect(reentry.stopped).toBe(0);
    expect(reentry.escalated).toBe(0);
    expect(reentry.members).toBe(MAX_CONSECUTIVE);
    expect(await systemCommentCount(fixture.issueId)).toBe(commentsAfterStop);
    expect(await chainStopReceiptCount(fixture.companyId)).toBe(1);
  }, 30_000);

  it("does not cut off a chain that makes real progress", async () => {
    const fixture = await seedStrandedContinuationIssue();

    const rounds = await driveChain({
      ...fixture,
      livenessStates: Array.from({ length: MAX_DEPTH - 2 }, () => "advanced"),
    });

    expect(rounds).toHaveLength(MAX_DEPTH - 2);
    for (const round of rounds) {
      expect(round.requeued).toBe(1);
      expect(round.stopped).toBe(0);
      expect(round.escalated).toBe(0);
      expect(round.issueStatus).toBe("in_progress");
    }
    expect(await chainMemberRunCount(fixture.companyId, fixture.issueId)).toBe(
      MAX_DEPTH - 2,
    );
    expect(await chainStopReceiptCount(fixture.companyId)).toBe(0);
  }, 30_000);

  it("bounds an alternating blocked/advanced chain by the absolute depth ceiling", async () => {
    const fixture = await seedStrandedContinuationIssue();

    const rounds = await driveChain({
      ...fixture,
      livenessStates: Array.from({ length: MAX_DEPTH + 2 }, (_, index) =>
        index % 2 === 0 ? "blocked" : "advanced",
      ),
    });

    // A consecutive-only bound can never trip here: every newest member breaks
    // the run. The depth ceiling is the only thing that can stop this chain.
    const trip = rounds.find((round) => round.stopped === 1);
    expect(trip).toBeDefined();
    expect(trip!.requeued).toBe(0);
    expect(trip!.escalated).toBe(1);
    expect(trip!.issueStatus).toBe("blocked");
    expect(await chainMemberRunCount(fixture.companyId, fixture.issueId)).toBe(
      MAX_DEPTH,
    );
    expect(
      rounds.slice(rounds.indexOf(trip!) + 1).every((round) => round.requeued === 0),
    ).toBe(true);
  }, 30_000);

  it("covers the needs_followup liveness path, not only blocked", async () => {
    const fixture = await seedStrandedContinuationIssue();

    const rounds = await driveChain({
      ...fixture,
      livenessStates: Array.from({ length: MAX_CONSECUTIVE + 2 }, () => "needs_followup"),
    });

    const trip = rounds[MAX_CONSECUTIVE];
    expect(trip.requeued).toBe(0);
    expect(trip.stopped).toBe(1);
    expect(trip.escalated).toBe(1);
    expect(trip.issueStatus).toBe("blocked");
    expect(await chainMemberRunCount(fixture.companyId, fixture.issueId)).toBe(
      MAX_CONSECUTIVE,
    );
    expect(await chainStopReceiptCount(fixture.companyId)).toBe(1);
  }, 30_000);

  it("a fresh human dispatch starts a new chain with a full budget", async () => {
    const fixture = await seedStrandedContinuationIssue();

    await driveChain({
      ...fixture,
      livenessStates: Array.from({ length: MAX_CONSECUTIVE + 1 }, () => "blocked"),
    });
    expect(await issueStatus(fixture.issueId)).toBe("blocked");

    // A human re-dispatch: the card returns to `in_progress` and a NEW root run
    // arrives with no `retryOfRunId` and no continuation context. The ancestry
    // walk stops at it, so the spent chain can neither suppress it nor hand its
    // budget to it.
    const freshRunId = randomUUID();
    const at = now();
    await db.insert(heartbeatRuns).values({
      id: freshRunId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      retryOfRunId: null,
      livenessState: "blocked",
      contextSnapshot: {
        issueId: fixture.issueId,
        taskId: fixture.issueId,
        wakeReason: "issue_assigned",
      },
      createdAt: at,
      startedAt: at,
      finishedAt: at,
      updatedAt: at,
    });
    // Handing the card back also resolves the board-owned recovery action the
    // escalation opened — otherwise the sweep correctly defers to it and never
    // reaches the chain budget at all.
    await db
      .update(issueRecoveryActions)
      .set({ status: "resolved", resolvedAt: now() })
      .where(eq(issueRecoveryActions.sourceIssueId, fixture.issueId));
    await db
      .update(issues)
      .set({ status: "in_progress", checkoutRunId: freshRunId })
      .where(eq(issues.id, fixture.issueId));

    const round = await sweepOnce(recoveryForTest(), fixture);

    expect(round.stopped).toBe(0);
    expect(round.escalated).toBe(0);
    expect(round.requeued).toBe(1);
    expect(round.issueStatus).toBe("in_progress");

    const successor = await latestRunForIssue(fixture.companyId, fixture.issueId);
    expect(successor?.retryOfRunId).toBe(freshRunId);
    expect(await chainStopReceiptCount(fixture.companyId)).toBe(1);
  }, 30_000);
});