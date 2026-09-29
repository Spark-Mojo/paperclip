import { randomUUID } from "node:crypto";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import {
  evaluateWakeLoopGuard,
  summarizeAgentIssueWakeupsInWindow,
  summarizeMutationChainWakeups,
  WAKE_LOOP_GUARD_CHAIN_LIMIT,
  WAKE_LOOP_GUARD_HOURLY_LIMIT,
  WAKE_LOOP_GUARD_WINDOW_MS,
} from "../services/wake-loop-guard.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping wake-loop guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("wake-loop guard", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wake-loop-guard-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.delete(issueRelations);
        await db.delete(heartbeatRunEvents);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentRuntimeState);
        await db.delete(issues);
        await db.delete(agents);
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

  async function seedCompanyAgentIssue(opts: {
    status?: "todo" | "in_progress" | "in_review" | "blocked" | "done" | "cancelled";
  } = {}) {
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
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stuck on cancelled blocker",
      status: opts.status ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });

    return { companyId, agentId, issueId };
  }

  async function seedSkippedWakeup(args: {
    companyId: string;
    agentId: string;
    issueId: string;
    mutation: string | null;
    retryOfRunId: string | null;
    count: number;
  }) {
    const now = Date.now();
    const rows = Array.from({ length: args.count }, (_, index) => ({
      id: randomUUID(),
      companyId: args.companyId,
      agentId: args.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_dependencies_blocked",
      payload: {
        issueId: args.issueId,
        ...(args.mutation ? { mutation: args.mutation } : {}),
        ...(args.retryOfRunId ? { retryOfRunId: args.retryOfRunId } : {}),
      },
      status: "skipped",
      requestedByActorType: "system",
      requestedByActorId: "test",
      createdAt: new Date(now - (args.count - index) * 1_000),
    }));
    await db.insert(agentWakeupRequests).values(rows);
    return rows.length;
  }

  it("counts skipped wakeup rows for the (agent, issue) pair within the window", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const retryOfRunId = "e6d552b0-1111-2222-3333-444455556666";
    await seedSkippedWakeup({
      companyId, agentId, issueId,
      mutation: "interaction",
      retryOfRunId,
      count: 5,
    });

    const summary = await summarizeAgentIssueWakeupsInWindow(db, {
      companyId, agentId, issueId,
    });
    expect(summary.totalInWindow).toBe(5);
    expect(summary.skippedInWindow).toBe(5);
  });

  it("chain summary keys on (mutation, retryOfRunId) and isolates different chains", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    await seedSkippedWakeup({
      companyId, agentId, issueId,
      mutation: "interaction",
      retryOfRunId: "chain-A",
      count: 4,
    });
    await seedSkippedWakeup({
      companyId, agentId, issueId,
      mutation: "interaction",
      retryOfRunId: "chain-B",
      count: 3,
    });

    const chainA = await summarizeMutationChainWakeups(db, {
      companyId, agentId, issueId,
      mutation: "interaction",
      retryOfRunId: "chain-A",
    });
    const chainB = await summarizeMutationChainWakeups(db, {
      companyId, agentId, issueId,
      mutation: "interaction",
      retryOfRunId: "chain-B",
    });
    expect(chainA.totalInWindow).toBe(4);
    expect(chainB.totalInWindow).toBe(3);
  });

  it("evaluateWakeLoopGuard trips the chain guard at 10 skips on the same chain", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const retryOfRunId = "e6d552b0-aaaa-bbbb-cccc-ddddeeeeffff";
    await seedSkippedWakeup({
      companyId, agentId, issueId,
      mutation: "interaction",
      retryOfRunId,
      count: WAKE_LOOP_GUARD_CHAIN_LIMIT,
    });

    const decision = await evaluateWakeLoopGuard(db, {
      companyId, agentId, issueId,
      payload: { issueId, mutation: "interaction", retryOfRunId },
    });
    expect(decision.tripped).toBe(true);
    if (decision.tripped) {
      expect(decision.guard).toBe("chain");
      expect(decision.count).toBe(WAKE_LOOP_GUARD_CHAIN_LIMIT);
      expect(decision.limit).toBe(WAKE_LOOP_GUARD_CHAIN_LIMIT);
    }
  });

  it("evaluateWakeLoopGuard trips the hourly guard at 20 across chains", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    // 7 skips on chain A, 7 on chain B, 7 on chain C → 21 total, each chain under
    // the chain limit but the (agent, issue) hourly guard trips.
    await seedSkippedWakeup({
      companyId, agentId, issueId,
      mutation: "interaction", retryOfRunId: "chain-A", count: 7,
    });
    await seedSkippedWakeup({
      companyId, agentId, issueId,
      mutation: "interaction", retryOfRunId: "chain-B", count: 7,
    });
    await seedSkippedWakeup({
      companyId, agentId, issueId,
      mutation: "interaction", retryOfRunId: "chain-C", count: 7,
    });

    const decision = await evaluateWakeLoopGuard(db, {
      companyId, agentId, issueId,
      payload: { issueId, mutation: "interaction", retryOfRunId: "chain-D" },
    });
    expect(decision.tripped).toBe(true);
    if (decision.tripped) {
      expect(decision.guard).toBe("hourly");
      expect(decision.count).toBe(21);
      expect(decision.limit).toBe(WAKE_LOOP_GUARD_HOURLY_LIMIT);
    }
  });

  it("evaluateWakeLoopGuard admits a fresh retryOfRunId when only its own chain is empty", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    // Exhaust the chain guard on `exhausted-chain` (10 rows) AND push the
    // (agent, issue) bucket above the hourly limit via other chain rows.
    await seedSkippedWakeup({
      companyId, agentId, issueId,
      mutation: "interaction", retryOfRunId: "exhausted-chain",
      count: WAKE_LOOP_GUARD_CHAIN_LIMIT,
    });
    await seedSkippedWakeup({
      companyId, agentId, issueId,
      mutation: "interaction", retryOfRunId: "noise-chain-1",
      count: 6,
    });
    await seedSkippedWakeup({
      companyId, agentId, issueId,
      mutation: "interaction", retryOfRunId: "noise-chain-2",
      count: 6,
    });

    const decision = await evaluateWakeLoopGuard(db, {
      companyId, agentId, issueId,
      payload: { issueId, mutation: "interaction", retryOfRunId: "fresh-chain" },
    });
    // `fresh-chain` itself is empty, so the chain guard does not trip on it.
    // The (agent, issue) hourly guard trips because the bucket holds 22 rows
    // regardless of chain.
    expect(decision.tripped).toBe(true);
    if (decision.tripped) {
      expect(decision.guard).toBe("hourly");
    }
  });

  it("enqueueWakeup records wake_loop_guard_tripped when the guard trips", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const retryOfRunId = "e6d552b0-deadbeef-cafe-fade-000000000000";
    await seedSkippedWakeup({
      companyId, agentId, issueId,
      mutation: "interaction", retryOfRunId,
      count: WAKE_LOOP_GUARD_CHAIN_LIMIT,
    });

    const wake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, mutation: "interaction", retryOfRunId },
      contextSnapshot: {
        issueId,
        wakeReason: "issue_commented",
        source: "wake-loop-guard-test",
      },
      requestedByActorType: "system",
      requestedByActorId: "test",
    });
    expect(wake).toBeNull();

    const latestSkip = await db
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

    expect(latestSkip?.status).toBe("skipped");
    expect(latestSkip?.reason).toBe("wake_loop_guard_tripped");
    const skipPayload = latestSkip?.payload as Record<string, unknown> | null;
    const skipDetails = (skipPayload?.heartbeatSkip ?? {}) as Record<string, unknown>;
    expect(skipDetails.guard).toBe("chain");
    expect(skipDetails.count).toBe(WAKE_LOOP_GUARD_CHAIN_LIMIT);
  });

  it("does not insert further wakeup rows once the guard trips (loop dies cold)", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const retryOfRunId = "e6d552b0-11112222-3333-4444-555566667777";
    await seedSkippedWakeup({
      companyId, agentId, issueId,
      mutation: "interaction", retryOfRunId,
      count: WAKE_LOOP_GUARD_CHAIN_LIMIT,
    });

    const before = await db
      .select({ count: count() })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.agentId, agentId),
      ))
      .then((rows) => rows[0]?.count ?? 0);

    // Simulate five reconciliation passes trying to re-emit the same wake.
    for (let pass = 0; pass < 5; pass += 1) {
      const wake = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId, mutation: "interaction", retryOfRunId },
        contextSnapshot: {
          issueId,
          wakeReason: "issue_commented",
          source: "wake-loop-guard-test",
        },
        requestedByActorType: "system",
        requestedByActorId: "test",
      });
      expect(wake).toBeNull();
    }

    const after = await db
      .select({ count: count() })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.agentId, agentId),
      ))
      .then((rows) => rows[0]?.count ?? 0);

    // Five additional reconciliation ticks: only the FIRST writes a
    // wake_loop_guard_tripped row; subsequent attempts are deduped on
    // (company, agent, issue, guard) within WAKE_LOOP_GUARD_TRIP_RECORD_DEDUP_MS.
    // Without the guard, this loop would have produced N rows per tick, 30 s
    // apart, until the operator intervened — SPA-7900 measured 2,526. Without
    // dedup, this loop would still produce 5 rows in this test (one per pass).
    expect(after - before).toBe(1);

    // The single new row is the trip-record for `chain` guard.
    const recentReason = await db
      .select({ reason: agentWakeupRequests.reason, status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.agentId, agentId),
      ))
      .orderBy(desc(agentWakeupRequests.requestedAt))
      .limit(1)
      .then((rows) => rows[0]);
    expect(recentReason?.status).toBe("skipped");
    expect(recentReason?.reason).toBe("wake_loop_guard_tripped");
  });

  it("refuses to enqueue a wake when the issue is already terminal (done/cancelled)", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue({ status: "done" });
    const retryOfRunId = "e6d552b0-terminal-done-1111-2222-3333";

    const before = await db
      .select({ count: count() })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.agentId, agentId),
      ))
      .then((rows) => rows[0]?.count ?? 0);

    // Five reconciliation passes against a terminal issue: zero rows.
    for (let pass = 0; pass < 5; pass += 1) {
      const wake = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId, mutation: "interaction", retryOfRunId },
        contextSnapshot: {
          issueId,
          wakeReason: "issue_commented",
          source: "wake-loop-guard-test",
        },
        requestedByActorType: "system",
        requestedByActorId: "test",
      });
      expect(wake).toBeNull();
    }

    const after = await db
      .select({ count: count() })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.agentId, agentId),
      ))
      .then((rows) => rows[0]?.count ?? 0);

    expect(after - before).toBe(0);
  });

  it("refuses to enqueue a wake when the issue is cancelled, same as done", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue({ status: "cancelled" });

    const before = await db
      .select({ count: count() })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.agentId, agentId),
      ))
      .then((rows) => rows[0]?.count ?? 0);

    const wake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "issue_commented" },
      requestedByActorType: "system",
      requestedByActorId: "test",
    });
    expect(wake).toBeNull();

    const after = await db
      .select({ count: count() })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.agentId, agentId),
      ))
      .then((rows) => rows[0]?.count ?? 0);

    expect(after - before).toBe(0);
  });

  it("operator-driven wake (requestedByActorType=user) bypasses the terminal-status guard", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue({ status: "done" });

    const wake = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "user",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    });
    expect(wake).not.toBeNull();
  });

  it("trip-row dedup window: a second guard trip within 60 s writes no new row", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const retryOfRunId = "e6d552b0-dedup-test-1111-2222-3333";
    await seedSkippedWakeup({
      companyId, agentId, issueId,
      mutation: "interaction", retryOfRunId,
      count: WAKE_LOOP_GUARD_CHAIN_LIMIT,
    });

    // First wake — guard trips, one row written.
    await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, mutation: "interaction", retryOfRunId },
      contextSnapshot: { issueId, wakeReason: "issue_commented" },
      requestedByActorType: "system",
      requestedByActorId: "test",
    });

    const afterFirst = await db
      .select({ count: count() })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.agentId, agentId),
        eq(agentWakeupRequests.reason, "wake_loop_guard_tripped"),
      ))
      .then((rows) => rows[0]?.count ?? 0);
    expect(afterFirst).toBe(1);

    // Second wake immediately — guard still trips, but row deduped.
    await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, mutation: "interaction", retryOfRunId },
      contextSnapshot: { issueId, wakeReason: "issue_commented" },
      requestedByActorType: "system",
      requestedByActorId: "test",
    });

    const afterSecond = await db
      .select({ count: count() })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.agentId, agentId),
        eq(agentWakeupRequests.reason, "wake_loop_guard_tripped"),
      ))
      .then((rows) => rows[0]?.count ?? 0);
    expect(afterSecond).toBe(1);
  });

  it("operator-driven wakeups (requestedByActorType=user) bypass the guard", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const retryOfRunId = "e6d552b0-bbbbcccc-dddd-eeee-ffff00001111";
    await seedSkippedWakeup({
      companyId, agentId, issueId,
      mutation: "interaction", retryOfRunId,
      count: WAKE_LOOP_GUARD_CHAIN_LIMIT,
    });

    // Operator wakes must always pass — a board operator pressing "retry" is
    // the resolution path, not the loop.
    const wake = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "user",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    });
    expect(wake).not.toBeNull();
  });

  it("distinct (agent, issue) pairs do not trip each other's hourly guards", async () => {
    const companyId = randomUUID();
    const agentA = randomUUID();
    const agentB = randomUUID();
    const issueA = randomUUID();
    const issueB = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values([
      {
        id: agentA, companyId, name: "A", role: "engineer", status: "active",
        adapterType: "codex_local", adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      },
      {
        id: agentB, companyId, name: "B", role: "engineer", status: "active",
        adapterType: "codex_local", adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      },
    ]);
    await db.insert(issues).values([
      {
        id: issueA, companyId, title: "A", status: "in_progress", priority: "medium",
        assigneeAgentId: agentA, responsibleUserId: "responsible-user",
      },
      {
        id: issueB, companyId, title: "B", status: "in_progress", priority: "medium",
        assigneeAgentId: agentB, responsibleUserId: "responsible-user",
      },
    ]);

    // Trip agent A's hourly guard on issue A.
    await seedSkippedWakeup({
      companyId, agentId: agentA, issueId: issueA,
      mutation: "interaction", retryOfRunId: "A-chain",
      count: WAKE_LOOP_GUARD_HOURLY_LIMIT + 1,
    });
    // Issue B's bucket is empty for B; B's wake is admitted.
    const wake = await heartbeat.wakeup(agentB, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: issueB, mutation: "interaction", retryOfRunId: "B-chain" },
      contextSnapshot: { issueId: issueB, wakeReason: "issue_commented" },
      requestedByActorType: "system",
      requestedByActorId: "test",
    });
    expect(wake).not.toBeNull();

    // Confirm the (agentA, issueA) bucket is the one that tripped — by trying
    // again and seeing it rejected.
    const reentryWake = await heartbeat.wakeup(agentA, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: issueA, mutation: "interaction", retryOfRunId: "A-chain" },
      contextSnapshot: { issueId: issueA, wakeReason: "issue_commented" },
      requestedByActorType: "system",
      requestedByActorId: "test",
    });
    expect(reentryWake).toBeNull();
  });

  it("window cutoff excludes wakeups older than the rolling hour", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const retryOfRunId = "e6d552b0-old-skipped-rows";
    const stale = new Date(Date.now() - (WAKE_LOOP_GUARD_WINDOW_MS + 60_000));
    const rows = Array.from({ length: WAKE_LOOP_GUARD_HOURLY_LIMIT + 5 }, () => ({
      id: randomUUID(),
      companyId, agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_dependencies_blocked",
      payload: { issueId, mutation: "interaction", retryOfRunId },
      status: "skipped",
      requestedByActorType: "system",
      requestedByActorId: "test",
      createdAt: stale,
    }));
    await db.insert(agentWakeupRequests).values(rows);

    const decision = await evaluateWakeLoopGuard(db, {
      companyId, agentId, issueId,
      payload: { issueId, mutation: "interaction", retryOfRunId },
    });
    expect(decision.tripped).toBe(false);
  });

  it("payloads with no mutation and no retryOfRunId are admitted (hourly check only)", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    // 19 skips under hourly limit, no chain keying.
    await seedSkippedWakeup({
      companyId, agentId, issueId,
      mutation: null, retryOfRunId: null,
      count: 19,
    });

    const decision = await evaluateWakeLoopGuard(db, {
      companyId, agentId, issueId,
      payload: { issueId }, // no mutation, no retryOfRunId
    });
    expect(decision.tripped).toBe(false);
  });
});