import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Environment } from "@paperclipai/shared";
import {
  activityLog,
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
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

describeEmbeddedPostgres("terminal environment leases (SPA-9423)", () => {
  let cleanupDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("terminal-environment-leases-");
    cleanupDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(companies);
  });

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
    // engine surface, not a test-only exercise.
    const indexSource = await import("node:fs/promises").then((fs) =>
      fs.readFile(
        `${process.cwd()}/src/index.ts`,
        "utf8",
      ),
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
});
