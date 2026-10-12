import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as adapterServerUtils from "@paperclipai/adapter-utils/server-utils";
import {
  closeHttpListenerForShutdown,
  coordinateHeartbeatSchedulerShutdown,
  drainRunExecutionFinalizersForShutdown,
  finalizeServerShutdown,
  loadWithoutCoordinatedShutdownSignalHooks,
} from "./shutdown.js";
import * as shutdownModule from "./shutdown.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function stubLogger() {
  return { info: vi.fn(), error: vi.fn() };
}

/**
 * SPA-11948 R2. Fixture processes are tracked at module scope, not just inside
 * the test body. A vitest-level timeout kills a test WITHOUT unwinding its
 * `finally`, so body-only cleanup would leak a live detached child. The
 * `afterEach` sweep below is the backstop for that path.
 */
const shutdownFixturePids = new Set<number>();

function trackShutdownFixturePid(pid: number | null | undefined) {
  if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
    shutdownFixturePids.add(pid);
  }
}

function forceKillShutdownFixtures() {
  for (const pid of shutdownFixturePids) {
    // The fixture is spawned detached, so it leads its own process group: the
    // group kill is the one that matches how a refused run spawn is torn down.
    try {
      process.kill(-pid, "SIGKILL");
      continue;
    } catch {
      // Not a process group leader; fall through to the bare pid.
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already dead.
    }
  }
  shutdownFixturePids.clear();
}

function isPidAlive(pid: number | null | undefined) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isPidAlive(pid);
}

afterEach(() => {
  forceKillShutdownFixtures();
});

