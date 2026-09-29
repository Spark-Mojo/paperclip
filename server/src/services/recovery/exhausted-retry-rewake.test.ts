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
  ORPHANED_RETRY_REWAKE_MAX_ATTEMPTS,
  ORPHANED_RETRY_REWAKE_SOURCE,
  ORPHANED_RETRY_REWAKE_WAKE_REASON,
  buildExhaustedRetryRewakeEpisodeKey,
  buildExhaustedRetryRewakeIdempotencyKey,
  buildOrphanedRetryRewakeEpisodeKey,
  buildOrphanedRetryRewakeIdempotencyKey,
  decideExhaustedRetryRewake,
  decideOrphanedRetryRewake,
  exhaustedRetryRewakeEpisodeContext,
  isOrphanedRetryRun,
  orphanedRetryRewakeEpisodeContext,
  orphanedRetryRewakeReplacementContext,
  readExhaustedRetryRewakeEpisode,
  readOrphanedRetryRewakeEpisode,
  type ExhaustedRetryEpisodeFacts,
  type OrphanedRetryFacts,
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

function orphanedEligible(overrides: Partial<OrphanedRetryFacts> = {}): OrphanedRetryFacts {
  return {
    runStatus: "interrupted",
    runErrorCode: "orphaned_running_run",
    latestFinishedAt: LONG_AGO,
    episodeRewakeCount: 0,
    recoveryBudgetExhausted: false,
    hasNewerRun: false,
    exhaustedRetryBudgetSpent: false,
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

describe("SPA-9351 shape 4: decideOrphanedRetryRewake", () => {
  it("re-dispatches a run orphaned by a restart", () => {
    const decision = decideOrphanedRetryRewake(orphanedEligible());
    expect(decision.kind).toBe("redispatch");
    if (decision.kind === "redispatch") {
      expect(decision.delayMs).toBe(DELAY_MS);
    }
  });

  it.each([
    ["server_shutdown_interrupted", "own shutdown lane"],
    ["orphaned_running_run_issue_terminal", "issue-terminal authority"],
    ["operator_interrupted", "deliberate stop"],
    [null, "no recorded code"],
  ] as [string | null, string][])("never re-dispatches %s (%s)", (errorCode) => {
    expect(
      decideOrphanedRetryRewake(orphanedEligible({ runErrorCode: errorCode })),
    ).toEqual({ kind: "suppressed", reason: "not_orphaned_retry_run" });
    expect(isOrphanedRetryRun({ status: "interrupted", errorCode })).toBe(false);
  });

  it.each(["failed", "cancelled", "timed_out", "succeeded", "running"])(
    "never re-dispatches a run whose status is %s",
    (status) => {
      expect(decideOrphanedRetryRewake(orphanedEligible({ runStatus: status }))).toEqual({
        kind: "suppressed",
        reason: "not_orphaned_retry_run",
      });
    },
  );

  it("accepts only the exact interrupted + orphaned_running_run pair", () => {
    expect(isOrphanedRetryRun({ status: "interrupted", errorCode: "orphaned_running_run" })).toBe(
      true,
    );
  });

  it("never displaces a newer run, however old the orphan looks", () => {
    expect(decideOrphanedRetryRewake(orphanedEligible({ hasNewerRun: true }))).toEqual({
      kind: "suppressed",
      reason: "newer_run_exists",
    });
  });

  it("caps the re-dispatch at one per episode", () => {
    expect(ORPHANED_RETRY_REWAKE_MAX_ATTEMPTS).toBe(1);
    expect(
      decideOrphanedRetryRewake(
        orphanedEligible({ episodeRewakeCount: ORPHANED_RETRY_REWAKE_MAX_ATTEMPTS }),
      ),
    ).toEqual({ kind: "suppressed", reason: "episode_already_redispatched" });
  });

  it("does not spend a second budget when shape 1 already recovered the card", () => {
    expect(
      decideOrphanedRetryRewake(orphanedEligible({ exhaustedRetryBudgetSpent: true })),
    ).toEqual({ kind: "suppressed", reason: "exhausted_retry_budget_spent" });
  });

  it("keys the episode on the retry ROOT, so a replacement orphan cannot reset it", () => {
    const first = buildOrphanedRetryRewakeEpisodeKey({
      companyId: "c1",
      issueId: "i1",
      rootRunId: "root-1",
    });
    const second = buildOrphanedRetryRewakeEpisodeKey({
      companyId: "c1",
      issueId: "i1",
      rootRunId: "root-1",
    });
    expect(second).toBe(first);
    expect(
      buildOrphanedRetryRewakeEpisodeKey({ companyId: "c1", issueId: "i1", rootRunId: "root-2" }),
    ).not.toBe(first);
  });

  it("gives a stable idempotency key per episode so concurrent sweeps race on it", () => {
    const episodeKey = buildOrphanedRetryRewakeEpisodeKey({
      companyId: "c1",
      issueId: "i1",
      rootRunId: "root-1",
    });
    expect(
      buildOrphanedRetryRewakeIdempotencyKey({ companyId: "c1", issueId: "i1", episodeKey }),
    ).toBe(
      buildOrphanedRetryRewakeIdempotencyKey({ companyId: "c1", issueId: "i1", episodeKey }),
    );
  });

  it.each([
    ["hasLiveExecutionPath", "live_execution_path"],
    ["hasQueuedWake", "queued_wake"],
    ["hasOpenBlocker", "open_blocker"],
    ["hasPendingInteraction", "pending_interaction"],
    ["isInvocationBudgetBlocked", "invocation_budget_blocked"],
    ["isSuppressedByPauseHold", "pause_hold"],
  ] as const)("suppresses on %s", (fact, reason) => {
    expect(decideOrphanedRetryRewake(orphanedEligible({ [fact]: true }))).toEqual({
      kind: "suppressed",
      reason,
    });
  });

  it.each(["done", "blocked", "in_review", "backlog", "cancelled"])(
    "does not re-dispatch a %s card",
    (status) => {
      expect(decideOrphanedRetryRewake(orphanedEligible({ issueStatus: status }))).toEqual({
        kind: "suppressed",
        reason: "issue_not_assignable",
      });
    },
  );

  it("does not re-dispatch an unassigned card", () => {
    expect(decideOrphanedRetryRewake(orphanedEligible({ hasAgentAssignee: false }))).toEqual({
      kind: "suppressed",
      reason: "issue_not_assignable",
    });
  });

  it("does not resurrect a card whose recovery action already escalated", () => {
    expect(
      decideOrphanedRetryRewake(orphanedEligible({ recoveryBudgetExhausted: true })),
    ).toEqual({ kind: "suppressed", reason: "recovery_budget_exhausted" });
  });

  it("waits out the delay, and never fires immediately on an unanchored orphan", () => {
    expect(
      decideOrphanedRetryRewake(
        orphanedEligible({ latestFinishedAt: new Date(NOW.getTime() - DELAY_MS + 1_000) }),
      ),
    ).toEqual({ kind: "suppressed", reason: "delay_not_elapsed" });
    expect(decideOrphanedRetryRewake(orphanedEligible({ latestFinishedAt: null }))).toEqual({
      kind: "suppressed",
      reason: "delay_not_elapsed",
    });
  });

  it("round-trips the episode and the replacement marker through a wake context", () => {
    const episodeKey = buildOrphanedRetryRewakeEpisodeKey({
      companyId: "c1",
      issueId: "i1",
      rootRunId: "root-1",
    });
    const context = orphanedRetryRewakeReplacementContext({
      episodeKey,
      orphanRunId: "orphan-1",
      rootRunId: "root-1",
      previousOrphanRunId: "orphan-0",
    });
    expect(readOrphanedRetryRewakeEpisode(context)).toEqual({
      episodeKey,
      orphanRunId: "orphan-1",
      rootRunId: "root-1",
      previousOrphanRunId: "orphan-0",
    });
    expect(orphanedRetryRewakeEpisodeContext(context)).toEqual(context);
    expect(readOrphanedRetryRewakeEpisode({ issueId: "i1" })).toBeNull();
  });

  it("carries the shape-1 episode marker forward so the two budgets cannot stack", () => {
    const orphanEpisode = buildOrphanedRetryRewakeEpisodeKey({
      companyId: "c1",
      issueId: "i1",
      rootRunId: "root-1",
    });
    const context = {
      ...orphanedRetryRewakeReplacementContext({
        episodeKey: orphanEpisode,
        orphanRunId: "orphan-1",
        rootRunId: "root-1",
      }),
      ...exhaustedRetryRewakeEpisodeContext({
        episodeKey: "exhausted_retry_rewake:c1:i1:run-a",
        exhaustedRunId: "run-a",
        errorCode: "adapter_failed",
      }),
    };
    expect(readOrphanedRetryRewakeEpisode(context)?.episodeKey).toBe(orphanEpisode);
    expect(readExhaustedRetryRewakeEpisode(context)?.exhaustedRunId).toBe("run-a");
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

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping SPA-9351 shape 4 integration on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("SPA-9351 shape 4: sweep re-dispatches a run orphaned by a restart", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-spa-9351-shape4-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db
      .update(issues)
      .set({ checkoutRunId: null, executionRunId: null, executionLockedAt: null });
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.execute(sql`delete from heartbeat_run_events`);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRecoveryActions);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  async function seedLiveRetryAcrossRestart(options: {
    agentId: string;
    issueId: string;
    rootRunId: string;
    retryRunId: string;
  }) {
    const companyId = "12121212-1212-4121-8121-121212121212";
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "SPA",
      requireBoardApprovalForNewAgents: false,
    });
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
      id: options.issueId,
      companyId,
      title: "Retry orphaned by a restart",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: options.agentId,
      issueNumber: 2,
      identifier: "SPA-2",
    });
    await db.insert(heartbeatRuns).values({
      id: options.rootRunId,
      companyId,
      agentId: options.agentId,
      invocationSource: "manual",
      status: "failed",
      errorCode: "adapter_failed",
      startedAt: LONG_AGO,
      finishedAt: LONG_AGO,
      createdAt: LONG_AGO,
      contextSnapshot: {
        issueId: options.issueId,
        taskId: options.issueId,
        retryReason: BOUNDED_TRANSIENT_RETRY_REASON,
      },
    });
    await db.insert(heartbeatRuns).values({
      id: options.retryRunId,
      companyId,
      agentId: options.agentId,
      invocationSource: "automation",
      status: "running",
      retryOfRunId: options.rootRunId,
      scheduledRetryReason: "transient_failure",
      processPid: 999_999_999,
      processGroupId: 999_999_999,
      startedAt: NOW,
      createdAt: NOW,
      contextSnapshot: {
        issueId: options.issueId,
        taskId: options.issueId,
        wakeReason: "transient_failure_retry",
        retryOfRunId: options.rootRunId,
      },
    });
    await db
      .update(issues)
      .set({
        executionRunId: options.retryRunId,
        checkoutRunId: options.retryRunId,
        executionLockedAt: NOW,
      })
      .where(eq(issues.id, options.issueId));

    return { companyId, ...options };
  }

  async function simulateRestartOrphanCleanup(seeded: {
    companyId: string;
    retryRunId: string;
    issueId: string;
  }) {
    const { recoveryService } = await import("./service.js");
    const recovery = recoveryService(db, {
      enqueueWakeup: (async () => null) as never,
    });
    const swept = await recovery.sweepStaleIssueLocks();
    expect(swept.terminalizedRunIds).toContain(seeded.retryRunId);

    const [run] = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, seeded.retryRunId));
    expect(run?.status).toBe("interrupted");
    expect(run?.errorCode).toBe("orphaned_running_run");

    await db
      .update(heartbeatRuns)
      .set({ finishedAt: LONG_AGO })
      .where(eq(heartbeatRuns.id, seeded.retryRunId));

    const [issue] = await db
      .select({ executionRunId: issues.executionRunId, checkoutRunId: issues.checkoutRunId })
      .from(issues)
      .where(eq(issues.id, seeded.issueId));
    expect(issue?.executionRunId).toBeNull();
    expect(issue?.checkoutRunId).toBeNull();
  }

  it("re-dispatches the card after the engine restarts mid-retry", async () => {
    const seeded = await seedLiveRetryAcrossRestart({
      agentId: "d1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1",
      issueId: "d2d2d2d2-d2d2-42d2-82d2-d2d2d2d2d2d2",
      rootRunId: "d3d3d3d3-d3d3-43d3-83d3-d3d3d3d3d3d3",
      retryRunId: "d4d4d4d4-d4d4-44d4-84d4-d4d4d4d4d4d4",
    });
    await simulateRestartOrphanCleanup(seeded);

    const { recoveryService } = await import("./service.js");
    const captured: Record<string, unknown>[] = [];
    const enqueueWakeup = vi.fn(async (_agentId: string, opts: Record<string, unknown>) => {
      captured.push(opts);
      return {
        id: "d5d5d5d5-d5d5-45d5-85d5-d5d5d5d5d5d5",
        companyId: seeded.companyId,
        agentId: seeded.agentId,
        status: "queued",
      };
    });

    const recovery = recoveryService(db, { enqueueWakeup } as never);
    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.orphanedRetryRedispatched).toBe(1);
    expect(result.issueIds).toContain(seeded.issueId);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    const [wakeAgentId, wakeOpts] = enqueueWakeup.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(wakeAgentId).toBe(seeded.agentId);
    expect(wakeOpts.reason).toBe(ORPHANED_RETRY_REWAKE_WAKE_REASON);
    expect((wakeOpts.contextSnapshot as Record<string, unknown>).source).toBe(
      ORPHANED_RETRY_REWAKE_SOURCE,
    );
    expect(wakeOpts.retryOfRunId).toBeUndefined();
    expect(wakeOpts.idempotencyKey).toContain("orphaned_retry_rewake");

    const episode = readOrphanedRetryRewakeEpisode(
      captured[0].contextSnapshot as Record<string, unknown>,
    );
    expect(episode?.orphanRunId).toBe(seeded.retryRunId);
    expect(episode?.rootRunId).toBe(seeded.rootRunId);

    const [issue] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, seeded.issueId));
    expect(issue?.status).toBe("in_progress");
    console.log("STRANDED-RECOVERY-GATES: shape4-orphaned-retry");
  });

  it("leaves a shutdown-interrupted run on its own lane", async () => {
    const seeded = await seedLiveRetryAcrossRestart({
      agentId: "b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1",
      issueId: "b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2",
      rootRunId: "b3b3b3b3-b3b3-43b3-83b3-b3b3b3b3b3b3",
      retryRunId: "b4b4b4b4-b4b4-44b4-84b4-b4b4b4b4b4b4",
    });
    await simulateRestartOrphanCleanup(seeded);
    await db
      .update(heartbeatRuns)
      .set({ errorCode: "server_shutdown_interrupted" })
      .where(eq(heartbeatRuns.id, seeded.retryRunId));

    const { recoveryService } = await import("./service.js");
    const enqueueWakeup = vi.fn(async () => ({
      id: "b5b5b5b5-b5b5-45b5-85b5-b5b5b5b5b5b5",
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      status: "queued",
    }));
    const recovery = recoveryService(db, { enqueueWakeup } as never);
    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.orphanedRetryRedispatched).toBe(0);
  });

  it("leaves an issue-terminal orphan on its own lane", async () => {
    const seeded = await seedLiveRetryAcrossRestart({
      agentId: "c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1",
      issueId: "c2c2c2c2-c2c2-42c2-82c2-c2c2c2c2c2c2",
      rootRunId: "c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3",
      retryRunId: "c4c4c4c4-c4c4-44c4-84c4-c4c4c4c4c4c4",
    });
    await simulateRestartOrphanCleanup(seeded);
    await db
      .update(heartbeatRuns)
      .set({ errorCode: "orphaned_running_run_issue_terminal" })
      .where(eq(heartbeatRuns.id, seeded.retryRunId));

    const { recoveryService } = await import("./service.js");
    const enqueueWakeup = vi.fn(async () => ({
      id: "c5c5c5c5-c5c5-45c5-85c5-c5c5c5c5c5c5",
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      status: "queued",
    }));
    const recovery = recoveryService(db, { enqueueWakeup } as never);
    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.orphanedRetryRedispatched).toBe(0);
  });

  it("does not reset the budget when the replacement is itself orphaned", async () => {
    const seeded = await seedLiveRetryAcrossRestart({
      agentId: "e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1",
      issueId: "e2e2e2e2-e2e2-42e2-82e2-e2e2e2e2e2e2",
      rootRunId: "e3e3e3e3-e3e3-43e3-83e3-e3e3e3e3e3e3",
      retryRunId: "e4e4e4e4-e4e4-44e4-84e4-e4e4e4e4e4e4",
    });
    await simulateRestartOrphanCleanup(seeded);

    const { recoveryService } = await import("./service.js");
    const first = vi.fn(async () => ({
      id: "e5e5e5e5-e5e5-45e5-85e5-e5e5e5e5e5e5",
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      status: "queued",
    }));
    const recovery = recoveryService(db, { enqueueWakeup: first } as never);
    expect((await recovery.reconcileStrandedAssignedIssues()).orphanedRetryRedispatched).toBe(1);

    const replacementRunId = "e6e6e6e6-e6e6-46e6-86e6-e6e6e6e6e6e6";
    await db.insert(heartbeatRuns).values({
      id: replacementRunId,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      invocationSource: "automation",
      status: "running",
      retryOfRunId: seeded.rootRunId,
      processPid: 999_999_998,
      processGroupId: 999_999_998,
      startedAt: NOW,
      createdAt: NOW,
      contextSnapshot: {
        issueId: seeded.issueId,
        taskId: seeded.issueId,
        wakeReason: ORPHANED_RETRY_REWAKE_WAKE_REASON,
        ...orphanedRetryRewakeReplacementContext({
          episodeKey: buildOrphanedRetryRewakeEpisodeKey({
            companyId: seeded.companyId,
            issueId: seeded.issueId,
            rootRunId: seeded.rootRunId,
          }),
          orphanRunId: seeded.retryRunId,
          rootRunId: seeded.rootRunId,
        }),
      },
    });
    await db
      .update(issues)
      .set({ executionRunId: replacementRunId, checkoutRunId: replacementRunId })
      .where(eq(issues.id, seeded.issueId));

    const second = vi.fn(async () => ({
      id: "e7e7e7e7-e7e7-47e7-87e7-e7e7e7e7e7e7",
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      status: "queued",
    }));
    const recoveryAgain = recoveryService(db, { enqueueWakeup: second } as never);
    await recoveryAgain.sweepStaleIssueLocks();
    const result = await recoveryAgain.reconcileStrandedAssignedIssues();

    expect(second).not.toHaveBeenCalled();
    expect(result.orphanedRetryRedispatched).toBe(0);
  });

  it("admits exactly one replacement under concurrent sweeps", async () => {
    const seeded = await seedLiveRetryAcrossRestart({
      agentId: "f1f1f1f1-f1f1-41f1-81f1-f1f1f1f1f1f1",
      issueId: "f2f2f2f2-f2f2-42f2-82f2-f2f2f2f2f2f2",
      rootRunId: "f3f3f3f3-f3f3-43f3-83f3-f3f3f3f3f3f3",
      retryRunId: "f4f4f4f4-f4f4-44f4-84f4-f4f4f4f4f4f4",
    });
    await simulateRestartOrphanCleanup(seeded);

    const { recoveryService } = await import("./service.js");
    const episodeKey = buildOrphanedRetryRewakeEpisodeKey({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      rootRunId: seeded.rootRunId,
    });
    const enqueueWakeup = vi.fn(async () => {
      const inserted = await db
        .insert(agentWakeupRequests)
        .values([
          {
            companyId: seeded.companyId,
            agentId: seeded.agentId,
            source: "automation",
            triggerDetail: "system",
            reason: ORPHANED_RETRY_REWAKE_WAKE_REASON,
            status: "queued",
            idempotencyKey: buildOrphanedRetryRewakeIdempotencyKey({
              companyId: seeded.companyId,
              issueId: seeded.issueId,
              episodeKey,
            }),
            payload: { issueId: seeded.issueId },
          },
        ])
        .returning({ id: agentWakeupRequests.id })
        .then((rows) => rows[0] ?? null)
        .catch((error: unknown) => {
          const conflict = error as { code?: string };
          return conflict?.code === "23505" ? null : Promise.reject(error);
        });
      return inserted
        ? { id: inserted.id, companyId: seeded.companyId, agentId: seeded.agentId, status: "queued" }
        : null;
    });

    const recovery = recoveryService(db, { enqueueWakeup } as never);
    const [a, b] = await Promise.all([
      recovery.reconcileStrandedAssignedIssues(),
      recovery.reconcileStrandedAssignedIssues(),
    ]);

    expect([a, b].reduce((n, r) => n + r.orphanedRetryRedispatched, 0)).toBe(1);
    const queued = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.status, "queued"));
    expect(queued).toHaveLength(1);
  });

  it("leaves a newer live run alone", async () => {
    const seeded = await seedLiveRetryAcrossRestart({
      agentId: "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1",
      issueId: "a2a2a2a2-a2a2-42a2-82a2-a2a2a2a2a2a2",
      rootRunId: "a3a3a3a3-a3a3-43a3-83a3-a3a3a3a3a3a3",
      retryRunId: "a4a4a4a4-a4a4-44a4-84a4-a4a4a4a4a4a4",
    });
    await simulateRestartOrphanCleanup(seeded);
    await db.insert(heartbeatRuns).values({
      id: "a5a5a5a5-a5a5-45a5-85a5-a5a5a5a5a5a5",
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      invocationSource: "automation",
      status: "running",
      startedAt: NOW,
      createdAt: new Date(NOW.getTime() + 60_000),
      contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId },
    });

    const { recoveryService } = await import("./service.js");
    const enqueueWakeup = vi.fn(async () => ({
      id: "a6a6a6a6-a6a6-46a6-86a6-a6a6a6a6a6a6",
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      status: "queued",
    }));
    const recovery = recoveryService(db, { enqueueWakeup } as never);
    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.orphanedRetryRedispatched).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });
});

// Keep drizzle imports referenced for FK-safe cleanup ordering documentation.
void and;
void inArray;
void sql;
void desc;
