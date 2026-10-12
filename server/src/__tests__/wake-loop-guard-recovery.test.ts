/**
 * DEX RECEIPT (SPA-11862) — NOT a fix. A reproduction test that fails on the
 * rebased wake-loop-guard stack (`dex/SPA-11862-pr110-rebased`, head
 * ee30191a24bdc6c31bbca8e8f598c4182842fadc) and passes on the base tip.
 *
 * Three defects, all in the reduced stack's own code, all on the exact path
 * this card exists to add (the R1/R2 wake-loop guard in the stranded-recovery
 * sweep). None are visible to the existing suite, because `wake-loop-guard.test.ts`
 * exercises the guard module and `heartbeatService` DIRECTLY and never drives
 * `recoveryService.reconcileStrandedAssignedIssues()` — the only caller of
 * `enqueueStrandedIssueRecovery`.
 *
 * D1 (this test's failure): `wake-loop-guard.ts` calls
 *   `issuesSvc.addComment(issueId, body, null, { authorType: "system" })`
 * in three places (lines ~612, ~669, ~676). `issues.addComment` immediately
 * dereferences the actor: `if (dbOrTx === db && (actor.runId || actor.userId))`
 * (issues.ts:12741) => `TypeError: Cannot read properties of null (reading 'runId')`.
 * No other caller in the repo passes a null actor; system comments elsewhere are
 * written with a direct insert or a real actor. The `actor as Parameters<...>[2]`
 * cast at recovery/service.ts:2261 is what hides this from `tsc`.
 *
 * D2: `recovery/service.ts:2239` (terminal-status short-circuit) returns bare
 * `null` from `enqueueStrandedIssueRecovery`, declared
 * `Promise<StrandedRecoveryEnqueueOutcome>` (non-null union).
 *
 * D3: `recovery/service.ts:2282` (guard-tripped) does the same.
 *
 * D2/D3 are masked at runtime by D1 firing first in the guard-tripped branch;
 * both still fail `tsc --noEmit` (2 errors in this file; the base tip has 0).
 * All 6 call sites of `enqueueStrandedIssueRecovery` read `queued.queued`
 * unguarded, so once D1 is fixed D2/D3 become live TypeErrors.
 *
 * Expected fix shape (Ty's call, not Dex's): D1 — pass a real system actor
 * rather than `null`; D2/D3 — return `{ queued: false, chainStop: null }`, the
 * existing refusal shape used at service.ts:2126/2146/2152/2154/2180.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.ts";

const CONTINUATION_SOURCE = "issue.productive_terminal_continuation_recovery";
const CONTINUATION_REASON = "issue_continuation_needed";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("wake-loop guard real recovery sweep", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dex-repro-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("throws TypeError instead of refusing the wake when the guard trips", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const rootRunId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const at = new Date(Date.now() - 600_000);

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
    // A successful, productive in-progress continuation run: the shape the sweep
    // treats as a stranded continuation.
    await db.insert(heartbeatRuns).values({
      id: rootRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "system",
      status: "succeeded",
      retryOfRunId: null,
      livenessState: "advanced",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: CONTINUATION_REASON,
        retryReason: CONTINUATION_REASON,
        source: CONTINUATION_SOURCE,
      },
      createdAt: at,
      startedAt: at,
      finishedAt: at,
      updatedAt: at,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stranded continuation whose retries trip the wake-loop guard",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      assigneeUserId: null,
      checkoutRunId: rootRunId,
      executionRunId: null,
      executionState: null,
      monitorNextCheckAt: null,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: at,
    });

    // Recent visible progress, which exempts the issue from the pre-enqueue
    // escalation so the sweep actually REACHES `enqueueStrandedIssueRecovery`.
    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      authorAgentId: agentId,
      authorUserId: null,
      body: "Visible progress, so the sweep proceeds to the enqueue path.",
      createdAt: new Date(Date.now() - 30_000),
      updatedAt: new Date(Date.now() - 30_000),
    } as never);

    // 10 skipped chain wakes for this (company, agent, issue) => chain limit
    // (WAKE_LOOP_GUARD_CHAIN_LIMIT = 10) trips, so the guard takes its
    // tripped branch and calls `escalateWakeBudgetExhausted`.
    for (let i = 0; i < 10; i += 1) {
      await db.insert(agentWakeupRequests).values({
        id: randomUUID(),
        companyId,
        agentId,
        source: CONTINUATION_SOURCE,
        triggerDetail: "system",
        status: "skipped",
        skipReason: "dependency",
        retryOfRunId: rootRunId,
        payload: { issueId, retryOfRunId: rootRunId, mutation: "interaction" },
        createdAt: new Date(Date.now() - 60_000 + i * 1_000),
        updatedAt: new Date(Date.now() - 60_000 + i * 1_000),
      } as never);
    }

    const enqueueWakeup = async (agent: string, options: Record<string, unknown> = {}) => {
      const [row] = await db
        .select({ companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, agent));
      if (!row) throw new Error(`Missing test recovery wake agent ${agent}`);
      const runId = randomUUID();
      const now = new Date();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: row.companyId,
        agentId: agent,
        invocationSource: (options.source as string) ?? "on_demand",
        triggerDetail: (options.triggerDetail as string) ?? null,
        status: "queued",
        retryOfRunId:
          ((options.payload as Record<string, unknown> | undefined)?.retryOfRunId as string) ??
          null,
        contextSnapshot: (options.contextSnapshot as Record<string, unknown>) ?? {},
        createdAt: now,
        startedAt: now,
        updatedAt: now,
      });
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      return run;
    };

    const recovery = recoveryService(db, { enqueueWakeup: enqueueWakeup as never });

    // Negative control: the fixture is a genuine sweep candidate, and the guard
    // really did trip — so a throw here is the defect, not an unrelated failure.
    const [seededSkips] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.status, "skipped"),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
        ),
      );
    expect(Number(seededSkips?.n)).toBe(10);

    // THE RECEIPT. Desired behaviour: the sweep returns normally with the wake
    // refused and zero new rows. Actual behaviour on the rebased head: TypeError.
    await expect(
      recovery.reconcileStrandedAssignedIssues(),
    ).resolves.toBeDefined();
  }, 60_000);

  // SPA-11862 — productive continuation must not be suppressed or escalated by
  // saturated question-response retry history. The targeted suppression is
  // restricted to question-response retry wakes only; the broad recovery guard
  // removal must preserve the normal productive-continuation enqueue.
  it("productive continuation is not suppressed or escalated by question-response history", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const rootRunId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const at = new Date(Date.now() - 600_000);

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
    await db.insert(heartbeatRuns).values({
      id: rootRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "system",
      status: "succeeded",
      retryOfRunId: null,
      livenessState: "advanced",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: CONTINUATION_REASON,
        retryReason: CONTINUATION_REASON,
        source: CONTINUATION_SOURCE,
      },
      createdAt: at,
      startedAt: at,
      finishedAt: at,
      updatedAt: at,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stranded productive continuation (must NOT be suppressed by QR history)",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      assigneeUserId: null,
      checkoutRunId: rootRunId,
      executionRunId: null,
      executionState: null,
      monitorNextCheckAt: null,
      responsibleUserId: "responsible-user",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
      startedAt: at,
    });

    // Recent visible progress — exempt from the pre-enqueue escalation so the
    // sweep reaches enqueueStrandedIssueRecovery.
    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      authorAgentId: agentId,
      authorUserId: null,
      body: "Visible progress, so the sweep proceeds to the enqueue path.",
      createdAt: new Date(Date.now() - 30_000),
      updatedAt: new Date(Date.now() - 30_000),
    } as never);

    // Saturated question-response history on the same (agent, issue) — 25
    // canonical-shaped skipped rows for a single interactionId, with the
    // matching idempotencyKey and source. The broad recovery guard removal
    // means this history must NOT trip any guard, must NOT escalate, and
    // must NOT suppress the productive continuation.
    const questionResponseInteractionId = "7c1d9b3a-1111-4222-8333-444455556666";
    const questionResponseRows = Array.from({ length: 25 }, (_, index) => ({
      id: randomUUID(),
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      status: "skipped",
      skipReason: "dependency",
      retryOfRunId: null,
      payload: {
        issueId,
        mutation: "interaction",
        interactionId: questionResponseInteractionId,
      },
      idempotencyKey: `question-response:${questionResponseInteractionId}`,
      createdAt: new Date(Date.now() - 60_000 + index * 1_000),
      updatedAt: new Date(Date.now() - 60_000 + index * 1_000),
    } as never));
    await db.insert(agentWakeupRequests).values(questionResponseRows);

    let enqueuedAgent: string | null = null;
    let enqueuedOptions: Record<string, unknown> | null = null;
    const enqueueWakeup = async (
      agent: string,
      options: Record<string, unknown> = {},
    ) => {
      enqueuedAgent = agent;
      enqueuedOptions = options;
      const [row] = await db
        .select({ companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, agent));
      if (!row) throw new Error(`Missing test recovery wake agent ${agent}`);
      const runId = randomUUID();
      const now = new Date();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: row.companyId,
        agentId: agent,
        invocationSource: (options.source as string) ?? "on_demand",
        triggerDetail: (options.triggerDetail as string) ?? null,
        status: "queued",
        retryOfRunId:
          ((options.payload as Record<string, unknown> | undefined)?.retryOfRunId as string) ??
          null,
        contextSnapshot: (options.contextSnapshot as Record<string, unknown>) ?? {},
        createdAt: now,
        startedAt: now,
        updatedAt: now,
      });
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      return run;
    };

    const recovery = recoveryService(db, { enqueueWakeup: enqueueWakeup as never });

    // Sweep must resolve without throwing AND must enqueue the productive
    // continuation wake — no suppression, no escalation.
    await expect(
      recovery.reconcileStrandedAssignedIssues(),
    ).resolves.toBeDefined();
    expect(enqueuedAgent).toBe(agentId);
    expect(enqueuedOptions).not.toBeNull();
    const enqueuedReason = (enqueuedOptions as Record<string, unknown> | null)?.reason;
    expect(enqueuedReason).toBe(CONTINUATION_REASON);

    // No wake_loop_guard_tripped rows may have been written for this
    // (company, agent, issue) — the broad recovery guard is gone, and the
    // targeted question-response-history guard is wake-only (no escalation).
    const tripRows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.reason, "wake_loop_guard_tripped"),
        ),
      );
    expect(Number(tripRows[0]?.n)).toBe(0);

    // No synthetic escalation issue may have been created for this (agent,
    // issue) — the productive continuation is a normal recovery enqueue,
    // not a guard-tripped escalation.
    const escalations = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "wake_loop_guard_escalation"),
        ),
      );
    expect(Number(escalations[0]?.n)).toBe(0);

    // The issue itself must not have been moved to `blocked` by the sweep —
    // a normal productive continuation must keep working.
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.status).toBe("in_progress");
  }, 60_000);
});