describe("finalizeServerShutdown", () => {
  it("awaits the setup-token cleanup before the database stop and the process exit", async () => {
    const order: string[] = [];
    // The held promise models the setup-token session cancellation and its
    // sandbox lease release. The teardown must not continue while it is pending.
    const release = deferred();
    const shutdownAppServices = vi.fn(async () => {
      order.push("appServices:start");
      await release.promise;
      order.push("appServices:settled");
    });
    const closeHttpListener = vi.fn(async () => {
      order.push("listener:close");
    });
    const closeDatabase = vi.fn(async () => {
      order.push("database:close");
    });
    const stopEmbeddedPostgres = vi.fn(async () => {
      order.push("postgres:stop");
    });
    const shutdownInstrumentation = vi.fn(async () => {
      order.push("instrumentation:flush");
    });
    const shutdownSentry = vi.fn(async () => {
      order.push("sentry:flush");
    });

    let exited = false;
    const finalize = finalizeServerShutdown({
      signal: "SIGTERM",
      shutdownAppServices,
      closeHttpListener,
      closeDatabase,
      stopEmbeddedPostgres,
      shutdownInstrumentation,
      shutdownSentry,
      log: stubLogger(),
    }).then(() => {
      // This models the caller's `process.exit(0)` continuation.
      exited = true;
      order.push("exit");
    });

    // The cleanup is in flight. The database stop, the instrumentation flush,
    // and the process exit continuation must all wait for it to settle.
    await vi.waitFor(() => expect(shutdownAppServices).toHaveBeenCalledOnce());
    // The listener already closed: requests are drained while every service
    // is still available, and nothing after this point can be reached.
    expect(closeHttpListener).toHaveBeenCalledOnce();
    expect(closeDatabase).not.toHaveBeenCalled();
    expect(stopEmbeddedPostgres).not.toHaveBeenCalled();
    expect(shutdownInstrumentation).not.toHaveBeenCalled();
    expect(exited).toBe(false);

    release.resolve();
    await finalize;

    expect(exited).toBe(true);
    expect(order).toEqual([
      "listener:close",
      "appServices:start",
      "appServices:settled",
      "database:close",
      "postgres:stop",
      "instrumentation:flush",
      "sentry:flush",
      "exit",
    ]);
  });

  it("keeps the teardown durable and still exits when the setup-token release fails", async () => {
    const order: string[] = [];
    // The held promise rejects, which models a lease release that failed. The
    // reaper owns the durable retry, so the teardown must log the failure and
    // continue rather than swallow it or block the exit.
    const release = deferred();
    const releaseError = new Error("lease release failed");
    const shutdownAppServices = vi.fn(async () => {
      await release.promise;
    });
    const stopEmbeddedPostgres = vi.fn(async () => {
      order.push("postgres:stop");
    });
    const shutdownInstrumentation = vi.fn(async () => {
      order.push("instrumentation:flush");
    });
    const shutdownSentry = vi.fn(async () => undefined);
    const log = stubLogger();

    let exited = false;
    const finalize = finalizeServerShutdown({
      signal: "SIGTERM",
      shutdownAppServices,
      stopEmbeddedPostgres,
      shutdownInstrumentation,
      shutdownSentry,
      log,
    }).then(() => {
      exited = true;
    });

    await vi.waitFor(() => expect(shutdownAppServices).toHaveBeenCalledOnce());
    expect(stopEmbeddedPostgres).not.toHaveBeenCalled();
    expect(exited).toBe(false);

    release.reject(releaseError);
    await finalize;

    // The teardown surfaced the failure in the log, then finished the ordered
    // teardown and reached the exit continuation.
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: releaseError, signal: "SIGTERM" }),
      expect.any(String),
    );
    expect(order).toEqual(["postgres:stop", "instrumentation:flush"]);
    expect(exited).toBe(true);
  });

  it("logs a failed database close and still stops the provider and exits", async () => {
    const order: string[] = [];
    const closeError = new Error("pool end timed out");
    const closeDatabase = vi.fn(async () => {
      order.push("database:close");
      throw closeError;
    });
    const stopEmbeddedPostgres = vi.fn(async () => {
      order.push("postgres:stop");
    });
    const log = stubLogger();

    await finalizeServerShutdown({
      signal: "SIGTERM",
      shutdownAppServices: vi.fn(async () => undefined),
      closeDatabase,
      stopEmbeddedPostgres,
      shutdownInstrumentation: vi.fn(async () => undefined),
      shutdownSentry: vi.fn(async () => undefined),
      log,
    });

    expect(order).toEqual(["database:close", "postgres:stop"]);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: closeError, signal: "SIGTERM" }),
      "Database client shutdown failed",
    );
  });

  it("waits for pending run-failure reports before the database stop and the Sentry flush", async () => {
    const order: string[] = [];
    const release = deferred();
    const drainPendingRunFailureReports = vi.fn(async () => {
      order.push("runFailureReports:start");
      await release.promise;
      order.push("runFailureReports:settled");
    });
    const closeDatabase = vi.fn(async () => {
      order.push("database:close");
    });
    const shutdownSentry = vi.fn(async () => {
      order.push("sentry:flush");
    });

    const finalize = finalizeServerShutdown({
      signal: "SIGTERM",
      shutdownAppServices: vi.fn(async () => undefined),
      drainPendingRunFailureReports,
      closeDatabase,
      stopEmbeddedPostgres: null,
      shutdownInstrumentation: vi.fn(async () => undefined),
      shutdownSentry,
      log: stubLogger(),
    });

    await vi.waitFor(() => expect(drainPendingRunFailureReports).toHaveBeenCalledOnce());
    expect(closeDatabase).not.toHaveBeenCalled();
    expect(shutdownSentry).not.toHaveBeenCalled();

    release.resolve();
    await finalize;

    expect(order).toEqual([
      "runFailureReports:start",
      "runFailureReports:settled",
      "database:close",
      "sentry:flush",
    ]);
  });

  it("logs a failed run-failure report drain and still stops the database and exits", async () => {
    const drainError = new Error("drain failed");
    const drainPendingRunFailureReports = vi.fn(async () => {
      throw drainError;
    });
    const closeDatabase = vi.fn(async () => undefined);
    const log = stubLogger();

    await finalizeServerShutdown({
      signal: "SIGTERM",
      shutdownAppServices: vi.fn(async () => undefined),
      drainPendingRunFailureReports,
      closeDatabase,
      stopEmbeddedPostgres: null,
      shutdownInstrumentation: vi.fn(async () => undefined),
      shutdownSentry: vi.fn(async () => undefined),
      log,
    });

    expect(closeDatabase).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: drainError, signal: "SIGTERM" }),
      "run-failure report drain failed",
    );
  });

  it("skips the database stop when no embedded PostgreSQL runs in this process", async () => {
    const shutdownAppServices = vi.fn(async () => undefined);
    const shutdownInstrumentation = vi.fn(async () => undefined);
    const shutdownSentry = vi.fn(async () => undefined);
    const log = stubLogger();

    await finalizeServerShutdown({
      signal: "SIGINT",
      shutdownAppServices,
      stopEmbeddedPostgres: null,
      shutdownInstrumentation,
      shutdownSentry,
      log,
    });

    expect(shutdownAppServices).toHaveBeenCalledOnce();
    expect(shutdownInstrumentation).toHaveBeenCalledOnce();
    expect(log.info).not.toHaveBeenCalled();
  });
});

