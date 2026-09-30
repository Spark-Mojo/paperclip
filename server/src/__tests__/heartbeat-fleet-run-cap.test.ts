import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  FLEET_MAX_CONCURRENT_RUNS_DEFAULT,
  FLEET_MAX_CONCURRENT_RUNS_ENV_VAR,
  FLEET_RUN_LIVENESS_WINDOW_DEFAULT_MS,
  FLEET_RUN_LIVENESS_WINDOW_ENV_VAR,
  computeAvailableRunSlots,
  heartbeatService,
  isFleetRunningRowLive,
  normalizeFleetMaxConcurrentRuns,
  normalizeFleetRunLivenessWindowMs,
} from "../services/heartbeat.ts";
import {
  isInsideFleetRunAdmission,
  runOutsideFleetRunAdmission,
  withFleetRunAdmissionLock,
} from "../services/agent-start-lock.ts";
import { runningProcesses } from "../adapters/index.ts";

// Fleet-wide run ceiling (port of upstream paperclipai/paperclip#13621) plus the
// Spark Mojo stale-run guard. The adapter is replaced wholesale: this suite is
// about how many runs the scheduler is willing to start at once. Each execution
// parks on a per-run gate so a "running" row stays running while assertions read
// the fan-out.
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (_context: { runId: string }) => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Fleet run cap test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres fleet-run-cap tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SEEDED_AGENT_COUNT = 6;

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

function deadPid() {
  // A real PID that has already exited (and been reaped by spawnSync).
  const child = spawnSync(process.execPath, ["-e", "0"]);
  return child.pid as number;
}

