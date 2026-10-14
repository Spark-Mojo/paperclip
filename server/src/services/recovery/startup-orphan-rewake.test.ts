import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueTreeHolds,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { recoveryService } from "./service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping startup orphan re-wake tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * SPA-12218 — startup orphan re-wake.
 *
 * The engine process was SIGKILLed at 2026-10-13T14:46:35Z and systemd restarted
 * it 30s later. The startup backstop terminalized 17 in-flight runs with
 * `errorCode = "orphaned_running_run"` / `status = "interrupted"`, but the owning
 * issues stayed `in_progress` with no run and were never re-woken: a human monitor
 * had to wake 14 of them by hand ~19 minutes later.
 *
 * `reconcileOrphanedRunIssues` is the new startup sweep that closes that gap: after
 * the orphaned runs are terminalized, it re-wakes each active issue whose LATEST run
 * ended with `errorCode = "orphaned_running_run"` — at most one wake per issue, ever.
 *
 * These tests bind the required behaviour. They run against the real schema (no
 * mocks of drizzle tables), the same embedded-Postgres harness the sibling recovery
 * sweeps use, and a stubbed `enqueueWakeup` — exactly as
 * `server/src/__tests__/recovery-stale-issue-lock-sweep.test.ts` does.
 */
describeEmbeddedPostgres("recovery reconcileOrphanedRunIssues (SPA-12218 startup orphan re-wake)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-startup-orphan-rewake-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueTreeHolds);
    await db.delete(issues);
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** The errorCode the startup backstop writes when it terminalizes an orphaned run. */
  const ORPHANED_RUN_ERROR_CODE = "orphaned_running_run";

  async function seedCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    return { companyId, agentId };
  }

  /**
   * Seed one issue. `identifier` is unique-indexed, so it is minted per issue.
   * `lockRunId` reproduces the interrupted state: the issue still points at the run
   * the backstop just terminalized.
   */
  async function seedIssue(input: {
    companyId: string;
    agentId: string;
    status?: string;
    title: string;
    lockRunId?: string | null;
    executionState?: unknown;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: input.title,
      status: input.status ?? "in_progress",
      priority: "high",
      assigneeAgentId: input.agentId,
      assigneeUserId: null,
      checkoutRunId: input.lockRunId ?? null,
      executionRunId: input.lockRunId ?? null,
      executionState:
        input.executionState === undefined
          ? null
          : (input.executionState as never),
    });
    return issueId;
  }

  /** A second, independent agent in the same company, for reviewer-vs-assignee cases. */
  async function seedAgent(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `reviewer-${agentId.slice(0, 8)}`,
      status: "active",
    } as never);
    return { agentId };
  }

  /**
   * Seed one run bound to an issue through `contextSnapshot.issueId`, which is the
   * binding the sibling sweeps use (`getLatestIssueRun`, `hasActiveExecutionPath`).
   * `createdAt` is explicit so "LATEST run" ordering is deterministic.
   */
  async function seedRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    status: string;
    errorCode?: string | null;
    createdAt: Date;
    /** SPA-12218: bind the run by `issueId`, by `taskId`, or with a disagreeing pair. */
    contextIssueKey?: "issueId" | "taskId" | "disagreeing";
    /** SPA-12319: a dead recorded pid so the sweep terminalizes via process-death authority. */
    processPid?: number | null;
  }) {
    const runId = randomUUID();
    const contextKey = input.contextIssueKey ?? "issueId";
    const contextSnapshot =
      contextKey === "disagreeing"
        ? { issueId: input.issueId, taskId: randomUUID() }
        : { [contextKey]: input.issueId };
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      status: input.status,
      errorCode: input.errorCode ?? null,
      invocationSource: "manual",
      contextSnapshot,
      processPid: input.processPid ?? null,
      createdAt: input.createdAt,
      startedAt: input.createdAt,
      finishedAt: input.status === "running" || input.status === "queued" ? null : input.createdAt,
    });
    return runId;
  }

  /**
   * The recovery service under test, with `enqueueWakeup` stubbed so no provider
   * process is launched. The stub PERSISTS the wake into `agent_wakeup_requests`
   * (the shape `recoveryServiceForTest({ persistWakeup: true })` uses in
   * `heartbeat-process-recovery.test.ts`), because "at most one wake per issue,
   * ever" is only observable if the wake survives into the next sweep.
   */
  function recoveryServiceForTest() {
    const enqueueWakeup = vi.fn(
      async (agentId: string, options: { payload?: Record<string, unknown> | null } = {}) =>
        null as null,
    );
    const service = recoveryService(db, {
      enqueueWakeup: async (agentId, options = {}) => {
        const [agent] = await db
          .select({ companyId: agents.companyId })
          .from(agents)
          .where(eq(agents.id, agentId));
        if (!agent) throw new Error(`Missing test recovery wake agent ${agentId}`);
        await db.insert(agentWakeupRequests).values({
          companyId: agent.companyId,
          agentId,
          source: "automation",
          triggerDetail: "system",
          reason: options.reason ?? null,
          payload: options.payload ?? null,
          requestedByActorType: "system",
          idempotencyKey: options.idempotencyKey ?? null,
        });
        enqueueWakeup(agentId, options);
        return null;
      },
    });
    return { service, enqueueWakeup };
  }

  async function countPersistedWakes(companyId: string) {
    return db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
  }

  it("re-wakes an active issue whose latest run was orphaned by the startup backstop", async () => {
    const { companyId, agentId } = await seedCompany();
    const issueId = await seedIssue({
      companyId,
      agentId,
      status: "in_progress",
      title: "Interrupted by the SIGKILL — must be re-woken",
    });
    const runId = await seedRun({
      companyId,
      agentId,
      issueId,
      status: "interrupted",
      errorCode: ORPHANED_RUN_ERROR_CODE,
      createdAt: new Date("2026-10-13T14:46:35.000Z"),
    });
    await db.update(issues).set({ checkoutRunId: runId, executionRunId: runId }).where(eq(issues.id, issueId));

    const { service, enqueueWakeup } = recoveryServiceForTest();
    const result = await service.reconcileOrphanedRunIssues();

    expect(result).toMatchObject({ scanned: 1, rewoken: 1, issueIds: [issueId] });
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    expect(enqueueWakeup.mock.calls[0]?.[0]).toBe(agentId);
    await expect(countPersistedWakes(companyId)).resolves.toHaveLength(1);
  });

  it.each(["todo", "in_review"])("re-wakes an active issue in status %s", async (status) => {
    const { companyId, agentId } = await seedCompany();
    const issueId = await seedIssue({ companyId, agentId, status, title: `Orphaned in ${status}` });
    await seedRun({
      companyId,
      agentId,
      issueId,
      status: "interrupted",
      errorCode: ORPHANED_RUN_ERROR_CODE,
      createdAt: new Date("2026-10-13T14:46:35.000Z"),
    });

    const { service, enqueueWakeup } = recoveryServiceForTest();
    const result = await service.reconcileOrphanedRunIssues();

    expect(result).toMatchObject({ rewoken: 1, issueIds: [issueId] });
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it("does not re-woke an issue that already has a queued run", async () => {
    const { companyId, agentId } = await seedCompany();
    const issueId = await seedIssue({
      companyId,
      agentId,
      status: "in_progress",
      title: "Already has a queued run — dedupe",
    });
    await seedRun({
      companyId,
      agentId,
      issueId,
      status: "interrupted",
      errorCode: ORPHANED_RUN_ERROR_CODE,
      createdAt: new Date("2026-10-13T14:46:35.000Z"),
    });
    // A newer queued run already owns the next action.
    await seedRun({
      companyId,
      agentId,
      issueId,
      status: "queued",
      createdAt: new Date("2026-10-13T14:47:05.000Z"),
    });

    const { service, enqueueWakeup } = recoveryServiceForTest();
    const result = await service.reconcileOrphanedRunIssues();

    expect(result.rewoken).toBe(0);
    expect(result.issueIds).not.toContain(issueId);
    expect(enqueueWakeup).not.toHaveBeenCalled();
    await expect(countPersistedWakes(companyId)).resolves.toHaveLength(0);
  });

  it("does not re-woke an issue that already has a running run", async () => {
    const { companyId, agentId } = await seedCompany();
    const issueId = await seedIssue({
      companyId,
      agentId,
      status: "in_progress",
      title: "Already running — dedupe",
    });
    await seedRun({
      companyId,
      agentId,
      issueId,
      status: "interrupted",
      errorCode: ORPHANED_RUN_ERROR_CODE,
      createdAt: new Date("2026-10-13T14:46:35.000Z"),
    });
    await seedRun({
      companyId,
      agentId,
      issueId,
      status: "running",
      createdAt: new Date("2026-10-13T14:47:05.000Z"),
    });

    const { service, enqueueWakeup } = recoveryServiceForTest();
    const result = await service.reconcileOrphanedRunIssues();

    expect(result.rewoken).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not re-woke a PAUSED issue", async () => {
    const { companyId, agentId } = await seedCompany();
    const issueId = await seedIssue({
      companyId,
      agentId,
      status: "in_progress",
      title: "Paused subtree — must not be re-woken",
    });
    await seedRun({
      companyId,
      agentId,
      issueId,
      status: "interrupted",
      errorCode: ORPHANED_RUN_ERROR_CODE,
      createdAt: new Date("2026-10-13T14:46:35.000Z"),
    });
    // An active pause-mode tree hold is the engine's durable "paused" gate
    // (issueTreeHolds rows with mode "pause" + status "active"), the same
    // condition `isAutomaticRecoverySuppressedByPauseHold` reads.
    await db.insert(issueTreeHolds).values({
      companyId,
      rootIssueId: issueId,
      mode: "pause",
      status: "active",
      reason: "operator paused the subtree",
      releasePolicy: { strategy: "manual" },
    });

    const { service, enqueueWakeup } = recoveryServiceForTest();
    const result = await service.reconcileOrphanedRunIssues();

    expect(result.rewoken).toBe(0);
    expect(result.issueIds).not.toContain(issueId);
    expect(enqueueWakeup).not.toHaveBeenCalled();
    await expect(countPersistedWakes(companyId)).resolves.toHaveLength(0);
  });

  it("does not re-woke a PAUSED assignee agent", async () => {
    const { companyId, agentId } = await seedCompany();
    await db
      .update(agents)
      .set({ status: "paused", pauseReason: "operator pause", pausedAt: new Date() })
      .where(eq(agents.id, agentId));
    const issueId = await seedIssue({
      companyId,
      agentId,
      status: "in_progress",
      title: "Assignee paused — must not be re-woken",
    });
    await seedRun({
      companyId,
      agentId,
      issueId,
      status: "interrupted",
      errorCode: ORPHANED_RUN_ERROR_CODE,
      createdAt: new Date("2026-10-13T14:46:35.000Z"),
    });

    const { service, enqueueWakeup } = recoveryServiceForTest();
    const result = await service.reconcileOrphanedRunIssues();

    expect(result.rewoken).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it.each(["done", "cancelled", "blocked"])("does not re-woke a terminal issue in status %s", async (status) => {
    const { companyId, agentId } = await seedCompany();
    const issueId = await seedIssue({
      companyId,
      agentId,
      status,
      title: `Terminal (${status}) — must not be re-woken`,
    });
    await seedRun({
      companyId,
      agentId,
      issueId,
      status: "interrupted",
      errorCode: ORPHANED_RUN_ERROR_CODE,
      createdAt: new Date("2026-10-13T14:46:35.000Z"),
    });

    const { service, enqueueWakeup } = recoveryServiceForTest();
    const result = await service.reconcileOrphanedRunIssues();

    expect(result.rewoken).toBe(0);
    expect(result.issueIds).not.toContain(issueId);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it.each([
    ["succeeded", null],
    ["failed", "adapter_failed"],
    ["failed", "timeout"],
    ["cancelled", "cancelled"],
  ] as const)(
    "does not re-woke an issue whose latest run ended %s / %s normally",
    async (status, errorCode) => {
      const { companyId, agentId } = await seedCompany();
      const issueId = await seedIssue({
        companyId,
        agentId,
        status: "in_progress",
        title: "Latest run ended normally",
      });
      await seedRun({
        companyId,
        agentId,
        issueId,
        status,
        errorCode,
        createdAt: new Date("2026-10-13T14:46:35.000Z"),
      });

      const { service, enqueueWakeup } = recoveryServiceForTest();
      const result = await service.reconcileOrphanedRunIssues();

      expect(result.rewoken).toBe(0);
      expect(result.issueIds).not.toContain(issueId);
      expect(enqueueWakeup).not.toHaveBeenCalled();
      await expect(countPersistedWakes(companyId)).resolves.toHaveLength(0);
    },
  );

  it("re-wakes only the issue whose LATEST run is orphaned when both runs are orphaned", async () => {
    const { companyId, agentId } = await seedCompany();

    const olderIssueId = await seedIssue({
      companyId,
      agentId,
      status: "in_progress",
      title: "Two orphaned runs — only the latest counts",
    });
    await seedRun({
      companyId,
      agentId,
      issueId: olderIssueId,
      status: "interrupted",
      errorCode: ORPHANED_RUN_ERROR_CODE,
      createdAt: new Date("2026-10-13T14:40:00.000Z"),
    });
    const newestIssueId = await seedIssue({
      companyId,
      agentId,
      status: "in_progress",
      title: "LATEST run is orphaned — re-woken",
    });
    await seedRun({
      companyId,
      agentId,
      issueId: newestIssueId,
      status: "interrupted",
      errorCode: ORPHANED_RUN_ERROR_CODE,
      createdAt: new Date("2026-10-13T14:46:35.000Z"),
    });
    // A newer run on the FIRST issue supersedes its orphaned run, so that issue's
    // latest run is no longer the orphan.
    await seedRun({
      companyId,
      agentId,
      issueId: olderIssueId,
      status: "succeeded",
      createdAt: new Date("2026-10-13T14:50:00.000Z"),
    });

    const { service, enqueueWakeup } = recoveryServiceForTest();
    const result = await service.reconcileOrphanedRunIssues();

    expect(result.rewoken).toBe(1);
    expect(result.issueIds).toEqual([newestIssueId]);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it("IDEMPOTENCE: a second sweep re-wakes nothing", async () => {
    const { companyId, agentId } = await seedCompany();
    const issueId = await seedIssue({
      companyId,
      agentId,
      status: "in_progress",
      title: "Idempotence — at most one wake, ever",
    });
    await seedRun({
      companyId,
      agentId,
      issueId,
      status: "interrupted",
      errorCode: ORPHANED_RUN_ERROR_CODE,
      createdAt: new Date("2026-10-13T14:46:35.000Z"),
    });

    const { service, enqueueWakeup } = recoveryServiceForTest();
    const first = await service.reconcileOrphanedRunIssues();
    const second = await service.reconcileOrphanedRunIssues();

    expect(first).toMatchObject({ rewoken: 1, issueIds: [issueId] });
    expect(second.rewoken).toBe(0);
    expect(second.issueIds).not.toContain(issueId);
    // The durable receipt: exactly one persisted wake across both sweeps.
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    await expect(countPersistedWakes(companyId)).resolves.toHaveLength(1);
  });

  it("does not affect an issue with no runs at all", async () => {
    const { companyId, agentId } = await seedCompany();
    const issueId = await seedIssue({
      companyId,
      agentId,
      status: "in_progress",
      title: "Never ran — untouched by the orphan sweep",
    });

    const { service, enqueueWakeup } = recoveryServiceForTest();
    const result = await service.reconcileOrphanedRunIssues();

    expect(result.rewoken).toBe(0);
    expect(result.issueIds).not.toContain(issueId);
    expect(enqueueWakeup).not.toHaveBeenCalled();
    const runs = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, issueId));
    expect(runs).toEqual([]);
    await expect(countPersistedWakes(companyId)).resolves.toHaveLength(0);
  });

  it("re-wakes each eligible issue exactly once in a multi-issue sweep", async () => {
    const { companyId, agentId } = await seedCompany();
    const orphanCreatedAt = new Date("2026-10-13T14:46:35.000Z");
    const eligible: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const issueId = await seedIssue({
        companyId,
        agentId,
        status: "in_progress",
        title: `Interrupted card ${index}`,
      });
      await seedRun({
        companyId,
        agentId,
        issueId,
        status: "interrupted",
        errorCode: ORPHANED_RUN_ERROR_CODE,
        createdAt: orphanCreatedAt,
      });
      eligible.push(issueId);
    }
    const healthyIssueId = await seedIssue({
      companyId,
      agentId,
      status: "in_progress",
      title: "Healthy card — succeeded run",
    });
    await seedRun({
      companyId,
      agentId,
      issueId: healthyIssueId,
      status: "succeeded",
      createdAt: orphanCreatedAt,
    });

    const { service, enqueueWakeup } = recoveryServiceForTest();
    const result = await service.reconcileOrphanedRunIssues();

    expect(result.rewoken).toBe(3);
    expect(result.issueIds).toHaveLength(3);
    for (const issueId of eligible) expect(result.issueIds).toContain(issueId);
    expect(result.issueIds).not.toContain(healthyIssueId);
    expect(enqueueWakeup).toHaveBeenCalledTimes(3);
    await expect(countPersistedWakes(companyId)).resolves.toHaveLength(3);
  });

  it("skips a hidden issue but re-wakes the same shape in a second company", async () => {
    const { companyId, agentId } = await seedCompany();
    const otherCompanyId = randomUUID();
    const otherAgentId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other",
      issuePrefix: `O${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: otherAgentId,
      companyId: otherCompanyId,
      name: "OtherCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
    });

    const hiddenIssueId = await seedIssue({
      companyId,
      agentId,
      status: "in_progress",
      title: "Hidden card — must not be re-woken",
    });
    await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, hiddenIssueId));
    await seedRun({
      companyId,
      agentId,
      issueId: hiddenIssueId,
      status: "interrupted",
      errorCode: ORPHANED_RUN_ERROR_CODE,
      createdAt: new Date("2026-10-13T14:46:35.000Z"),
    });

    const otherIssueId = await seedIssue({
      companyId: otherCompanyId,
      agentId: otherAgentId,
      status: "in_progress",
      title: "Other company card",
    });
    await seedRun({
      companyId: otherCompanyId,
      agentId: otherAgentId,
      issueId: otherIssueId,
      status: "interrupted",
      errorCode: ORPHANED_RUN_ERROR_CODE,
      createdAt: new Date("2026-10-13T14:46:35.000Z"),
    });

    const { service, enqueueWakeup } = recoveryServiceForTest();
    const result = await service.reconcileOrphanedRunIssues();

    // A hidden card is excluded from recovery scope; the identical orphan in a
    // second company is still eligible, and its wake is addressed to THAT
    // company's agent, never to this company's agent.
    expect(result.issueIds).not.toContain(hiddenIssueId);
    expect(result.issueIds).toEqual([otherIssueId]);
    expect(result.rewoken).toBe(1);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    expect(enqueueWakeup.mock.calls[0]?.[0]).toBe(otherAgentId);
  });

  it("scans without error when the fleet has no orphaned runs at all", async () => {
    const { companyId, agentId } = await seedCompany();
    await seedIssue({ companyId, agentId, status: "in_progress", title: "Nothing orphaned" });

    const { service, enqueueWakeup } = recoveryServiceForTest();
    const result = await service.reconcileOrphanedRunIssues();

    expect(result.rewoken).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(0);
    expect(result.issueIds).toEqual([]);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("counts every candidate issue in scanned", async () => {
    const { companyId, agentId } = await seedCompany();
    const orphanedIssueId = await seedIssue({
      companyId,
      agentId,
      status: "in_progress",
      title: "Orphaned card",
    });
    await seedRun({
      companyId,
      agentId,
      issueId: orphanedIssueId,
      status: "interrupted",
      errorCode: ORPHANED_RUN_ERROR_CODE,
      createdAt: new Date("2026-10-13T14:46:35.000Z"),
    });
    const pausedIssueId = await seedIssue({
      companyId,
      agentId,
      status: "in_progress",
      title: "Paused card",
    });
    await seedRun({
      companyId,
      agentId,
      issueId: pausedIssueId,
      status: "interrupted",
      errorCode: ORPHANED_RUN_ERROR_CODE,
      createdAt: new Date("2026-10-13T14:46:35.000Z"),
    });
    await db.insert(issueTreeHolds).values({
      companyId,
      rootIssueId: pausedIssueId,
      mode: "pause",
      status: "active",
      reason: "paused subtree",
      releasePolicy: { strategy: "manual" },
    });
    const healthyIssueId = await seedIssue({
      companyId,
      agentId,
      status: "in_progress",
      title: "Healthy card",
    });
    await seedRun({
      companyId,
      agentId,
      issueId: healthyIssueId,
      status: "succeeded",
      createdAt: new Date("2026-10-13T14:46:35.000Z"),
    });

    const { service } = recoveryServiceForTest();
    const result = await service.reconcileOrphanedRunIssues();

    // `scanned` counts TRUE orphans — the candidate query filters to issues whose
    // latest run ended `orphaned_running_run`. The healthy card is not a
    // candidate at all and never consumes the per-boot cap; the paused card IS a
    // true orphan but is excluded later by the pause gate, so it is scanned and
    // then skipped.
    expect(result.scanned).toBe(2);
    expect(result.rewoken).toBe(1);
    expect(result.issueIds).toEqual([orphanedIssueId]);
    expect(result.skipped).toBe(1);
  });

  it("re-wakes an orphan whose issue is unassigned to an agent only when an agent exists", async () => {
    // Defensive: the wake target must be a real assignee agent id. An issue with
    // no assignee cannot be woken and must be skipped, not silently addressed to
    // null/undefined.
    const { companyId, agentId } = await seedCompany();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "No assignee — cannot be woken",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
    });
    await seedRun({
      companyId,
      agentId,
      issueId,
      status: "interrupted",
      errorCode: ORPHANED_RUN_ERROR_CODE,
      createdAt: new Date("2026-10-13T14:46:35.000Z"),
    });

    const { service, enqueueWakeup } = recoveryServiceForTest();
    const result = await service.reconcileOrphanedRunIssues();

    expect(result.rewoken).toBe(0);
    expect(result.issueIds).not.toContain(issueId);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not re-woke an issue whose orphaned run was superseded by a DEFERRED wake", async () => {
    // A deferred wake already parked for this issue's current assignee is a live
    // execution path (`hasActiveExecutionPath`), so the orphan sweep must not race
    // it with a second wake.
    const { companyId, agentId } = await seedCompany();
    const issueId = await seedIssue({
      companyId,
      agentId,
      status: "in_progress",
      title: "Deferred wake already owns the next action",
    });
    await seedRun({
      companyId,
      agentId,
      issueId,
      status: "interrupted",
      errorCode: ORPHANED_RUN_ERROR_CODE,
      createdAt: new Date("2026-10-13T14:46:35.000Z"),
    });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      status: "deferred_issue_execution",
      payload: { issueId },
    });

    const { service, enqueueWakeup } = recoveryServiceForTest();
    const result = await service.reconcileOrphanedRunIssues();

    expect(result.rewoken).toBe(0);
    expect(result.issueIds).not.toContain(issueId);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("leaves runs untouched — the sweep only wakes, it does not terminalize", async () => {
    // This sweep runs AFTER the backstop already terminalized the runs. It must not
    // rewrite run status or errorCode, and must not clear the issue lock.
    const { companyId, agentId } = await seedCompany();
    const issueId = await seedIssue({
      companyId,
      agentId,
      status: "in_progress",
      title: "Runs already terminalized — sweep must not rewrite them",
    });
    const runId = await seedRun({
      companyId,
      agentId,
      issueId,
      status: "interrupted",
      errorCode: ORPHANED_RUN_ERROR_CODE,
      createdAt: new Date("2026-10-13T14:46:35.000Z"),
    });
    // Seed the lock so the assertion below proves the sweep did NOT clear it,
    // rather than observing a null that was never set.
    await db.update(issues).set({ checkoutRunId: runId, executionRunId: runId }).where(eq(issues.id, issueId));

    const { service } = recoveryServiceForTest();
    await service.reconcileOrphanedRunIssues();

    const run = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    expect(run).toEqual({ status: "interrupted", errorCode: ORPHANED_RUN_ERROR_CODE });

    const issue = await db
      .select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    // The orphan sweep does not own lock clearing; sweepStaleIssueLocks does.
    expect(issue).toEqual({ checkoutRunId: runId, executionRunId: runId });
  });

  it("returns a well-formed result shape for an empty fleet", async () => {
    const { service } = recoveryServiceForTest();
    const result = await service.reconcileOrphanedRunIssues();

    expect(result).toEqual({
      scanned: 0,
      rewoken: 0,
      skipped: 0,
      deferredForNextBoot: 0,
      issueIds: [],
    });
    expect(Array.isArray(result.issueIds)).toBe(true);
  });

  // --- SPA-12218 reviewer regressions (added after critic BLOCKER findings) ---

  it("re-wakes an in_review issue via its current review PARTICIPANT, not the assignee", async () => {
    const { companyId, agentId: assigneeAgentId } = await seedCompany();
    const { agentId: reviewerAgentId } = await seedAgent(companyId);
    const stageId = randomUUID();
    const issueId = await seedIssue({
      companyId,
      agentId: assigneeAgentId,
      status: "in_review",
      title: "Interrupted review — must wake the reviewer, not the assignee",
      // `parseIssueExecutionState` is a strict zod parse: every field below is
      // REQUIRED by `issueExecutionStateSchema`. An under-specified fixture
      // silently parses to null, which would make this test pass for the wrong
      // reason (falling back to the assignee) rather than proving participant
      // targeting at all.
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 1,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: assigneeAgentId, userId: null },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });
    await seedRun({
      companyId,
      agentId: assigneeAgentId,
      issueId,
      status: "interrupted",
      errorCode: ORPHANED_RUN_ERROR_CODE,
      createdAt: new Date("2026-10-13T14:46:35.000Z"),
    });

    const { service, enqueueWakeup } = recoveryServiceForTest();
    const result = await service.reconcileOrphanedRunIssues();

    expect(result.rewoken).toBe(1);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    // The wake must be addressed to the reviewer.
    expect(enqueueWakeup.mock.calls[0]![0]).toBe(reviewerAgentId);
  });

  it("re-wakes an orphan whose run carries only taskId in its context", async () => {
    // The terminalization backstop associates runs through
    // `issueIdFromRunContext`, which accepts `taskId` as well as `issueId`. A
    // sweep that matched only on `issueId` would silently miss this orphan and
    // the card would never be re-woken.
    const { companyId, agentId } = await seedCompany();
    const issueId = await seedIssue({
      companyId,
      agentId,
      status: "in_progress",
      title: "Orphan bound by taskId only",
    });
    await seedRun({
      companyId,
      agentId,
      issueId,
      status: "interrupted",
      errorCode: ORPHANED_RUN_ERROR_CODE,
      createdAt: new Date("2026-10-13T14:46:35.000Z"),
      contextIssueKey: "taskId",
    });

    const { service, enqueueWakeup } = recoveryServiceForTest();
    const result = await service.reconcileOrphanedRunIssues();

    expect(result.rewoken).toBe(1);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it("bounds one boot's re-wakes and reports the remainder for the next", async () => {
    // Seed more orphans than a single boot should ever wake at once.
    const { companyId, agentId } = await seedCompany();
    const seeded: string[] = [];
    for (let i = 0; i < 120; i += 1) {
      const issueId = await seedIssue({
        companyId,
        agentId,
        status: "in_progress",
        title: `Backlog orphan ${i}`,
      });
      seeded.push(issueId);
      await seedRun({
        companyId,
        agentId,
        issueId,
        status: "interrupted",
        errorCode: ORPHANED_RUN_ERROR_CODE,
        createdAt: new Date("2026-10-13T14:46:35.000Z"),
      });
    }

    const { service, enqueueWakeup } = recoveryServiceForTest();
    const first = await service.reconcileOrphanedRunIssues();

    // The cap holds the blast radius; the rest is deferred, never dropped.
    expect(enqueueWakeup.mock.calls.length).toBeLessThanOrEqual(100);
    expect(first.rewoken).toBeLessThanOrEqual(100);
    expect(first.rewoken + first.deferredForNextBoot).toBe(120);
    const afterFirstBoot = enqueueWakeup.mock.calls.length;

    // The deferred remainder must actually DRAIN on a later boot. A cap that
    // starves — re-selecting the same already-handled prefix every boot and
    // never reaching the true orphans — would pass every assertion above and
    // still leave cards idle forever. This is the assertion that closes it.
    const second = await service.reconcileOrphanedRunIssues();
    expect(second.rewoken).toBeGreaterThan(0);
    expect(enqueueWakeup.mock.calls.length).toBeGreaterThan(afterFirstBoot);

    // And a third boot finishes the backlog without ever re-waking a card twice.
    await service.reconcileOrphanedRunIssues();
    const wokenIssues = new Set(
      enqueueWakeup.mock.calls.map((call) => {
        const options = call[1] as { payload?: Record<string, unknown> | null };
        return String((options.payload as { issueId?: string })?.issueId ?? "");
      }),
    );
    expect(wokenIssues.size).toBe(seeded.length);
  });

  it("does NOT re-wake an issue whose run context names a DIFFERENT issue as its taskId", async () => {
    // Parity with `issueIdFromRunContext`: a context carrying BOTH keys with
    // different values is not bound to either issue. An OR-only match would let
    // such a run wake the wrong card.
    const { companyId, agentId } = await seedCompany();
    const issueId = await seedIssue({
      companyId,
      agentId,
      status: "in_progress",
      title: "Run context disagrees — not bound to this issue",
    });
    await seedRun({
      companyId,
      agentId,
      issueId,
      status: "interrupted",
      errorCode: ORPHANED_RUN_ERROR_CODE,
      createdAt: new Date("2026-10-13T14:46:35.000Z"),
      contextIssueKey: "disagreeing",
    });

    const { service, enqueueWakeup } = recoveryServiceForTest();
    const result = await service.reconcileOrphanedRunIssues();

    expect(result.rewoken).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not treat an issue as an orphan when a NEWER non-orphan run exists", async () => {
    // The latest run is authoritative. An old orphaned run sitting underneath a
    // newer successful run is history, not a lost execution path.
    const { companyId, agentId } = await seedCompany();
    const issueId = await seedIssue({
      companyId,
      agentId,
      status: "in_progress",
      title: "Old orphan superseded by a newer successful run",
    });
    await seedRun({
      companyId,
      agentId,
      issueId,
      status: "interrupted",
      errorCode: ORPHANED_RUN_ERROR_CODE,
      createdAt: new Date("2026-10-13T14:46:35.000Z"),
    });
    await seedRun({
      companyId,
      agentId,
      issueId,
      status: "succeeded",
      errorCode: null,
      createdAt: new Date("2026-10-13T15:00:00.000Z"),
    });

    const { service, enqueueWakeup } = recoveryServiceForTest();
    const result = await service.reconcileOrphanedRunIssues();

    expect(result.rewoken).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  // --- SPA-12319 sweep-path orphan handback ---
  //
  // The measured SPA-12311 shape: an `in_progress` issue still holds a lock on
  // a `running` run whose process is gone, with the run's contextSnapshot
  // bound to the issue. `sweepStaleIssueLocks` terminalizes the run via
  // process-death authority (status `interrupted`, errorCode
  // `orphaned_running_run`) and clears the lock; `reconcileOrphanedRunIssues`
  // is then the single owner of the handback — it must re-wake the issue.
  // No second wake path exists inside the sweep and the reconciler is never
  // routed via the run-end-state guard.

  it("SPA-12319: sweep terminalizes the orphan, then the reconciler re-wakes the issue", async () => {
    const { companyId, agentId } = await seedCompany();
    const issueId = await seedIssue({
      companyId,
      agentId,
      status: "in_progress",
      title: "Sweep-path orphan — terminalize then hand back",
    });
    const runId = await seedRun({
      companyId,
      agentId,
      issueId,
      status: "running",
      createdAt: new Date("2026-10-13T14:46:35.000Z"),
      // A pid this large never maps to a live process, so isPidAlive returns
      // false and the run is an orphan under process-death authority.
      processPid: 2_000_000_000,
    });
    await db.update(issues).set({ checkoutRunId: runId, executionRunId: runId }).where(eq(issues.id, issueId));

    const { service, enqueueWakeup } = recoveryServiceForTest();

    const swept = await service.sweepStaleIssueLocks();
    expect(swept.terminalizedRunIds).toEqual([runId]);
    expect(swept.cleared).toBe(1);

    const terminalized = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    expect(terminalized).toEqual({ status: "interrupted", errorCode: ORPHANED_RUN_ERROR_CODE });

    const lock = await db
      .select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(lock).toEqual({ checkoutRunId: null, executionRunId: null });

    const rewoke = await service.reconcileOrphanedRunIssues();
    expect(rewoke).toMatchObject({ scanned: 1, rewoken: 1, issueIds: [issueId] });

    // "Not left with zero runs and no wake": exactly one persisted wake whose
    // payload carries the interrupted run id, and the sweep's run-event for it.
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    expect(enqueueWakeup.mock.calls[0]?.[0]).toBe(agentId);
    const persisted = await db
      .select({ payload: agentWakeupRequests.payload, idempotencyKey: agentWakeupRequests.idempotencyKey })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
    expect(persisted).toHaveLength(1);
    expect((persisted[0]?.payload as { orphanedRunId?: string } | null)?.orphanedRunId).toBe(runId);
    expect(persisted[0]?.idempotencyKey).toBe(`issue_orphaned_run_rewake:${runId}`);
    const events = await db
      .select({ runId: heartbeatRunEvents.runId, message: heartbeatRunEvents.message })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId));
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]?.message).toContain("process and sandbox gone");
  });

  it("SPA-12319: a done issue is NOT re-woken after the sweep", async () => {
    // Mirrors the reuse-lease test: issue-terminal authority terminalizes the
    // run for a `done` issue, but the reconciler's candidate set is active
    // statuses only, so the dead card must never be re-woken.
    const { companyId, agentId } = await seedCompany();
    const issueId = await seedIssue({
      companyId,
      agentId,
      status: "done",
      title: "Sweep-path terminal issue — must not be re-woken",
    });
    const runId = await seedRun({
      companyId,
      agentId,
      issueId,
      status: "running",
      createdAt: new Date("2026-10-13T14:46:35.000Z"),
      processPid: 2_000_000_000,
    });
    await db.update(issues).set({ checkoutRunId: runId, executionRunId: runId }).where(eq(issues.id, issueId));

    const { service, enqueueWakeup } = recoveryServiceForTest();

    const swept = await service.sweepStaleIssueLocks();
    expect(swept.terminalizedRunIds).toEqual([runId]);

    const rewoke = await service.reconcileOrphanedRunIssues();
    expect(rewoke.rewoken).toBe(0);
    expect(rewoke.issueIds).not.toContain(issueId);
    expect(enqueueWakeup).not.toHaveBeenCalled();
    await expect(countPersistedWakes(companyId)).resolves.toHaveLength(0);
  });

  it("SPA-12319: sweep then reconciler twice yields exactly one persisted wake", async () => {
    const { companyId, agentId } = await seedCompany();
    const issueId = await seedIssue({
      companyId,
      agentId,
      status: "in_progress",
      title: "Sweep-path no-double-wake",
    });
    const runId = await seedRun({
      companyId,
      agentId,
      issueId,
      status: "running",
      createdAt: new Date("2026-10-13T14:46:35.000Z"),
      processPid: 2_000_000_000,
    });
    await db.update(issues).set({ checkoutRunId: runId, executionRunId: runId }).where(eq(issues.id, issueId));

    const { service, enqueueWakeup } = recoveryServiceForTest();

    const swept = await service.sweepStaleIssueLocks();
    expect(swept.terminalizedRunIds).toEqual([runId]);

    const first = await service.reconcileOrphanedRunIssues();
    const second = await service.reconcileOrphanedRunIssues();

    expect(first).toMatchObject({ rewoken: 1, issueIds: [issueId] });
    expect(second.rewoken).toBe(0);
    expect(second.issueIds).not.toContain(issueId);
    // Run-keyed idempotency receipt `issue_orphaned_run_rewake:<runId>`.
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    await expect(countPersistedWakes(companyId)).resolves.toHaveLength(1);
  });
});