describe("closeHttpListenerForShutdown", () => {
  function fakeServer(input: { listening: boolean; closeDelayMs?: number | null }) {
    const closeIdleConnections = vi.fn();
    const closeAllConnections = vi.fn();
    const close = vi.fn((callback?: (err?: Error) => void) => {
      if (input.closeDelayMs === null) return;
      setTimeout(() => callback?.(), input.closeDelayMs ?? 0);
    });
    return { listening: input.listening, close, closeIdleConnections, closeAllConnections };
  }

  it("stops accepting, closes idle keep-alive sockets, and resolves once the listener closed", async () => {
    const server = fakeServer({ listening: true, closeDelayMs: 0 });
    await expect(
      closeHttpListenerForShutdown({ server, signal: "SIGTERM", timeoutMs: 1_000, log: stubLogger() }),
    ).resolves.toBe("closed");
    expect(server.close).toHaveBeenCalledOnce();
    expect(server.closeIdleConnections).toHaveBeenCalledOnce();
    expect(server.closeAllConnections).not.toHaveBeenCalled();
  });

  it("closes the remaining connections when the drain outlives the grace period", async () => {
    vi.useFakeTimers();
    try {
      const server = fakeServer({ listening: true, closeDelayMs: null });
      const log = stubLogger();
      const pending = closeHttpListenerForShutdown({ server, signal: "SIGINT", timeoutMs: 250, log });
      await vi.advanceTimersByTimeAsync(250);
      await expect(pending).resolves.toBe("timed_out");
      expect(server.closeAllConnections).toHaveBeenCalledOnce();
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: 250 }),
        expect.stringContaining("timed out"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing when the listener was never bound", async () => {
    const server = fakeServer({ listening: false });
    await expect(
      closeHttpListenerForShutdown({ server, signal: "SIGTERM", log: stubLogger() }),
    ).resolves.toBe("not_listening");
    expect(server.close).not.toHaveBeenCalled();
  });
});

