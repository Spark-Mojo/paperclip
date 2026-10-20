import { describe, expect, it, vi } from "vitest";
import {
  ACTIVE_RUN_LOG_RUNTIME_STATUS_REFRESH_INTERVAL_MS,
  ONLOG_DRAIN_TIMEOUT_MS,
  ONLOG_INSTRUMENT_SAMPLE_DEFAULT,
  ONLOG_INSTRUMENT_SAMPLE_ENV_VAR,
  normalizeOnLogRaceTimeoutMs,
  raceOnLogPersistence,
  resolveOnLogChunkApplication,
  resolveOnLogDrainTimeoutMs,
  resolveOnLogInstrumentSampleRate,
  selectOnLogAwaitingLabel,
  shouldRefreshLogRuntimeStatus,
  shouldSampleOnLogInstrumentation,
} from "../services/heartbeat.ts";

describe("heartbeat onLog drain helpers", () => {
  it("select_on_log_awaiting_label_picks_max_stage", () => {
    expect(
      selectOnLogAwaitingLabel({
        fs: 5,
        db_flush: 120,
        heartbeat_touch: 3,
      }),
    ).toBe("db_flush");
    expect(
      selectOnLogAwaitingLabel({
        fs: 1,
        db_flush: 2,
        heartbeat_touch: 3,
      }),
    ).toBe("heartbeat_touch");
  });

  it("select_on_log_awaiting_label_breaks_ties_fs_first", () => {
    expect(
      selectOnLogAwaitingLabel({
        fs: 10,
        db_flush: 10,
        heartbeat_touch: 10,
      }),
    ).toBe("fs");
    expect(
      selectOnLogAwaitingLabel({
        fs: 1,
        db_flush: 9,
        heartbeat_touch: 9,
      }),
    ).toBe("db_flush");
  });

  it("select_on_log_awaiting_label_rejects_publish_key", () => {
    // publishLiveEvent is sync (live-events.ts:28-37: plain emitter.emit,
    // no promise), so publish is not an awaited stage and must not win.
    expect(
      selectOnLogAwaitingLabel({
        fs: 1,
        db_flush: 2,
        heartbeat_touch: 3,
        publish: 44,
      } as unknown as { fs: number; db_flush: number; heartbeat_touch: number }),
    ).toBe("heartbeat_touch");
  });

  it("timeout_const_defaults_to_3000_with_env_override_and_garbage_fallback", () => {
    expect(ONLOG_DRAIN_TIMEOUT_MS).toBe(3000);
    expect(resolveOnLogDrainTimeoutMs({})).toBe(3000);
    expect(
      resolveOnLogDrainTimeoutMs({ PAPERCLIP_ONLOG_TIMEOUT_MS: "500" }),
    ).toBe(500);
    expect(
      resolveOnLogDrainTimeoutMs({ PAPERCLIP_ONLOG_TIMEOUT_MS: "garbage" }),
    ).toBe(3000);
    expect(resolveOnLogDrainTimeoutMs({ PAPERCLIP_ONLOG_TIMEOUT_MS: "" })).toBe(
      3000,
    );
    expect(
      resolveOnLogDrainTimeoutMs({ PAPERCLIP_ONLOG_TIMEOUT_MS: "-5" }),
    ).toBe(3000);
    expect(resolveOnLogDrainTimeoutMs({ PAPERCLIP_ONLOG_TIMEOUT_MS: "0" })).toBe(
      3000,
    );
    expect(
      resolveOnLogDrainTimeoutMs({ PAPERCLIP_ONLOG_TIMEOUT_MS: "NaN" }),
    ).toBe(3000);
    expect(
      resolveOnLogDrainTimeoutMs({ PAPERCLIP_ONLOG_TIMEOUT_MS: "Infinity" }),
    ).toBe(3000);
    expect(
      resolveOnLogDrainTimeoutMs({ PAPERCLIP_ONLOG_TIMEOUT_MS: "33.9" }),
    ).toBe(33);
  });

  it("race_timeout_sanitizer_falls_back_on_nan_and_nonpositive", () => {
    expect(normalizeOnLogRaceTimeoutMs(3000)).toBe(3000);
    expect(normalizeOnLogRaceTimeoutMs(33.9)).toBe(33);
    expect(normalizeOnLogRaceTimeoutMs(Number.NaN)).toBe(
      ONLOG_DRAIN_TIMEOUT_MS,
    );
    expect(normalizeOnLogRaceTimeoutMs(0)).toBe(ONLOG_DRAIN_TIMEOUT_MS);
    expect(normalizeOnLogRaceTimeoutMs(-5)).toBe(ONLOG_DRAIN_TIMEOUT_MS);
    expect(normalizeOnLogRaceTimeoutMs("500" as unknown as number)).toBe(
      ONLOG_DRAIN_TIMEOUT_MS,
    );
  });

  it("race_resolves_dropped_for_never_settling_work_within_bound", async () => {
    const never = new Promise<string>(() => {});
    const start = Date.now();
    const result = await raceOnLogPersistence(never, 20);
    expect(result.outcome).toBe("dropped");
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("race_resolves_persisted_for_settled_work", async () => {
    const result = await raceOnLogPersistence(Promise.resolve("ok"), 1000);
    expect(result).toEqual({ outcome: "persisted", value: "ok" });
  });

  it("race_resolves_dropped_on_work_rejection", async () => {
    const result = await raceOnLogPersistence(
      Promise.reject(new Error("db down")),
      1000,
    );
    expect(result.outcome).toBe("dropped");
  });

  it("chunk_guard_late_settle_keeps_newer_pending_and_accumulates_bytes_once", () => {
    // Chunk 2 (newer) settles first and claims the slot.
    let persistedLogBytes = 100;
    let pending: { seq: number; bytes: number } | null = null;
    const newer = resolveOnLogChunkApplication({
      persistedLogBytes,
      chunkSeq: 2,
      latestSeq: 2,
      appendedBytes: 10,
    });
    expect(newer.ownsPendingSlot).toBe(true);
    persistedLogBytes = newer.persistedLogBytes;
    if (newer.ownsPendingSlot) pending = { seq: 2, bytes: persistedLogBytes };
    // Chunk 1 (timed out earlier) settles late against the current total: it
    // must not clobber chunk 2's slot, and its own bytes count exactly once.
    const stale = resolveOnLogChunkApplication({
      persistedLogBytes,
      chunkSeq: 1,
      latestSeq: 2,
      appendedBytes: 10,
    });
    expect(stale.ownsPendingSlot).toBe(false);
    persistedLogBytes = stale.persistedLogBytes;
    if (!stale.ownsPendingSlot && pending) pending.bytes = persistedLogBytes;
    expect(persistedLogBytes).toBe(120);
    expect(pending).toEqual({ seq: 2, bytes: 120 });
  });

  it("chunk_guard_future_seq_never_owns_pending_slot", () => {
    // Seqs are unique/monotonic, so chunkSeq > latestSeq is impossible — but
    // if it ever happens the chunk must NOT own (strict ===, never >=).
    const future = resolveOnLogChunkApplication({
      persistedLogBytes: 100,
      chunkSeq: 3,
      latestSeq: 2,
      appendedBytes: 10,
    });
    expect(future.ownsPendingSlot).toBe(false);
    expect(future.persistedLogBytes).toBe(110);
  });

  it("stale_guard_false_drives_flush_skip", () => {
    // Flush-skipped-when-stale is ownsPendingSlot=false driving the skip, by
    // construction in persistWork (see heartbeat.ts). Pin the guard side.
    const stale = resolveOnLogChunkApplication({
      persistedLogBytes: 110,
      chunkSeq: 1,
      latestSeq: 2,
      appendedBytes: 10,
    });
    expect(stale.ownsPendingSlot).toBe(false);
    const shouldFlush = stale.ownsPendingSlot;
    expect(shouldFlush).toBe(false);
  });

  it("stale_touch_skips_via_throttle_arithmetic", () => {
    // A late chunk carries an earlier ts; once a newer chunk touched,
    // old_ts - new_touchMs is negative and the touch is skipped.
    const newerTouchMs = 1_000_000;
    expect(
      shouldRefreshLogRuntimeStatus({
        logActivityAtMs: newerTouchMs,
        lastTouchMs: 0,
      }),
    ).toBe(true);
    expect(
      shouldRefreshLogRuntimeStatus({
        logActivityAtMs: newerTouchMs - 60_000,
        lastTouchMs: newerTouchMs,
      }),
    ).toBe(false);
    // Boundary: exactly INTERVAL ahead refreshes.
    expect(
      shouldRefreshLogRuntimeStatus({
        logActivityAtMs:
          newerTouchMs + ACTIVE_RUN_LOG_RUNTIME_STATUS_REFRESH_INTERVAL_MS,
        lastTouchMs: newerTouchMs,
      }),
    ).toBe(true);
  });

  it("sampler_returns_false_when_rate_zero", () => {
    for (let i = 0; i < 25; i++) {
      expect(shouldSampleOnLogInstrumentation(0)).toBe(false);
    }
    expect(shouldSampleOnLogInstrumentation(1)).toBe(true);
  });

  it("sampler_env_garbage_falls_back_to_default", () => {
    expect(
      resolveOnLogInstrumentSampleRate({
        [ONLOG_INSTRUMENT_SAMPLE_ENV_VAR]: "garbage",
      }),
    ).toBe(ONLOG_INSTRUMENT_SAMPLE_DEFAULT);
    expect(resolveOnLogInstrumentSampleRate({})).toBe(
      ONLOG_INSTRUMENT_SAMPLE_DEFAULT,
    );
    expect(
      resolveOnLogInstrumentSampleRate({
        [ONLOG_INSTRUMENT_SAMPLE_ENV_VAR]: "0",
      }),
    ).toBe(0);
    // Single env key drives the resolved rate.
    expect(
      resolveOnLogInstrumentSampleRate({
        [ONLOG_INSTRUMENT_SAMPLE_ENV_VAR]: "1",
      }),
    ).toBe(1);
    expect(
      resolveOnLogInstrumentSampleRate({
        [ONLOG_INSTRUMENT_SAMPLE_ENV_VAR]: "0",
      }),
    ).toBe(0);
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.05);
    try {
      // NaN rate falls back to the 0.1 default: 0.05 < 0.1 samples true,
      // proving garbage is a fallback, not a silent false.
      expect(shouldSampleOnLogInstrumentation(Number.NaN)).toBe(true);
      expect(spy).toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
