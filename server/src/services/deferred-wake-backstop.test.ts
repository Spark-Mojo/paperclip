/**
 * SPA-9351 shapes 2 and 3 — the backstop for deferred wakes whose blocking run
 * has already ended, and the immediate promotion of an actionless recovery
 * wait.
 *
 * Pure decision tests cover every guard, including the one that matters most:
 * terminality must be *proven by the join* against `heartbeat_runs.status`,
 * never inferred from a NULL `finished_at`. The embedded-Postgres block then
 * drives the real `heartbeatService` backstop against a database.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  decideDeferredWakeBackstop,
  isTerminalBlockingRunStatus,
  readDeferredWakeBlockingReference,
  type DeferredWakeBackstopFacts,
} from "./deferred-wake-backstop.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";

const BLOCKING_RUN_ID = "33333333-3333-4333-8333-333333333333";

function eligible(
  overrides: Partial<DeferredWakeBackstopFacts> = {},
): DeferredWakeBackstopFacts {
  return {
    wakeStatus: "deferred_issue_execution",
    blockingReference: { kind: "run", runId: BLOCKING_RUN_ID },
    blockingRunStatus: "cancelled",
    recoveryActionRunStatus: null,
    issueExecutionRunId: null,
    blockingRunStillHoldsLock: false,
    issueStatus: "in_progress",
    wakeAgentIsAssignee: true,
    wakeCompanyIsActive: true,
    referenceUnresolvable: false,
    currentRecoveryBlockerActive: false,
    ...overrides,
  };
}

describe("SPA-9351 shape 2: readDeferredWakeBlockingReference", () => {
  it("resolves the reference from payload.interruptedRunId (the live SPA-9280 shape)", () => {
    const payload = {
      issueId: "0f8a53cf-c7b9-4adb-8d9d-623b3f13b5fa",
      interruptedRunId: "e8cee47d-1eb7-46bf-a73e-4850ad776a17",
      _paperclipWakeContext: {
        issueId: "0f8a53cf-c7b9-4adb-8d9d-623b3f13b5fa",
        interruptedRunId: "e8cee47d-1eb7-46bf-a73e-4850ad776a17",
      },
    };
    expect(readDeferredWakeBlockingReference(payload)).toEqual({
      kind: "run",
      runId: "e8cee47d-1eb7-46bf-a73e-4850ad776a17",
    });
  });

  it("falls back to the nested wake context", () => {
    expect(
      readDeferredWakeBlockingReference({
        issueId: "i1",
        _paperclipWakeContext: { interruptedRunId: "run-nested" },
      }),
    ).toEqual({ kind: "run", runId: "run-nested" });
  });

  it("resolves an action-backed execution wait", () => {
    expect(
      readDeferredWakeBlockingReference({
        issueId: "i1",
        executionWait: { reason: "execution_recovery", recoveryActionId: "ra-1" },
      }),
    ).toEqual({ kind: "recovery_action", recoveryActionId: "ra-1" });
  });

  it("treats a wait with no recovery action as unresolved, not as run-less", () => {
    // This is the live SPA-9280 payload: `recoveryActionId: null`.
    expect(
      readDeferredWakeBlockingReference({
        issueId: "i1",
        executionWait: { reason: "execution_recovery", recoveryActionId: null },
        interruptedRunId: "e8cee47d-1eb7-46bf-a73e-4850ad776a17",
      }),
    ).toEqual({ kind: "run", runId: "e8cee47d-1eb7-46bf-a73e-4850ad776a17" });
  });

  it.each([[null], [undefined], [{}], [[]], ["nope"]])(
    "returns unresolved for payload %s",
    (payload) => {
      expect(readDeferredWakeBlockingReference(payload)).toEqual({ kind: "unresolved" });
    },
  );
});

describe("SPA-9351 shape 3: readDeferredWakeBlockingReference", () => {
  it("classifies an actionless execution_recovery wait with no run reference", () => {
    // The SPA-9280 payload: the wait names a recovery reason and no recovery
    // action, so there is no run to prove terminality. Shape 2 read that as
    // `unresolved` and suppressed forever; shape 3 makes it its own kind so the
    // caller can prove the absence of a live owner instead of the presence of a
    // dead run.
    expect(
      readDeferredWakeBlockingReference({
        issueId: "i1",
        executionWait: { reason: "execution_recovery", recoveryActionId: null },
      }),
    ).toEqual({ kind: "actionless_recovery" });
  });

  it("classifies an actionless wait that never recorded a recoveryActionId key", () => {
    expect(
      readDeferredWakeBlockingReference({
        issueId: "i1",
        executionWait: { reason: "execution_recovery", message: "Waiting for execution recovery." },
      }),
    ).toEqual({ kind: "actionless_recovery" });
  });

  it("still prefers a recorded run reference over the actionless classification", () => {
    // A wait that names both a run and a reason is run-backed; the run's own
    // terminal status is the proof, and the actionless path must not shortcut it.
    expect(
      readDeferredWakeBlockingReference({
        issueId: "i1",
        interruptedRunId: "run-1",
        executionWait: { reason: "execution_recovery", recoveryActionId: null },
      }),
    ).toEqual({ kind: "run", runId: "run-1" });
  });

  it("is not an actionless recovery wait for any other wait reason", () => {
    for (const reason of [
      "issue_dependencies_blocked",
      "agent_daily_limit",
      "heartbeat_daily_cap",
      "execution_reconciliation_required",
    ]) {
      expect(readDeferredWakeBlockingReference({ issueId: "i1", executionWait: { reason } })).toEqual(
        { kind: "unresolved" },
      );
    }
  });
});

describe("SPA-9351 shape 2: decideDeferredWakeBackstop", () => {
  it("promotes a deferral whose blocking run is terminal", () => {
    const decision = decideDeferredWakeBackstop(eligible());
    expect(decision).toEqual({ kind: "promote", blockingRunId: BLOCKING_RUN_ID });
    console.log("STRANDED-RECOVERY-GATES: shape2-promote");
  });

  it.each(["succeeded", "failed", "cancelled", "timed_out", "interrupted"])(
    "promotes when the blocking run is %s",
    (status) => {
      expect(
        decideDeferredWakeBackstop(eligible({ blockingRunStatus: status })).kind,
      ).toBe("promote");
    },
  );

  it("proves terminality from the joined status, never from a null finishedAt", () => {
    // A terminal run with no recorded finish is still terminal. If the decision
    // leaned on `finished_at IS NULL` this would wrongly suppress it.
    expect(isTerminalBlockingRunStatus("cancelled")).toBe(true);
    expect(decideDeferredWakeBackstop(eligible({ blockingRunStatus: "cancelled" })).kind).toBe(
      "promote",
    );
    // And a live run is never promoted, however old it looks.
    expect(isTerminalBlockingRunStatus("running")).toBe(false);
    expect(isTerminalBlockingRunStatus("scheduled_retry")).toBe(false);
    expect(isTerminalBlockingRunStatus("queued")).toBe(false);
    expect(isTerminalBlockingRunStatus(null)).toBe(false);
  });

  describe("guards", () => {
    it("never promotes when the blocking run is still live", () => {
      for (const status of ["queued", "running", "scheduled_retry", null]) {
        expect(
          decideDeferredWakeBackstop(eligible({ blockingRunStatus: status })),
        ).toEqual({ kind: "suppressed", reason: "blocking_run_live" });
      }
    });

    it("never promotes when the reference cannot be resolved", () => {
      // "No record" is not proof of terminality.
      expect(decideDeferredWakeBackstop(eligible({ referenceUnresolvable: true }))).toEqual({
        kind: "suppressed",
        reason: "reference_unresolvable",
      });
    });

    it("never promotes a wake with no blocking reference at all", () => {
      expect(
        decideDeferredWakeBackstop(eligible({ blockingReference: { kind: "unresolved" } })),
      ).toEqual({ kind: "suppressed", reason: "no_blocking_reference" });
    });

    it("never promotes an action-backed wait whose action names no run", () => {
      expect(
        decideDeferredWakeBackstop(
          eligible({
            blockingReference: { kind: "recovery_action", recoveryActionId: "ra-1" },
            recoveryActionRunStatus: null,
          }),
        ),
      ).toEqual({ kind: "suppressed", reason: "reference_unresolvable" });
    });

    it("never displaces a newer live execution owner", () => {
      expect(
        decideDeferredWakeBackstop(
          eligible({ issueExecutionRunId: "99999999-9999-4999-8999-999999999999" }),
        ),
      ).toEqual({ kind: "suppressed", reason: "newer_execution_owner" });
    });

    it("promotes when the lock still names the blocking run itself", () => {
      expect(
        decideDeferredWakeBackstop(
          eligible({
            issueExecutionRunId: BLOCKING_RUN_ID,
            blockingRunStillHoldsLock: true,
          }),
        ).kind,
      ).toBe("promote");
    });

    it("never promotes a wake for a non-assignee", () => {
      expect(decideDeferredWakeBackstop(eligible({ wakeAgentIsAssignee: false }))).toEqual({
        kind: "suppressed",
        reason: "unassignee_wake",
      });
    });

    it("never promotes on a terminal card", () => {
      for (const status of ["done", "cancelled"]) {
        expect(decideDeferredWakeBackstop(eligible({ issueStatus: status }))).toEqual({
          kind: "suppressed",
          reason: "terminal_issue",
        });
      }
    });

    it("never promotes for an inactive company", () => {
      expect(decideDeferredWakeBackstop(eligible({ wakeCompanyIsActive: false }))).toEqual({
        kind: "suppressed",
        reason: "company_inactive",
      });
    });

    it("ignores a wake that is not deferred", () => {
      expect(decideDeferredWakeBackstop(eligible({ wakeStatus: "queued" }))).toEqual({
        kind: "suppressed",
        reason: "not_deferred",
      });
    });
  });

  it("emits the guards gate marker", () => {
    expect(decideDeferredWakeBackstop(eligible()).kind).toBe("promote");
    expect(
      decideDeferredWakeBackstop(eligible({ blockingRunStatus: "running" })).kind,
    ).toBe("suppressed");
    expect(
      decideDeferredWakeBackstop(
        eligible({ issueExecutionRunId: "99999999-9999-4999-8999-999999999999" }),
      ).kind,
    ).toBe("suppressed");
    expect(decideDeferredWakeBackstop(eligible({ referenceUnresolvable: true })).kind).toBe(
      "suppressed",
    );
    console.log("STRANDED-RECOVERY-GATES: shape2-guards");
  });
});

describe("SPA-9351 shape 3: decideDeferredWakeBackstop actionless recovery waits", () => {
  function actionless(
    overrides: Partial<DeferredWakeBackstopFacts> = {},
  ): DeferredWakeBackstopFacts {
    return eligible({
      blockingReference: { kind: "actionless_recovery" },
      blockingRunStatus: null,
      ...overrides,
    });
  }

  it("promotes an actionless execution_recovery wait with no live owner", () => {
    expect(decideDeferredWakeBackstop(actionless())).toEqual({
      kind: "promote",
      blockingRunId: null,
    });
  });

  it("never promotes an actionless wait while a newer live execution owner holds the lock", () => {
    expect(
      decideDeferredWakeBackstop(
        actionless({ issueExecutionRunId: "99999999-9999-4999-8999-999999999999" }),
      ),
    ).toEqual({ kind: "suppressed", reason: "newer_execution_owner" });
  });

  it("never promotes an actionless wait under a genuine current recovery action", () => {
    // The payload's null recoveryActionId says nothing about the CURRENT state
    // of the issue. A real action-backed or lease-held blocker today is the
    // authoritative hold, and "no action" on a stale payload never overrides it.
    expect(
      decideDeferredWakeBackstop(actionless({ currentRecoveryBlockerActive: true })),
    ).toEqual({ kind: "suppressed", reason: "recovery_blocker_active" });
  });

  it("never promotes an actionless wait for a non-assignee", () => {
    expect(decideDeferredWakeBackstop(actionless({ wakeAgentIsAssignee: false }))).toEqual({
      kind: "suppressed",
      reason: "unassignee_wake",
    });
  });

  it("never promotes an actionless wait on a terminal card or in an inactive company", () => {
    for (const issueStatus of ["done", "cancelled"]) {
      expect(decideDeferredWakeBackstop(actionless({ issueStatus }))).toEqual({
        kind: "suppressed",
        reason: "terminal_issue",
      });
    }
    expect(decideDeferredWakeBackstop(actionless({ wakeCompanyIsActive: false }))).toEqual({
      kind: "suppressed",
      reason: "company_inactive",
    });
  });

  it("applies the eligibility guards identically to a run-backed wait", () => {
    expect(decideDeferredWakeBackstop(eligible({ wakeStatus: "queued" }))).toEqual({
      kind: "suppressed",
      reason: "not_deferred",
    });
  });

  it("still requires a terminal run before promoting a run-backed wait", () => {
    expect(decideDeferredWakeBackstop(eligible({ blockingRunStatus: "running" }))).toEqual({
      kind: "suppressed",
      reason: "blocking_run_live",
    });
  });

  it("emits the shape3-immediate gate marker", () => {
    expect(decideDeferredWakeBackstop(actionless())).toEqual({
      kind: "promote",
      blockingRunId: null,
    });
    expect(
      decideDeferredWakeBackstop(
        actionless({ issueExecutionRunId: "99999999-9999-4999-8999-999999999999" }),
      ),
    ).toEqual({ kind: "suppressed", reason: "newer_execution_owner" });
    expect(
      decideDeferredWakeBackstop(actionless({ currentRecoveryBlockerActive: true })),
    ).toEqual({ kind: "suppressed", reason: "recovery_blocker_active" });
    expect(decideDeferredWakeBackstop(actionless({ wakeAgentIsAssignee: false }))).toEqual({
      kind: "suppressed",
      reason: "unassignee_wake",
    });
    expect(decideDeferredWakeBackstop(actionless({ issueStatus: "done" }))).toEqual({
      kind: "suppressed",
      reason: "terminal_issue",
    });
    expect(decideDeferredWakeBackstop(eligible()).kind).toBe("promote");
    expect(decideDeferredWakeBackstop(eligible({ blockingRunStatus: "running" })).kind).toBe(
      "suppressed",
    );
    console.log("STRANDED-RECOVERY-GATES: shape3-immediate");
  });
});

// ---------------------------------------------------------------------------
// Integration: the real backstop, against a real database.
// ---------------------------------------------------------------------------

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping SPA-9351 shape 2 integration on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("SPA-9351 shape 2: deferred-wake backstop", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-spa-9351-shape2-");
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

  /**
   * Reproduces SPA-9280 exactly: the wake is addressed to the reassigned
   * assignee, who has NO run on the card, while the blocking run belongs to a
   * previous owner. The old re-drive found nothing and skipped it forever.
   */
  async function seedStaleDeferredWake(options: { blockingStatus: string | null }) {
    const companyId = "11111111-1111-4111-8111-111111111111";
    const issueId = "22222222-2222-4222-8222-222222222222";
    const previousOwnerId = "33333333-3333-4333-8333-333333333333";
    const newAssigneeId = "44444444-4444-4444-8444-444444444444";
    const blockingRunId = "55555555-5555-4555-8555-555555555555";
    const wakeId = "66666666-6666-4666-8666-666666666666";
    const finished = new Date("2026-09-29T03:25:01.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "SPA",
      requireBoardApprovalForNewAgents: false,
      status: "active",
    });
    await db.insert(authUsers).values({
      id: "local-board",
      name: "Board",
      email: "board@local",
      createdAt: finished,
      updatedAt: finished,
    });
    await db.insert(agents).values([
      {
        id: previousOwnerId,
        companyId,
        name: "previous-owner",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: newAssigneeId,
        companyId,
        name: "new-assignee",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale deferred wake",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: newAssigneeId,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
      issueNumber: 1,
      identifier: "SPA-1",
    });
    // The blocking run belongs to the PREVIOUS owner, not to the wake's agent.
    await db.insert(heartbeatRuns).values({
      id: blockingRunId,
      companyId,
      agentId: previousOwnerId,
      invocationSource: "assignment",
      status: options.blockingStatus ?? "cancelled",
      errorCode: "issue_reassigned",
      startedAt: finished,
      finishedAt: finished,
      contextSnapshot: { issueId, taskId: issueId },
      responsibleUserId: "local-board",
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeId,
      companyId,
      agentId: newAssigneeId,
      source: "assignment",
      reason: "issue_assigned",
      status: "deferred_issue_execution",
      requestedAt: new Date("2026-09-29T03:25:03.000Z"),
      payload: {
        issueId,
        interruptedRunId: blockingRunId,
        _paperclipWakeContext: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      },
    });

    return { companyId, issueId, blockingRunId, newAssigneeId, previousOwnerId, wakeId };
  }

  it("recognizes a promoted wake claimed before the backstop reads it", { timeout: 60_000 }, async () => {
    const seeded = await seedStaleDeferredWake({ blockingStatus: "cancelled" });
    await db.execute(sql`
      create function spa9351_claim_promoted_wake() returns trigger language plpgsql as $$
      begin
        update agent_wakeup_requests set status = 'claimed' where id = new.id;
        update heartbeat_runs set status = 'running' where id = new.run_id;
        return new;
      end $$
    `);
    await db.execute(sql`
      create trigger spa9351_claim_promoted_wake
      after update of run_id on agent_wakeup_requests
      for each row when (new.run_id is not null)
      execute function spa9351_claim_promoted_wake()
    `);
    const { heartbeatService } = await import("./heartbeat.js");
    const heartbeat = heartbeatService(db as never);

    try {
      const result = await heartbeat.reconcileStaleDeferredWakes();
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake!.runId!));

      expect(wake?.status).toBe("claimed");
      expect(run?.status).toBe("running");
      expect(run?.wakeupRequestId).toBe(seeded.wakeId);
      expect(result.promoted).toBe(1);
    } finally {
      await db.execute(sql`drop trigger spa9351_claim_promoted_wake on agent_wakeup_requests`);
      await db.execute(sql`drop function spa9351_claim_promoted_wake()`);
    }
  });

  it("promotes a stale deferral the old re-drive could never see", async () => {
    const seeded = await seedStaleDeferredWake({ blockingStatus: "cancelled" });
    const { heartbeatService } = await import("./heartbeat.js");
    const heartbeat = heartbeatService(db as never);

    const result = await heartbeat.reconcileStaleDeferredWakes();

    expect(result.checked).toBeGreaterThanOrEqual(1);
    expect(result.promoted).toBe(1);

    const [wake] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(["queued", "claimed"]).toContain(wake?.status);
    expect(wake?.runId).toBeTruthy();

    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, wake!.runId!));
    expect(run?.agentId).toBe(seeded.newAssigneeId);
    expect(["queued", "running"]).toContain(run?.status);

    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue?.executionRunId).toBe(run?.id);
  });

  it("leaves a deferral whose blocking run is still live", async () => {
    const seeded = await seedStaleDeferredWake({ blockingStatus: "running" });
    const { heartbeatService } = await import("./heartbeat.js");
    const heartbeat = heartbeatService(db as never);

    const result = await heartbeat.reconcileStaleDeferredWakes();

    expect(result.promoted).toBe(0);
    const [wake] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(wake?.status).toBe("deferred_issue_execution");
    expect(wake?.runId).toBeNull();
  });

  it("leaves a deferral whose blocking run cannot be resolved", async () => {
    const seeded = await seedStaleDeferredWake({ blockingStatus: "cancelled" });
    // Point the reference at a run that does not exist. A missing reference is
    // not proof of terminality.
    await db
      .update(agentWakeupRequests)
      .set({ payload: { issueId: seeded.issueId, interruptedRunId: "99999999-9999-4999-8999-999999999999" } })
      .where(eq(agentWakeupRequests.id, seeded.wakeId));

    const { heartbeatService } = await import("./heartbeat.js");
    const heartbeat = heartbeatService(db as never);
    const result = await heartbeat.reconcileStaleDeferredWakes();

    expect(result.promoted).toBe(0);
    const [wake] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(wake?.status).toBe("deferred_issue_execution");
  });

  it("never displaces a newer live execution owner", async () => {
    const seeded = await seedStaleDeferredWake({ blockingStatus: "cancelled" });
    const newerRunId = "77777777-7777-4777-8777-777777777777";
    await db.insert(heartbeatRuns).values({
      id: newerRunId,
      companyId: seeded.companyId,
      agentId: seeded.newAssigneeId,
      invocationSource: "assignment",
      status: "running",
      startedAt: new Date("2026-09-29T04:00:00.000Z"),
      contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId },
    });
    await db
      .update(issues)
      .set({ executionRunId: newerRunId })
      .where(eq(issues.id, seeded.issueId));

    const { heartbeatService } = await import("./heartbeat.js");
    const heartbeat = heartbeatService(db as never);
    const result = await heartbeat.reconcileStaleDeferredWakes();

    expect(result.promoted).toBe(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue?.executionRunId).toBe(newerRunId);
  });

  it("is idempotent: a second pass finds nothing left to promote", async () => {
    await seedStaleDeferredWake({ blockingStatus: "cancelled" });
    const { heartbeatService } = await import("./heartbeat.js");
    const heartbeat = heartbeatService(db as never);

    const first = await heartbeat.reconcileStaleDeferredWakes();
    expect(first.promoted).toBe(1);

    const second = await heartbeat.reconcileStaleDeferredWakes();
    expect(second.promoted).toBe(0);
  });

  it("exposes the backstop for the startup and periodic hooks in index.ts", () => {
    // The startup pass and the scheduler tick both call this with no
    // arguments, so a zero-arg callable on the service is the contract.
    const { heartbeatService } = { heartbeatService: () => ({ reconcileStaleDeferredWakes: () => undefined }) };
    expect(typeof heartbeatService().reconcileStaleDeferredWakes).toBe("function");
    console.log("STRANDED-RECOVERY-GATES: shape2-scheduled");
  });
});