describe("drainRunExecutionFinalizersForShutdown", () => {
  it("awaits bounded execution finalizers", async () => {
    const release = deferred();
    const drain = vi.fn(() => release.promise);
    const pending = drainRunExecutionFinalizersForShutdown({
      signal: "SIGTERM",
      drain,
      timeoutMs: 1_000,
      log: stubLogger(),
    });
    await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce());
    release.resolve();
    await expect(pending).resolves.toBe("drained");
  });

  it("returns after the bounded timeout when an adopted run remains active", async () => {
    vi.useFakeTimers();
    try {
      const log = stubLogger();
      const pending = drainRunExecutionFinalizersForShutdown({
        signal: "SIGINT",
        drain: () => new Promise<void>(() => undefined),
        timeoutMs: 250,
        log,
      });
      await vi.advanceTimersByTimeAsync(250);
      await expect(pending).resolves.toBe("timed_out");
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: 250 }),
        expect.stringContaining("timed out"),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("loadWithoutCoordinatedShutdownSignalHooks", () => {
  it("removes the eager signal handlers from the real embedded-postgres import", async () => {
    const before = {
      SIGINT: process.rawListeners("SIGINT"),
      SIGTERM: process.rawListeners("SIGTERM"),
    };
    const moduleName = "embedded-postgres";

    await loadWithoutCoordinatedShutdownSignalHooks(() => import(moduleName));

    expect(process.rawListeners("SIGINT")).toEqual(before.SIGINT);
    expect(process.rawListeners("SIGTERM")).toEqual(before.SIGTERM);
  });

  it("keeps the database available for a marker-backed SIGTERM snapshot", async () => {
    const signalTarget = new EventEmitter();
    const preexistingSignalListener = vi.fn();
    signalTarget.on("SIGTERM", preexistingSignalListener);

    let databaseAvailable = true;
    const embeddedPostgresExitHook = vi.fn(() => {
      databaseAvailable = false;
    });
    await loadWithoutCoordinatedShutdownSignalHooks(
      async () => {
        signalTarget.on("SIGINT", embeddedPostgresExitHook);
        signalTarget.on("SIGTERM", embeddedPostgresExitHook);
        return { default: class EmbeddedPostgres {} };
      },
      signalTarget,
    );

    let shutdown: Promise<unknown> | null = null;
    let snapshotCaptured = false;
    signalTarget.once("SIGTERM", () => {
      shutdown = coordinateHeartbeatSchedulerShutdown({
        signal: "SIGTERM",
        prepareHotRestartShutdown: async () => {
          // This models the real failure path: a valid intent exists, and the
          // snapshot must query embedded PostgreSQL after SIGTERM is delivered.
          expect(databaseAvailable).toBe(true);
          snapshotCaptured = true;
          return { mode: "hot_restart" as const, skipDrain: true };
        },
        waitForHeartbeatSchedulerIdle: vi.fn(async () => undefined),
      });
    });

    signalTarget.emit("SIGTERM");
    await shutdown;

    expect(preexistingSignalListener).toHaveBeenCalledOnce();
    expect(embeddedPostgresExitHook).not.toHaveBeenCalled();
    expect(snapshotCaptured).toBe(true);
  });
});

describe("coordinateHeartbeatSchedulerShutdown", () => {
  it("quiesces active scheduler work before capturing a hot-restart snapshot", async () => {
    let snapshotCaptured = false;
    let releaseScheduler!: () => void;
    const schedulerIdle = new Promise<void>((resolve) => {
      releaseScheduler = resolve;
    });
    const waitForHeartbeatSchedulerIdle = vi.fn(() => schedulerIdle);

    const shutdown = coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown: vi.fn(async () => {
        snapshotCaptured = true;
        return { mode: "prepared" as const, skipDrain: true };
      }),
      waitForHeartbeatSchedulerIdle,
    });

    await vi.waitFor(() => expect(waitForHeartbeatSchedulerIdle).toHaveBeenCalledOnce());
    expect(snapshotCaptured).toBe(false);
    releaseScheduler();

    const result = await shutdown;
    expect(snapshotCaptured).toBe(true);
    expect(result).toEqual({
      hotRestart: { mode: "prepared", skipDrain: true },
      preparationError: null,
      waitedForSchedulerIdle: true,
    });
  });

  it("quiesces scheduler work before selecting server-stdio runs to drain", async () => {
    const waitForHeartbeatSchedulerIdle = vi.fn(async () => undefined);

    const result = await coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown: vi.fn(async () => ({
        mode: "acp_drain_required" as const,
        skipDrain: false,
        drainRunIds: ["acp-run"],
      })),
      waitForHeartbeatSchedulerIdle,
    });

    expect(waitForHeartbeatSchedulerIdle).toHaveBeenCalledOnce();
    expect(result).toEqual({
      hotRestart: {
        mode: "acp_drain_required",
        skipDrain: false,
        drainRunIds: ["acp-run"],
      },
      preparationError: null,
      waitedForSchedulerIdle: true,
    });
  });

  it("preserves the scheduler idle wait for normal graceful shutdown", async () => {
    let releaseScheduler!: () => void;
    const schedulerIdle = new Promise<void>((resolve) => {
      releaseScheduler = resolve;
    });
    const waitForHeartbeatSchedulerIdle = vi.fn(() => schedulerIdle);
    let settled = false;

    const shutdown = coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown: vi.fn(async () => ({
        mode: "not_requested" as const,
        skipDrain: false,
      })),
      waitForHeartbeatSchedulerIdle,
    }).finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(waitForHeartbeatSchedulerIdle).toHaveBeenCalledOnce());
    expect(settled).toBe(false);

    releaseScheduler();

    await expect(shutdown).resolves.toEqual({
      hotRestart: { mode: "not_requested", skipDrain: false },
      preparationError: null,
      waitedForSchedulerIdle: true,
    });
  });

  it("waits for scheduler idle when hot-restart preparation is unavailable", async () => {
    const waitForHeartbeatSchedulerIdle = vi.fn(async () => undefined);

    const result = await coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown: null,
      waitForHeartbeatSchedulerIdle,
    });

    expect(waitForHeartbeatSchedulerIdle).toHaveBeenCalledOnce();
    expect(result).toEqual({
      hotRestart: null,
      preparationError: null,
      waitedForSchedulerIdle: true,
    });
  });

  it("falls back to the scheduler idle wait when hot-restart preparation fails", async () => {
    const preparationError = new Error("snapshot failed");
    const waitForHeartbeatSchedulerIdle = vi.fn(async () => undefined);

    const result = await coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown: vi.fn(async () => {
        throw preparationError;
      }),
      waitForHeartbeatSchedulerIdle,
    });

    expect(waitForHeartbeatSchedulerIdle).toHaveBeenCalledOnce();
    expect(result).toEqual({
      hotRestart: null,
      preparationError,
      waitedForSchedulerIdle: true,
    });
  });

  it.skipIf(process.platform === "win32")(
    "closes and drains spawn admission before the hot-restart snapshot without killing registered adoptable runs",
    async () => {
      const adapterApi = adapterServerUtils as unknown as Record<string, unknown>;
      const getFence = adapterApi.getSpawnAdmissionFence as
        | (() => SpawnAdmissionFence)
        | undefined;
      expect(typeof getFence, "missing_spawn_admission_api:getSpawnAdmissionFence").toBe(
        "function",
      );
      const fence = getFence!();
      fence.reopen();
      expect(fence.inFlight()).toBe(0);

      const adoptable = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { detached: true, stdio: "ignore" },
      );
      trackShutdownFixturePid(adoptable.pid);
      adoptable.unref();
      const order: string[] = [];
      const originalClose = fence.close;
      const originalDrain = fence.drain;
      fence.close = () => {
        order.push("admission_close");
        originalClose.call(fence);
      };
      fence.drain = async (options) => {
        order.push("admission_drain");
        return originalDrain.call(fence, options);
      };

      try {
        await vi.waitFor(() => expect(isPidAlive(adoptable.pid!)).toBe(true));
        const prepareHotRestartShutdown = vi.fn(async () => {
          order.push("snapshot");
          expect(fence.isClosed()).toBe(true);
          expect(fence.inFlight()).toBe(0);
          expect(isPidAlive(adoptable.pid!)).toBe(true);
          return { mode: "hot_restart" as const, skipDrain: true as const };
        });

        await expect(
          coordinateHeartbeatSchedulerShutdown({
            signal: "SIGTERM",
            prepareHotRestartShutdown,
            waitForHeartbeatSchedulerIdle: async () => {
              order.push("scheduler_idle");
            },
            spawnAdmissionFence: fence,
            log: stubLogger(),
          }),
        ).resolves.toEqual({
          hotRestart: { mode: "hot_restart", skipDrain: true },
          preparationError: null,
          waitedForSchedulerIdle: true,
        });

        expect(order).toEqual([
          "scheduler_idle",
          "admission_close",
          "admission_drain",
          "snapshot",
        ]);
        expect(fence.isClosed()).toBe(true);
        expect(isPidAlive(adoptable.pid!)).toBe(true);
      } finally {
        fence.close = originalClose;
        fence.drain = originalDrain;
        fence.reopen();
        forceKillShutdownFixtures();
      }
    },
    20_000,
  );

  it("refuses to take a hot-restart snapshot when spawn admission does not drain", async () => {
    let closed = false;
    const fence = {
      close: vi.fn(() => {
        closed = true;
      }),
      reopen: vi.fn(() => {
        closed = false;
      }),
      isClosed: () => closed,
      inFlight: () => 1,
      enterAdmission: () => ({
        admit: async () => undefined,
        settle: () => undefined,
      }),
      drain: vi.fn(async () => "timed_out" as const),
    } satisfies SpawnAdmissionFence;
    const prepareHotRestartShutdown = vi.fn(async () => ({
      mode: "hot_restart" as const,
      skipDrain: true as const,
    }));

    const result = await coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown,
      waitForHeartbeatSchedulerIdle: async () => undefined,
      spawnAdmissionFence: fence,
      spawnAdmissionDrainTimeoutMs: 5,
      log: stubLogger(),
    });

    expect(prepareHotRestartShutdown).not.toHaveBeenCalled();
    expect(result.hotRestart).toBeNull();
    expect(result.preparationError).toBeInstanceOf(Error);
    expect((result.preparationError as Error).message).toContain(
      "spawn_admission_drain_timed_out",
    );
    expect(fence.isClosed()).toBe(true);
  });
});

