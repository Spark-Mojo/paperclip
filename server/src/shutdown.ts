type HotRestartShutdownPreparation = {
  skipDrain: boolean;
};

type ShutdownLogger = {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
};

type SpawnAdmissionFence = {
  close(): void;
  drain(options: { timeoutMs: number }): Promise<unknown>;
};

/**
 * SPA-11948. Close process admission and drain the pre-spawn window before the
 * registered-run and execution-finalizer drains. No lock is held while either
 * downstream drain performs database I/O; the fence is only a bounded counter.
 *
 * The fence drains BOTH directions: an unsettled admission lease at the time
 * this helper runs is a real mid-spawn child that the registered-run drain
 * cannot see, so leaving it outstanding and proceeding would re-introduce the
 * orphan-survives-restart shape this card exists to prevent. A `timed_out`
 * admission drain therefore fails CLOSED — the helper throws rather than
 * proceed to `drainRuns` or `drainExecutionFinalizers`, and the shutdown
 * surfaces the timeout instead of silently dropping a child.
 *
 * The registered-run drain is wrapped so a rejected `drainRuns` cannot
 * short-circuit the execution-finalizer drain: the finalizer owns the lease
 * releases that a partial registered-run drain would have left dangling, and
 * the run-drain rejection is rethrown after the finalizer has had its chance.
 */
export async function drainRunsForGracefulShutdown(input: {
  signal: "SIGINT" | "SIGTERM";
  spawnAdmissionFence: SpawnAdmissionFence;
  drainRuns: () => Promise<void>;
  drainExecutionFinalizers: () => Promise<void>;
  timeoutMs?: number;
  log: ShutdownLogger;
}): Promise<void> {
  const timeoutMs = input.timeoutMs ?? 5_000;
  input.spawnAdmissionFence.close();
  const admissionDrain = await input.spawnAdmissionFence.drain({ timeoutMs });
  if (admissionDrain === "timed_out") {
    input.log.error(
      { signal: input.signal, timeoutMs },
      "bounded spawn admission drain timed out; refusing to proceed while an in-flight spawn remains unsettled",
    );
    throw new Error(
      `spawn_admission_drain_timed_out:${input.signal}:${timeoutMs}ms`,
    );
  }
  let runDrainError: unknown = null;
  try {
    await input.drainRuns();
  } catch (err) {
    runDrainError = err;
    input.log.error(
      { err, signal: input.signal },
      "graceful registered-run drain failed; continuing to execution finalizer drain before surfacing",
    );
  }
  // The execution-finalizer drain MUST run even when the registered-run drain
  // rejects: a failed run drain leaves owned leases and pending finalizers
  // dangling, and skipping this step would surface as a lease that outlives
  // the process exit. Its own rejection is logged but never overwrites the
  // run-drain error — the caller sees the registered-run cause first.
  try {
    await input.drainExecutionFinalizers();
  } catch (err) {
    input.log.error(
      { err, signal: input.signal },
      "graceful execution-finalizer drain failed",
    );
    if (runDrainError === null) runDrainError = err;
  }
  if (runDrainError !== null) throw runDrainError;
}