describe("fleet run ceiling helpers", () => {
  it("defaults to no ceiling and clamps configured values to 1..50", () => {
    expect(FLEET_MAX_CONCURRENT_RUNS_DEFAULT).toBeNull();
    expect(FLEET_MAX_CONCURRENT_RUNS_ENV_VAR).toBe("PAPERCLIP_MAX_CONCURRENT_AGENT_RUNS");
    expect(normalizeFleetMaxConcurrentRuns(undefined)).toBeNull();
    expect(normalizeFleetMaxConcurrentRuns(null)).toBeNull();
    expect(normalizeFleetMaxConcurrentRuns("")).toBeNull();
    expect(normalizeFleetMaxConcurrentRuns("   ")).toBeNull();
    expect(normalizeFleetMaxConcurrentRuns("abc")).toBeNull();
    expect(normalizeFleetMaxConcurrentRuns("NaN")).toBeNull();
    expect(normalizeFleetMaxConcurrentRuns("Infinity")).toBeNull();
    expect(normalizeFleetMaxConcurrentRuns("3")).toBe(3);
    expect(normalizeFleetMaxConcurrentRuns(" 8 ")).toBe(8);
    expect(normalizeFleetMaxConcurrentRuns("1.7")).toBe(1);
    expect(normalizeFleetMaxConcurrentRuns("1e3")).toBe(50);
    expect(normalizeFleetMaxConcurrentRuns("0")).toBe(1);
    expect(normalizeFleetMaxConcurrentRuns(0)).toBe(1);
    expect(normalizeFleetMaxConcurrentRuns("-1")).toBe(1);
    expect(normalizeFleetMaxConcurrentRuns(-4)).toBe(1);
    expect(normalizeFleetMaxConcurrentRuns(500)).toBe(50);
  });

  it("clamps the liveness window and falls back to the default when invalid", () => {
    expect(FLEET_RUN_LIVENESS_WINDOW_ENV_VAR).toBe("PAPERCLIP_FLEET_RUN_LIVENESS_WINDOW_MS");
    expect(FLEET_RUN_LIVENESS_WINDOW_DEFAULT_MS).toBe(600_000);
    expect(normalizeFleetRunLivenessWindowMs(undefined)).toBe(600_000);
    expect(normalizeFleetRunLivenessWindowMs("")).toBe(600_000);
    expect(normalizeFleetRunLivenessWindowMs("soon")).toBe(600_000);
    expect(normalizeFleetRunLivenessWindowMs("0")).toBe(60_000);
    expect(normalizeFleetRunLivenessWindowMs("-5")).toBe(60_000);
    expect(normalizeFleetRunLivenessWindowMs("120000")).toBe(120_000);
    expect(normalizeFleetRunLivenessWindowMs(10 ** 12)).toBe(86_400_000);
  });

  it("takes the lower of the per-agent cap and the remaining fleet budget", () => {
    expect(
      computeAvailableRunSlots({
        agentMaxConcurrentRuns: 20,
        agentRunningRuns: 1,
        fleetMaxConcurrentRuns: null,
        fleetRunningRuns: 7,
      }),
    ).toBe(19);
    expect(
      computeAvailableRunSlots({
        agentMaxConcurrentRuns: 1,
        agentRunningRuns: 1,
        fleetMaxConcurrentRuns: 5,
        fleetRunningRuns: 1,
      }),
    ).toBe(0);
    expect(
      computeAvailableRunSlots({
        agentMaxConcurrentRuns: 20,
        agentRunningRuns: 0,
        fleetMaxConcurrentRuns: 2,
        fleetRunningRuns: 2,
      }),
    ).toBe(0);
    expect(
      computeAvailableRunSlots({
        agentMaxConcurrentRuns: 20,
        agentRunningRuns: 0,
        fleetMaxConcurrentRuns: 2,
        fleetRunningRuns: 1,
      }),
    ).toBe(1);
    expect(
      computeAvailableRunSlots({
        agentMaxConcurrentRuns: 3,
        agentRunningRuns: 9,
        fleetMaxConcurrentRuns: 2,
        fleetRunningRuns: 7,
      }),
    ).toBe(0);
  });

  it("counts a running row only with live evidence (stale-run guard)", () => {
    const base = {
      recentActivity: false,
      locallyTracked: false,
      controllerLeaseLive: false,
      childKnownDead: false,
    };
    // Silent past the window with no controller: dead, never holds a slot.
    expect(isFleetRunningRowLive(base)).toBe(false);
    // Recent activity always counts.
    expect(isFleetRunningRowLive({ ...base, recentActivity: true })).toBe(true);
    expect(isFleetRunningRowLive({ ...base, recentActivity: true, childKnownDead: true })).toBe(true);
    // A live controller counts while its child is not known dead.
    expect(isFleetRunningRowLive({ ...base, locallyTracked: true })).toBe(true);
    expect(isFleetRunningRowLive({ ...base, controllerLeaseLive: true })).toBe(true);
    // A controller still awaiting a child that already died is the stuck shape.
    expect(isFleetRunningRowLive({ ...base, locallyTracked: true, childKnownDead: true })).toBe(false);
    expect(isFleetRunningRowLive({ ...base, controllerLeaseLive: true, childKnownDead: true })).toBe(false);
  });
});