// SPA-11948 R2. The spawn-admission fence (`getSpawnAdmissionFence`) and the
// shutdown drain helper (`drainRunsForGracefulShutdown`) do not exist yet, so
// BOTH are read through `Record<string, unknown>` casts rather than named
// imports. A named import of a missing export is a module LINK error, which
// would take every unrelated case in this file down with it; the cast keeps
// this tests-only commit collecting and turns each gap into one precise
// assertion failure instead. `pnpm --filter @paperclipai/server typecheck` stays
// green for this file, so the RED below is attributable to behavior alone.
//
// The fence shape is NOT re-pinned here: it mirrors the sibling adapter test
// (`packages/adapter-utils/src/server-utils.test.ts`), which owns that
// contract. This file only consumes the process-global singleton the server
// itself imports through `@paperclipai/adapter-utils/server-utils`, so the
// fence it closes is the same object the production spawn path gates on.
type SpawnAdmissionMeta = {
  pid: number;
  processGroupId: number | null;
  resourceUnit: string | null;
};

type SpawnAdmissionTicket = {
  /** Post-spawn. Rejects `spawn_admission_closed` after signalling the tree. */
  admit(meta: SpawnAdmissionMeta): Promise<void>;
  /** End the attempt. Idempotent; required on both the admitted and refused paths. */
  settle(): void;
};

