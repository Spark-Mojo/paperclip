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
  routines,
  routineTriggers,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import {
  evaluateWakeLoopGuard,
  hasEligibleRoutineContinuation,
  summarizeAgentIssueWakeupsInWindow,
  summarizeMutationChainWakeups,
  WAKE_LOOP_GUARD_BACKOFF_BASE_MS,
  WAKE_LOOP_GUARD_BACKOFF_CAP_MS,
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
    heartbeat = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
    });
  }, 20_000);

  afterEach(async () => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.delete(routineTriggers);
        await db.delete(routines);
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

  it("evaluateWakeLoopGuard trips the hourly guard at 20 across chains", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    // 7 skips on chain A, 7 on chain B, 7 on chain C → 21 total. Each chain
    // is under its own backoff floor for `chain-D` (no prior rows), but the
    // (agent, issue) hourly guard trips because the bucket holds 21 rows
    // regardless of chain.
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

  it("evaluateWakeLoopGuard trips the backoff layer when the chain has a recent prior skip", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const retryOfRunId = "e6d552b0-backoff-cur-veee-1111-2222333344";
    // Seed 1 prior skip 1 s ago — under the chain cap (10), well under the
    // hourly cap (20), but attempt 2 must wait the backoff floor (30 s).
    const now = new Date();
    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId, agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_dependencies_blocked",
      payload: { issueId, mutation: "interaction", retryOfRunId },
      status: "skipped",
      requestedByActorType: "system",
      requestedByActorId: "test",
      createdAt: new Date(now.getTime() - 1_000),
    });

    const decision = await evaluateWakeLoopGuard(db, {
      companyId, agentId, issueId,
      payload: { issueId, mutation: "interaction", retryOfRunId },
      now,
    });
    expect(decision.tripped).toBe(true);
    if (decision.tripped) {
      expect(decision.guard).toBe("backoff");
      expect(decision.count).toBe(1);
      expect(decision.attempt).toBe(2);
      expect(decision.limit).toBe(2);
      // The next-eligible time is the prior skip + 30 s (attempt 2 floor).
      const gap = decision.nextEligibleAt.getTime() - decision.mostRecentSkipAt.getTime();
      expect(gap).toBe(WAKE_LOOP_GUARD_BACKOFF_BASE_MS);
    }
  });

  it("evaluateWakeLoopGuard admits a chain wake when the backoff curve is honored", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const retryOfRunId = "e6d552b0-backoff-coo-led-1111-2222333344";
    // Seed 1 prior skip 5 minutes ago — well past attempt 2's 30 s floor and
    // under both caps; the wake must be admitted.
    const now = new Date();
    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId, agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_dependencies_blocked",
      payload: { issueId, mutation: "interaction", retryOfRunId },
      status: "skipped",
      requestedByActorType: "system",
      requestedByActorId: "test",
      createdAt: new Date(now.getTime() - 5 * 60 * 1000),
    });

    const decision = await evaluateWakeLoopGuard(db, {
      companyId, agentId, issueId,
      payload: { issueId, mutation: "interaction", retryOfRunId },
      now,
    });
    expect(decision.tripped).toBe(false);
  });

  it("backoff curve doubles per attempt and caps at 1 hour", async () => {
    // attempt 2 → 30 s
    expect(WAKE_LOOP_GUARD_BACKOFF_BASE_MS).toBe(30_000);
    // attempt 10 (2^8 × 30 s = 7 680 000 ms ≈ 2.13 h) → 1 h cap
    const ten = WAKE_LOOP_GUARD_BACKOFF_BASE_MS * Math.pow(2, 8);
    expect(ten).toBeGreaterThan(WAKE_LOOP_GUARD_BACKOFF_CAP_MS);
    expect(WAKE_LOOP_GUARD_BACKOFF_CAP_MS).toBe(60 * 60 * 1000);
  });

  it("evaluateWakeLoopGuard admits a fresh retryOfRunId when only its own chain is empty", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    // Saturate the (agent, issue) bucket above the hourly limit with mixed
    // chain rows, then verify that `fresh-chain` (an empty chain) trips the
    // hourly guard — not the chain guard, which only fires for chains that
    // have their own recent skips.
    await seedSkippedWakeup({
      companyId, agentId, issueId,
      mutation: "interaction", retryOfRunId: "exhausted-chain",
      count: 10,
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
    // Seed 1 prior skip 1 s ago — well under the hourly cap, but the next
    // wake is attempt 2 which needs the 30 s backoff floor.
    const now = Date.now();
    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId, agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_dependencies_blocked",
      payload: { issueId, mutation: "interaction", retryOfRunId },
      status: "skipped",
      requestedByActorType: "system",
      requestedByActorId: "test",
      createdAt: new Date(now - 1_000),
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
    expect(skipDetails.guard).toBe("backoff");
    expect(skipDetails.count).toBe(1);
  });

  it("does not insert further wakeup rows once the guard trips (loop dies cold)", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const retryOfRunId = "e6d552b0-11112222-3333-4444-555566667777";
    // Seed 1 prior skip 1 s ago — well under the hourly cap, but the next
    // wake is attempt 2 which needs the 30 s backoff floor.
    const now = Date.now();
    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId, agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_dependencies_blocked",
      payload: { issueId, mutation: "interaction", retryOfRunId },
      status: "skipped",
      requestedByActorType: "system",
      requestedByActorId: "test",
      createdAt: new Date(now - 1_000),
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

    // The single new row is the trip-record for the backoff guard.
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
    // Seed 1 prior skip 1 s ago — backoff fires on the next wake.
    const now = Date.now();
    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId, agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_dependencies_blocked",
      payload: { issueId, mutation: "interaction", retryOfRunId },
      status: "skipped",
      requestedByActorType: "system",
      requestedByActorId: "test",
      createdAt: new Date(now - 1_000),
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
    const now = Date.now();
    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId, agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_dependencies_blocked",
      payload: { issueId, mutation: "interaction", retryOfRunId },
      status: "skipped",
      requestedByActorType: "system",
      requestedByActorId: "test",
      createdAt: new Date(now - 1_000),
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

  it.each(["interaction"])("permanently exhausts a low-frequency %s chain across hourly rollover", async (mutation) => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const now = new Date();
    await db.insert(agentWakeupRequests).values(Array.from({ length: 10 }, (_, index) => ({
      companyId, agentId,
      source: "automation", triggerDetail: "system", status: "skipped",
      reason: "issue_dependencies_blocked",
      payload: { issueId, mutation, retryOfRunId: "persistent-chain" },
      createdAt: new Date(now.getTime() - (12 - index) * 12 * 60_000),
    })));
    for (const elapsed of [0, 24 * 60 * 60_000]) {
      const decision = await evaluateWakeLoopGuard(db, {
        companyId, agentId, issueId,
        payload: { issueId, mutation, retryOfRunId: "persistent-chain" },
        now: new Date(now.getTime() + elapsed),
      });
      expect(decision).toMatchObject({ tripped: true, guard: "chain", count: 10, limit: 10 });
    }
    expect(await evaluateWakeLoopGuard(db, {
      companyId, agentId, issueId, payload: { issueId, mutation, retryOfRunId: "new-work" }, now,
    })).toEqual({ tripped: false });
  });

  it("does not permanently exhaust healthy successful continuations", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const now = new Date();
    await db.insert(agentWakeupRequests).values(Array.from({ length: 10 }, (_, index) => ({
      companyId, agentId, source: "automation", triggerDetail: "system", status: "consumed",
      reason: index % 2 ? "issue_continuation_needed" : "finish_successful_run_handoff",
      payload: { issueId, retryOfRunId: randomUUID() },
      createdAt: new Date(now.getTime() - (12 - index) * 12 * 60_000),
    })));
    expect(await evaluateWakeLoopGuard(db, {
      companyId, agentId, issueId, payload: { issueId, retryOfRunId: randomUUID() },
      reason: "issue_continuation_needed", now,
    })).toEqual({ tripped: false });
  });

  // SPA-11862 — issue_continuation_needed and finish_successful_run_handoff are
  // not question-response retry wakes. They must remain ineligible for the
  // chain-exhaust pattern: even at 10 saturated rows on the wake field, the
  // chain guard must not report them as exhausted.
  it.each(["issue_continuation_needed", "finish_successful_run_handoff"] as const)(
    "does not chain-exhaust a healthy %s wake even with 10 saturated rows on the same wake field",
    async (reason) => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
      const now = new Date();
      await db.insert(agentWakeupRequests).values(Array.from({ length: 10 }, (_, index) => ({
        companyId, agentId,
        source: "automation", triggerDetail: "system", status: "skipped",
        reason: "issue_dependencies_blocked",
        payload: { issueId, mutation: "interaction", retryOfRunId: "persistent-chain" },
        createdAt: new Date(now.getTime() - (12 - index) * 12 * 60_000),
      })));
      // No payload mutation / no chain key → not eligible for chain guard.
      expect(await evaluateWakeLoopGuard(db, {
        companyId, agentId, issueId,
        payload: { issueId },
        reason,
        now,
      })).toEqual({ tripped: false });
    },
  );

  it("credits only explicit same-owner scheduled routine delegation", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const routineId = randomUUID();
    await db.insert(routines).values({ id: routineId, companyId, parentIssueId: issueId,
      assigneeAgentId: agentId, title: "Next continuation", status: "active" });
    await db.insert(routineTriggers).values({ companyId, routineId, kind: "schedule",
      enabled: true, nextRunAt: new Date(Date.now() + 60_000) });
    const input = { companyId, agentId, issueId, continuationRoutineId: routineId };
    expect(await hasEligibleRoutineContinuation(db, input)).toBe(true);
    expect(await hasEligibleRoutineContinuation(db, { ...input, continuationRoutineId: undefined })).toBe(false);
    expect(await hasEligibleRoutineContinuation(db, { ...input, agentId: randomUUID() })).toBe(false);
    await db.update(routineTriggers).set({ enabled: false }).where(eq(routineTriggers.routineId, routineId));
    expect(await hasEligibleRoutineContinuation(db, input)).toBe(false);
    await db.update(routineTriggers).set({ enabled: true, nextRunAt: null }).where(eq(routineTriggers.routineId, routineId));
    expect(await hasEligibleRoutineContinuation(db, input)).toBe(false);
  });

  it("keeps the backoff attempt count across the hourly boundary", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const now = new Date();
    await db.insert(agentWakeupRequests).values(Array.from({ length: 8 }, (_, index) => ({
      companyId, agentId, source: "automation", triggerDetail: "system", status: "skipped",
      reason: "issue_dependencies_blocked",
      payload: { issueId, mutation: "interaction", retryOfRunId: "long-chain" },
      createdAt: new Date(now.getTime() - (index === 7 ? 30_000 : (9 - index) * 60 * 60_000)),
    })));
    expect(await evaluateWakeLoopGuard(db, {
      companyId, agentId, issueId, payload: { issueId, mutation: "interaction", retryOfRunId: "long-chain" }, now,
    })).toMatchObject({ tripped: true, guard: "backoff", attempt: 9 });
  });

  it("window cutoff excludes unrelated wakeups older than the rolling hour", async () => {
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
      payload: { issueId, mutation: "interaction", retryOfRunId: "fresh-chain" },
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

  // SPA-11862 — narrow the saturated-history guard to question-response retry
  // wakes only. The hourly/chain caps catch gross abuse; the dedicated
  // question-response-history suppression is the targeted defense for the
  // "skipped question-response wake every 30 s" defect.
  describe("isQuestionResponseRetryWake eligibility predicate (SPA-11862)", () => {
    // The helper is the new exported predicate. Until the production export is
    // added, this import will fail compilation and the suite is RED by design.
    let isQuestionResponseRetryWake: typeof import("../services/wake-loop-guard.ts").isQuestionResponseRetryWake;
    let isQuestionResponseRetryWakeSuppressedByError:
      typeof import("../services/wake-loop-guard.ts").isQuestionResponseRetryWakeSuppressedByError;
    let summarizeQuestionResponseHistoryInWindow:
      typeof import("../services/wake-loop-guard.ts").summarizeQuestionResponseHistoryInWindow;
    beforeAll(async () => {
      const mod = await import("../services/wake-loop-guard.ts");
      isQuestionResponseRetryWake = mod.isQuestionResponseRetryWake;
      isQuestionResponseRetryWakeSuppressedByError = mod.isQuestionResponseRetryWakeSuppressedByError;
      summarizeQuestionResponseHistoryInWindow = mod.summarizeQuestionResponseHistoryInWindow;
    });

    const interactionId = "7c1d9b3a-1111-4222-8333-444455556666";

    function canonicalEligibleWake() {
      return {
        reason: "issue_commented",
        payload: { mutation: "interaction", interactionId },
        idempotencyKey: `question-response:${interactionId}`,
        contextSnapshot: {
          source: "issue.interaction.respond",
          interactionId,
          wakeReason: "issue_commented",
        },
        requestedByActorType: "system" as const,
        manualUserWake: false,
      };
    }

    it("admits the canonical question-response wake shape", () => {
      expect(isQuestionResponseRetryWake(canonicalEligibleWake())).toBe(true);
    });

    it.each(["user", "agent", "system"] as const)(
      "remains eligible when requestedByActorType=%s (actor attribution is not a bypass)",
      (requestedByActorType) => {
        expect(
          isQuestionResponseRetryWake({
            ...canonicalEligibleWake(),
            requestedByActorType,
          }),
        ).toBe(true);
      },
    );

    it("stays eligible when payload.retryOfRunId is absent (drifting retryOfRunId does not affect eligibility)", () => {
      expect(isQuestionResponseRetryWake(canonicalEligibleWake())).toBe(true);
    });

    it("stays eligible when payload.retryOfRunId is set to a stale value (drifting retryOfRunId does not affect eligibility)", () => {
      expect(
        isQuestionResponseRetryWake({
          ...canonicalEligibleWake(),
          payload: {
            ...canonicalEligibleWake().payload,
            retryOfRunId: "stale-orphan-run-id-from-a-prior-cycle",
          },
        }),
      ).toBe(true);
    });

    it("explicit manualUserWake=true bypasses the predicate (returns false: not a candidate for suppression)", () => {
      expect(
        isQuestionResponseRetryWake({
          ...canonicalEligibleWake(),
          manualUserWake: true,
        }),
      ).toBe(false);
    });

    it("rejects when reason is not issue_commented", () => {
      expect(
        isQuestionResponseRetryWake({
          ...canonicalEligibleWake(),
          reason: "issue_assigned",
        }),
      ).toBe(false);
    });

    it("rejects when payload.mutation is not 'interaction'", () => {
      expect(
        isQuestionResponseRetryWake({
          ...canonicalEligibleWake(),
          payload: { ...canonicalEligibleWake().payload, mutation: "comment" },
        }),
      ).toBe(false);
    });

    it("rejects when payload.interactionId is missing or not a UUID", () => {
      expect(
        isQuestionResponseRetryWake({
          ...canonicalEligibleWake(),
          payload: { ...canonicalEligibleWake().payload, interactionId: undefined },
        }),
      ).toBe(false);
      expect(
        isQuestionResponseRetryWake({
          ...canonicalEligibleWake(),
          payload: { ...canonicalEligibleWake().payload, interactionId: "not-a-uuid" },
        }),
      ).toBe(false);
    });

    it("rejects when idempotencyKey is missing or not exactly 'question-response:<interactionId>'", () => {
      expect(
        isQuestionResponseRetryWake({
          ...canonicalEligibleWake(),
          idempotencyKey: undefined,
        }),
      ).toBe(false);
      expect(
        isQuestionResponseRetryWake({
          ...canonicalEligibleWake(),
          idempotencyKey: "question-response:other-uuid",
        }),
      ).toBe(false);
      expect(
        isQuestionResponseRetryWake({
          ...canonicalEligibleWake(),
          idempotencyKey: `handoff_bounded_continuation:${interactionId}`,
        }),
      ).toBe(false);
    });

    it("rejects when contextSnapshot.source is not 'issue.interaction.respond'", () => {
      expect(
        isQuestionResponseRetryWake({
          ...canonicalEligibleWake(),
          contextSnapshot: { ...canonicalEligibleWake().contextSnapshot, source: "issue.assigned" },
        }),
      ).toBe(false);
    });

    it("rejects when contextSnapshot.interactionId is missing or does not match payload.interactionId", () => {
      expect(
        isQuestionResponseRetryWake({
          ...canonicalEligibleWake(),
          contextSnapshot: { ...canonicalEligibleWake().contextSnapshot, interactionId: undefined },
        }),
      ).toBe(false);
      expect(
        isQuestionResponseRetryWake({
          ...canonicalEligibleWake(),
          contextSnapshot: {
            ...canonicalEligibleWake().contextSnapshot,
            interactionId: "8d2e0c4b-2222-4333-9444-555566667777",
          },
        }),
      ).toBe(false);
    });

    it("rejects when contextSnapshot.wakeReason is missing or does not match reason", () => {
      expect(
        isQuestionResponseRetryWake({
          ...canonicalEligibleWake(),
          contextSnapshot: { ...canonicalEligibleWake().contextSnapshot, wakeReason: undefined },
        }),
      ).toBe(false);
      expect(
        isQuestionResponseRetryWake({
          ...canonicalEligibleWake(),
          contextSnapshot: {
            ...canonicalEligibleWake().contextSnapshot,
            wakeReason: "issue_assigned",
          },
        }),
      ).toBe(false);
    });

    it("rejects wakes whose reason is unrelated to question-response delivery", () => {
      for (const reason of ["issue_assigned", "issue_monitor_due", "issue_review_path_lost"]) {
        expect(
          isQuestionResponseRetryWake({ ...canonicalEligibleWake(), reason }),
        ).toBe(false);
      }
    });

    it("rejects wakes whose contextSnapshot.source is an unrelated comment path", () => {
      expect(
        isQuestionResponseRetryWake({
          ...canonicalEligibleWake(),
          contextSnapshot: {
            ...canonicalEligibleWake().contextSnapshot,
            source: "issue.commented",
          },
        }),
      ).toBe(false);
    });

    it("summarizeQuestionResponseHistoryInWindow counts only eligible skipped rows for (agent, issue)", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
      const now = Date.now();
      const otherInteractionId = "a1111111-2222-4333-8444-555566667777";
      // Eligible skipped row (canonical shape) — must count.
      await db.insert(agentWakeupRequests).values({
        id: randomUUID(),
        companyId, agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: {
          issueId,
          mutation: "interaction",
          interactionId,
        },
        idempotencyKey: `question-response:${interactionId}`,
        status: "skipped",
        requestedByActorType: "system",
        requestedByActorId: "question-response-delivery",
        createdAt: new Date(now - 1_000),
      });
      // Ineligible sibling — payload interactionId and idempotency key disagree — must NOT count.
      await db.insert(agentWakeupRequests).values({
        id: randomUUID(),
        companyId, agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId, mutation: "interaction", interactionId: otherInteractionId },
        idempotencyKey: `question-response:${interactionId}`,
        status: "skipped",
        requestedByActorType: "system",
        requestedByActorId: "question-response-delivery",
        createdAt: new Date(now - 1_000),
      });
      // Ineligible sibling — non-interaction mutation — must NOT count.
      await db.insert(agentWakeupRequests).values({
        id: randomUUID(),
        companyId, agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId, mutation: "comment", interactionId },
        idempotencyKey: `question-response:${interactionId}`,
        status: "skipped",
        requestedByActorType: "system",
        requestedByActorId: "question-response-delivery",
        createdAt: new Date(now - 1_000),
      });
      // Ineligible sibling — different reason — must NOT count.
      await db.insert(agentWakeupRequests).values({
        id: randomUUID(),
        companyId, agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId, mutation: "interaction", interactionId },
        idempotencyKey: `question-response:${interactionId}`,
        status: "skipped",
        requestedByActorType: "system",
        requestedByActorId: "question-response-delivery",
        createdAt: new Date(now - 1_000),
      });

      const summary = await summarizeQuestionResponseHistoryInWindow(db, {
        companyId, agentId, issueId,
        now: new Date(now),
      });
      expect(summary.eligibleSkippedInWindow).toBe(1);
    });

    it("trip-row exclusion: a wake_loop_guard_tripped row is never counted toward eligible history", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
      const now = Date.now();
      await db.insert(agentWakeupRequests).values({
        id: randomUUID(),
        companyId, agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "wake_loop_guard_tripped",
        payload: {
          issueId,
          heartbeatSkip: { guard: "chain", count: 11, limit: 10, windowMs: 60 * 60 * 1000 },
        },
        status: "skipped",
        requestedByActorType: "system",
        requestedByActorId: "test",
        createdAt: new Date(now - 1_000),
      });

      const summary = await summarizeQuestionResponseHistoryInWindow(db, {
        companyId, agentId, issueId,
        now: new Date(now),
      });
      expect(summary.eligibleSkippedInWindow).toBe(0);
    });

    it("isQuestionResponseRetryWakeSuppressedByError: eligible wake with saturated history is suppressed; non-eligible wake is not", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
      const now = Date.now();
      // 21 eligible skipped rows in the last hour — well over any reasonable
      // saturated-history threshold (a stable production cap is 20 hourly, so
      // 21 forces the suppression without depending on the constant).
      const rows = Array.from({ length: 21 }, () => ({
        id: randomUUID(),
        companyId, agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_dependencies_blocked",
        payload: {
          issueId,
          mutation: "interaction",
          interactionId,
        },
        idempotencyKey: `question-response:${interactionId}`,
        status: "skipped",
        requestedByActorType: "system",
        requestedByActorId: "question-response-delivery",
        createdAt: new Date(now - 1_000),
      }));
      await db.insert(agentWakeupRequests).values(rows);

      // Eligible wake shape → suppression must apply.
      expect(
        await isQuestionResponseRetryWakeSuppressedByError(db, {
          companyId, agentId, issueId,
          wake: canonicalEligibleWake(),
          now: new Date(now),
        }),
      ).toBe(true);

      // Non-eligible wake shape (wrong reason) → guard must NOT suppress it.
      expect(
        await isQuestionResponseRetryWakeSuppressedByError(db, {
          companyId, agentId, issueId,
          wake: { ...canonicalEligibleWake(), reason: "issue_assigned" },
          now: new Date(now),
        }),
      ).toBe(false);

      // Eligible but manualUserWake=true → must bypass the suppression.
      expect(
        await isQuestionResponseRetryWakeSuppressedByError(db, {
          companyId, agentId, issueId,
          wake: { ...canonicalEligibleWake(), manualUserWake: true },
          now: new Date(now),
        }),
      ).toBe(false);
    });

    it("hourly accounting is eligible-only: non-eligible rows do not consume the budget", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
      const now = Date.now();
      // 25 unrelated skipped rows — none eligible, none should count toward
      // the question-response-history bucket.
      await seedSkippedWakeup({
        companyId, agentId, issueId,
        mutation: "interaction",
        retryOfRunId: "noise",
        count: 25,
      });
      const summary = await summarizeQuestionResponseHistoryInWindow(db, {
        companyId, agentId, issueId,
        now: new Date(now),
      });
      expect(summary.eligibleSkippedInWindow).toBe(0);
    });
  });

  describe("heartbeat integration: saturated eligible question-response history suppresses only the matching retry (SPA-11862)", () => {
    const interactionId = "7c1d9b3a-1111-4222-8333-444455556666";

    async function seedSaturatedEligibleQuestionResponseHistory(
      args: { companyId: string; agentId: string; issueId: string; count: number },
    ) {
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
          mutation: "interaction",
          interactionId,
        },
        idempotencyKey: `question-response:${interactionId}`,
        status: "skipped",
        requestedByActorType: "system",
        requestedByActorId: "question-response-delivery",
        createdAt: new Date(now - (args.count - index) * 1_000),
      }));
      await db.insert(agentWakeupRequests).values(rows);
    }

    function canonicalQuestionResponseWake(
      args: { companyId: string; agentId: string; issueId: string },
    ) {
      return {
        source: "automation" as const,
        triggerDetail: "system" as const,
        reason: "issue_commented",
        payload: { issueId: args.issueId, mutation: "interaction", interactionId },
        idempotencyKey: `question-response:${interactionId}`,
        contextSnapshot: {
          issueId: args.issueId,
          taskId: args.issueId,
          source: "issue.interaction.respond",
          interactionId,
          interactionKind: "ask_user_questions",
          interactionStatus: "answered",
          wakeReason: "issue_commented",
        },
        requestedByActorType: "system" as const,
        requestedByActorId: "question-response-delivery",
      };
    }

    it("suppresses the matching question-response retry when the eligible history is saturated", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
      await seedSaturatedEligibleQuestionResponseHistory({ companyId, agentId, issueId, count: 21 });

      const wake = await heartbeat.wakeup(agentId, canonicalQuestionResponseWake({ companyId, agentId, issueId }));
      expect(wake).toBeNull();

      // A single wake_loop_guard_tripped row must be the only NEW row — no
      // question-response retry row, no extra trip-rows (dedup). The guard
      // label should reflect the targeted question-response-history guard,
      // not the gross-abuse chain/hourly layer.
      const recentRows = await db
        .select({
          reason: agentWakeupRequests.reason,
          payload: agentWakeupRequests.payload,
          status: agentWakeupRequests.status,
        })
        .from(agentWakeupRequests)
        .where(and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.agentId, agentId),
        ))
        .orderBy(desc(agentWakeupRequests.createdAt))
        .limit(1);
      const latest = recentRows[0];
      expect(latest?.reason).toBe("wake_loop_guard_tripped");
      const skip = (latest?.payload as Record<string, unknown> | null)?.heartbeatSkip as Record<string, unknown> | undefined;
      // The targeted suppression must label the trip distinctly from the
      // broad chain/hourly guards — never re-use those.
      expect(typeof skip?.guard).toBe("string");
      expect(["chain", "hourly", "backoff"]).not.toContain(skip?.guard);
    });

    it("still enqueues an assignment wake when the eligible history is saturated", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
      await seedSaturatedEligibleQuestionResponseHistory({ companyId, agentId, issueId, count: 21 });

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

    it("still enqueues an issue_review_path_lost wake when the eligible history is saturated", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
      await seedSaturatedEligibleQuestionResponseHistory({ companyId, agentId, issueId, count: 21 });

      const wake = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_review_path_lost",
        payload: { issueId },
        contextSnapshot: {
          issueId,
          wakeReason: "issue_review_path_lost",
          source: "issue.execution_review_recovery",
        },
        requestedByActorType: "system",
        requestedByActorId: "issue_review_recovery",
      });
      expect(wake).not.toBeNull();
    });

    it("still enqueues an issue_continuation_needed wake when the eligible history is saturated", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
      await seedSaturatedEligibleQuestionResponseHistory({ companyId, agentId, issueId, count: 21 });

      const wake = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_continuation_needed",
        payload: { issueId },
        contextSnapshot: {
          issueId,
          wakeReason: "issue_continuation_needed",
          source: "issue.productive_terminal_continuation_recovery",
        },
        requestedByActorType: "system",
        requestedByActorId: "continuation_recovery",
      });
      expect(wake).not.toBeNull();
    });

    it("still enqueues a finish_successful_run_handoff wake when the eligible history is saturated", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
      await seedSaturatedEligibleQuestionResponseHistory({ companyId, agentId, issueId, count: 21 });

      const wake = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "finish_successful_run_handoff",
        payload: { issueId },
        contextSnapshot: {
          issueId,
          wakeReason: "finish_successful_run_handoff",
          source: "issue.successful_run_handoff",
        },
        requestedByActorType: "system",
        requestedByActorId: "successful_run_handoff",
      });
      expect(wake).not.toBeNull();
    });

    it("still enqueues an unrelated corrective/comment wake when the eligible history is saturated", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
      await seedSaturatedEligibleQuestionResponseHistory({ companyId, agentId, issueId, count: 21 });

      const wake = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId }, // no mutation:interaction → not a question-response retry
        contextSnapshot: {
          issueId,
          wakeReason: "issue_commented",
          source: "issue.commented",
        },
        requestedByActorType: "system",
        requestedByActorId: "comment_listener",
      });
      expect(wake).not.toBeNull();
    });

    it("an explicit manual user wake bypasses the question-response-history suppression", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
      await seedSaturatedEligibleQuestionResponseHistory({ companyId, agentId, issueId, count: 21 });

      const wake = await heartbeat.wakeup(agentId, {
        ...canonicalQuestionResponseWake({ companyId, agentId, issueId }),
        source: "on_demand",
        triggerDetail: "user",
        manualUserWake: true,
        requestedByActorType: "user",
        requestedByActorId: "board-user",
      });
      expect(wake).not.toBeNull();
    });
  });
});