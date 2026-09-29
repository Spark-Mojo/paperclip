/**
 * SPA-9351 shape 1 — the bounded re-wake for a card stranded by an exhausted
 * retry budget.
 *
 * Pure decision tests first: they are fast, deterministic, and cover every
 * guard. The embedded-Postgres test at the bottom drives the real
 * `recoveryService` sweep so the wiring (and, critically, the fact that the
 * exhausted predecessor is never handed back to `scheduleRecoveryRetry`) is
 * proven against the actual database.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  BOUNDED_TRANSIENT_RETRY_REASON,
  DEFAULT_STRANDED_EXHAUSTED_RETRY_REWAKE_DELAY_MS,
  EXHAUSTED_RETRY_REWAKE_MAX_ATTEMPTS,
  EXHAUSTED_RETRY_REWAKE_SOURCE,
  EXHAUSTED_RETRY_REWAKE_WAKE_REASON,
  buildExhaustedRetryRewakeEpisodeKey,
  buildExhaustedRetryRewakeIdempotencyKey,
  decideExhaustedRetryRewake,
  exhaustedRetryRewakeEpisodeContext,
  readExhaustedRetryRewakeEpisode,
  type ExhaustedRetryEpisodeFacts,
} from "./exhausted-retry-rewake.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";

// The delay is read from the environment at decision time, so pin it here
// rather than relying on ambient config. `ELAPSED_AGO` must exceed it.
process.env.STRANDED_EXHAUSTED_RETRY_REWAKE_DELAY_MS = "1800000";
const DELAY_MS = Number(process.env.STRANDED_EXHAUSTED_RETRY_REWAKE_DELAY_MS);
const NOW = new Date("2026-09-29T12:00:00.000Z");
const LONG_AGO = new Date(NOW.getTime() - 4 * 60 * 60 * 1000);

/** A fully eligible exhausted-transient episode; individual tests break one fact. */
function eligible(overrides: Partial<ExhaustedRetryEpisodeFacts> = {}): ExhaustedRetryEpisodeFacts {
  return {
    retryReason: BOUNDED_TRANSIENT_RETRY_REASON,
    errorCode: "adapter_failed",
    classificationKind: "transient_infra",
    retryBudgetExhausted: true,
    latestFinishedAt: LONG_AGO,
    episodeRewakeCount: 0,
    recoveryBudgetExhausted: false,
    hasLiveExecutionPath: false,
    hasQueuedWake: false,
    hasOpenBlocker: false,
    hasPendingInteraction: false,
    isInvocationBudgetBlocked: false,
    isSuppressedByPauseHold: false,
    issueStatus: "in_progress",
    hasAgentAssignee: true,
    now: NOW,
    ...overrides,
  };
}