type SpawnAdmissionFence = {
  /** Take an admission lease. MUST be called BEFORE `spawn()`. */
  enterAdmission(): SpawnAdmissionTicket;
  close(): void;
  reopen(): void;
  isClosed(): boolean;
  inFlight(): number;
  drain(options?: { timeoutMs?: number }): Promise<unknown>;
};

type GetSpawnAdmissionFence = () => SpawnAdmissionFence;

/**
 * The shutdown ordering contract under test (R2, server side):
 *
 *   1. close spawn admission — nothing may reach the registry after this point;
 *   2. await the work already admitted or mid-spawn (the fence's own drain);
 *   3. drain the runs that ARE registered;
 *   4. drain execution finalizers.
 *
 * Step 2 is the half that is easy to lose: without it, a child whose `spawn()`
 * returned but whose registration has not runs is invisible to step 3, the
 * teardown reports "clean", and the child survives the restart as an orphan
 * still holding a concurrency cap slot.
 */
type DrainRunsForGracefulShutdown = (input: {
  signal: "SIGINT" | "SIGTERM";
  spawnAdmissionFence: SpawnAdmissionFence;
  drainRuns: () => Promise<void>;
  drainExecutionFinalizers: () => Promise<void>;
  timeoutMs?: number;
  log: { info(obj: object, msg: string): void; error(obj: object, msg: string): void };
}) => Promise<unknown>;

function readShutdownApis() {
  const adapterApi = adapterServerUtils as unknown as Record<string, unknown>;
  const shutdownApi = shutdownModule as unknown as Record<string, unknown>;

  expect(
    typeof adapterApi.getSpawnAdmissionFence,
    "missing_spawn_admission_api:getSpawnAdmissionFence",
  ).toBe("function");
  expect(
    typeof shutdownApi.drainRunsForGracefulShutdown,
    "missing_shutdown_api:drainRunsForGracefulShutdown",
  ).toBe("function");

  return {
    getSpawnAdmissionFence: adapterApi.getSpawnAdmissionFence as GetSpawnAdmissionFence,
    drainRunsForGracefulShutdown:
      shutdownApi.drainRunsForGracefulShutdown as DrainRunsForGracefulShutdown,
  };
}