describe("fleet run admission lock", () => {
  it("serialises concurrent holders", async () => {
    let inside = 0;
    let maxInside = 0;
    const order: number[] = [];
    await Promise.all(
      [0, 1, 2, 3].map((index) =>
        withFleetRunAdmissionLock(async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          await new Promise((resolve) => setTimeout(resolve, 10));
          order.push(index);
          inside -= 1;
        }),
      ),
    );
    expect(maxInside).toBe(1);
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it("runs nested acquisitions inline instead of deadlocking", async () => {
    const result = await withFleetRunAdmissionLock(async () =>
      withFleetRunAdmissionLock(async () => (isInsideFleetRunAdmission() ? "nested" : "lost")),
    );
    expect(result).toBe("nested");
  });

  it("releases the lock when the holder throws", async () => {
    await expect(
      withFleetRunAdmissionLock(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(withFleetRunAdmissionLock(async () => "next")).resolves.toBe("next");
  });

  it("detaches fire-and-forget work from the admission context", async () => {
    let detachedSawContext: boolean | null = null;
    let detached: Promise<void> | null = null;
    await withFleetRunAdmissionLock(async () => {
      detached = runOutsideFleetRunAdmission(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        detachedSawContext = isInsideFleetRunAdmission();
      });
    });
    await detached;
    expect(detachedSawContext).toBe(false);
    expect(isInsideFleetRunAdmission()).toBe(false);
  });
});

describeEmbeddedPostgres("fleet-wide agent run ceiling", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let heartbeatAtCeilingOne!: ReturnType<typeof heartbeatService>;
  let heartbeatAtCeilingTwo!: ReturnType<typeof heartbeatService>;
  let heartbeatAtCeilingTwoB!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const gates = new Map<string, () => void>();
  const startedRunIds: string[] = [];
  let blockExecutions = true;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-fleet-run-cap-");
    db = createDb(tempDb.connectionString);
    const runtimeEnv: Record<string, string | undefined> = {
      ...process.env,
      PAPERCLIP_IN_WORKTREE: "false",
    };
    delete runtimeEnv[FLEET_MAX_CONCURRENT_RUNS_ENV_VAR];
    delete runtimeEnv[FLEET_RUN_LIVENESS_WINDOW_ENV_VAR];
    heartbeat = heartbeatService(db, { runtimeEnv });
    heartbeatAtCeilingOne = heartbeatService(db, {
      runtimeEnv: { ...runtimeEnv, [FLEET_MAX_CONCURRENT_RUNS_ENV_VAR]: "1" },
    });
    heartbeatAtCeilingTwo = heartbeatService(db, {
      runtimeEnv: { ...runtimeEnv, [FLEET_MAX_CONCURRENT_RUNS_ENV_VAR]: "2" },
    });
    heartbeatAtCeilingTwoB = heartbeatService(db, {
      runtimeEnv: { ...runtimeEnv, [FLEET_MAX_CONCURRENT_RUNS_ENV_VAR]: "2" },
    });

    mockAdapterExecute.mockImplementation(async (context: { runId: string }) => {
      startedRunIds.push(context.runId);
      if (blockExecutions) {
        await new Promise<void>((resolve) => {
          gates.set(context.runId, resolve);
        });
      }
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Fleet run cap test run.",
        provider: "test",
        model: "test-model",
      };
    });
  }, 120_000);

  afterEach(async () => {
    // Parked or never-started runs are synthetic: cancel the rows first so the
    // drain below never waits on work that nothing will start.
    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(inArray(heartbeatRuns.status, ["queued", "running"]));
    blockExecutions = false;
    for (const release of gates.values()) release();
    gates.clear();
    await heartbeat.drainActiveRunExecutions();
    await heartbeatAtCeilingOne.drainActiveRunExecutions();
    await heartbeatAtCeilingTwo.drainActiveRunExecutions();
    await heartbeatAtCeilingTwoB.drainActiveRunExecutions();
    runningProcesses.clear();
    startedRunIds.length = 0;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.delete(environmentLeases);
        await db.delete(issueComments);
        await db.delete(issues);
        await db.delete(heartbeatRunEvents);
        await db.delete(activityLog);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentRuntimeState);
        await db.delete(agents);
        await db.delete(environments);
        await db.delete(executionWorkspaces);
        await db.delete(companySkills);
        await db.delete(companies);
        break;
      } catch (error) {
        if (attempt >= 9) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    blockExecutions = true;
  }, 60_000);

  afterAll(async () => {
    gates.clear();
    await tempDb?.cleanup();
  });

  function executionsOf(runIds: string[]) {
    return startedRunIds.filter((runId) => runIds.includes(runId));
  }

  async function waitForExecutionsOf(runIds: string[], count: number, timeoutMs = 60_000) {
    return await waitForCondition(async () => executionsOf(runIds).length >= count, timeoutMs);
  }

  async function releaseExecution(runId: string) {
    await waitForCondition(async () => gates.has(runId), 30_000);
    gates.get(runId)?.();
    gates.delete(runId);
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, index: number) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `FleetCoder${index}-${agentId.slice(0, 4)}`,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return agentId;
  }

  async function seedAgentWithQueuedRun(input: { companyId: string; index: number; createdAt: Date }) {
    const agentId = await seedAgent(input.companyId, input.index);
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: `Fleet issue ${input.index}`,
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    return { agentId, issueId, runId };
  }

  async function seedCompanyWithQueuedRuns(count = SEEDED_AGENT_COUNT) {
    const companyId = await seedCompany();
    const seeded = [];
    const base = Date.now() - count * 60_000;
    for (let index = 0; index < count; index += 1) {
      seeded.push(
        await seedAgentWithQueuedRun({
          companyId,
          index,
          // Ticket 0 is the oldest, ticket count-1 the newest.
          createdAt: new Date(base + index * 60_000),
        }),
      );
    }
    return { companyId, seeded };
  }

  // A pre-existing `running` row owned by a separate agent, to exercise the
  // stale-run guard. Timestamps default to two hours old (outside the window).
  async function seedRunningRow(input: {
    companyId: string;
    lastActivityAt?: Date;
    controllerLeaseExpiresAt?: Date | null;
    processPid?: number | null;
  }) {
    const agentId = await seedAgent(input.companyId, 99);
    const runId = randomUUID();
    const at = input.lastActivityAt ?? new Date(Date.now() - 2 * 60 * 60 * 1000);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: {},
      createdAt: at,
      updatedAt: at,
      startedAt: at,
      controllerBootId: input.controllerLeaseExpiresAt ? randomUUID() : null,
      controllerLeaseExpiresAt: input.controllerLeaseExpiresAt ?? null,
      processPid: input.processPid ?? null,
    });
    return runId;
  }

  async function listRuns(companyId: string) {
    return await db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId))
      .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id));
  }

  async function seededStatuses(runIds: string[]) {
    const rows = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, runIds));
    return {
      running: rows.filter((row) => row.status === "running").map((row) => row.id),
      queued: rows.filter((row) => row.status === "queued").map((row) => row.id),
      other: rows.filter((row) => row.status !== "running" && row.status !== "queued"),
      total: rows.length,
    };
  }

  // Let any over-admission that would happen actually happen before asserting.
  async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  it("starts the whole backlog when no ceiling is configured (unchanged behaviour)", async () => {
    const { seeded } = await seedCompanyWithQueuedRuns();
    const seededRunIds = seeded.map((s) => s.runId);

    await heartbeat.resumeQueuedRuns();
    expect(await waitForExecutionsOf(seededRunIds, SEEDED_AGENT_COUNT)).toBe(true);

    const statuses = await seededStatuses(seededRunIds);
    expect(statuses.running).toHaveLength(SEEDED_AGENT_COUNT);
  }, 120_000);

  it("admits at most the ceiling across agents and keeps the excess queued", async () => {
    const { companyId, seeded } = await seedCompanyWithQueuedRuns();
    const seededRunIds = seeded.map((s) => s.runId);

    await heartbeatAtCeilingTwo.resumeQueuedRuns();
    expect(await waitForExecutionsOf(seededRunIds, 2)).toBe(true);
    await settle();

    const runs = await listRuns(companyId);
    const running = runs.filter((run) => run.status === "running");
    expect(running).toHaveLength(2);
    // Oldest tickets take the slots.
    expect(running.map((run) => run.id).sort()).toEqual(seededRunIds.slice(0, 2).sort());
    // Excess work stays queued: nothing cancelled, failed, or dropped.
    expect(runs.map((run) => run.id).sort()).toEqual(seededRunIds.slice().sort());
    expect(runs.filter((run) => run.status === "queued")).toHaveLength(SEEDED_AGENT_COUNT - 2);
    expect(executionsOf(seededRunIds).sort()).toEqual(seededRunIds.slice(0, 2).sort());

    // A repeat sweep while full admits nothing more and drops nothing.
    await heartbeatAtCeilingTwo.resumeQueuedRuns();
    await settle();
    const again = await seededStatuses(seededRunIds);
    expect(again.running).toHaveLength(2);
    expect(again.queued).toHaveLength(SEEDED_AGENT_COUNT - 2);
    expect(again.other).toHaveLength(0);
  }, 120_000);

  it("honours a ceiling of one", async () => {
    const { seeded } = await seedCompanyWithQueuedRuns(3);
    const seededRunIds = seeded.map((s) => s.runId);

    await heartbeatAtCeilingOne.resumeQueuedRuns();
    expect(await waitForExecutionsOf(seededRunIds, 1)).toBe(true);
    await settle();

    const statuses = await seededStatuses(seededRunIds);
    expect(statuses.running).toEqual([seeded[0]!.runId]);
    expect(statuses.queued).toHaveLength(2);
    expect(statuses.other).toHaveLength(0);
    expect(executionsOf(seededRunIds)).toEqual([seeded[0]!.runId]);
  }, 120_000);

  it("stays at the ceiling when overlapping sweeps run (idempotence, not the race proof)", async () => {
    const { seeded } = await seedCompanyWithQueuedRuns();
    const seededRunIds = seeded.map((s) => s.runId);

    // Two service instances (as routes and the scheduler construct) sweeping at
    // the same moment. Each would see two free slots without the fleet lock.
    await Promise.all([
      heartbeatAtCeilingTwo.resumeQueuedRuns(),
      heartbeatAtCeilingTwoB.resumeQueuedRuns(),
      heartbeatAtCeilingTwo.resumeQueuedRuns(),
    ]);
    expect(await waitForExecutionsOf(seededRunIds, 2)).toBe(true);
    await settle();

    const statuses = await seededStatuses(seededRunIds);
    expect(statuses.running).toHaveLength(2);
    expect(statuses.queued).toHaveLength(SEEDED_AGENT_COUNT - 2);
    expect(statuses.other).toHaveLength(0);
    expect(executionsOf(seededRunIds)).toHaveLength(2);
  }, 120_000);

  it("cannot exceed the ceiling when wakes for different agents admit concurrently", async () => {
    const companyId = await seedCompany();
    const targets: Array<{ agentId: string; issueId: string }> = [];
    for (let index = 0; index < SEEDED_AGENT_COUNT; index += 1) {
      const agentId = await seedAgent(companyId, index);
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: `Concurrent wake ${index}`,
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      });
      targets.push({ agentId, issueId });
    }

    // Every agent admits at the same moment: without the fleet lock each one
    // reads the same free fleet budget and claims it.
    const wakes = await Promise.all(
      targets.map(({ agentId, issueId }) =>
        heartbeatAtCeilingTwo.wakeup(agentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: { issueId },
          contextSnapshot: { issueId, wakeReason: "issue_assigned" },
          requestedByActorType: "system",
          requestedByActorId: "test",
        }),
      ),
    );
    expect(wakes.filter(Boolean)).toHaveLength(SEEDED_AGENT_COUNT);
    await settle();

    const runs = await listRuns(companyId);
    expect(runs.filter((run) => run.status === "running")).toHaveLength(2);
    expect(runs.filter((run) => run.status === "queued")).toHaveLength(SEEDED_AGENT_COUNT - 2);
    expect(runs.filter((run) => run.status !== "running" && run.status !== "queued")).toHaveLength(0);
    expect(startedRunIds.filter((id) => runs.some((run) => run.id === id))).toHaveLength(2);
  }, 120_000);

  it("re-admits an over-cap queued run once a slot frees", async () => {
    const { seeded } = await seedCompanyWithQueuedRuns();
    const seededRunIds = seeded.map((s) => s.runId);

    await heartbeatAtCeilingTwo.resumeQueuedRuns();
    expect(await waitForExecutionsOf(seededRunIds, 2)).toBe(true);

    // The oldest ticket finishes; its agent has no further queued work.
    const oldestRunId = seeded[0]!.runId;
    await releaseExecution(oldestRunId);
    expect(
      await waitForCondition(async () => {
        const [row] = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, oldestRunId));
        return row?.status === "succeeded";
      }, 30_000),
    ).toBe(true);

    // The periodic sweep hands the freed slot to the longest-waiting ticket.
    await heartbeatAtCeilingTwo.resumeQueuedRuns();
    expect(await waitForExecutionsOf(seededRunIds, 3)).toBe(true);
    await settle();

    const statuses = await seededStatuses(seededRunIds);
    expect(statuses.total).toBe(SEEDED_AGENT_COUNT);
    expect(statuses.running.sort()).toEqual([seeded[1]!.runId, seeded[2]!.runId].sort());
    expect(statuses.queued).toHaveLength(SEEDED_AGENT_COUNT - 3);
    expect(statuses.other.map((row) => [row.id, row.status])).toEqual([[oldestRunId, "succeeded"]]);
  }, 120_000);

  it("drains a burst larger than the ceiling with no lost ticket", async () => {
    const { seeded } = await seedCompanyWithQueuedRuns(4);
    const seededRunIds = seeded.map((s) => s.runId);

    blockExecutions = false;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await heartbeatAtCeilingTwo.resumeQueuedRuns();
      const statuses = await seededStatuses(seededRunIds);
      if (statuses.running.length === 0 && statuses.queued.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    const rows = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, seededRunIds));
    expect(rows.filter((row) => row.status !== "succeeded")).toEqual([]);
    expect(new Set(executionsOf(seededRunIds))).toEqual(new Set(seededRunIds));
  }, 120_000);

  describe("stale-run guard", () => {
    it("does not let a dead running row consume a slot", async () => {
      const { companyId, seeded } = await seedCompanyWithQueuedRuns(3);
      const seededRunIds = seeded.map((s) => s.runId);
      // Two dead rows would fill a ceiling of two if counted raw.
      await seedRunningRow({ companyId });
      await seedRunningRow({ companyId, processPid: deadPid() });

      await heartbeatAtCeilingTwo.resumeQueuedRuns();
      expect(await waitForExecutionsOf(seededRunIds, 2)).toBe(true);
      await settle();

      const statuses = await seededStatuses(seededRunIds);
      expect(statuses.running).toHaveLength(2);
      expect(statuses.queued).toHaveLength(1);
    }, 120_000);

    it("does not count a live-leased row whose recorded child is gone", async () => {
      const { companyId, seeded } = await seedCompanyWithQueuedRuns(3);
      const seededRunIds = seeded.map((s) => s.runId);
      await seedRunningRow({
        companyId,
        controllerLeaseExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
        processPid: deadPid(),
      });

      await heartbeatAtCeilingTwo.resumeQueuedRuns();
      expect(await waitForExecutionsOf(seededRunIds, 2)).toBe(true);
      await settle();

      expect((await seededStatuses(seededRunIds)).running).toHaveLength(2);
    }, 120_000);

    it("counts a silent row that still holds a live controller lease", async () => {
      const { companyId, seeded } = await seedCompanyWithQueuedRuns(3);
      const seededRunIds = seeded.map((s) => s.runId);
      await seedRunningRow({
        companyId,
        controllerLeaseExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
      });

      await heartbeatAtCeilingTwo.resumeQueuedRuns();
      expect(await waitForExecutionsOf(seededRunIds, 1)).toBe(true);
      await settle();

      const statuses = await seededStatuses(seededRunIds);
      expect(statuses.running).toHaveLength(1);
      expect(statuses.queued).toHaveLength(2);
    }, 120_000);

    it("counts a row with recent activity even without a controller", async () => {
      const { companyId, seeded } = await seedCompanyWithQueuedRuns(3);
      const seededRunIds = seeded.map((s) => s.runId);
      await seedRunningRow({ companyId, lastActivityAt: new Date() });

      await heartbeatAtCeilingTwo.resumeQueuedRuns();
      expect(await waitForExecutionsOf(seededRunIds, 1)).toBe(true);
      await settle();

      const statuses = await seededStatuses(seededRunIds);
      expect(statuses.running).toHaveLength(1);
      expect(statuses.queued).toHaveLength(2);
    }, 120_000);

    it("ignores stale rows entirely when no ceiling is configured", async () => {
      const { companyId, seeded } = await seedCompanyWithQueuedRuns(3);
      const seededRunIds = seeded.map((s) => s.runId);
      await seedRunningRow({ companyId, lastActivityAt: new Date() });

      await heartbeat.resumeQueuedRuns();
      expect(await waitForExecutionsOf(seededRunIds, 3)).toBe(true);
      expect((await seededStatuses(seededRunIds)).running).toHaveLength(3);
      // The pre-existing row is untouched by admission.
      const rows = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
        .where(sql`${heartbeatRuns.id} not in (${sql.join(seededRunIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
      expect(rows.map((row) => row.status)).toEqual(["running"]);
    }, 120_000);
  });
});
