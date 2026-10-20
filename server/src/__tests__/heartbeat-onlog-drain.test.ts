import { describe, expect, it, vi } from "vitest";
import {
  ACTIVE_RUN_LOG_RUNTIME_STATUS_REFRESH_INTERVAL_MS,
  ONLOG_DRAIN_TIMEOUT_MS,
  ONLOG_INSTRUMENT_SAMPLE_DEFAULT,
  ONLOG_INSTRUMENT_SAMPLE_ENV_VAR,
  buildOnLogStartFields,
  normalizeOnLogRaceTimeoutMs,
  raceOnLogPersistence,
  resolveOnLogChunkApplication,
  resolveOnLogDrainTimeoutMs,
  resolveOnLogInstrumentSampleRate,
  runOnLogPersistenceWithTimeout,
  selectOnLogAwaitingLabel,
  shouldRefreshLogRuntimeStatus,
  shouldSampleOnLogInstrumentation,
} from "../services/heartbeat.ts";

function makeCapturingLogger() {
  const infos: Array<{ fields: Record<string, unknown>; msg: string }> = [];
  const warns: Array<{ fields: Record<string, unknown>; msg: string }> = [];
  return {
    infos,
    warns,
    log: {
      info: (fields: Record<string, unknown>, msg: string) => {
        infos.push({ fields, msg });
      },
      warn: (fields: Record<string, unknown>, msg: string) => {
        warns.push({ fields, msg });
      },
    },
  };
}

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

  it("stale_interleave_pending_flushed_bytes_monotonic_and_null_pending_noop", () => {
    // Regression (PR #227 review T5): an older chunk that timed out settles
    // AFTER the newer chunk created AND flushed the pending slot. Models the
    // persistWork pending-slot logic in heartbeat.ts. bytes is a run-level
    // monotonic counter: the stale continuation must only move it upward,
    // and a null pending makes it a slot no-op — its bytes reach the DB via
    // the next owning chunk's flush with that owner's identity.
    interface Pending {
      at: number;
      seq: number;
      stream: "stdout" | "stderr";
      bytes: number;
    }
    let persistedLogBytes = 100;
    let pending: Pending | null = null;
    const flushed: Pending[] = [];
    const flush = () => {
      if (!pending) return;
      flushed.push({ ...pending });
      pending = null;
    };

    // Newer chunk 5 owns the slot and flushes: DB gets seq 5 with 120 bytes.
    const newer = resolveOnLogChunkApplication({
      persistedLogBytes,
      chunkSeq: 5,
      latestSeq: 5,
      appendedBytes: 20,
    });
    expect(newer.ownsPendingSlot).toBe(true);
    persistedLogBytes = newer.persistedLogBytes;
    pending = { at: 200, seq: 5, stream: "stdout", bytes: persistedLogBytes };
    flush();
    expect(flushed).toEqual([{ at: 200, seq: 5, stream: "stdout", bytes: 120 }]);

    // Stale chunk 4 (timed out earlier) settles late against a null pending:
    // no slot write, no flush of the newer chunk's identity under the stale
    // turn — bytes fold into the closure total only.
    const stale = resolveOnLogChunkApplication({
      persistedLogBytes,
      chunkSeq: 4,
      latestSeq: 5,
      appendedBytes: 10,
    });
    expect(stale.ownsPendingSlot).toBe(false);
    persistedLogBytes = stale.persistedLogBytes;
    if (!stale.ownsPendingSlot && pending) pending.bytes = persistedLogBytes;
    expect(persistedLogBytes).toBe(130);
    expect(pending).toBeNull();
    expect(flushed).toHaveLength(1);

    // Next owner chunk 6 flushes the full monotonic total under its own
    // identity — 130, never regressing to the pre-stale 120.
    const next = resolveOnLogChunkApplication({
      persistedLogBytes,
      chunkSeq: 6,
      latestSeq: 6,
      appendedBytes: 5,
    });
    persistedLogBytes = next.persistedLogBytes;
    pending = { at: 300, seq: 6, stream: "stderr", bytes: persistedLogBytes };
    flush();
    expect(flushed[1]).toEqual({ at: 300, seq: 6, stream: "stderr", bytes: 135 });
    for (let i = 1; i < flushed.length; i++) {
      expect(flushed[i].bytes).toBeGreaterThanOrEqual(flushed[i - 1].bytes);
    }
  });

  it("stale_interleave_pending_unflushed_owner_identity_kept_bytes_move_up", () => {
    // Regression (PR #227 review T5), other order: the newer chunk's pending
    // exists but has NOT flushed when the stale chunk lands. The refresh
    // moves bytes upward while at/seq/stream stay the owner's, so a flush
    // triggered by the owner writes owner identity with the refreshed total.
    interface Pending {
      at: number;
      seq: number;
      stream: "stdout" | "stderr";
      bytes: number;
    }
    let persistedLogBytes = 100;
    let pending: Pending | null = null;
    // Owner chunk 6 created the slot (not yet flushed).
    const owner = resolveOnLogChunkApplication({
      persistedLogBytes,
      chunkSeq: 6,
      latestSeq: 6,
      appendedBytes: 20,
    });
    persistedLogBytes = owner.persistedLogBytes;
    pending = { at: 400, seq: 6, stream: "stdout", bytes: persistedLogBytes };

    // Stale chunk 5 (timed out earlier) settles late: refresh bytes only.
    const stale = resolveOnLogChunkApplication({
      persistedLogBytes,
      chunkSeq: 5,
      latestSeq: 6,
      appendedBytes: 10,
    });
    expect(stale.ownsPendingSlot).toBe(false);
    persistedLogBytes = stale.persistedLogBytes;
    if (!stale.ownsPendingSlot && pending) pending.bytes = persistedLogBytes;
    expect(persistedLogBytes).toBe(130);
    expect(pending).toEqual({ at: 400, seq: 6, stream: "stdout", bytes: 130 });
    // Flush content: owner identity, refreshed monotonic bytes.
    expect(pending.bytes).toBeGreaterThanOrEqual(120);
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

  it("onlog_start_fields_carry_source_queue_run", () => {
    expect(
      buildOnLogStartFields({ source: "stdout", queue: 3, runId: "run-1" }),
    ).toEqual({ source: "stdout", queue: 3, runId: "run-1" });
  });

  it("persistence_helper_hung_work_logs_dropped_with_inflight_stage_and_settles", async () => {
    // db_flush hangs past the race: elapsed map still reads 0 for the
    // stalled stage, so awaiting must name the in-flight stage, not fs.
    const cap = makeCapturingLogger();
    const hung = new Promise<{ seq: number }>(() => {});
    const result = await runOnLogPersistenceWithTimeout({
      persistWork: hung,
      timeoutMs: 20,
      onLogEntryMs: 1000,
      sampled: true,
      currentStage: () => "db_flush",
      stageElapsedMs: { fs: 4, db_flush: 0, heartbeat_touch: 0 },
      runId: "run-1",
      log: cap.log,
      now: () => 1020,
    });
    expect(result.outcome).toBe("dropped");
    expect(cap.warns).toHaveLength(1);
    expect(cap.warns[0].msg).toBe("progress_flush_dropped");
    expect(cap.warns[0].fields.runId).toBe("run-1");
    expect(cap.warns[0].fields.awaiting).toBe("db_flush");
    const resolve = cap.infos.find((e) => e.msg === "onLog_resolve");
    expect(resolve).toBeDefined();
    expect(resolve?.fields.awaiting).toBe("db_flush");
    expect(typeof resolve?.fields.elapsed_ms).toBe("number");
  });

  it("persistence_helper_persisted_path_uses_max_elapsed_label", async () => {
    const cap = makeCapturingLogger();
    const result = await runOnLogPersistenceWithTimeout({
      persistWork: Promise.resolve({ seq: 7 }),
      timeoutMs: 1000,
      onLogEntryMs: 1000,
      sampled: true,
      currentStage: () => "heartbeat_touch",
      stageElapsedMs: { fs: 5, db_flush: 120, heartbeat_touch: 3 },
      runId: "run-1",
      log: cap.log,
      now: () => 1128,
    });
    expect(result).toEqual({ outcome: "persisted", value: { seq: 7 } });
    expect(cap.warns).toHaveLength(0);
    expect(cap.infos).toHaveLength(1);
    expect(cap.infos[0].msg).toBe("onLog_resolve");
    expect(cap.infos[0].fields.awaiting).toBe("db_flush");
    expect(cap.infos[0].fields.elapsed_ms).toBe(128);
  });

  it("persistence_helper_unsampled_emits_no_resolve", async () => {
    const cap = makeCapturingLogger();
    await runOnLogPersistenceWithTimeout({
      persistWork: Promise.resolve("ok"),
      timeoutMs: 1000,
      onLogEntryMs: 1000,
      sampled: false,
      currentStage: () => "fs",
      stageElapsedMs: { fs: 1, db_flush: 1, heartbeat_touch: 1 },
      runId: "run-1",
      log: cap.log,
      now: () => 1001,
    });
    expect(cap.infos).toHaveLength(0);
    expect(cap.warns).toHaveLength(0);
  });

  it("persistence_helper_garbage_timeout_falls_back_to_default", async () => {
    // NEGATIVE: garbage timeout must not arm a zero/NaN timer that drops
    // every chunk — settled work still persists.
    const cap = makeCapturingLogger();
    const result = await runOnLogPersistenceWithTimeout({
      persistWork: Promise.resolve("ok"),
      timeoutMs: Number.NaN,
      onLogEntryMs: 1000,
      sampled: false,
      currentStage: () => "fs",
      stageElapsedMs: { fs: 1, db_flush: 0, heartbeat_touch: 0 },
      runId: "run-1",
      log: cap.log,
      now: () => 1001,
    });
    expect(result).toEqual({ outcome: "persisted", value: "ok" });
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