describe("drainRunsForGracefulShutdown — spawn-admission ordering (SPA-11948)", () => {
  // A real detached child, not a mock: the refusal half of R2 claims a refused
  // spawn is KILLED rather than orphaned, and only a live process can prove it.
  // It leads its own process group, so `processGroupId` is its own pid.
  function spawnAdmissionFixture() {
    const fixture = spawn(
      process.execPath,
      [
        "-e",
        // Idle until released, then self-terminate: an independent bound on the
        // fixture's lifetime, so a leaked process cannot outlive the suite.
        "const t=setInterval(()=>{},1000);setTimeout(()=>{clearInterval(t);process.exit(0);},25000);",
      ],
      { detached: true, stdio: "ignore" },
    );
    trackShutdownFixturePid(fixture.pid);
    // The fixture must never keep the worker's event loop alive.
    fixture.unref();
    return fixture;
  }

  it.skipIf(process.platform === "win32")(
    "closes spawn admission before draining runs and refuses an admitted spawn that arrives afterwards",
    async () => {
      const { getSpawnAdmissionFence, drainRunsForGracefulShutdown } = readShutdownApis();
      const fence = getSpawnAdmissionFence();
      fence.reopen();

      // The fence is a process-global singleton, so a lease leaked by another
      // case would make every `inFlight()` reading below vacuous. Assert the
      // precondition rather than assuming it.
      expect(
        fence.inFlight(),
        "fence_must_start_with_no_outstanding_admission_leases",
      ).toBe(0);

      // Lease BEFORE the process exists — the production order, and the reason
      // a post-spawn barrier cannot make `inFlight()` read 0 by construction.
      const ticket = fence.enterAdmission();
      expect(
        fence.inFlight(),
        "admission_lease_must_count_before_the_spawn_happens",
      ).toBe(1);

      const fixture = spawnAdmissionFixture();

      const order: string[] = [];
      // Sampled, not asserted, from inside the drain: if the helper swallows a
      // thrown assertion, the sampled value still reports the ordering fact.
      let admissionClosedWhenRunsDrained: boolean | null = null;
      const drainRuns = vi.fn(async () => {
        order.push("run_drain");
        admissionClosedWhenRunsDrained = fence.isClosed();
      });
      const drainExecutionFinalizers = vi.fn(async () => {
        order.push("execution_finalizer_drain");
      });

      try {
        await vi.waitFor(() => expect(isPidAlive(fixture.pid!)).toBe(true));

        // Admission is OPEN here, so this one is registered rather than refused.
        let openAdmissionError: unknown;
        try {
          await ticket.admit({
            pid: fixture.pid!,
            processGroupId: fixture.pid!,
            resourceUnit: null,
          });
        } catch (error) {
          openAdmissionError = error;
        }
        expect(
          openAdmissionError,
          "admitted_spawn_was_refused_while_spawn_admission_was_open",
        ).toBeUndefined();

        ticket.settle();
        expect(
          fence.inFlight(),
          "settle_must_release_the_admission_lease",
        ).toBe(0);

        await drainRunsForGracefulShutdown({
          signal: "SIGTERM",
          spawnAdmissionFence: fence,
          drainRuns,
          drainExecutionFinalizers,
          timeoutMs: 5_000,
          log: stubLogger(),
        });

        expect(order, "run_drain_must_precede_execution_finalizer_drain").toEqual([
          "run_drain",
          "execution_finalizer_drain",
        ]);
        // The load-bearing ordering fact: nothing may reach the registry after
        // the drain starts, so admission closes FIRST.
        expect(
          admissionClosedWhenRunsDrained,
          "run_drain_started_before_spawn_admission_closed",
        ).toBe(true);
        expect(fence.isClosed()).toBe(true);
        // The fence's own drain waited for the lease to settle rather than
        // declaring victory because the gate happens to be closed.
        expect(
          fence.inFlight(),
          "fence_drain_ignored_an_outstanding_admission_lease",
        ).toBe(0);

        // A spawn that arrives after the gate closed is refused — and KILLED,
        // which is the half that matters: the caller's `spawn()` already
        // returned, so a refused-but-alive child is exactly the orphan that
        // holds a concurrency cap slot across the restart.
        const lateFixture = spawnAdmissionFixture();
        await vi.waitFor(() => expect(isPidAlive(lateFixture.pid!)).toBe(true));

        const lateTicket = fence.enterAdmission();
        expect(
          fence.inFlight(),
          "admission_lease_must_count_even_while_the_gate_is_closed",
        ).toBe(1);

        let refusal: unknown;
        try {
          await lateTicket.admit({
            pid: lateFixture.pid!,
            processGroupId: lateFixture.pid!,
            resourceUnit: null,
          });
        } catch (error) {
          refusal = error;
        }
        expect(
          refusal,
          "admitted_spawn_after_shutdown_was_admitted_instead_of_refused",
        ).toBeInstanceOf(Error);
        expect((refusal as Error).message).toContain("spawn_admission_closed");
        expect(
          await waitForPidExit(lateFixture.pid!, 5_000),
          "refused_admitted_spawn_survived_as_an_orphan",
        ).toBe(true);

        lateTicket.settle();
        expect(
          fence.inFlight(),
          "settled_lease_must_release_the_admission_counter",
        ).toBe(0);
      } finally {
        ticket.settle();
        forceKillShutdownFixtures();
        fence.reopen();
      }
    },
    20_000,
  );

  it("fails closed on an admission timeout before registered-run or finalizer drains", async () => {
    const timeoutFence = {
      close: vi.fn(),
      reopen: vi.fn(),
      drain: vi.fn(async () => "timed_out" as const),
    };
    const drainRuns = vi.fn(async () => undefined);
    const drainExecutionFinalizers = vi.fn(async () => undefined);

    await expect(
      readShutdownApis().drainRunsForGracefulShutdown({
        signal: "SIGTERM",
        spawnAdmissionFence: timeoutFence as unknown as SpawnAdmissionFence,
        drainRuns,
        drainExecutionFinalizers,
        timeoutMs: 5,
        log: stubLogger(),
      }),
    ).rejects.toThrow("spawn_admission_drain_timed_out");

    expect(drainRuns).not.toHaveBeenCalled();
    expect(drainExecutionFinalizers).not.toHaveBeenCalled();
  });

  it("still drains execution finalizers when the registered-run drain rejects", async () => {
    const runDrainError = new Error("registered run drain failed");
    const order: string[] = [];
    const drainedFence = {
      close: vi.fn(),
      reopen: vi.fn(),
      drain: vi.fn(async () => "drained" as const),
    };

    await expect(
      readShutdownApis().drainRunsForGracefulShutdown({
        signal: "SIGTERM",
        spawnAdmissionFence: drainedFence as unknown as SpawnAdmissionFence,
        drainRuns: async () => {
          order.push("run_drain");
          throw runDrainError;
        },
        drainExecutionFinalizers: async () => {
          order.push("execution_finalizer_drain");
        },
        log: stubLogger(),
      }),
    ).rejects.toBe(runDrainError);

    expect(order).toEqual(["run_drain", "execution_finalizer_drain"]);
  });

  it.skipIf(process.platform === "win32")(
    "holds the run and finalizer drains until admitted mid-spawn work has settled",
    async () => {
      const { drainRunsForGracefulShutdown } = readShutdownApis();

      // A stub fence, not the process-global one: the shutdown helper takes the
      // fence as a dependency (like every other seam in `shutdown.ts`), so a
      // stub is the honest way to hold step 2 of the contract open. The stub's
      // drain IS the wait for spawns already admitted or mid-spawn, which is why
      // parking it must stall both drains below.
      const fenceCalls: string[] = [];
      let admissionClosed = false;
      const atAdmissionDrain = deferred<{ timeoutMs: number | undefined }>();
      const releaseAdmissionDrain = deferred();
      const fence = {
        close() {
          admissionClosed = true;
          fenceCalls.push("admission_close");
        },
        reopen() {
          admissionClosed = false;
        },
        isClosed() {
          return admissionClosed;
        },
        inFlight() {
          // Never drains by itself: only `releaseAdmissionDrain` ends the wait.
          return 1;
        },
        // Present for shape honesty only — this test never spawns, so it never
        // takes a lease. The wait it does exercise is the fence's own drain.
        enterAdmission: () => ({
          admit: async () => undefined,
          settle: () => undefined,
        }),
        drain: async (options?: { timeoutMs?: number }) => {
          fenceCalls.push("admission_drain");
          atAdmissionDrain.resolve({ timeoutMs: options?.timeoutMs });
          await releaseAdmissionDrain.promise;
          return "drained";
        },
      } as unknown as SpawnAdmissionFence;

      const order: string[] = [];
      const drainRuns = vi.fn(async () => {
        order.push("run_drain");
      });
      const drainExecutionFinalizers = vi.fn(async () => {
        order.push("execution_finalizer_drain");
      });

      let settled = false;
      const shutdown = drainRunsForGracefulShutdown({
        signal: "SIGTERM",
        spawnAdmissionFence: fence,
        drainRuns,
        drainExecutionFinalizers,
        timeoutMs: 5_000,
        log: stubLogger(),
      }).finally(() => {
        settled = true;
      });

      try {
        await Promise.race([
          atAdmissionDrain.promise,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("shutdown_never_awaited_spawn_admission_drain")),
              5_000,
            ),
          ),
        ]);
        // Admission closes BEFORE the wait for admitted work, never after it.
        expect(
          fenceCalls,
          "spawn_admission_not_closed_before_admitted_work_was_awaited",
        ).toEqual(["admission_close", "admission_drain"]);
        expect(fence.isClosed()).toBe(true);

        const earlyOutcome = await Promise.race([
          shutdown.then(() => "settled" as const),
          new Promise<"still_open">((resolve) =>
            setTimeout(() => resolve("still_open"), 150),
          ),
        ]);
        expect(
          earlyOutcome,
          "shutdown_settled_while_a_spawn_was_still_in_flight",
        ).toBe("still_open");
        expect(settled).toBe(false);
        expect(
          order,
          "run_or_finalizer_drain_started_before_admitted_work_settled",
        ).toEqual([]);

        releaseAdmissionDrain.resolve();
        await shutdown;

        expect(order).toEqual(["run_drain", "execution_finalizer_drain"]);
      } finally {
        releaseAdmissionDrain.resolve();
        forceKillShutdownFixtures();
        // Bounded: a helper that never calls the fence's drain would otherwise
        // leave `shutdown` pending forever and hang the run on this await.
        await Promise.race([
          shutdown.catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, 2_000)),
        ]);
      }
    },
    20_000,
  );
});
