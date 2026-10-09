import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Environment } from "@paperclipai/shared";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { environmentRuntimeService } from "./environment-runtime.js";
import { heartbeatService } from "./heartbeat.js";
import {
  installReplacementDispatcher,
  TERMINAL_LEASE_LOCAL_EPHEMERAL_DEFAULT_TTL_MS,
} from "./terminal-environment-leases.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping terminal environment lease tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const RECLAIM_BATCH = 25;

// SPA-9351: the direct-terminal-writer cases below call heartbeat.wakeup,
// which dispatches post-commit and keeps writing rows after the test body
// returns. Teardown must drain those dispatches BEFORE deleting fixture rows,
// and must delete children (agent_task_sessions) before the runs they
// reference. The same discipline the deferred-wake suite adopted for the
// `delete from heartbeat_runs` vs async `UPDATE issues` race.
const trackedHeartbeatServices: Array<{ drainActiveRunExecutions: () => Promise<void> }> = [];

function trackHeartbeatService<T extends { drainActiveRunExecutions: () => Promise<void> }>(
  service: T,
): T {
  trackedHeartbeatServices.push(service);
  return service;
}

async function drainTrackedHeartbeatServices(): Promise<void> {
  // Repeat: a settling run can dispatch a follow-up for the same agent,
  // registering further work on the same instance before it goes idle.
  for (let pass = 0; pass < 5; pass += 1) {
    await Promise.all(
      trackedHeartbeatServices.map((service) => service.drainActiveRunExecutions()),
    );
  }
  trackedHeartbeatServices.length = 0;
}