export async function drainRunExecutionFinalizersForShutdown(input: {
  signal: "SIGINT" | "SIGTERM";
  drain: (() => Promise<void>) | null;
  timeoutMs?: number;
  log: ShutdownLogger;
}): Promise<"drained" | "timed_out" | "unavailable"> {
  if (!input.drain) return "unavailable";
  const timeoutMs = input.timeoutMs ?? 5_000;
  let timer: NodeJS.Timeout | null = null;
  try {
    const result = await Promise.race([
      input.drain().then(() => "drained" as const),
      new Promise<"timed_out">((resolve) => {
        timer = setTimeout(() => resolve("timed_out"), timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (result === "timed_out") {
      input.log.info(
        { signal: input.signal, timeoutMs },
        "bounded heartbeat execution finalizer drain timed out",
      );
    }
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type ShutdownHttpListener = {
  listening: boolean;
  close(callback?: (err?: Error) => void): unknown;
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
};

/**
 * Stops the HTTP listener from accepting new requests and waits, for at most
 * `timeoutMs`, for the open connections to finish. Idle keep-alive sockets
 * close at once; whatever is still open when the grace period ends is closed
 * forcibly, so the teardown never hangs on a long-lived client. Call this
 * before the database pool ends, so no request can reach a route after
 * `sql.end()` and fail with a connection-ended error.
 */
export async function closeHttpListenerForShutdown(input: {
  server: ShutdownHttpListener;
  signal: "SIGINT" | "SIGTERM";
  timeoutMs?: number;
  log: ShutdownLogger;
}): Promise<"closed" | "timed_out" | "not_listening"> {
  if (!input.server.listening) return "not_listening";
  const timeoutMs = input.timeoutMs ?? 5_000;
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      new Promise<"closed">((resolve) => {
        input.server.close((err) => {
          if (err && (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
            input.log.error({ err, signal: input.signal }, "HTTP listener close failed");
          }
          resolve("closed");
        });
        input.server.closeIdleConnections?.();
      }),
      new Promise<"timed_out">((resolve) => {
        timer = setTimeout(() => {
          input.log.info(
            { signal: input.signal, timeoutMs },
            "HTTP listener drain timed out; closing the remaining connections",
          );
          input.server.closeAllConnections?.();
          resolve("timed_out");
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Runs the final, ordered teardown of the server. It awaits the application
 * service cleanup first, so a live setup-token login session stops and releases
 * its sandbox lease before the database and the provider stop. The caller runs
 * `process.exit(0)` only after this helper resolves, so an orderly shutdown
 * never leaves a sandbox lease or confidential login state alive past the
 * process exit.
 *
 * A step that rejects does not stop the teardown. The helper logs the error and
 * continues to the next step. A failed setup-token lease release stays a
 * durable record for the startup reaper; the helper surfaces it in the log
 * instead of blocking the exit path.
 */
export async function finalizeServerShutdown(input: {
  signal: "SIGINT" | "SIGTERM";
  shutdownAppServices: (() => Promise<void>) | undefined;
  /**
   * Stops the HTTP listener and drains its connections (see
   * `closeHttpListenerForShutdown`). Runs first, while every application
   * service is still available to the requests being drained, so no request
   * runs against a half-dismantled service or an ended pool.
   */
  closeHttpListener?: (() => Promise<unknown>) | null;
  /**
   * Waits for every run-failure Sentry report still in flight. Runs after the
   * application services and before the database pool ends, so a report that
   * started just before shutdown still gets its database read and reaches
   * Sentry before `shutdownSentry` flushes and closes the client.
   */
  drainPendingRunFailureReports?: (() => Promise<void>) | null;
  /**
   * Ends the server's PostgreSQL client pools. Runs after the application
   * services (which still need the database) and before the embedded
   * provider stops, so the backends close in order and none outlive the
   * process.
   */
  closeDatabase?: (() => Promise<void>) | null;
  stopEmbeddedPostgres: (() => Promise<void>) | null;
  shutdownInstrumentation: () => Promise<void>;
  shutdownSentry: () => Promise<void>;
  log: ShutdownLogger;
}): Promise<void> {
  const { signal } = input;

  // Stop accepting requests and drain the open ones before any service goes
  // away, so a request that is still in flight sees a fully working server.
  if (input.closeHttpListener) {
    try {
      await input.closeHttpListener();
    } catch (err) {
      input.log.error({ err, signal }, "HTTP listener shutdown failed");
    }
  }

  // Await the application service cleanup, so a live setup-token login session
  // releases its sandbox lease before the database and the provider stop. A
  // rejected cleanup stays durable for the reaper; it does not block the exit.
  try {
    await input.shutdownAppServices?.();
  } catch (err) {
    input.log.error({ err, signal }, "Application service shutdown failed");
  }

  // Wait for every in-flight run-failure Sentry report before the database
  // pool ends. `reportRunFailure` is fire-and-forget: without this wait, a
  // report that started just before shutdown can lose its database read to
  // the pool end below, or lose its Sentry call to the flush further down.
  if (input.drainPendingRunFailureReports) {
    try {
      await input.drainPendingRunFailureReports();
    } catch (err) {
      input.log.error({ err, signal }, "run-failure report drain failed");
    }
  }

  // End the client pools once nothing needs them any more. Without this the
  // process exit leaves the pooled backends to PostgreSQL's own TCP keepalive
  // reaping, and a restart loop can pile up enough of them to hit
  // `max_connections` before the next boot gets a connection.
  if (input.closeDatabase) {
    try {
      await input.closeDatabase();
    } catch (err) {
      input.log.error({ err, signal }, "Database client shutdown failed");
    }
  }

  if (input.stopEmbeddedPostgres) {
    input.log.info({ signal }, "Stopping embedded PostgreSQL");
    try {
      await input.stopEmbeddedPostgres();
    } catch (err) {
      input.log.error({ err }, "Failed to stop embedded PostgreSQL cleanly");
    }
  }

  // Flush buffered OTel spans before the process goes away; without this await
  // the exporter's final batch is dropped on exit.
  await input.shutdownInstrumentation();

  // Flush buffered Sentry events before the process goes away; without this
  // await the last events are dropped on exit.
  await input.shutdownSentry();
}

const COORDINATED_SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

type ShutdownSignalTarget = {
  rawListeners(eventName: string): Function[];
  removeListener(eventName: string, listener: (...args: any[]) => void): unknown;
};

/**
 * Some dependencies eagerly install process signal handlers as an import side
 * effect. Paperclip must remain the sole owner of SIGINT/SIGTERM ordering: its
 * handler first snapshots live heartbeat runs and only then stops embedded
 * infrastructure. Remove only listeners added by the supplied import, while
 * preserving every listener that was already registered.
 */
export async function loadWithoutCoordinatedShutdownSignalHooks<T>(
  load: () => Promise<T>,
  signalTarget: ShutdownSignalTarget = process,
) {
  const listenersBeforeLoad = new Map(
    COORDINATED_SHUTDOWN_SIGNALS.map((signal) => [
      signal,
      signalTarget.rawListeners(signal),
    ]),
  );

  let loaded: T;
  try {
    loaded = await load();
  } finally {
    for (const signal of COORDINATED_SHUTDOWN_SIGNALS) {
      const remainingBeforeLoad = [...(listenersBeforeLoad.get(signal) ?? [])];
      for (const listener of signalTarget.rawListeners(signal)) {
        const existingIndex = remainingBeforeLoad.indexOf(listener);
        if (existingIndex >= 0) {
          remainingBeforeLoad.splice(existingIndex, 1);
          continue;
        }
        signalTarget.removeListener(signal, listener as (...args: any[]) => void);
      }
    }
  }

  return loaded;
}

export async function coordinateHeartbeatSchedulerShutdown<
  TPreparation extends HotRestartShutdownPreparation,
>(input: {
  signal: "SIGINT" | "SIGTERM";
  prepareHotRestartShutdown: ((signal: "SIGINT" | "SIGTERM") => Promise<TPreparation>) | null;
  waitForHeartbeatSchedulerIdle: () => Promise<void>;
  /**
   * Optional spawn-admission fence. The hot-restart snapshot must be taken
   * AFTER the fence is closed, so a `spawn()` whose `admit()` arrives during
   * the snapshot is refused at the gate instead of creating a `running` row
   * absent from both the snapshot and the selective drain set. Once shutdown
   * begins the fence remains closed on every path; graceful draining may call
   * `close()` again, which is idempotent.
   */
  spawnAdmissionFence?: SpawnAdmissionFence | null;
  /** Bounded timeout for the pre-snapshot spawn-admission drain. */
  spawnAdmissionDrainTimeoutMs?: number;
  log?: ShutdownLogger;
}): Promise<{
  hotRestart: TPreparation | null;
  preparationError: unknown;
  waitedForSchedulerIdle: boolean;
}> {
  let hotRestart: TPreparation | null = null;
  let preparationError: unknown = null;
  const log = input.log;

  // The signal handler stops the scheduler before entering this coordinator.
  // Quiesce any callback that was already in flight before querying running
  // rows for the shutdown snapshot, otherwise a late queue claim can create a
  // run that is absent from both the snapshot and the selective drain set.
  await input.waitForHeartbeatSchedulerIdle();

  // SPA-11948 R2. Close spawn admission BEFORE the snapshot so a
  // `spawn()` whose `admit()` lands during the snapshot query is refused at
  // the gate instead of becoming a `running` row that is missing from both
  // the snapshot and the selective drain set. Outstanding leases stay
  // counted while we drain; mid-spawn children whose ticket reaches the
  // closed gate are signalled and their tickets settled, so the drain
  // resolves with the in-flight counter at zero unless the producer is wedged.
  if (input.spawnAdmissionFence) {
    const drainTimeoutMs = input.spawnAdmissionDrainTimeoutMs ?? 5_000;
    input.spawnAdmissionFence.close();
    const admissionDrain = await input.spawnAdmissionFence.drain({
      timeoutMs: drainTimeoutMs,
    });
    if (admissionDrain === "timed_out") {
      const error = new Error(
        `spawn_admission_drain_timed_out:${input.signal}:${drainTimeoutMs}ms`,
      );
      log?.error(
        { err: error, signal: input.signal, timeoutMs: drainTimeoutMs },
        "pre-snapshot spawn admission drain timed out; refusing to capture an incomplete hot-restart snapshot",
      );
      return {
        hotRestart: null,
        preparationError: error,
        waitedForSchedulerIdle: true,
      };
    }
  }

  if (input.prepareHotRestartShutdown) {
    try {
      hotRestart = await input.prepareHotRestartShutdown(input.signal);
    } catch (err) {
      preparationError = err;
    }
  }

  return {
    hotRestart,
    preparationError,
    waitedForSchedulerIdle: true,
  };
}
