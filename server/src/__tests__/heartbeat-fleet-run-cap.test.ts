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
  instanceSettings,
  issueComments,
  issues,
  projects,
} from "@paperclipai/db";
import { instanceSettingsService } from "../services/instance-settings.ts";
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
  invalidateFleetMaxConcurrentRunsCache,
  isFleetRunningRowLive,
  normalizeFleetMaxConcurrentRuns,
  normalizeFleetRunLivenessWindowMs,
  resolveFleetMaxConcurrentRuns,
} from "../services/heartbeat.ts";
import {
  FLEET_ADMISSION_STALE_MS,
  deferFleetRunAdmission,
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

  it("resolves precedence: an explicit DB value wins over the env var", () => {
    expect(resolveFleetMaxConcurrentRuns({ dbValue: 5, envValue: "20" })).toEqual({
      value: 5,
      source: "db",
    });
    // An explicit DB null ("no ceiling") wins over a configured env var too.
    expect(resolveFleetMaxConcurrentRuns({ dbValue: null, envValue: "20" })).toEqual({
      value: null,
      source: "db",
    });
  });

  it("falls through to the env var when the DB value is absent (not configured)", () => {
    expect(resolveFleetMaxConcurrentRuns({ dbValue: undefined, envValue: "7" })).toEqual({
      value: 7,
      source: "env",
    });
    expect(resolveFleetMaxConcurrentRuns({ dbValue: undefined, envValue: undefined })).toEqual({
      value: null,
      source: "none",
    });
  });

  it("clamps a DB value to 1..50, same as the env var", () => {
    expect(resolveFleetMaxConcurrentRuns({ dbValue: 500, envValue: undefined })).toEqual({
      value: 50,
      source: "db",
    });
    expect(resolveFleetMaxConcurrentRuns({ dbValue: 0, envValue: undefined })).toEqual({
      value: 1,
      source: "db",
    });
    expect(resolveFleetMaxConcurrentRuns({ dbValue: 1.9, envValue: undefined })).toEqual({
      value: 1,
      source: "db",
    });
  });

  it("never silently reads a malformed DB value as no-ceiling; falls back to the env var", () => {
    for (const malformed of ["garbage", "NaN", "Infinity", true, {}, [], "  "]) {
      expect(resolveFleetMaxConcurrentRuns({ dbValue: malformed, envValue: "4" })).toEqual({
        value: 4,
        source: "env",
      });
      // ...and to "none" when no env var is set either -- still never "db".
      expect(resolveFleetMaxConcurrentRuns({ dbValue: malformed, envValue: undefined })).toEqual({
        value: null,
        source: "none",
      });
    }
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
    // Silent past the window with no live recorded child: never holds a slot.
    expect(isFleetRunningRowLive({ recentActivity: false, recordedChildAlive: false })).toBe(false);
    // Recent activity counts.
    expect(isFleetRunningRowLive({ recentActivity: true, recordedChildAlive: false })).toBe(true);
    // A live recorded child counts however long it has been silent.
    expect(isFleetRunningRowLive({ recentActivity: false, recordedChildAlive: true })).toBe(true);
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

  it("defers nested admissions to after the section instead of running them inline", async () => {
    const deferred = new Set<string>();
    const seenInside: string[] = [];
    expect(deferFleetRunAdmission("outside")).toBe(false);
    await withFleetRunAdmissionLock(
      async () => {
        expect(deferFleetRunAdmission("agent-a")).toBe(true);
        expect(deferFleetRunAdmission("agent-b")).toBe(true);
        expect(deferFleetRunAdmission("agent-a")).toBe(true);
        seenInside.push(...deferred);
      },
      { deferred },
    );
    // Collected (deduped) for the owner to drain once it releases its locks.
    expect([...deferred]).toEqual(["agent-a", "agent-b"]);
    expect(seenInside).toEqual(["agent-a", "agent-b"]);
    expect(deferred.has("outside")).toBe(false);
  });

  it("lets a waiter proceed once a hung holder passes the stale timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      // A holder whose awaited work never settles (e.g. a hung DB call).
      void withFleetRunAdmissionLock(() => new Promise<never>(() => {}));
      let proceeded = false;
      const waiter = withFleetRunAdmissionLock(async () => {
        proceeded = true;
        return "ran";
      });
      await vi.advanceTimersByTimeAsync(FLEET_ADMISSION_STALE_MS - 1_000);
      expect(proceeded).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(waiter).resolves.toBe("ran");
      expect(proceeded).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    // The lock is free again for later holders.
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
  // Assigned in the suite's beforeAll, after the DB handle exists, and reused by
  // the queued-priority block below. Never declared twice at any scope: a
  // duplicate `let` is a syntax error and a duplicate hoisted `function`
  // silently replaces the original for the whole suite.
  let runtimeEnvBaseFromSuite: Record<string, string | undefined> = {};

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-fleet-run-cap-");
    db = createDb(tempDb.connectionString);
    const runtimeEnv: Record<string, string | undefined> = {
      ...process.env,
      PAPERCLIP_IN_WORKTREE: "false",
    };
    delete runtimeEnv[FLEET_MAX_CONCURRENT_RUNS_ENV_VAR];
    delete runtimeEnv[FLEET_RUN_LIVENESS_WINDOW_ENV_VAR];
    runtimeEnvBaseFromSuite = runtimeEnv;
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
    // Drain every service in this file, including the ones the queued-priority
    // block builds, and only now: the drains await parked executions, so they
    // must run after the gate release above or they hang the suite.
    await drainAllServices();
    runningProcesses.clear();
    startedRunIds.length = 0;
    // Any test that set a DB fleet-cap override (or warmed the cache) must not
    // leak it into the next test, which assumes "no DB override, env only".
    invalidateFleetMaxConcurrentRunsCache();
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.delete(environmentLeases);
        await db.delete(issueComments);
        await db.delete(issues);
        await db.delete(projects);
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
        await db.delete(instanceSettings);
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

  // Every service instance this file constructs, drained as one. Services the
  // queued-priority block adds are pushed here from its own beforeAll, so a
  // parked execution can never outlive the test that started it.
  const allHeartbeatServices: Array<ReturnType<typeof heartbeatService>> = [];
  function registerHeartbeatService(
    service: ReturnType<typeof heartbeatService>,
  ): ReturnType<typeof heartbeatService> {
    allHeartbeatServices.push(service);
    return service;
  }
  async function drainAllServices() {
    for (const service of allHeartbeatServices) {
      await service.drainActiveRunExecutions();
    }
  }

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

  async function seedAgentWithQueuedRun(input: {
    companyId: string;
    index: number;
    createdAt: Date;
    issueStatus?: "todo" | "in_progress";
    priority?: string;
  }) {
    const agentId = await seedAgent(input.companyId, input.index);
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: `Fleet issue ${input.index}`,
      status: input.issueStatus ?? "in_progress",
      priority: input.priority ?? "medium",
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

  // SPA-10513 slice 2 fixtures. One agent per seeded ticket, so the cross-agent
  // sweep is the only thing that can decide which ticket reaches a freed slot.
  // Every helper is declared inside the new describe block, so these functions
  // must never be hoisted into the suite scope above: duplicate `function`
  // declarations in the same scope silently win by hoist order and would
  // replace the real `seedCompany` for every other test in this file.
  describe("queued priority admission", () => {
    // Default is priority-then-age; this is the documented revert to the
    // previous oldest-ticket-first sweep ordering, by env var alone.
    const FIFO_SWITCH = "PAPERCLIP_QUEUED_RUN_ORDER";

    async function seedArchivedCompany() {
      const companyId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip Archived",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        defaultResponsibleUserId: "responsible-user",
        requireBoardApprovalForNewAgents: false,
        status: "archived",
      });
      return companyId;
    }

    async function seedCrossAgentBacklog(input: {
      companyId: string;
      tickets: Array<{
        priority: string;
        ageMinutes: number;
        issueStatus?: "todo" | "in_progress";
      }>;
      indexOffset?: number;
    }) {
      const base = Date.now();
      const seeded = [];
      for (const [index, ticket] of input.tickets.entries()) {
        seeded.push(
          await seedAgentWithQueuedRun({
            companyId: input.companyId,
            index: (input.indexOffset ?? 0) + index,
            createdAt: new Date(base - ticket.ageMinutes * 60_000),
            issueStatus: ticket.issueStatus,
            priority: ticket.priority,
          }),
        );
      }
      return seeded;
    }

    const runtimeEnvBase = runtimeEnvBaseFromSuite;
    let priorityHeartbeat!: ReturnType<typeof heartbeatService>;
    let priorityHeartbeatFifo!: ReturnType<typeof heartbeatService>;
    let priorityHeartbeatCeilingOne!: ReturnType<typeof heartbeatService>;
    let priorityHeartbeatNoCeiling!: ReturnType<typeof heartbeatService>;
    let priorityHeartbeatNoCeilingFifo!: ReturnType<typeof heartbeatService>;

    beforeAll(() => {
      priorityHeartbeat = registerHeartbeatService(
        heartbeatService(db, {
          runtimeEnv: {
            ...runtimeEnvBase,
            [FLEET_MAX_CONCURRENT_RUNS_ENV_VAR]: "2",
          },
        }),
      );
      priorityHeartbeatFifo = registerHeartbeatService(
        heartbeatService(db, {
          runtimeEnv: {
            ...runtimeEnvBase,
            [FLEET_MAX_CONCURRENT_RUNS_ENV_VAR]: "2",
            [FIFO_SWITCH]: "fifo",
          },
        }),
      );
      priorityHeartbeatCeilingOne = registerHeartbeatService(
        heartbeatService(db, {
          runtimeEnv: {
            ...runtimeEnvBase,
            [FLEET_MAX_CONCURRENT_RUNS_ENV_VAR]: "1",
          },
        }),
      );
      priorityHeartbeatNoCeiling = registerHeartbeatService(
        heartbeatService(db, {
          runtimeEnv: { ...runtimeEnvBase },
        }),
      );
      priorityHeartbeatNoCeilingFifo = registerHeartbeatService(
        heartbeatService(db, {
          runtimeEnv: {
            ...runtimeEnvBase,
            [FIFO_SWITCH]: "fifo",
          },
        }),
      );
    });

    it("admits critical before high before medium before low across agents, then oldest first", async () => {
      const companyId = await seedCompany();
      // Deliberately anti-correlated with age: the only correct sweep admits
      // every critical card first, even though each is newer than every low one.
      const seeded = await seedCrossAgentBacklog({
        companyId,
        tickets: [
          { priority: "low", ageMinutes: 120 },
          { priority: "medium", ageMinutes: 90 },
          { priority: "high", ageMinutes: 60 },
          { priority: "critical", ageMinutes: 30 },
          { priority: "critical", ageMinutes: 45 },
          { priority: "low", ageMinutes: 150 },
        ],
      });
      const seededRunIds = seeded.map((s) => s.runId);

      await priorityHeartbeat.resumeQueuedRuns();
      expect(await waitForExecutionsOf(seededRunIds, 2)).toBe(true);
      await settle();

      expect(
        (await seededStatuses(seededRunIds)).running.sort(),
      ).toEqual([seeded[3]!.runId, seeded[4]!.runId].sort());
    }, 120_000);

    it("breaks a priority tie by the oldest queued ticket, never by insertion order", async () => {
      const companyId = await seedCompany();
      const seeded = await seedCrossAgentBacklog({
        companyId,
        tickets: [
          { priority: "high", ageMinutes: 45 },
          { priority: "high", ageMinutes: 5 },
          { priority: "low", ageMinutes: 300 },
        ],
      });
      const seededRunIds = seeded.map((s) => s.runId);

      await priorityHeartbeatCeilingOne.resumeQueuedRuns();
      expect(await waitForExecutionsOf(seededRunIds, 1)).toBe(true);
      await settle();

      const statuses = await seededStatuses(seededRunIds);
      expect(statuses.running).toEqual([seeded[0]!.runId]);
      expect(statuses.queued.sort()).toEqual([seeded[1]!.runId, seeded[2]!.runId].sort());
    }, 120_000);

    it("admits a newer critical ahead of older high, medium and low tickets", async () => {
      const companyId = await seedCompany();
      const seeded = await seedCrossAgentBacklog({
        companyId,
        tickets: [
          { priority: "low", ageMinutes: 240 },
          { priority: "medium", ageMinutes: 180 },
          { priority: "high", ageMinutes: 120 },
          { priority: "critical", ageMinutes: 1 },
        ],
      });
      const seededRunIds = seeded.map((s) => s.runId);

      await priorityHeartbeatCeilingOne.resumeQueuedRuns();
      expect(await waitForExecutionsOf(seededRunIds, 1)).toBe(true);
      await settle();

      expect((await seededStatuses(seededRunIds)).running).toEqual([
        seeded[3]!.runId,
      ]);
    }, 120_000);

    it("routes a freed slot to the highest-priority pending card", async () => {
      const companyId = await seedCompany();
      // The oldest critical ticket takes the first slot; its completion
      // admits the remaining queued ticket.
      const seeded = await seedCrossAgentBacklog({
        companyId,
        tickets: [
          { priority: "critical", ageMinutes: 240 },
          { priority: "low", ageMinutes: 200 },
          { priority: "low", ageMinutes: 160 },
        ],
      });
      const seededRunIds = seeded.map((s) => s.runId);

      await priorityHeartbeat.resumeQueuedRuns();
      expect(await waitForExecutionsOf(seededRunIds, 2)).toBe(true);
      await settle();
      expect(
        (await seededStatuses(seededRunIds)).running.sort(),
      ).toEqual([seeded[0]!.runId, seeded[1]!.runId].sort());

      await releaseExecution(seeded[0]!.runId);
      expect(
        await waitForCondition(async () => {
          const [row] = await db
            .select({ status: heartbeatRuns.status })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, seeded[0]!.runId));
          return row?.status === "succeeded";
        }, 30_000),
      ).toBe(true);

      await priorityHeartbeat.resumeQueuedRuns();
      expect(await waitForExecutionsOf(seededRunIds, 3)).toBe(true);
      await settle();

      expect(executionsOf([seeded[2]!.runId])).toEqual([seeded[2]!.runId]);
      const statuses = await seededStatuses(seededRunIds);
      expect(statuses.running.sort()).toEqual(
        [seeded[1]!.runId, seeded[2]!.runId].sort(),
      );
      expect(statuses.queued).toEqual([]);
      expect(statuses.other.map((row) => [row.id, row.status])).toEqual([
        [seeded[0]!.runId, "succeeded"],
      ]);
    }, 120_000);

    it("keeps per-agent continuation readiness ahead of a newer critical card", async () => {
      const companyId = await seedCompany();
      // A continuing card keeps precedence over a newer critical card on the
      // same agent; the other agent's critical ticket wins the first fleet slot.
      const continuingAgentId = await seedAgent(companyId, 0);
      const continuingIssueId = randomUUID();
      const continuingRunId = randomUUID();
      const continuingWakeupId = randomUUID();
      await db.insert(issues).values({
        id: continuingIssueId,
        companyId,
        title: "Continuing medium card",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: continuingAgentId,
        responsibleUserId: "responsible-user",
      });
      await db.insert(agentWakeupRequests).values({
        id: continuingWakeupId,
        companyId,
        agentId: continuingAgentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: continuingIssueId },
        status: "queued",
      });
      await db.insert(heartbeatRuns).values({
        id: continuingRunId,
        companyId,
        agentId: continuingAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: continuingWakeupId,
        contextSnapshot: { issueId: continuingIssueId, wakeReason: "issue_assigned" },
        createdAt: new Date(Date.now() - 30 * 60_000),
        updatedAt: new Date(Date.now() - 30 * 60_000),
      });
      await db
        .update(agentWakeupRequests)
        .set({ runId: continuingRunId })
        .where(eq(agentWakeupRequests.id, continuingWakeupId));
      const critical = await seedCrossAgentBacklog({
        companyId,
        tickets: [{ priority: "critical", ageMinutes: 1 }],
        indexOffset: 7,
      });

      await priorityHeartbeatCeilingOne.resumeQueuedRuns();
      expect(await waitForExecutionsOf(critical.map((c) => c.runId), 1)).toBe(true);
      await settle();

      expect((await seededStatuses([continuingRunId])).queued).toEqual([
        continuingRunId,
      ]);
      expect((await seededStatuses(critical.map((c) => c.runId))).running).toEqual([critical[0]!.runId]);
    }, 120_000);

    it("does not let a company's priority ticket take a slot ahead of an older ticket elsewhere", async () => {
      const companyA = await seedCompany();
      const companyB = await seedCompany();
      const inCompanyA = await seedCrossAgentBacklog({
        companyId: companyA,
        tickets: [
          { priority: "critical", ageMinutes: 1 },
          { priority: "low", ageMinutes: 10 },
        ],
      });
      const inCompanyB = await seedCrossAgentBacklog({
        companyId: companyB,
        tickets: [
          { priority: "low", ageMinutes: 60 },
          { priority: "low", ageMinutes: 30 },
        ],
        indexOffset: 20,
      });

      await priorityHeartbeatCeilingOne.resumeQueuedRuns();
      expect(await waitForExecutionsOf([inCompanyA[0]!.runId], 1)).toBe(true);
      await settle();

      expect((await seededStatuses([inCompanyA[0]!.runId])).running).toEqual([
        inCompanyA[0]!.runId,
      ]);
      expect(
        (await seededStatuses(inCompanyB.map((s) => s.runId))).running,
      ).toEqual([]);
    }, 120_000);

    it("never admits a ticket whose company is not active", async () => {
      const archivedCompanyId = await seedArchivedCompany();
      const activeCompanyId = await seedCompany();
      const archived = await seedCrossAgentBacklog({
        companyId: archivedCompanyId,
        tickets: [{ priority: "critical", ageMinutes: 1 }],
        indexOffset: 30,
      });
      const active = await seedCrossAgentBacklog({
        companyId: activeCompanyId,
        tickets: [{ priority: "low", ageMinutes: 120 }],
        indexOffset: 40,
      });

      await priorityHeartbeatCeilingOne.resumeQueuedRuns();
      expect(
        await waitForExecutionsOf(active.map((s) => s.runId), 1),
      ).toBe(true);
      await settle();

      expect(
        (await seededStatuses(archived.map((s) => s.runId))).queued,
      ).toEqual(archived.map((s) => s.runId).sort());
    }, 120_000);

    it("reverts to oldest-ticket-first ordering through the revert env var", async () => {
      const companyId = await seedCompany();
      const seeded = await seedCrossAgentBacklog({
        companyId,
        tickets: [
          { priority: "low", ageMinutes: 240 },
          { priority: "medium", ageMinutes: 180 },
          { priority: "high", ageMinutes: 120 },
          { priority: "critical", ageMinutes: 1 },
        ],
      });
      const seededRunIds = seeded.map((s) => s.runId);

      await priorityHeartbeatFifo.resumeQueuedRuns();
      expect(await waitForExecutionsOf(seededRunIds, 2)).toBe(true);
      await settle();

      expect((await seededStatuses(seededRunIds)).running.sort()).toEqual([
        seeded[0]!.runId,
        seeded[1]!.runId,
      ].sort());
    }, 120_000);

    it("claims every slot it can when no ceiling is configured, under both orderings", async () => {
      const tickets = [
        { priority: "low", ageMinutes: 240 },
        { priority: "critical", ageMinutes: 180 },
        { priority: "medium", ageMinutes: 120 },
        { priority: "high", ageMinutes: 60 },
      ];

      const priorityCompanyId = await seedCompany();
      const underPriority = await seedCrossAgentBacklog({
        companyId: priorityCompanyId,
        tickets,
        indexOffset: 50,
      });
      const underPriorityRunIds = underPriority.map((s) => s.runId);
      await priorityHeartbeatNoCeiling.resumeQueuedRuns();
      expect(await waitForExecutionsOf(underPriorityRunIds, 4)).toBe(true);
      await settle();
      expect((await seededStatuses(underPriorityRunIds)).running).toHaveLength(4);

      const fifoCompanyId = await seedCompany();
      const underFifo = await seedCrossAgentBacklog({
        companyId: fifoCompanyId,
        tickets,
        indexOffset: 60,
      });
      const underFifoRunIds = underFifo.map((s) => s.runId);
      await priorityHeartbeatNoCeilingFifo.resumeQueuedRuns();
      expect(await waitForExecutionsOf(underFifoRunIds, 4)).toBe(true);
      await settle();
      expect((await seededStatuses(underFifoRunIds)).running).toHaveLength(4);
    }, 120_000);
  });

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

  it("SPA-10069 starts a cap-deferred review-stage wake without a comment or monitor after capacity clears", async () => {
    const companyId = await seedCompany();
    const holder = await seedAgentWithQueuedRun({ companyId, index: 0, createdAt: new Date(Date.now() - 60_000) });
    const reviewerId = await seedAgent(companyId, 1);
    const issueId = randomUUID();
    const stageId = randomUUID();
    await db.insert(issues).values({
      id: issueId, companyId, title: "Cap-deferred review", status: "in_review", priority: "medium",
      assigneeAgentId: reviewerId, responsibleUserId: "responsible-user",
      executionState: {
        status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review",
        stageEnteredAt: new Date(Date.now() - 20 * 60_000).toISOString(),
        currentParticipant: { type: "agent", agentId: reviewerId, userId: null },
        returnAssignee: { type: "agent", agentId: holder.agentId, userId: null },
        reviewRequest: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
      },
    });
    await heartbeatAtCeilingOne.resumeQueuedRuns();
    expect(await waitForExecutionsOf([holder.runId], 1)).toBe(true);
    const reviewRun = await heartbeatAtCeilingOne.wakeup(reviewerId, {
      source: "assignment", reason: "execution_review_requested", payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "execution_review_requested" },
      requestedByActorType: "system", requestedByActorId: "test",
    });
    expect(reviewRun?.status).toBe("queued");
    expect((await heartbeatAtCeilingOne.reconcileStrandedAssignedIssues()).reviewParticipantRequeued).toBe(0);
    expect(executionsOf([reviewRun!.id])).toHaveLength(0);
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, holder.issueId));
    await releaseExecution(holder.runId);
    expect(await waitForCondition(async () => (await heartbeat.getRun(holder.runId))?.status === "succeeded", 30_000)).toBe(true);
    await heartbeatAtCeilingOne.reconcileStrandedAssignedIssues();
    await heartbeatAtCeilingOne.resumeQueuedRuns();
    expect(await waitForExecutionsOf([reviewRun!.id], 1)).toBe(true);
    expect((await heartbeat.getRun(reviewRun!.id))?.status).toBe("running");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).toHaveLength(0);
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]?.monitorNextCheckAt).toBeNull();
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

  describe("SPA-10137: live DB-backed fleet cap", () => {
    // Uses `heartbeat` (no env ceiling configured) throughout, so the DB value
    // is the sole source of truth and these tests cannot cross-talk with the
    // env-ceiling fixtures (heartbeatAtCeilingOne/Two/TwoB) above.
    async function setDbFleetCap(value: number | null) {
      await instanceSettingsService(db).updateGeneral({ fleetMaxConcurrentRuns: value });
    }

    it("reads the DB override through heartbeatService and caches it until invalidated", async () => {
      expect(await heartbeat.getFleetMaxConcurrentRunsStatus()).toEqual({
        value: null,
        source: "none",
      });

      await setDbFleetCap(3);
      // Cache was never warmed yet in this test, but it may be warm from
      // another `heartbeat.getFleetMaxConcurrentRunsStatus()` call elsewhere
      // in this run; invalidate first so this read is guaranteed fresh.
      invalidateFleetMaxConcurrentRunsCache();
      expect(await heartbeat.getFleetMaxConcurrentRunsStatus()).toEqual({
        value: 3,
        source: "db",
      });

      // Write a new value WITHOUT invalidating: the cached read must still
      // return the stale value until something invalidates it.
      await setDbFleetCap(10);
      expect(await heartbeat.getFleetMaxConcurrentRunsStatus()).toEqual({
        value: 3,
        source: "db",
      });

      invalidateFleetMaxConcurrentRunsCache();
      expect(await heartbeat.getFleetMaxConcurrentRunsStatus()).toEqual({
        value: 10,
        source: "db",
      });
    });

    it("raises the cap live and starts queued runs within one admission pass, no restart", async () => {
      await setDbFleetCap(2);
      invalidateFleetMaxConcurrentRunsCache();

      const { seeded } = await seedCompanyWithQueuedRuns(4);
      const seededRunIds = seeded.map((s) => s.runId);

      await heartbeat.resumeQueuedRuns();
      expect(await waitForExecutionsOf(seededRunIds, 2)).toBe(true);
      await settle();
      expect((await seededStatuses(seededRunIds)).running).toHaveLength(2);

      // Raise the cap live, on the SAME heartbeatService instance (no
      // restart) -- exactly what the instance-settings route does on a PATCH
      // that raises the value -- then trigger one admission pass.
      await setDbFleetCap(4);
      invalidateFleetMaxConcurrentRunsCache();
      expect(await heartbeat.getFleetMaxConcurrentRunsStatus()).toEqual({
        value: 4,
        source: "db",
      });
      await heartbeat.resumeQueuedRuns();
      expect(await waitForExecutionsOf(seededRunIds, 4)).toBe(true);
      await settle();

      const statuses = await seededStatuses(seededRunIds);
      expect(statuses.running).toHaveLength(4);
      expect(statuses.queued).toHaveLength(0);
      expect(statuses.other).toHaveLength(0);
    }, 120_000);

    it("lowers the cap live without killing any already-running run", async () => {
      await setDbFleetCap(4);
      invalidateFleetMaxConcurrentRunsCache();

      const { seeded } = await seedCompanyWithQueuedRuns(6);
      const seededRunIds = seeded.map((s) => s.runId);

      await heartbeat.resumeQueuedRuns();
      expect(await waitForExecutionsOf(seededRunIds, 4)).toBe(true);
      await settle();
      const before = await seededStatuses(seededRunIds);
      expect(before.running).toHaveLength(4);
      expect(before.queued).toHaveLength(2);

      // Lower the cap below the current running count, then sweep again.
      await setDbFleetCap(1);
      invalidateFleetMaxConcurrentRunsCache();
      await heartbeat.resumeQueuedRuns();
      await settle();

      // Every run that was already running stays running (none cancelled,
      // none force-stopped); admission simply withholds the excess.
      const after = await seededStatuses(seededRunIds);
      expect(after.running.sort()).toEqual(before.running.sort());
      expect(after.queued).toHaveLength(2);
      expect(after.other).toHaveLength(0);
    }, 120_000);

    it("falls back to the env var when the DB value is unparseable (never silently no-ceiling)", async () => {
      // Write a well-formed row, then corrupt just this key directly (bypasses
      // API validation, simulating a manual DB edit / bad restore).
      await setDbFleetCap(2);
      await db
        .update(instanceSettings)
        .set({ general: sql`jsonb_set(${instanceSettings.general}, '{fleetMaxConcurrentRuns}', '"garbage"')` });
      invalidateFleetMaxConcurrentRunsCache();

      expect(await heartbeatAtCeilingTwo.getFleetMaxConcurrentRunsStatus()).toEqual({
        value: 2,
        source: "env",
      });
    });
  });

  it("defers a claim's nested re-admission instead of stalling the fleet lock on it", async () => {
    // Agent A's two queued runs are budget-blocked (their project is paused for
    // budget), so each claim cancels the run, and the cancel re-admits agent A.
    // Run inline under the fleet lock, that re-admit waited the full 30s agent
    // start-lock timeout on A's own lock, per cancelled run, and every other
    // agent's admission queued behind it. Deferred, B is admitted at once.
    const companyId = await seedCompany();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Paused for budget",
      pausedAt: new Date(),
      pauseReason: "budget",
    });
    const agentA = await seedAgent(companyId, 0);
    const base = Date.now() - 10 * 60_000;
    const blockedRunIds: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId: agentA,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        contextSnapshot: { projectId, wakeReason: "issue_assigned" },
        createdAt: new Date(base + index * 1_000),
        updatedAt: new Date(base + index * 1_000),
      });
      blockedRunIds.push(runId);
    }
    const agentB = await seedAgentWithQueuedRun({
      companyId,
      index: 1,
      createdAt: new Date(base + 60_000),
    });

    const startedAt = Date.now();
    await heartbeatAtCeilingTwo.resumeQueuedRuns();
    expect(await waitForExecutionsOf([agentB.runId], 1, 20_000)).toBe(true);
    const elapsedMs = Date.now() - startedAt;
    // Well under one 30s agent start-lock timeout.
    expect(elapsedMs).toBeLessThan(20_000);
    await settle();

    const rows = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId));
    const statusOf = new Map(rows.map((row) => [row.id, row.status]));
    expect(statusOf.get(agentB.runId)).toBe("running");
    // The budget cancels are existing budget behaviour, not the ceiling.
    expect(blockedRunIds.map((id) => statusOf.get(id))).toEqual(["cancelled", "cancelled"]);
    expect(rows.filter((row) => row.status === "running")).toHaveLength(1);
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

    it("does not count a silent pid-less row on controller ownership alone (hung pre-launch shape)", async () => {
      const { companyId, seeded } = await seedCompanyWithQueuedRuns(3);
      const seededRunIds = seeded.map((s) => s.runId);
      // Started two hours ago, never recorded a child, but the controller is
      // still tracking it in-process and renewing its lease: a run hung in
      // workspace preparation. It must not hold a slot forever.
      const hungRunId = await seedRunningRow({
        companyId,
        controllerLeaseExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
      });
      runningProcesses.set(hungRunId, {
        child: {} as never,
        graceSec: 1,
        processGroupId: null,
      });

      await heartbeatAtCeilingTwo.resumeQueuedRuns();
      expect(await waitForExecutionsOf(seededRunIds, 2)).toBe(true);
      await settle();

      const statuses = await seededStatuses(seededRunIds);
      expect(statuses.running).toHaveLength(2);
      expect(statuses.queued).toHaveLength(1);
    }, 120_000);

    it("counts a silent row whose recorded child process is still alive", async () => {
      const { companyId, seeded } = await seedCompanyWithQueuedRuns(3);
      const seededRunIds = seeded.map((s) => s.runId);
      // Silent for two hours and no controller lease, but the recorded pid is
      // alive (this test process stands in for a detached adapter child).
      await seedRunningRow({ companyId, processPid: process.pid });

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