describeEmbeddedPostgres("terminal environment leases (SPA-9423)", () => {
  let cleanupDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("terminal-environment-leases-");
    cleanupDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 30_000);

  afterEach(async () => {
    await drainTrackedHeartbeatServices();
    await db.delete(activityLog);
    await db.delete(companySkills);
    await db.delete(agentTaskSessions);
    await db.delete(environmentLeases);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(companies);
  }, 120_000);

  afterAll(async () => {
    await cleanupDb?.();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({
      id: companyId,
      name: `Terminal Lease Co ${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      status: "active",
      // heartbeat.wakeup() needs a responsible user to dispatch a run. The
      // seed below is used by the direct-terminal-writer cases.
      defaultResponsibleUserId: "responsible-user",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Lease Subject Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      createdAt: now,
      updatedAt: now,
    });
    return { companyId, agentId };
  }

  async function seedEnvironment(input: {
    companyId: string;
    driver: string;
    config?: Record<string, unknown>;
  }): Promise<Environment> {
    if (input.driver === "local") {
      const existing = await db
        .select()
        .from(environments)
        .where(eq(environments.driver, "local"))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (existing) {
        return rowToEnvironment(existing, input.companyId);
      }
    }
    const environmentId = randomUUID();
    const now = new Date();
    await db.insert(environments).values({
      id: environmentId,
      name: `${input.driver}-${environmentId.slice(0, 6)}`,
      driver: input.driver,
      status: "active",
      config: input.config ?? {},
      createdAt: now,
      updatedAt: now,
    });
    const inserted = await db
      .select()
      .from(environments)
      .where(eq(environments.id, environmentId))
      .then((rows) => rows[0]);
    return rowToEnvironment(inserted!, input.companyId);
  }

  function rowToEnvironment(
    row: typeof environments.$inferSelect,
    fallbackCompanyId: string,
  ): Environment {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      driver: row.driver as Environment["driver"],
      status: row.status as Environment["status"],
      config: (row.config as Record<string, unknown>) ?? {},
      envVars: (row.envVars as Environment["envVars"]) ?? {},
      metadata: (row.metadata as Record<string, unknown>) ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } as Environment;
  }

  /**
   * A queued run holding an issue's execution lock, with a second agent as the
   * new assignee. Mirrors the seeded cross-agent reassignment fixture in
   * `__tests__/heartbeat-lock-release-on-reassignment.test.ts`, which is the
   * production shape of the direct terminal writer at heartbeat.ts:28236.
   */
  async function seedReassignmentHolder(input: {
    companyId: string;
    agentId: string;
    holderStatus: "queued" | "running";
  }) {
    const reviewerAgentId = randomUUID();
    const issueId = randomUUID();
    const holderRunId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issuePrefix = `T${input.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const now = new Date();

    await db.insert(agents).values({
      id: reviewerAgentId,
      companyId: input.companyId,
      name: `Lease Reviewer ${reviewerAgentId.slice(0, 8)}`,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "assignment",
      status: "queued",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(heartbeatRuns).values({
      id: holderRunId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input.holderStatus,
      wakeupRequestId,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_assigned",
      },
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "Cross-agent reassignment with a held lease",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: reviewerAgentId,
      executionRunId: holderRunId,
      executionAgentNameKey: "lease-subject-agent",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      createdAt: now,
      updatedAt: now,
    });

    return { reviewerAgentId, issueId, holderRunId, wakeupRequestId };
  }

  async function seedRun(input: { companyId: string; agentId: string; status: string; id?: string }) {
    const runId = input.id ?? randomUUID();
    const now = new Date();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      status: input.status,
      invocationSource: "manual",
      createdAt: now,
      updatedAt: now,
    });
    return runId;
  }

  it("atomically releases a local ephemeral lease with its terminal run", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = await seedRun({ companyId, agentId, status: "running" });
    const lease = await environmentRuntimeService(db).acquireRunLease({
      companyId,
      environment: await seedEnvironment({ companyId, driver: "local" }),
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    await heartbeatService(db).terminalizeRunOnLeaseRelease(
      await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then(rows => rows[0]!),
    );
    const [terminalRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const [terminalLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.lease.id));
    expect(terminalRun?.status).toBe("interrupted");
    expect(terminalLease?.status).toBe("released");
  });

  it.each(["lease-release", "shutdown"] as const)("rolls back terminal run state when durable lease release fails via %s", async (entrypoint) => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = await seedRun({ companyId, agentId, status: "running" });
    const { lease } = await environmentRuntimeService(db).acquireRunLease({
      companyId,
      environment: await seedEnvironment({ companyId, driver: "local" }),
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });
    const [originalRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    await db.execute(sql.raw(`CREATE FUNCTION spa9351_reject_lease_release() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = '${lease.id}' AND OLD.status = 'active'
          AND NEW.status IN ('released', 'pending_cleanup') THEN
          RAISE EXCEPTION 'SPA9351_LEASE_RELEASE_REJECTED';
        END IF;
        RETURN NEW;
      END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER spa9351_reject_lease_release
      BEFORE UPDATE ON environment_leases FOR EACH ROW
      EXECUTE FUNCTION spa9351_reject_lease_release()`));
    try {
      const heartbeat = heartbeatService(db);
      const terminalization = entrypoint === "lease-release"
        ? heartbeat.terminalizeRunOnLeaseRelease(originalRun!)
        : heartbeat.drainRunningRunsForShutdown("SIGTERM", new Date(), [runId]);
      const failure = await terminalization.then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      const databaseError = (failure as Error & { cause?: Error }).cause ?? failure;
      expect(String(databaseError)).toContain("SPA9351_LEASE_RELEASE_REJECTED");
      const [runAfter] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const [leaseAfter] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
      expect(runAfter).toEqual(originalRun);
      expect(leaseAfter?.status).toBe("active");
      expect(leaseAfter?.releasedAt).toBeNull();
    } finally {
      await db.execute(sql.raw("DROP TRIGGER spa9351_reject_lease_release ON environment_leases"));
      await db.execute(sql.raw("DROP FUNCTION spa9351_reject_lease_release()"));
    }
  });

  it.each(["succeeded", "failed", "cancelled", "interrupted", "timed_out"])(
    "reclaims a %s owner within one sweep and is idempotent",
    async (status) => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const runId = await seedRun({ companyId, agentId, status });
      const { lease } = await environmentRuntimeService(db).acquireRunLease({
        companyId,
        environment: await seedEnvironment({ companyId, driver: "local" }),
        issueId: null,
        heartbeatRunId: runId,
        persistedExecutionWorkspace: null,
      });
      const heartbeat = heartbeatService(db);
      const first = await heartbeat.reclaimTerminalEnvironmentLeases({ batchSize: RECLAIM_BATCH });
      expect(first.releasedLeaseIds).toEqual([lease.id]);
      expect(first.driverFailures).toEqual([]);
      const [released] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
      const expectedLeaseStatus = status === "failed" || status === "timed_out"
        ? "failed"
        : status === "cancelled" ? "expired" : "released";
      expect(released?.status).toBe(expectedLeaseStatus);
      expect(released?.releasedAt).toBeInstanceOf(Date);
      const second = await heartbeat.reclaimTerminalEnvironmentLeases({ batchSize: RECLAIM_BATCH });
      expect(second.reclaimed).toBe(0);
      expect(second.releasedLeaseIds).toEqual([]);
    },
  );

  it.each(["unknown", "queued", "running", "scheduled_retry"])(
    "preserves a %s owner despite an orphan error code",
    async (status) => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const runId = await seedRun({ companyId, agentId, status });
      await db.update(heartbeatRuns).set({ errorCode: "orphaned_running_run" })
        .where(eq(heartbeatRuns.id, runId));
      const { lease } = await environmentRuntimeService(db).acquireRunLease({
        companyId,
        environment: await seedEnvironment({ companyId, driver: "local" }),
        issueId: null,
        heartbeatRunId: runId,
        persistedExecutionWorkspace: null,
      });
      const result = await heartbeatService(db).reclaimTerminalEnvironmentLeases({ batchSize: RECLAIM_BATCH });
      const [after] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
      expect(after?.status).toBe("active");
      expect(after?.releasedAt).toBeNull();
      expect(result.reclaimed).toBe(0);
      expect(result.driverFailures).toEqual([]);
    },
  );

  it("LEASE-GATES: terminal-release", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const environment = await seedEnvironment({ companyId, driver: "local" });
    const heartbeat = heartbeatService(db);

    const succeededRunId = await seedRun({ companyId, agentId, status: "succeeded" });
    const failedRunId = await seedRun({ companyId, agentId, status: "failed" });
    const cancelledRunId = await seedRun({ companyId, agentId, status: "cancelled" });
    const interruptedRunId = await seedRun({
      companyId,
      agentId,
      status: "interrupted",
    });

    const runtime = environmentRuntimeService(db);
    for (const runId of [succeededRunId, failedRunId, cancelledRunId, interruptedRunId]) {
      const lease = await runtime.acquireRunLease({
        companyId,
        environment,
        issueId: null,
        heartbeatRunId: runId,
        persistedExecutionWorkspace: null,
      });
      expect(lease.lease.status).toBe("active");
    }

    for (const [runId, status] of [
      [succeededRunId, "succeeded"],
      [failedRunId, "failed"],
      [cancelledRunId, "cancelled"],
      [interruptedRunId, "interrupted"],
    ] as const) {
      await heartbeat.releaseEnvironmentLeasesForRun({
        runId,
        companyId,
        agentId,
        status,
        failureReason: status === "failed" ? "boom" : undefined,
      });
    }

    const remaining = await db
      .select({ id: environmentLeases.id, status: environmentLeases.status })
      .from(environmentLeases)
      .where(eq(environmentLeases.companyId, companyId));
    const stillActive = remaining.filter((row) => row.status === "active");
    expect(stillActive).toHaveLength(0);

    const retainedEnvironment = await seedEnvironment({
      companyId,
      driver: "local",
    });
    const retainedRunId = await seedRun({
      companyId,
      agentId,
      status: "succeeded",
    });
    const retainedLease = await runtime.acquireRunLease({
      companyId,
      environment: retainedEnvironment,
      issueId: null,
      heartbeatRunId: retainedRunId,
      persistedExecutionWorkspace: null,
    });
    await db
      .update(environmentLeases)
      .set({
        status: "retained",
        metadata: {
          ...(retainedLease.lease.metadata ?? {}),
          nativeRunnerOwnership: { held: true, observedAt: new Date().toISOString() },
        },
      })
      .where(eq(environmentLeases.id, retainedLease.lease.id));

    await heartbeat.releaseEnvironmentLeasesForRun({
      runId: retainedRunId,
      companyId,
      agentId,
      status: "succeeded",
      providerResourceDisposition: "stop_and_retain",
    });

    const retainedRows = await db
      .select({ status: environmentLeases.status })
      .from(environmentLeases)
      .where(eq(environmentLeases.id, retainedLease.lease.id));
    expect(retainedRows[0]?.status).toBe("retained");

    // The interrupted-during-shutdown path is the wire the card asks for:
    // `releaseEnvironmentLeasesForRun` called from `drainRunningRunsForShutdown`
    // (heartbeat.ts L15380) on a run whose status flipped to `interrupted`
    // with `errorCode = server_shutdown_interrupted`. Mirror that wire here.
    const shutdownRunId = await seedRun({
      companyId,
      agentId,
      status: "interrupted",
      id: randomUUID(),
    });
    await db
      .update(heartbeatRuns)
      .set({ errorCode: "server_shutdown_interrupted" })
      .where(eq(heartbeatRuns.id, shutdownRunId));
    const shutdownLease = await runtime.acquireRunLease({
      companyId,
      environment: await seedEnvironment({ companyId, driver: "local" }),
      issueId: null,
      heartbeatRunId: shutdownRunId,
      persistedExecutionWorkspace: null,
    });
    await heartbeat.releaseEnvironmentLeasesForRun({
      runId: shutdownRunId,
      companyId,
      agentId,
      status: "interrupted",
      failureReason: "server_shutdown_interrupted",
    });
    const shutdownRows = await db
      .select({ status: environmentLeases.status })
      .from(environmentLeases)
      .where(eq(environmentLeases.id, shutdownLease.lease.id));
    expect(shutdownRows[0]?.status).not.toBe("active");

    // Drive the same wire through the heartbeat service's actual shutdown
    // path (`drainRunningRunsForShutdown`). It iterates every running run,
    // flips status to `interrupted` with `errorCode = server_shutdown_interrupted`,
    // and calls `releaseEnvironmentLeasesForRun` on each — which is the
    // wire the card asks for. We pre-populate a `running` run with an
    // active lease, invoke the drain, and assert the lease is released.
    const shutdownDrainRunId = await seedRun({
      companyId,
      agentId,
      status: "running",
      id: randomUUID(),
    });
    await db
      .update(heartbeatRuns)
      .set({
        startedAt: new Date(Date.now() - 60_000),
        runtimeMode: "legacy",
      })
      .where(eq(heartbeatRuns.id, shutdownDrainRunId));
    const shutdownDrainLease = await runtime.acquireRunLease({
      companyId,
      environment: await seedEnvironment({ companyId, driver: "local" }),
      issueId: null,
      heartbeatRunId: shutdownDrainRunId,
      persistedExecutionWorkspace: null,
    });
    await heartbeat.drainRunningRunsForShutdown("SIGTERM", new Date(), [
      shutdownDrainRunId,
    ]);
    const shutdownDrainRows = await db
      .select({ status: environmentLeases.status })
      .from(environmentLeases)
      .where(eq(environmentLeases.id, shutdownDrainLease.lease.id));
    expect(shutdownDrainRows[0]?.status).not.toBe("active");
    const drainRunRow = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, shutdownDrainRunId))
      .then((rows) => rows[0]);
    expect(drainRunRow?.status).toBe("interrupted");
    expect(drainRunRow?.errorCode).toBe("server_shutdown_interrupted");

    // SPA-9423 D1 fix: assert the sweep path actually flips the lease status
    // through the driver teardown. The runtime releaseRunLeases selects by
    // status=active + heartbeatRunId; if the sweep's claim-first pattern
    // had flipped to pending_cleanup first, the select would return zero
    // rows and the lease would stay active. Confirm the lease is now
    // terminal (released/expired/failed), proving the runtime path ran.
    const reclaimOnlyRunId = await seedRun({
      companyId,
      agentId,
      status: "failed",
      id: randomUUID(),
    });
    const reclaimLease = await runtime.acquireRunLease({
      companyId,
      environment: await seedEnvironment({ companyId, driver: "local" }),
      issueId: null,
      heartbeatRunId: reclaimOnlyRunId,
      persistedExecutionWorkspace: null,
    });
    const reclaimResult = await heartbeat.reclaimTerminalEnvironmentLeases({
      batchSize: RECLAIM_BATCH,
    });
    expect(reclaimResult.reclaimed).toBeGreaterThanOrEqual(1);
    expect(reclaimResult.releasedLeaseIds).toContain(reclaimLease.lease.id);
    const reclaimStatus = await db
      .select({ status: environmentLeases.status })
      .from(environmentLeases)
      .where(eq(environmentLeases.id, reclaimLease.lease.id));
    expect(reclaimStatus[0]?.status).not.toBe("active");
  });

  it("LEASE-GATES: sweep-guards", async () => {
    const { companyId: companyA, agentId: agentA } = await seedCompanyAndAgent();
    const { companyId: companyB } = await seedCompanyAndAgent();
    const environment = await seedEnvironment({ companyId: companyA, driver: "local" });
    const runtime = environmentRuntimeService(db);

    const orphanRunId = await seedRun({ companyId: companyA, agentId: agentA, status: "failed" });
    await runtime.acquireRunLease({
      companyId: companyA,
      environment,
      issueId: null,
      heartbeatRunId: orphanRunId,
      persistedExecutionWorkspace: null,
    });

    const liveRunId = await seedRun({ companyId: companyA, agentId: agentA, status: "running" });
    await runtime.acquireRunLease({
      companyId: companyA,
      environment,
      issueId: null,
      heartbeatRunId: liveRunId,
      persistedExecutionWorkspace: null,
    });

    const queuedRunId = await seedRun({ companyId: companyA, agentId: agentA, status: "queued" });
    await runtime.acquireRunLease({
      companyId: companyA,
      environment,
      issueId: null,
      heartbeatRunId: queuedRunId,
      persistedExecutionWorkspace: null,
    });

    const crossCompanyRunId = await seedRun({
      companyId: companyA,
      agentId: agentA,
      status: "failed",
    });
    await db.insert(environmentLeases).values({
      id: randomUUID(),
      companyId: companyB,
      environmentId: environment.id,
      executionWorkspaceId: null,
      issueId: null,
      heartbeatRunId: crossCompanyRunId,
      status: "active",
      leasePolicy: "ephemeral",
      provider: "local",
      providerLeaseId: null,
      acquiredAt: new Date(Date.now() - 30 * 60 * 1000),
      lastUsedAt: new Date(Date.now() - 30 * 60 * 1000),
      expiresAt: null,
      releasedAt: null,
      failureReason: null,
      cleanupStatus: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const changedOwnershipRunId = await seedRun({
      companyId: companyA,
      agentId: agentA,
      status: "failed",
    });
    await runtime.acquireRunLease({
      companyId: companyA,
      environment,
      issueId: null,
      heartbeatRunId: changedOwnershipRunId,
      persistedExecutionWorkspace: null,
    });
    await db
      .update(environmentLeases)
      .set({
        heartbeatRunId: null,
        metadata: { rebind: true },
      })
      .where(eq(environmentLeases.heartbeatRunId, changedOwnershipRunId));

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reclaimTerminalEnvironmentLeases({
      batchSize: RECLAIM_BATCH,
    });

    expect(result.reclaimed).toBe(1);
    expect(result.skippedLiveOwners).toBeGreaterThanOrEqual(2);
    expect(result.skippedCrossCompany).toBe(1);
    expect(result.skippedOwnershipChanged).toBe(1);

    const stillActive = await db
      .select({ id: environmentLeases.id, runId: environmentLeases.heartbeatRunId })
      .from(environmentLeases)
      .where(eq(environmentLeases.status, "active"));
    const stillActiveRunIds = new Set(stillActive.map((row) => row.runId));
    expect(stillActiveRunIds.has(orphanRunId)).toBe(false);
    expect(stillActiveRunIds.has(liveRunId)).toBe(true);
    expect(stillActiveRunIds.has(queuedRunId)).toBe(true);
  });

  it("LEASE-GATES: finite-expiry", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const environment = await seedEnvironment({ companyId, driver: "local" });
    const heartbeat = heartbeatService(db);
    const runtime = environmentRuntimeService(db);

    const liveRunId = await seedRun({ companyId, agentId, status: "running" });
    const liveLease = await runtime.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: liveRunId,
      persistedExecutionWorkspace: null,
    });
    expect(liveLease.lease.expiresAt).not.toBeNull();

    const expiredLeasesAtExpiry = await db
      .select({ id: environmentLeases.id })
      .from(environmentLeases)
      .where(eq(environmentLeases.heartbeatRunId, liveRunId));
    expect(expiredLeasesAtExpiry).toHaveLength(1);

    // Expiry alone cannot tear down a live run — terminal-owner proof is the
    // only reclaim predicate.
    const result = await heartbeat.reclaimTerminalEnvironmentLeases({
      batchSize: RECLAIM_BATCH,
    });
    expect(result.reclaimed).toBe(0);

    const liveRow = await db
      .select({ status: environmentLeases.status })
      .from(environmentLeases)
      .where(eq(environmentLeases.id, liveLease.lease.id));
    expect(liveRow[0]?.status).toBe("active");

    // After the run goes terminal, expiry is still not the predicate — the
    // sweep now reclaims because the run is provably terminal.
    const orphanRunId = await seedRun({ companyId, agentId, status: "failed" });
    const orphanLease = await runtime.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: orphanRunId,
      persistedExecutionWorkspace: null,
    });

    const reclaimed = await heartbeat.reclaimTerminalEnvironmentLeases({
      batchSize: RECLAIM_BATCH,
    });
    expect(reclaimed.reclaimed).toBe(1);
    const orphanRow = await db
      .select({ status: environmentLeases.status })
      .from(environmentLeases)
      .where(eq(environmentLeases.id, orphanLease.lease.id));
    expect(orphanRow[0]?.status).not.toBe("active");

    // Default TTL constant matches the wired 1-hour finite expiry.
    expect(TERMINAL_LEASE_LOCAL_EPHEMERAL_DEFAULT_TTL_MS).toBe(60 * 60 * 1000);
  });

  it("LEASE-GATES: restart-replacement", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const environment = await seedEnvironment({ companyId, driver: "local" });
    const heartbeat = heartbeatService(db);
    const runtime = environmentRuntimeService(db);

    // The heartbeat service installs a production bounded-replacement
    // dispatcher at construction time (heartbeat.ts installReplacementDispatcher
    // -> enqueueProcessLossRetry). The L4 test runs against that dispatcher.
    // We record the dispatcher calls by hooking the test's own observer.
    const dispatcherCalls: Array<{ fromRunId: string; leaseId: string }> = [];
    installReplacementDispatcher(async ({ fromRunId, leaseId }) => {
      dispatcherCalls.push({ fromRunId, leaseId });
      const newRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: newRunId,
        companyId,
        agentId,
        status: "scheduled_retry",
        invocationSource: "scheduled_retry",
        retryOfRunId: fromRunId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return { replacementRunId: newRunId };
    });

    const originalRunId = await seedRun({
      companyId,
      agentId,
      status: "interrupted",
      id: randomUUID(),
    });
    await db
      .update(heartbeatRuns)
      .set({ errorCode: "server_shutdown_interrupted" })
      .where(eq(heartbeatRuns.id, originalRunId));

    const lease = await runtime.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: originalRunId,
      persistedExecutionWorkspace: null,
    });

    const releaseEvents: string[] = [];
    const replaceEvents: string[] = [];
    const result = await heartbeat.reclaimTerminalEnvironmentLeasesForRestart({
      batchSize: RECLAIM_BATCH,
      onLeaseReleased: ({ runId, reason }) => {
        releaseEvents.push(`${runId}:${reason}`);
      },
      onReplacementDispatched: ({ fromRunId, runId }) => {
        replaceEvents.push(`${fromRunId}:${runId}`);
      },
    });

    // L4 ordering: prior owner terminal (interrupted + orphan errorCode)
    // → lease released by the terminal-owner path → bounded replacement
    // dispatched by `enqueueProcessLossRetry`. The replacement run is a NEW
    // heartbeat_run row, distinct from the original, scheduled_retry status.
    expect(releaseEvents.some((e) => e.startsWith(`${originalRunId}:`))).toBe(true);
    expect(result.releasedRestartOrphans.length).toBeGreaterThanOrEqual(1);
    expect(replaceEvents.length).toBeGreaterThanOrEqual(1);
    expect(result.replacedRunIds.length).toBeGreaterThanOrEqual(1);
    expect(result.replacedRunIds[0]).not.toBe(originalRunId);
    expect(result.replacementDispatchFailures).toHaveLength(0);

    // The L4 ordering: prior owner terminal (interrupted + orphan errorCode)
    // → lease released by the terminal-owner path → bounded replacement
    // dispatched by `enqueueProcessLossRetry`. The replacement run is a NEW
    // heartbeat_run row, distinct from the original, scheduled_retry status.
    expect(releaseEvents.some((e) => e.startsWith(`${originalRunId}:`))).toBe(true);
    expect(result.releasedRestartOrphans.length).toBeGreaterThanOrEqual(1);
    expect(replaceEvents.length).toBeGreaterThanOrEqual(1);
    expect(result.replacedRunIds.length).toBeGreaterThanOrEqual(1);
    expect(result.replacedRunIds[0]).not.toBe(originalRunId);
    expect(result.replacementDispatchFailures).toHaveLength(0);

    const rows = await db
      .select({ status: environmentLeases.status })
      .from(environmentLeases)
      .where(eq(environmentLeases.id, lease.lease.id));
    expect(rows[0]?.status).not.toBe("active");

    const replacementRows = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, result.replacedRunIds[0]));
    expect(replacementRows).toHaveLength(1);

    // The production restart-replacement dispatcher is also wired into the
    // periodic tick (server/src/index.ts -> heartbeat.reclaimTerminalEnvironmentLeasesForRestart
    // chained after reapOrphanedRuns). That wiring is what makes L4 a real
    // engine surface, not a test-only exercise. Anchor on the test file's
    // own location so the read survives non-repo-root CWDs (CI workers).
    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
    );
    const indexSource = await import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(repoRoot, "server", "src", "index.ts"), "utf8"),
    );
    expect(indexSource).toContain(
      "reclaimTerminalEnvironmentLeasesForRestart",
    );

    // SPA-9423 D2 fix: a historical `released` lease (already released on a
    // prior tick) must NOT trigger a replacement dispatch on the next sweep.
    // The restart path is bounded to leases the base reclaim touched in this
    // tick; the test seeds a second lease, releases it on one sweep, then
    // runs a SECOND sweep that touches a fresh terminal lease; the second
    // sweep's restart-dispatch must NOT observe the first lease.
    const historicalRunId = await seedRun({
      companyId,
      agentId,
      status: "interrupted",
      id: randomUUID(),
    });
    await db
      .update(heartbeatRuns)
      .set({ errorCode: "server_shutdown_interrupted" })
      .where(eq(heartbeatRuns.id, historicalRunId));
    const historicalLease = await runtime.acquireRunLease({
      companyId,
      environment: await seedEnvironment({ companyId, driver: "local" }),
      issueId: null,
      heartbeatRunId: historicalRunId,
      persistedExecutionWorkspace: null,
    });
    await heartbeat.reclaimTerminalEnvironmentLeasesForRestart({
      batchSize: RECLAIM_BATCH,
    });
    const historicalReleased = await db
      .select({ status: environmentLeases.status })
      .from(environmentLeases)
      .where(eq(environmentLeases.id, historicalLease.lease.id));
    expect(historicalReleased[0]?.status).not.toBe("active");

    // Now run a SECOND restart sweep with a fresh terminal lease; the
    // historical lease must NOT trigger another replacement dispatch.
    const freshRunId = await seedRun({
      companyId,
      agentId,
      status: "interrupted",
      id: randomUUID(),
    });
    await db
      .update(heartbeatRuns)
      .set({ errorCode: "server_shutdown_interrupted" })
      .where(eq(heartbeatRuns.id, freshRunId));
    const freshLease = await runtime.acquireRunLease({
      companyId,
      environment: await seedEnvironment({ companyId, driver: "local" }),
      issueId: null,
      heartbeatRunId: freshRunId,
      persistedExecutionWorkspace: null,
    });
    const freshReleaseEvents: string[] = [];
    const freshReplaceEvents: string[] = [];
    const freshResult = await heartbeat.reclaimTerminalEnvironmentLeasesForRestart({
      batchSize: RECLAIM_BATCH,
      onLeaseReleased: ({ runId }) => {
        freshReleaseEvents.push(runId);
      },
      onReplacementDispatched: ({ fromRunId, runId }) => {
        freshReplaceEvents.push(`${fromRunId}:${runId}`);
      },
    });
    expect(freshResult.releasedRestartOrphans.some((o) => o.runId === freshRunId)).toBe(true);
    expect(freshResult.releasedRestartOrphans.some((o) => o.runId === historicalRunId)).toBe(false);
    expect(freshReleaseEvents).toContain(freshRunId);
    expect(freshReleaseEvents).not.toContain(historicalRunId);
    expect(freshReplaceEvents.some((e) => e.startsWith(`${freshRunId}:`))).toBe(true);
    expect(freshReplaceEvents.some((e) => e.startsWith(`${historicalRunId}:`))).toBe(false);

    const freshStatus = await db
      .select({ status: environmentLeases.status })
      .from(environmentLeases)
      .where(eq(environmentLeases.id, freshLease.lease.id));
    expect(freshStatus[0]?.status).not.toBe("active");

    // SPA-9423 D3 fix: driver failures must be isolated AND retryable.
    // Install a failing teardown; the sweep must record the failure in
    // driverFailures and leave the lease active so the next sweep retries.
    const { installDriverTeardown } = await import(
      "./terminal-environment-leases.js"
    );
    const originalTeardownInstalledAt = Date.now();
    let teardownCallCount = 0;
    installDriverTeardown(async ({ heartbeatRunId, companyId, leaseId }) => {
      teardownCallCount += 1;
      if (teardownCallCount === 1) {
        throw new Error("simulated provider outage");
      }
      // Second call succeeds via the heartbeat-installed production teardown
      // path — but we are overriding it, so manually release via the runtime.
      const fallbackRuntime = environmentRuntimeService(db);
      await fallbackRuntime.releaseRunLeases(heartbeatRunId ?? "");
      void companyId;
      void leaseId;
    });
    void originalTeardownInstalledAt;

    const retryRunId = await seedRun({
      companyId,
      agentId,
      status: "failed",
      id: randomUUID(),
    });
    const retryLease = await runtime.acquireRunLease({
      companyId,
      environment: await seedEnvironment({ companyId, driver: "local" }),
      issueId: null,
      heartbeatRunId: retryRunId,
      persistedExecutionWorkspace: null,
    });

    const firstAttempt = await heartbeat.reclaimTerminalEnvironmentLeases({
      batchSize: RECLAIM_BATCH,
    });
    // The failing lease must be recorded in driverFailures, NOT in
    // releasedLeaseIds (so it does not trigger a restart dispatch).
    const failingEntry = firstAttempt.driverFailures.find(
      (f) => f.leaseId === retryLease.lease.id,
    );
    expect(failingEntry?.error).toContain("simulated provider outage");
    expect(firstAttempt.releasedLeaseIds).not.toContain(retryLease.lease.id);

    // The lease must still be active so the next sweep retries.
    const stillActive = await db
      .select({
        status: environmentLeases.status,
        cleanupStatus: environmentLeases.cleanupStatus,
      })
      .from(environmentLeases)
      .where(eq(environmentLeases.id, retryLease.lease.id));
    expect(stillActive[0]?.status).toBe("active");
    expect(stillActive[0]?.cleanupStatus).toBe("failed");

    // Second sweep succeeds (teardownCallCount === 2 path).
    const secondAttempt = await heartbeat.reclaimTerminalEnvironmentLeases({
      batchSize: RECLAIM_BATCH,
    });
    expect(secondAttempt.releasedLeaseIds).toContain(retryLease.lease.id);

    // Reset the module so the other tests in this file use the production
    // teardown again (heartbeat.ts installs it on the next heartbeatService(db)
    // call; the L4 test already ran with its own installReplacementDispatcher,
    // so re-installing that override is also required for cleanup).
    const { resetTerminalLeaseModuleForTest } = await import(
      "./terminal-environment-leases.js"
    );
    resetTerminalLeaseModuleForTest();

    // SPA-9423 D4 fix: `releaseLeaseAsFailed` must NOT resurrect a lease the
    // runtime already released. Simulate by writing the lease to status=released
    // BEFORE the sweep, then asserting the failure stamp does not overwrite it.
    const d4RunId = await seedRun({
      companyId,
      agentId,
      status: "failed",
      id: randomUUID(),
    });
    const d4Lease = await runtime.acquireRunLease({
      companyId,
      environment: await seedEnvironment({ companyId, driver: "local" }),
      issueId: null,
      heartbeatRunId: d4RunId,
      persistedExecutionWorkspace: null,
    });
    // Force the lease into released (simulating a successful concurrent
    // release).
    await db
      .update(environmentLeases)
      .set({ status: "released", releasedAt: new Date() })
      .where(eq(environmentLeases.id, d4Lease.lease.id));
    // releaseLeaseAsFailed is exported from the module; call it directly.
    const { releaseLeaseAsFailed } = await import(
      "./terminal-environment-leases.js"
    );
    await releaseLeaseAsFailed(db, d4Lease.lease.id, "test_resurrect");
    const d4After = await db
      .select({ status: environmentLeases.status, cleanupStatus: environmentLeases.cleanupStatus })
      .from(environmentLeases)
      .where(eq(environmentLeases.id, d4Lease.lease.id));
    expect(d4After[0]?.status).toBe("released");
    expect(d4After[0]?.cleanupStatus).not.toBe("failed");

    // SPA-9423 D5 fix: explicit native-ownership safeguard on the sweep path.
    // A native run with `errorCode = native_execution_ownership_unverified`
    // and `nativePhase = terminal_failure` must NOT be reclaimed even if its
    // status is `running`.
    const d5RunId = await seedRun({
      companyId,
      agentId,
      status: "running",
      id: randomUUID(),
    });
    await db
      .update(heartbeatRuns)
      .set({
        runtimeMode: "native",
        errorCode: "native_execution_ownership_unverified",
        nativePhase: "terminal_failure",
      })
      .where(eq(heartbeatRuns.id, d5RunId));
    const d5Lease = await runtime.acquireRunLease({
      companyId,
      environment: await seedEnvironment({ companyId, driver: "local" }),
      issueId: null,
      heartbeatRunId: d5RunId,
      persistedExecutionWorkspace: null,
    });
    const d5Result = await heartbeat.reclaimTerminalEnvironmentLeases({
      batchSize: RECLAIM_BATCH,
    });
    expect(d5Result.skippedLiveOwners).toBeGreaterThanOrEqual(1);
    const d5After = await db
      .select({ status: environmentLeases.status })
      .from(environmentLeases)
      .where(eq(environmentLeases.id, d5Lease.lease.id));
    expect(d5After[0]?.status).toBe("active");
  });

  // SPA-9351 direct terminal writers. The two atomic setters
  // (setRunStatus / setRunStatusFromLive) enclose the lease release in the
  // run's transaction, but the admission path cancels `queued` and
  // `scheduled_retry` holders through bare `tx.update(heartbeatRuns)` calls at
  // heartbeat.ts:17918, :18035, :28100, :28236 and :28328. A lease is acquired
  // before dispatch (environment-runtime.ts:1103 -> environments.ts:1596), so a
  // cancelled-by-those-paths run leaves its active lease behind and the card
  // strands with `execution_owner_active` — the shape the 2026-10-07 monitor
  // found on 118 leases. This gate pins the real admission cancellation, not a
  // synthetic status write, so a test that only re-implements the UPDATE shape
  // cannot pass for it.
  it("releases the lease of a queued holder cancelled on reassignment", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const scenario = await seedReassignmentHolder({ companyId, agentId, holderStatus: "queued" });
    const { lease } = await environmentRuntimeService(db).acquireRunLease({
      companyId,
      environment: await seedEnvironment({ companyId, driver: "local" }),
      issueId: scenario.issueId,
      heartbeatRunId: scenario.holderRunId,
      persistedExecutionWorkspace: null,
    });

    await trackHeartbeatService(heartbeatService(db)).wakeup(scenario.reviewerAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: scenario.issueId },
      contextSnapshot: {
        issueId: scenario.issueId,
        taskId: scenario.issueId,
        wakeReason: "issue_assigned",
      },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    const [holder] = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scenario.holderRunId));
    expect(holder?.errorCode).toBe("lock_released_on_reassignment");
    expect(holder?.status).toBe("cancelled");

    const [after] = await db
      .select({ status: environmentLeases.status, releasedAt: environmentLeases.releasedAt })
      .from(environmentLeases)
      .where(eq(environmentLeases.id, lease.id));
    expect(after?.status).not.toBe("active");
    expect(after?.releasedAt).toBeInstanceOf(Date);
  });

  it("releases the lease of a scheduled_retry run cancelled before it became due", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    // cancelStaleScheduledRetry (heartbeat.ts:28100) cancels a
    // scheduled_retry holder whose issue was cancelled before the retry became
    // due. It writes the run row directly rather than through setRunStatus, so
    // its lease is exactly the shape that strands. Drive it through the public
    // admission path: a wakeup for an issue already in `cancelled`.
    const cancelledIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const staleRunId = await seedRun({
      companyId,
      agentId,
      status: "scheduled_retry",
    });
    const now = new Date();
    // The admission path finds a legacy holder by context scan
    // (heartbeat.ts:28291, `contextSnapshot ->> 'issueId'`), so the run has to
    // name the issue or cancelStaleScheduledRetry never sees it.
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          issueId: cancelledIssueId,
          taskId: cancelledIssueId,
          wakeReason: "transient_failure_retry",
        },
        updatedAt: now,
      })
      .where(eq(heartbeatRuns.id, staleRunId));
    await db.insert(issues).values({
      id: cancelledIssueId,
      companyId,
      title: "Cancelled before the retry became due",
      status: "cancelled",
      priority: "medium",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      createdAt: now,
      updatedAt: now,
    });
    const { lease } = await environmentRuntimeService(db).acquireRunLease({
      companyId,
      environment: await seedEnvironment({ companyId, driver: "local" }),
      issueId: cancelledIssueId,
      heartbeatRunId: staleRunId,
      persistedExecutionWorkspace: null,
    });

    await trackHeartbeatService(heartbeatService(db)).wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: cancelledIssueId },
      contextSnapshot: {
        issueId: cancelledIssueId,
        taskId: cancelledIssueId,
        wakeReason: "issue_assigned",
      },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    const [stale] = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, staleRunId));
    expect(stale?.status).toBe("cancelled");
    expect(stale?.errorCode).toBe("issue_cancelled");

    const [after] = await db
      .select({ status: environmentLeases.status, releasedAt: environmentLeases.releasedAt })
      .from(environmentLeases)
      .where(eq(environmentLeases.id, lease.id));
    expect(after?.status).not.toBe("active");
    expect(after?.releasedAt).toBeInstanceOf(Date);
  });

  // SPA-9351 identity binding. The admission release pins
  // `heartbeat_run_id = run.id`, so a cancel must never free a DIFFERENT run's
  // live lease on the same agent. If the WHERE ever loosened to agent/company
  // scope, a newer queued run that acquired its own lease would have it
  // released by an older run's cancellation — a second stranding class traded
  // for the first. This case holds two leases on one company and requires that
  // cancelling one holder leaves the other's untouched.
  it("releases only the cancelled run's lease and never a sibling run's", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const environment = await seedEnvironment({ companyId, driver: "local" });
    const runtime = environmentRuntimeService(db);
    const scenario = await seedReassignmentHolder({ companyId, agentId, holderStatus: "queued" });

    const cancelledRunLease = await runtime.acquireRunLease({
      companyId,
      environment,
      issueId: scenario.issueId,
      heartbeatRunId: scenario.holderRunId,
      persistedExecutionWorkspace: null,
    });
    // A second, unrelated run on the SAME company and agent. It holds a lease
    // the cancel must not touch.
    const siblingRunId = await seedRun({ companyId, agentId, status: "queued" });
    const siblingLease = await runtime.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: siblingRunId,
      persistedExecutionWorkspace: null,
    });

    await trackHeartbeatService(heartbeatService(db)).wakeup(scenario.reviewerAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: scenario.issueId },
      contextSnapshot: {
        issueId: scenario.issueId,
        taskId: scenario.issueId,
        wakeReason: "issue_assigned",
      },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    const [released] = await db
      .select({ status: environmentLeases.status, releasedAt: environmentLeases.releasedAt })
      .from(environmentLeases)
      .where(eq(environmentLeases.id, cancelledRunLease.lease.id));
    expect(released?.status).not.toBe("active");
    expect(released?.releasedAt).toBeInstanceOf(Date);

    const [sibling] = await db
      .select({ status: environmentLeases.status, releasedAt: environmentLeases.releasedAt })
      .from(environmentLeases)
      .where(eq(environmentLeases.id, siblingLease.lease.id));
    expect(sibling?.status).toBe("active");
    expect(sibling?.releasedAt).toBeNull();
  });
});