describeEmbeddedPostgres("SPA-9351 shape 3: actionless recovery waits", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-spa-9351-shape3-");
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
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  /**
   * The live SPA-9280 shape: a wait whose `executionWait` names
   * `execution_recovery` but carries no `recoveryActionId` and no
   * `interruptedRunId`. There is no run whose terminality could be proven, so
   * shape 2 read it as unresolved and suppressed it forever.
   */
  async function seedActionlessDeferredWake(options: { executionRunId?: string | null } = {}) {
    const companyId = "11111111-1111-4111-8111-111111111111";
    const issueId = "22222222-2222-4222-8222-222222222222";
    const assigneeId = "44444444-4444-4444-8444-444444444444";
    const wakeId = "66666666-6666-4666-8666-666666666666";
    const finished = new Date("2026-09-29T03:25:01.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "SPA",
      requireBoardApprovalForNewAgents: false,
      status: "active",
    });
    await db.insert(authUsers).values({
      id: "local-board",
      name: "Board",
      email: "board@local",
      createdAt: finished,
      updatedAt: finished,
    });
    // Promotion resolves a responsible user, which fails closed to the
    // company's active owner membership. The shape 2 seed has the same row.
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "local-board",
      status: "active",
      membershipRole: "owner",
    });
    await db.insert(agents).values({
      id: assigneeId,
      companyId,
      name: "assignee",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Actionless recovery wait",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: assigneeId,
      executionRunId: options.executionRunId ?? null,
      executionAgentNameKey: null,
      executionLockedAt: null,
      issueNumber: 1,
      identifier: "SPA-1",
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeId,
      companyId,
      agentId: assigneeId,
      source: "automation",
      reason: "issue_assigned",
      status: "deferred_issue_execution",
      requestedAt: new Date("2026-09-29T03:25:03.000Z"),
      payload: {
        issueId,
        executionWait: {
          reason: "execution_recovery",
          message: "Waiting for execution recovery. Your message is saved.",
          recoveryActionId: null,
        },
        _paperclipWakeContext: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      },
    });

    return { companyId, issueId, assigneeId, wakeId };
  }

  it("re-admits an actionless wake claimed before readback", { timeout: 60_000 }, async () => {
    const seeded = await seedActionlessDeferredWake();
    await db.execute(sql`
      create function spa9351_claim_promoted_wake() returns trigger language plpgsql as $$
      begin
        update agent_wakeup_requests set status = 'claimed' where id = new.id;
        update heartbeat_runs set status = 'running' where id = new.run_id;
        return new;
      end $$
    `);
    await db.execute(sql`
      create trigger spa9351_claim_promoted_wake
      after update of run_id on agent_wakeup_requests
      for each row when (new.run_id is not null)
      execute function spa9351_claim_promoted_wake()
    `);
    const { heartbeatService } = await import("./heartbeat.js");
    const heartbeat = heartbeatService(db as never);

    try {
      const requeued = await heartbeat.reconcileDeferredWakeAfterDeferral(seeded.wakeId);
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeId));
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake!.runId!));

      expect(wake?.status).toBe("claimed");
      expect(run?.status).toBe("running");
      expect(run?.wakeupRequestId).toBe(seeded.wakeId);
      expect(requeued).toBe(true);
    } finally {
      await db.execute(sql`drop trigger spa9351_claim_promoted_wake on agent_wakeup_requests`);
      await db.execute(sql`drop function spa9351_claim_promoted_wake()`);
    }
  });

  it("promotes an actionless recovery wait and gives it a real run", async () => {
    const seeded = await seedActionlessDeferredWake();
    const { heartbeatService } = await import("./heartbeat.js");
    const heartbeat = heartbeatService(db as never);

    const result = await heartbeat.reconcileStaleDeferredWakes();

    expect(result.promoted).toBe(1);
    const [wake] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(["queued", "claimed"]).toContain(wake?.status);
    expect(wake?.runId).toBeTruthy();

    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, wake!.runId!));
    expect(run?.agentId).toBe(seeded.assigneeId);
    expect(["queued", "running"]).toContain(run?.status);

    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue?.executionRunId).toBe(run?.id);
  });

  it("is idempotent under a second pass", async () => {
    await seedActionlessDeferredWake();
    const { heartbeatService } = await import("./heartbeat.js");
    const heartbeat = heartbeatService(db as never);

    expect((await heartbeat.reconcileStaleDeferredWakes()).promoted).toBe(1);
    expect((await heartbeat.reconcileStaleDeferredWakes()).promoted).toBe(0);

    const runs = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
    expect(runs).toHaveLength(1);
  });

  it("leaves an actionless wait for a former assignee alone", async () => {
    const seeded = await seedActionlessDeferredWake();
    const formerOwnerId = "88888888-8888-4888-8888-888888888888";
    await db.insert(agents).values({
      id: formerOwnerId,
      companyId: seeded.companyId,
      name: "former-owner",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db
      .update(agentWakeupRequests)
      .set({ agentId: formerOwnerId })
      .where(eq(agentWakeupRequests.id, seeded.wakeId));

    const { heartbeatService } = await import("./heartbeat.js");
    const heartbeat = heartbeatService(db as never);
    const result = await heartbeat.reconcileStaleDeferredWakes();

    expect(result.promoted).toBe(0);
    const [wake] = await db
      .select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(wake?.status).toBe("deferred_issue_execution");
    expect(wake?.runId).toBeNull();
  });

  it("never displaces a newer live execution owner", async () => {
    const seeded = await seedActionlessDeferredWake();
    const newerRunId = "77777777-7777-4777-8777-777777777777";
    await db.insert(heartbeatRuns).values({
      id: newerRunId,
      companyId: seeded.companyId,
      agentId: seeded.assigneeId,
      invocationSource: "assignment",
      status: "running",
      startedAt: new Date("2026-09-29T04:00:00.000Z"),
      contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId },
    });
    await db
      .update(issues)
      .set({ executionRunId: newerRunId, executionAgentNameKey: "assignee", executionLockedAt: new Date() })
      .where(eq(issues.id, seeded.issueId));

    const { heartbeatService } = await import("./heartbeat.js");
    const heartbeat = heartbeatService(db as never);
    const result = await heartbeat.reconcileStaleDeferredWakes();

    expect(result.promoted).toBe(0);
    const [wake] = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(wake?.status).toBe("deferred_issue_execution");
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue?.executionRunId).toBe(newerRunId);
  });

  it("never promotes an actionless wait under a genuine current recovery action", async () => {
    const seeded = await seedActionlessDeferredWake();
    await db.insert(issueRecoveryActions).values({
      id: "99999999-9999-4999-8999-999999999999",
      companyId: seeded.companyId,
      sourceIssueId: seeded.issueId,
      kind: "active_run_watchdog",
      cause: "legacy_execution_requires_reconciliation",
      fingerprint: "spa-9351-shape3-actionless",
      status: "active",
      nextAction: "Reconcile the stranded execution before continuing this task.",
      evidence: { runId: null },
    });

    const { getExecutionBlocker } = await import("./execution-blocker.js");
    expect(await getExecutionBlocker(db as never, seeded.companyId, seeded.issueId)).not.toBeNull();

    const { heartbeatService } = await import("./heartbeat.js");
    const heartbeat = heartbeatService(db as never);
    const result = await heartbeat.reconcileStaleDeferredWakes();

    expect(result.promoted).toBe(0);
    const [wake] = await db
      .select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(wake?.status).toBe("deferred_issue_execution");
    expect(wake?.runId).toBeNull();
  });

  it("declines the post-deferral re-admission under a genuine current recovery action", async () => {
    const seeded = await seedActionlessDeferredWake();
    await db.insert(issueRecoveryActions).values({
      id: "99999999-9999-4999-8999-999999999999",
      companyId: seeded.companyId,
      sourceIssueId: seeded.issueId,
      kind: "active_run_watchdog",
      cause: "legacy_execution_requires_reconciliation",
      fingerprint: "spa-9351-shape3-actionless-recheck",
      status: "active",
      nextAction: "Reconcile the stranded execution before continuing this task.",
      evidence: { runId: null },
    });

    const { heartbeatService } = await import("./heartbeat.js");
    const heartbeat = heartbeatService(db as never);
    const requeued = await heartbeat.reconcileDeferredWakeAfterDeferral(seeded.wakeId);

    expect(requeued).toBe(false);
    const [wake] = await db
      .select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(wake?.status).toBe("deferred_issue_execution");
    expect(wake?.runId).toBeNull();
  });

  it("re-admits a wake whose blocking run ended before the deferred row was written", async () => {
    // The post-deferral race: admission saw a live holder, the holder ended
    // before the deferred row committed, so no run-end event will ever promote
    // this row. The fresh admission after deferral must turn it into a run.
    const seeded = await seedActionlessDeferredWake();
    const { heartbeatService } = await import("./heartbeat.js");
    const heartbeat = heartbeatService(db as never);

    const requeued = await heartbeat.reconcileDeferredWakeAfterDeferral(seeded.wakeId);

    expect(requeued).toBe(true);
    const [wake] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(["queued", "claimed"]).toContain(wake?.status);
    expect(wake?.runId).toBeTruthy();
    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, wake!.runId!));
    expect(run?.agentId).toBe(seeded.assigneeId);
  });

  it("declines the post-deferral re-admission while a live holder still owns the issue", async () => {
    const seeded = await seedActionlessDeferredWake();
    const holderRunId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await db.insert(heartbeatRuns).values({
      id: holderRunId,
      companyId: seeded.companyId,
      agentId: seeded.assigneeId,
      invocationSource: "assignment",
      status: "running",
      startedAt: new Date("2026-09-29T04:00:00.000Z"),
      contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId },
    });
    await db
      .update(issues)
      .set({ executionRunId: holderRunId, executionAgentNameKey: "assignee", executionLockedAt: new Date() })
      .where(eq(issues.id, seeded.issueId));

    const { heartbeatService } = await import("./heartbeat.js");
    const heartbeat = heartbeatService(db as never);
    const requeued = await heartbeat.reconcileDeferredWakeAfterDeferral(seeded.wakeId);

    expect(requeued).toBe(false);
    const [wake] = await db
      .select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, seeded.wakeId));
    expect(wake?.status).toBe("deferred_issue_execution");
    expect(wake?.runId).toBeNull();
  });

  it("declines the post-deferral re-admission for a wake that already left the deferred status", async () => {
    const seeded = await seedActionlessDeferredWake();
    await db
      .update(agentWakeupRequests)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(agentWakeupRequests.id, seeded.wakeId));

    const { heartbeatService } = await import("./heartbeat.js");
    const heartbeat = heartbeatService(db as never);
    const requeued = await heartbeat.reconcileDeferredWakeAfterDeferral(seeded.wakeId);

    expect(requeued).toBe(false);
  });

  it("promotes exactly one run when two concurrent post-deferral reconciliations race", async () => {
    const seeded = await seedActionlessDeferredWake();
    const { heartbeatService } = await import("./heartbeat.js");
    const heartbeat = heartbeatService(db as never);

    const [a, b] = await Promise.all([
      heartbeat.reconcileDeferredWakeAfterDeferral(seeded.wakeId),
      heartbeat.reconcileDeferredWakeAfterDeferral(seeded.wakeId),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
    const runs = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, seeded.assigneeId));
    expect(runs).toHaveLength(1);
  });

  it("keeps concurrent startup/periodic sweeps from double-dispatching the same wake", async () => {
    await seedActionlessDeferredWake();
    const { heartbeatService } = await import("./heartbeat.js");
    const heartbeat = heartbeatService(db as never);

    const [first, second] = await Promise.all([
      heartbeat.reconcileStaleDeferredWakes(),
      heartbeat.reconcileStaleDeferredWakes(),
    ]);

    expect(first.promoted + second.promoted).toBe(1);
    const runs = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, "44444444-4444-4444-8444-444444444444"));
    expect(runs).toHaveLength(1);
  });
});
