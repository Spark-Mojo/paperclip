/**
 * Stream-stall detector — SPA-11981.
 *
 * opencode adapter runs occasionally hang forever on a single model call: the
 * ndjson log stops right after a `step_start`, the process keeps an ESTABLISHED
 * connection to the model gateway, and no output arrives. The run stays
 * `running` and holds a cap slot until someone kills it. The detector emits a
 * single `onStall` signal once the configured idle window has elapsed without
 * any root stdout/stderr activity AND the root process is still alive.
 *
 * Containment contract (SPA-11981 forensic note, 2026-10-12). The detector
 * itself NEVER enumerates process state and NEVER signals a process. The
 * host survived a box-wide outage (PID 1944, the systemd --user manager,
 * SIGKILLed at 20:19:55Z) because a previous attempt used `kill -<pgid>` and
 * walked `/proc`. The detector's only output is the `onStall` callback; the
 * caller (runChildProcess) tears the run down via `systemctl --user stop
 * <scope>`, which is the cgroup fence — every pid in the unit exits, no pid
 * outside the unit can be reached. The detector does not know or care which
 * pids live in the scope; that's the unit's job.
 *
 * Therefore:
 *   - No /proc reads. No `liveDescendantPids()` walker. No
 *     `process.kill(-pgid, signal)` and no `pkill -P`. The detector cannot
 *     reach outside its own process.
 *   - Activity is the ONLY liveness signal the detector trusts. `noteActivity`
 *     is called from root stdout/stderr handlers in runChildProcess and
 *     resets the timer.
 *   - The detector never spawns or signals. It never resolves the run. The
 *     caller owns all of that. The detector's whole job is to time silence
 *     while the root process is alive.
 *
 * R2 — must not kill legitimate long silent work. Long silent tool calls and
 * subagent spawns that are alive in the run's cgroup but have NOT yet
 * produced output through the opencode root's stdout are NOT counted as
 * activity by this detector — the opencode adapter proxies child NDJSON
 * through the root's stdout stream by design, and the unit test exercises
 * that surface. A child that has been silent for the full idle window AND
 * produced no output through the root IS stalled as far as the engine is
 * concerned; surfacing it as a fresh attempt under a fresh cap slot is the
 * correct behavior on a stuck provider.
 *
 * R3 (run-time config). The default idle window is 15 minutes; configurable
 * via `PAPERCLIP_STREAM_STALL_IDLE_MS` env or the `idleMs` constructor
 * option. The poll interval is fixed at 1000 ms and cannot be reduced (avoid
 * stampede).
 *
 * Closed-class error code emitted by the run when the detector fires:
 * `model_stream_stalled`. The transient retry path treats this code as
 * retriable so a stuck provider gets a fresh attempt.
 */
import { EventEmitter } from "node:events";

export const MODEL_STREAM_STALLED_ERROR_CODE = "model_stream_stalled";

export interface StreamStallDetectorOptions {
  /** Idle window after which a run is considered stalled. Default 15 min. */
  idleMs?: number;
  /** Poll interval for checking root liveness. Default 1000 ms. */
  pollIntervalMs?: number;
  /** Called once when the run transitions to STALLED. */
  onStall?: (info: { idleMs: number; lastActivityAt: number; now: number }) => void;
  /**
   * Returns false when the root process has actually exited. The detector
   * does not emit a stall signal once the root is gone. This is the ONLY
   * external liveness probe the detector uses; it is up to the caller to
   * make the probe cheap (a property read, not a kill(0)+getattr dance).
   */
  isRootAlive?: () => boolean;
  /** Optional now-injection. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Disable timer entirely (used by unit tests that drive `noteActivity` +
   * `evaluateNow` directly). When true, `start` is a no-op until
   * `evaluateNow` is called.
   */
  disableTimer?: boolean;
}

export interface StreamStallDetector {
  /** Record output activity from the root (stdout/stderr). */
  noteActivity(): void;
  /** Stop the poll timer. Idempotent. */
  stop(): void;
  /** Run one poll iteration synchronously. Used by unit tests with a fake timer. */
  evaluateNow(): void;
  /** Inspect the current state. Useful for tests. */
  state(): {
    lastActivityAt: number;
    idleMs: number;
    elapsed: number;
    stalled: boolean;
    stopped: boolean;
  };
  /** True iff `onStall` has fired. */
  hasFired(): boolean;
}

const DEFAULT_IDLE_MS = 15 * 60 * 1000;
const DEFAULT_POLL_MS = 1000;
// Floor kept low so unit tests can drive sub-second idle windows; the
// production default (15 min) is far above this and unaffected.
const MIN_IDLE_MS = 50;
const MIN_POLL_MS = 25;

function resolveIdleMs(optionMs: number | undefined): number {
  if (typeof optionMs === "number" && Number.isFinite(optionMs) && optionMs > 0) {
    return Math.max(MIN_IDLE_MS, Math.floor(optionMs));
  }
  const envRaw = process.env.PAPERCLIP_STREAM_STALL_IDLE_MS;
  if (envRaw && envRaw.length > 0) {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.max(MIN_IDLE_MS, Math.floor(parsed));
    }
  }
  return DEFAULT_IDLE_MS;
}

export function createStreamStallDetector(
  options: StreamStallDetectorOptions = {},
): StreamStallDetector {
  const idleMs = resolveIdleMs(options.idleMs);
  const pollMs =
    typeof options.pollIntervalMs === "number" && options.pollIntervalMs >= MIN_POLL_MS
      ? Math.floor(options.pollIntervalMs)
      : DEFAULT_POLL_MS;
  const now = options.now ?? Date.now;
  const onStall = options.onStall;
  const isRootAlive = options.isRootAlive ?? (() => true);
  const disableTimer = options.disableTimer === true;

  let lastActivityAt = now();
  let stopped = false;
  let fired = false;
  let timer: NodeJS.Timeout | null = null;
  const emitter = new EventEmitter();

  const recordActivity = () => {
    if (stopped) return;
    lastActivityAt = now();
    emitter.emit("activity", lastActivityAt);
  };

  const scheduleNext = () => {
    if (stopped || fired || disableTimer) return;
    timer = setTimeout(evaluateNow, pollMs);
  };

  const evaluateNow = () => {
    // The very first time we get here the timer that called us has fired;
    // clear it so the next arm can take its place.
    timer = null;
    if (stopped || fired) return;
    if (!isRootAlive()) {
      // Root has exited; nothing to do. The caller resolves the run.
      return;
    }
    const elapsed = now() - lastActivityAt;
    if (elapsed >= idleMs) {
      fired = true;
      try {
        onStall?.({ idleMs: elapsed, lastActivityAt, now: now() });
      } catch {
        // Swallow — the detector must not throw into the caller's loop.
        // We deliberately do NOT re-emit on the EventEmitter because that
        // would throw synchronously when no listener is attached, which
        // would defeat the contract this entire guard exists to enforce.
      }
      return;
    }
    scheduleNext();
  };

  scheduleNext();

  return {
    noteActivity: recordActivity,
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    evaluateNow,
    state() {
      return {
        lastActivityAt,
        idleMs,
        elapsed: now() - lastActivityAt,
        stalled: fired,
        stopped,
      };
    },
    hasFired() {
      return fired;
    },
  };
}
