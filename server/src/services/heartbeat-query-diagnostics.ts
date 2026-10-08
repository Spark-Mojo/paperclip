import { logger } from "../middleware/logger.js";

export const HEARTBEAT_QUERY_DIAGNOSTIC_TAGS = [
  "conversation_ownership_blocker",
  "watchdog_candidate_silent_runs",
  "issue_secret_redaction_registry",
] as const;

export const HEARTBEAT_QUERY_DIAGNOSTIC_WINDOW_MS = 60_000;

export type HeartbeatQueryDiagnosticTag =
  (typeof HEARTBEAT_QUERY_DIAGNOSTIC_TAGS)[number];

export type HeartbeatQueryDiagnosticSummary = {
  event: "heartbeat_query_timing";
  tag: HeartbeatQueryDiagnosticTag;
  windowMs: number;
  elapsedWindowMs: number;
  started: number;
  completed: number;
  failed: number;
  inFlight: number;
  peakInFlight: number;
  successTotalDurationMs: number;
  successMaxDurationMs: number;
  failureTotalDurationMs: number;
  failureMaxDurationMs: number;
};

export type HeartbeatQueryDiagnostics = {
  measure<T>(
    tag: HeartbeatQueryDiagnosticTag,
    run: () => Promise<T> | T,
  ): Promise<T>;
};

type TagState = {
  windowStartMs: number;
  started: number;
  completed: number;
  failed: number;
  peakInFlight: number;
  successTotalDurationMs: number;
  successMaxDurationMs: number;
  failureTotalDurationMs: number;
  failureMaxDurationMs: number;
  inFlight: number;
};

const ALLOWED_TAGS: ReadonlySet<string> = new Set(
  HEARTBEAT_QUERY_DIAGNOSTIC_TAGS,
);

function isDiagnosticTag(
  value: unknown,
): value is HeartbeatQueryDiagnosticTag {
  return typeof value === "string" && ALLOWED_TAGS.has(value);
}

function roundMs(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value * 1000) / 1000 : 0;
}

export function createHeartbeatQueryDiagnostics(
  options: {
    monotonicNow?: () => number;
    windowMs?: number;
    emit?: (summary: HeartbeatQueryDiagnosticSummary) => void;
  } = {},
): HeartbeatQueryDiagnostics {
  const now = options.monotonicNow ?? (() => performance.now());
  const windowMs =
    Number.isFinite(options.windowMs) && (options.windowMs ?? 0) > 0
      ? (options.windowMs as number)
      : HEARTBEAT_QUERY_DIAGNOSTIC_WINDOW_MS;
  const emit =
    options.emit ??
    ((summary: HeartbeatQueryDiagnosticSummary) =>
      logger.info(summary, "Heartbeat query timing"));
  const stateByTag = new Map<HeartbeatQueryDiagnosticTag, TagState>();

  function stateFor(tag: HeartbeatQueryDiagnosticTag): TagState {
    const existing = stateByTag.get(tag);
    if (existing) return existing;
    const created: TagState = {
      windowStartMs: now(),
      started: 0,
      completed: 0,
      failed: 0,
      peakInFlight: 0,
      successTotalDurationMs: 0,
      successMaxDurationMs: 0,
      failureTotalDurationMs: 0,
      failureMaxDurationMs: 0,
      inFlight: 0,
    };
    stateByTag.set(tag, created);
    return created;
  }

  function emitWindowSummary(
    tag: HeartbeatQueryDiagnosticTag,
    state: TagState,
    closedAtMs: number,
  ): void {
    if (state.started === 0 && state.completed === 0 && state.failed === 0) return;
    const summary: HeartbeatQueryDiagnosticSummary = {
      event: "heartbeat_query_timing",
      tag,
      windowMs,
      elapsedWindowMs: roundMs(closedAtMs - state.windowStartMs),
      started: state.started,
      completed: state.completed,
      failed: state.failed,
      inFlight: state.inFlight,
      peakInFlight: state.peakInFlight,
      successTotalDurationMs: state.successTotalDurationMs,
      successMaxDurationMs: state.successMaxDurationMs,
      failureTotalDurationMs: state.failureTotalDurationMs,
      failureMaxDurationMs: state.failureMaxDurationMs,
    };
    try {
      const emitted = emit(summary) as unknown;
      if (emitted instanceof Promise) {
        void emitted.then(undefined, () => undefined);
      }
    } catch {}
  }

  function closeElapsedWindows(
    tag: HeartbeatQueryDiagnosticTag,
    state: TagState,
  ): void {
    const closedAtMs = now();
    if (closedAtMs - state.windowStartMs < windowMs) return;
    emitWindowSummary(tag, state, closedAtMs);
    state.windowStartMs = closedAtMs;
    state.started = 0;
    state.completed = 0;
    state.failed = 0;
    state.peakInFlight = state.inFlight;
    state.successTotalDurationMs = 0;
    state.successMaxDurationMs = 0;
    state.failureTotalDurationMs = 0;
    state.failureMaxDurationMs = 0;
  }

  function recordCompletion(
    state: TagState,
    durationMs: number,
    failed: boolean,
  ): void {
    if (failed) {
      state.failed += 1;
      state.failureTotalDurationMs += durationMs;
      if (durationMs > state.failureMaxDurationMs) {
        state.failureMaxDurationMs = durationMs;
      }
      return;
    }
    state.completed += 1;
    state.successTotalDurationMs += durationMs;
    if (durationMs > state.successMaxDurationMs) {
      state.successMaxDurationMs = durationMs;
    }
  }

  return {
    async measure<T>(
      tag: HeartbeatQueryDiagnosticTag,
      run: () => Promise<T> | T,
    ): Promise<T> {
      if (!isDiagnosticTag(tag)) return await run();
      const state = stateFor(tag);
      closeElapsedWindows(tag, state);
      const startMs = now();
      state.started += 1;
      state.inFlight += 1;
      if (state.inFlight > state.peakInFlight) state.peakInFlight = state.inFlight;
      try {
        const result = await run();
        closeElapsedWindows(tag, state);
        recordCompletion(state, roundMs(now() - startMs), false);
        return result;
      } catch (error) {
        closeElapsedWindows(tag, state);
        recordCompletion(state, roundMs(now() - startMs), true);
        throw error;
      } finally {
        state.inFlight -= 1;
      }
    },
  };
}

const sharedDiagnostics = createHeartbeatQueryDiagnostics();

export function measureHeartbeatQuery<T>(
  tag: HeartbeatQueryDiagnosticTag,
  run: () => Promise<T> | T,
): Promise<T> {
  return sharedDiagnostics.measure(tag, run);
}