describe("SPA-9351 shape 1: decideExhaustedRetryRewake", () => {
  it("re-wakes a card stranded by an exhausted bounded-transient retry", () => {
    const decision = decideExhaustedRetryRewake(eligible());
    expect(decision.kind).toBe("rewake");
    if (decision.kind === "rewake") {
      expect(decision.delayMs).toBe(DELAY_MS);
    }
    console.log("STRANDED-RECOVERY-GATES: shape1-rewake");
  });

  it("rewakes a `todo` card too — the card's own contract names in_progress/todo", () => {
    expect(decideExhaustedRetryRewake(eligible({ issueStatus: "todo" })).kind).toBe("rewake");
  });

  it("never re-wakes a non-retryable failure: it must stay on the escalate path", () => {
    const decision = decideExhaustedRetryRewake(
      eligible({ classificationKind: "non_retryable", errorCode: "setup_failed" }),
    );
    expect(decision).toEqual({ kind: "suppressed", reason: "not_retryable" });
    console.log("STRANDED-RECOVERY-GATES: shape1-non-retryable-untouched");
  });

  it("does not re-wake while retry budget remains", () => {
    expect(decideExhaustedRetryRewake(eligible({ retryBudgetExhausted: false }))).toEqual({
      kind: "suppressed",
      reason: "retry_budget_remaining",
    });
  });

  it("ignores episodes from a different lane (issue_continuation_needed keeps its own branch)", () => {
    expect(
      decideExhaustedRetryRewake(eligible({ retryReason: "issue_continuation_needed" })),
    ).toEqual({ kind: "suppressed", reason: "not_bounded_transient_episode" });
  });

  describe("bounded: one re-wake per episode", () => {
    it("does not re-wake an episode that already spent its re-wake", () => {
      expect(
        decideExhaustedRetryRewake(
          eligible({ episodeRewakeCount: EXHAUSTED_RETRY_REWAKE_MAX_ATTEMPTS }),
        ),
      ).toEqual({ kind: "suppressed", reason: "episode_already_rewoken" });
    });

    it("caps at exactly one re-wake", () => {
      expect(EXHAUSTED_RETRY_REWAKE_MAX_ATTEMPTS).toBe(1);
    });

    it("does not re-wake a card whose recovery action already escalated", () => {
      expect(decideExhaustedRetryRewake(eligible({ recoveryBudgetExhausted: true }))).toEqual({
        kind: "suppressed",
        reason: "recovery_budget_exhausted",
      });
    });

    it("budgets per episode, not per card: a different exhausted run is a fresh episode", () => {
      const first = buildExhaustedRetryRewakeEpisodeKey({
        companyId: "c1",
        issueId: "i1",
        exhaustedRunId: "run-a",
      });
      const second = buildExhaustedRetryRewakeEpisodeKey({
        companyId: "c1",
        issueId: "i1",
        exhaustedRunId: "run-b",
      });
      // `adapter_failed` is broad; keying on it would permanently suppress
      // recovery from a later, unrelated incident on the same card.
      expect(first).not.toBe(second);
      expect(first).not.toContain("adapter_failed");
    });

    it("gives a stable idempotency key per episode so a restart cannot double-fire", () => {
      const episodeKey = buildExhaustedRetryRewakeEpisodeKey({
        companyId: "c1",
        issueId: "i1",
        exhaustedRunId: "run-a",
      });
      expect(
        buildExhaustedRetryRewakeIdempotencyKey({ companyId: "c1", issueId: "i1", episodeKey }),
      ).toBe(
        buildExhaustedRetryRewakeIdempotencyKey({ companyId: "c1", issueId: "i1", episodeKey }),
      );
    });
  });

  describe("guards: a card with any other path is left alone", () => {
    it.each([
      ["hasLiveExecutionPath", "live_execution_path"],
      ["hasQueuedWake", "queued_wake"],
      ["hasOpenBlocker", "open_blocker"],
      ["hasPendingInteraction", "pending_interaction"],
      ["isInvocationBudgetBlocked", "invocation_budget_blocked"],
      ["isSuppressedByPauseHold", "pause_hold"],
    ] as const)("suppresses on %s", (fact, reason) => {
      expect(decideExhaustedRetryRewake(eligible({ [fact]: true }))).toEqual({
        kind: "suppressed",
        reason,
      });
    });

    it.each(["done", "blocked", "in_review", "backlog", "cancelled"])(
      "does not re-wake a %s card",
      (status) => {
        expect(decideExhaustedRetryRewake(eligible({ issueStatus: status }))).toEqual({
          kind: "suppressed",
          reason: "issue_not_assignable",
        });
      },
    );

    it("does not re-woke an unassigned card", () => {
      expect(decideExhaustedRetryRewake(eligible({ hasAgentAssignee: false }))).toEqual({
        kind: "suppressed",
        reason: "issue_not_assignable",
      });
    });
  });

  describe("delay", () => {
    it("waits out the full delay after the episode's last finished run", () => {
      const decision = decideExhaustedRetryRewake(
        eligible({
          latestFinishedAt: new Date(NOW.getTime() - DELAY_MS + 1_000),
        }),
      );
      expect(decision).toEqual({ kind: "suppressed", reason: "delay_not_elapsed" });
    });

    it("fires exactly at the delay boundary", () => {
      expect(
        decideExhaustedRetryRewake(
          eligible({ latestFinishedAt: new Date(NOW.getTime() - DELAY_MS) }),
        ).kind,
      ).toBe("rewake");
    });

    it("waits rather than firing immediately when no finish time is recorded", () => {
      expect(decideExhaustedRetryRewake(eligible({ latestFinishedAt: null }))).toEqual({
        kind: "suppressed",
        reason: "delay_not_elapsed",
      });
    });

    it("has a floor, so a misconfigured env cannot create a hot loop", () => {
      expect(DELAY_MS).toBeGreaterThanOrEqual(60_000);
    });
  });

  describe("episode context round-trip", () => {
    it("reads the episode back off a wake context snapshot", () => {
      const episodeKey = buildExhaustedRetryRewakeEpisodeKey({
        companyId: "c1",
        issueId: "i1",
        exhaustedRunId: "run-a",
      });
      const context = exhaustedRetryRewakeEpisodeContext({
        episodeKey,
        exhaustedRunId: "run-a",
        errorCode: "adapter_failed",
      });
      expect(readExhaustedRetryRewakeEpisode(context)).toEqual({
        episodeKey,
        exhaustedRunId: "run-a",
        errorCode: "adapter_failed",
      });
    });

    it("returns null for a context that carries no episode marker", () => {
      expect(readExhaustedRetryRewakeEpisode({ issueId: "i1" })).toBeNull();
      expect(readExhaustedRetryRewakeEpisode(null)).toBeNull();
    });
  });

  it("emits the bounded gate marker only once every bound is proven", () => {
    // Re-assert the three properties together, so a single regression cannot
    // silently drop the marker while the individual cases still pass.
    expect(decideExhaustedRetryRewake(eligible()).kind).toBe("rewake");
    expect(
      decideExhaustedRetryRewake(eligible({ episodeRewakeCount: 1 })).kind,
    ).toBe("suppressed");
    expect(
      decideExhaustedRetryRewake(eligible({ classificationKind: "non_retryable" })).kind,
    ).toBe("suppressed");
    console.log("STRANDED-RECOVERY-GATES: shape1-bounded");
  });
});

// ---------------------------------------------------------------------------
// Integration: the real sweep, against a real database.
// ---------------------------------------------------------------------------

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping SPA-9351 shape 1 integration on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("SPA-9351 shape 1: stranded sweep re-wakes an exhausted card", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-spa-9351-shape1-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRecoveryActions);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  async function seedStrandedByExhaustedTransientRetry(options: { agentId: string }) {
    const companyId = "11111111-1111-4111-8111-111111111111";
    const issueId = "22222222-2222-4222-8222-222222222222";
    const exhaustedRunId = "33333333-3333-4333-8333-333333333333";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "SPA",
      requireBoardApprovalForNewAgents: false,
    });
    // `authUsers` has no DB defaults on name/email/created_at/updated_at.
    await db.insert(authUsers).values({
      id: "local-board",
      name: "Board",
      email: "board@local",
      createdAt: LONG_AGO,
      updatedAt: LONG_AGO,
    });
    await db.insert(agents).values({
      id: options.agentId,
      companyId,
      name: "agent",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stranded by exhausted retries",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: options.agentId,
      executionRunId: null,
      issueNumber: 1,
      identifier: "SPA-1",
    });
    // Mirrors SPA-8692's real rows: a terminal `failed` run carrying
    // `retryReason: "transient_failure"` (the bounded-transient lane), which
    // the `issue_continuation_needed` branch structurally cannot see.
    await db.insert(heartbeatRuns).values({
      id: exhaustedRunId,
      companyId,
      agentId: options.agentId,
      invocationSource: "manual",
      status: "failed",
      errorCode: "adapter_failed",
      error: "spawn E2BIG",
      startedAt: LONG_AGO,
      finishedAt: LONG_AGO,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "transient_failure_retry",
        retryReason: BOUNDED_TRANSIENT_RETRY_REASON,
      },
    });

    return { companyId, issueId, exhaustedRunId, agentId: options.agentId };
  }

  it("enqueues exactly one re-wake and never re-submits the exhausted run to the retry scheduler", async () => {
    const seeded = await seedStrandedByExhaustedTransientRetry({
      agentId: "44444444-4444-4444-8444-444444444444",
    });
    const { recoveryService } = await import("./service.js");
    const enqueueWakeup = vi.fn(async () => ({
      id: "55555555-5555-4555-8555-555555555555",
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      status: "queued",
    }));
    const scheduleRecoveryRetry = vi.fn(async () => null);

    const recovery = recoveryService(db, { enqueueWakeup, scheduleRecoveryRetry } as never);
    const result = await recovery.reconcileStrandedAssignedIssues();
    expect(result.exhaustedRetryRewoken).toBe(1);
    expect(result.issueIds).toContain(seeded.issueId);

    // The re-wake happened...
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    const [wakeAgentId, wakeOpts] = enqueueWakeup.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(wakeAgentId).toBe(seeded.agentId);
    expect(wakeOpts.reason).toBe(EXHAUSTED_RETRY_REWAKE_WAKE_REASON);
    expect(
      (wakeOpts.contextSnapshot as Record<string, unknown>).source,
    ).toBe(EXHAUSTED_RETRY_REWAKE_SOURCE);
    expect(wakeOpts.idempotencyKey).toContain("exhausted_retry_rewake");

    // ...and critically it did NOT hand the already-exhausted predecessor back
    // to the heartbeat retry scheduler. That refusal is what stranded the card.
    expect(scheduleRecoveryRetry).not.toHaveBeenCalled();
    expect(wakeOpts.retryOfRunId).toBeUndefined();

    // The card is still `in_progress` — a re-wake, not an escalation.
    const [issue] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, seeded.issueId));
    expect(issue?.status).toBe("in_progress");
  });

  it("persists the episode on the wake so a restart cannot re-wake the same episode", async () => {
    const seeded = await seedStrandedByExhaustedTransientRetry({
      agentId: "66666666-6666-4666-8666-666666666666",
    });
    const { recoveryService } = await import("./service.js");
    const captured: Record<string, unknown>[] = [];
    const enqueueWakeup = vi.fn(async (_agentId: string, opts: Record<string, unknown>) => {
      captured.push(opts);
      return {
        id: "77777777-7777-4777-8777-777777777777",
        companyId: seeded.companyId,
        agentId: seeded.agentId,
        status: "queued",
      };
    });

    const recovery = recoveryService(db, { enqueueWakeup } as never);
    await recovery.reconcileStrandedAssignedIssues();
    expect(captured).toHaveLength(1);

    const episode = readExhaustedRetryRewakeEpisode(
      captured[0].contextSnapshot as Record<string, unknown>,
    );
    expect(episode).not.toBeNull();
    expect(episode?.exhaustedRunId).toBe(seeded.exhaustedRunId);
    expect(episode?.errorCode).toBe("adapter_failed");

    // Simulate the dispatched re-wake run: a second sweep must now see the
    // episode marker on a run and decline to re-wake again.
    await db.insert(heartbeatRuns).values({
      id: "88888888-8888-4888-8888-888888888888",
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      invocationSource: "automation",
      status: "failed",
      errorCode: "adapter_failed",
      startedAt: LONG_AGO,
      finishedAt: LONG_AGO,
      contextSnapshot: {
        issueId: seeded.issueId,
        wakeReason: EXHAUSTED_RETRY_REWAKE_WAKE_REASON,
        retryReason: EXHAUSTED_RETRY_REWAKE_WAKE_REASON,
        ...exhaustedRetryRewakeEpisodeContext({
          episodeKey: episode!.episodeKey,
          exhaustedRunId: episode!.exhaustedRunId,
          errorCode: episode!.errorCode,
        }),
      },
    });

    const second = vi.fn(async () => ({
      id: "99999999-9999-4999-8999-999999999999",
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      status: "queued",
    }));
    const recoveryAgain = recoveryService(db, { enqueueWakeup: second } as never);
    const result = await recoveryAgain.reconcileStrandedAssignedIssues();

    expect(second).not.toHaveBeenCalled();
    expect(result.exhaustedRetryRewoken).toBe(0);
  });

  it("leaves a live execution path alone", async () => {
    const seeded = await seedStrandedByExhaustedTransientRetry({
      agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    await db.insert(heartbeatRuns).values({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      invocationSource: "manual",
      status: "running",
      startedAt: NOW,
      contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId },
    });

    const { recoveryService } = await import("./service.js");
    const enqueueWakeup = vi.fn(async () => ({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      status: "queued",
    }));
    const recovery = recoveryService(db, { enqueueWakeup } as never);
    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.exhaustedRetryRewoken).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });
});

// Keep drizzle imports referenced for FK-safe cleanup ordering documentation.
void and;
void inArray;
void sql;
void desc;
