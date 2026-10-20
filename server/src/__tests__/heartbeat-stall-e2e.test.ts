/**
 * SPA-13853 d7 — end-to-end stall fixture (real runChildProcess, real spawn).
 *
 * What this file proves, end to end, with the REAL seams:
 *
 *   scenario A — the onLog drain bound is ABSENT, so a hung stdout persist
 *     parks the reader, the kernel pipe fills, the child's writes block, the
 *     stream-stall detector FIRES, and stdout STOPS DRAINING.
 *   scenario B — the onLog drain bound is ACTIVE (the production race), so
 *     the same hung persist is DROPPED after the bound elapses, the reader
 *     resumes, stdout KEEPS DRAINING to completion, the production warn sink
 *     records `progress_flush_dropped`, and the run is never stalled.
 *
 * Real seams used (no mocks of the machinery under test):
 *   - runChildProcess (packages/adapter-utils/src/server-utils.ts): the real
 *     pause -> per-stream chain -> onLog -> resumeReadable drain loop, the
 *     real stall-detector wiring, and the real scope-stop kill path
 *     (`systemctl --user stop <unit>`).
 *   - Stall-detector window: `PAPERCLIP_STREAM_STALL_IDLE_MS` env — the real
 *     seam, because runChildProcess passes no `idleMs` option, so production
 *     resolves the window through resolveIdleMs()'s env fallback (floor 50ms).
 *     The detector's poll interval stays at its production 1000ms default.
 *   - onLog drain bound: `resolveOnLogDrainTimeoutMs` +
 *     `runOnLogPersistenceWithTimeout` from server/src/services/heartbeat.ts —
 *     the exact helpers the heartbeat onLog wires (persistWork raced against
 *     PAPERCLIP_ONLOG_TIMEOUT_MS; on drop it logs `progress_flush_dropped`
 *     and returns while the fs append continues in the background).
 *   - onLog instrumentation: `shouldSampleOnLogInstrumentation` reads
 *     `PAPERCLIP_ONLOG_INSTRUMENT_SAMPLE`; with the sample rate at 1 the
 *     production `onLog_resolve` lines (with their `awaiting=` label) are
 *     emitted and captured through the same spy log sink as the warn.
 *
 * Why scenario A does not use the env var to "disable" the bound:
 * PAPERCLIP_ONLOG_TIMEOUT_MS cannot disable it — `resolveOnLogDrainTimeoutMs`
 * falls back to the 3000ms default for 0, negatives and garbage. The genuine
 * no-bound state is the pre-PR#227 onLog shape, which awaited its persist
 * work directly (no race on the path at all); scenario A restores that shape
 * verbatim, so the race is genuinely absent rather than mocked.
 *
 * Why scenario A asserts the PORTABLE observables:
 * the detector's own action is scope-only — `onStall` sets `streamStalled`,
 * calls `cleanupScope()` and emits the advisory
 * (packages/adapter-utils/src/server-utils.ts:5328-5344); the KILL is the
 * cgroup fence `systemctl --user stop <unit>` inside `stopRunScope`
 * (packages/adapter-utils/src/run-resource-scope.ts:44-51), which needs a
 * systemd USER session. On a host without one the fence cannot kill the
 * child, so "the child was killed" is not an observable this fixture may
 * depend on; the cgroup-kill path is covered by the production scope tests.
 * What IS portable, and is what this file asserts, is the MECHANISM the card
 * is about: the detector FIRED (the advisory reached onLogError) and stdout
 * STOPPED DRAINING because the reader stayed parked on the hung persist while
 * the kernel pipe filled and the child's writes blocked.
 *
 * The child is given a BOUNDED lifetime twice over (a loop deadline AND an
 * independent watchdog timer that force-exits even while the child is blocked
 * inside a backpressured `write()`), so the runChildProcess promise always
 * settles and no orphan process outlives the test; `timeoutSec` stays at 120
 * so the timeoutSec path can never be the killer. The hung persist is
 * released as soon as the advisory is observed, which is what lets the
 * reader resume so the close path can complete.
 *
 * Hermetic: no network, no DB. The child is a real spawned node process
 * whose writer respects stream backpressure (`write()` returning false waits
 * for `drain`), so the kernel pipe really fills when the reader stays paused.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import {
  MODEL_STREAM_STALLED_ERROR_CODE,
} from "@paperclipai/adapter-utils/stream-stall-detector";
import {
  ONLOG_DRAIN_TIMEOUT_ENV_VAR,
  ONLOG_INSTRUMENT_SAMPLE_ENV_VAR,
  buildOnLogStartFields,
  resolveOnLogDrainTimeoutMs,
  runOnLogPersistenceWithTimeout,
  shouldSampleOnLogInstrumentation,
} from "../services/heartbeat.ts";

const STALL_IDLE_ENV = "PAPERCLIP_STREAM_STALL_IDLE_MS";
const SETTLE_ENV = "PAPERCLIP_LOG_CHAIN_SETTLE_TIMEOUT_MS";
const SAMPLE_ENV = ONLOG_INSTRUMENT_SAMPLE_ENV_VAR;

// Scenario A: the child asks for far more than the ~64KB kernel pipe holds,
// so the pipe genuinely fills and the child's writes block while the reader
// is parked. The loop deadline and the watchdog both sit AFTER the
// detector's first 1000ms poll (so the detector fires FIRST) and the total
// is far above what the pipe can carry (so "the child finished its lines"
// can never be mistaken for "the drain was stuck").
const A_TOTAL_LINES = 5000;
const A_LINE_DELAY_MS = 2;
const A_DEADLINE_MS = 1200;
const A_WATCHDOG_MS = 3000;
// Scenario B: few enough lines that the whole run finishes in ~2s.
const B_TOTAL_LINES = 400;
const B_LINE_DELAY_MS = 5;
const B_DEADLINE_MS = 20_000;
const B_WATCHDOG_MS = 25_000;

/**
 * The child script: writes `total` lines of ~490 bytes (respecting pipe
 * backpressure) with `delayMs` between them, stops at `deadlineMs`, and is
 * force-exited by an INDEPENDENT watchdog timer at `watchdogMs` — the
 * watchdog is what bounds the child's life while it is blocked inside a
 * backpressured write (the loop deadline is unreachable from there). It
 * prints CHILD-DONE only when it actually wrote every line; a truncated
 * child prints CHILD-CUTOFF on stderr instead.
 */
function childScript(
  total: number,
  delayMs: number,
  deadlineMs: number,
  watchdogMs: number,
): string {
  return `
const TOTAL = ${total};
const DELAY = ${delayMs};
const DEADLINE = ${deadlineMs};
const started = Date.now();
let i = 0;
const watchdog = setTimeout(() => {
  process.stderr.write("CHILD-WATCHDOG " + i + "\\n");
  process.exit(0);
}, ${watchdogMs});
async function main() {
  process.stdout.write("CHILD-START\\n");
  while (i < TOTAL) {
    if (Date.now() - started > DEADLINE) break;
    const ok = process.stdout.write("LINE " + i + " " + "x".repeat(480) + "\\n");
    i++;
    if (!ok) await new Promise((r) => process.stdout.once("drain", r));
    await new Promise((r) => setTimeout(r, DELAY));
  }
  clearTimeout(watchdog);
  if (i >= TOTAL) process.stdout.write("CHILD-DONE " + i + "\\n");
  else process.stderr.write("CHILD-CUTOFF " + i + "\\n");
  process.exit(0);
}
main();
`;
}

interface LogSink {
  stdoutChunks: string[];
  stderrChunks: string[];
  /** Chunks whose fs append actually completed (the kept-on-timeout part). */
  fsAppends: number;
  warns: Array<{ fields: Record<string, unknown>; msg: string }>;
  infos: Array<{ fields: Record<string, unknown>; msg: string }>;
  advisories: Array<{ message: string; err: unknown }>;
  logPath?: string;
}

/** What the drain had taken out of the pipe at the moment the detector fired. */
interface StallSnapshot {
  drainedChunks: number;
  drainedLines: number;
  sawChildDone: boolean;
  errorText: string;
}

function makeSink(): LogSink {
  return {
    stdoutChunks: [],
    stderrChunks: [],
    fsAppends: 0,
    warns: [],
    infos: [],
    advisories: [],
  };
}

type OnLog = (stream: "stdout" | "stderr", chunk: string) => Promise<void>;

/**
 * Bounded await: every wait in this file is bounded, so a hung seam fails the
 * test with a named timeout instead of hanging the run.
 */
async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label}: timed out after ${ms}ms`)),
          ms,
        );
        if (typeof timer.unref === "function") timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The heartbeat-shaped onLog: every chunk's persist section (a real fs
 * append) is the persistWork; `boundTimeoutMs` selects the wiring.
 *   - null  -> pre-PR#227 shape: the persist is awaited directly. The drain
 *              bound race is genuinely absent from the path (the env var
 *              cannot express "no bound": 0/garbage fall back to 3000ms).
 *   - number -> the production race (runOnLogPersistenceWithTimeout) with
 *              the timeout resolved through the real env seam
 *              (PAPERCLIP_ONLOG_TIMEOUT_MS), and the production warn sink
 *              captured so `progress_flush_dropped` is observable.
 * The chunk at `hangIndex` on `hangStream` has a persist that never completes
 * until `releaseHang` resolves — the "hung onLog persist" (a stuck DB write
 * in production). The race never cancels it: when the gate later opens, the
 * fs append still lands, exactly like production's late-settle guard.
 */
function makeHeartbeatShapedOnLog(sink: LogSink, opts: {
  boundTimeoutMs: number | null;
  hangStream: "stdout" | "stderr";
  hangIndex: number;
  hangGate: Promise<void>;
  runId: string;
}): OnLog {
  let seq = 0;
  let queueDepth = 0;
  return async (stream, chunk) => {
    // Production entry shape (heartbeat.ts:24830-24843): queue depth first,
    // one entry timestamp, ONE sampled roll per chunk, and the onLog_start
    // line through the REAL buildOnLogStartFields helper — so at sample rate
    // 1 the fixture captures both production instrumentation lines
    // (onLog_start AND onLog_resolve), not a lookalike.
    queueDepth += 1;
    const onLogEntryMs = Date.now();
    const sampled = shouldSampleOnLogInstrumentation();
    if (sampled) {
      sink.infos.push({
        fields: buildOnLogStartFields({
          source: stream,
          queue: queueDepth,
          runId: opts.runId,
        }),
        msg: "onLog_start",
      });
    }
    const chunkSeq = seq++;
    if (stream === "stdout") sink.stdoutChunks.push(chunk);
    else sink.stderrChunks.push(chunk);
    const isHung = stream === opts.hangStream && chunkSeq === opts.hangIndex;
    const persistWork = (async () => {
      if (isHung) await opts.hangGate;
      await fs.appendFile(sink.logPath as string, chunk);
      sink.fsAppends += 1;
    })();
    if (opts.boundTimeoutMs === null) {
      // Pre-PR#227 shape: no race on the path — the hang blocks the caller.
      await persistWork;
      return;
    }
    await runOnLogPersistenceWithTimeout({
      persistWork,
      // Real seam: PAPERCLIP_ONLOG_TIMEOUT_MS resolved through
      // resolveOnLogDrainTimeoutMs (short window for test speed).
      timeoutMs: resolveOnLogDrainTimeoutMs(),
      onLogEntryMs,
      // Real seam: the same entry roll the production onLog makes
      // (PAPERCLIP_ONLOG_INSTRUMENT_SAMPLE read once per chunk).
      sampled,
      currentStage: () => "fs",
      stageElapsedMs: { fs: 0, db_flush: 0, heartbeat_touch: 0 },
      runId: opts.runId,
      log: {
        info: (fields, msg) => sink.infos.push({ fields, msg }),
        warn: (fields, msg) => sink.warns.push({ fields, msg }),
      },
    });
  };
}

async function withEnv(
  env: Record<string, string>,
  fn: () => Promise<void>,
): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const touchedTempPaths: string[] = [];
afterAll(async () => {
  await Promise.all(
    touchedTempPaths.map((p) => fs.rm(p, { force: true, recursive: true })),
  );
});

describe("heartbeat onLog drain bound x stream-stall detector (SPA-13853 d7 E2E)", () => {
  let sink: LogSink;
  let hangGateOpen!: () => void;
  let hangGate: Promise<void>;

  beforeEach(() => {
    sink = makeSink();
    hangGate = new Promise<void>((resolve) => {
      hangGateOpen = resolve;
    });
  });

  afterEach(() => {
    // Release any still-hanging persist so no continuation outlives the test.
    hangGateOpen();
  });

  it("scenario A — without the onLog drain bound the detector fires and stdout stops draining", async () => {
    await withEnv(
      {
        [STALL_IDLE_ENV]: "200",
        [SETTLE_ENV]: "500",
        // Never sample here: scenario A's evidence is the stall, not the
        // instrumentation lines (scenario B owns those).
        [SAMPLE_ENV]: "0",
      },
      async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "spa13853-a-"));
        touchedTempPaths.push(dir);
        sink.logPath = path.join(dir, "run.log");

        // The stall advisory, and the drain state at the moment it fired.
        let snapshot: StallSnapshot | null = null;
        let resolveSnapshot!: (value: StallSnapshot) => void;
        const snapshotPromise = new Promise<StallSnapshot>((resolve) => {
          resolveSnapshot = resolve;
        });
        const onLogError = (err: unknown, _runId: string, message: string) => {
          sink.advisories.push({ message, err });
          if (message !== "stream_stall_detector" || snapshot) return;
          const drained = sink.stdoutChunks.join("");
          snapshot = {
            drainedChunks: sink.stdoutChunks.length,
            drainedLines: (drained.match(/LINE \d+/g) ?? []).length,
            sawChildDone: drained.includes("CHILD-DONE"),
            errorText: err instanceof Error ? err.message : String(err),
          };
          resolveSnapshot(snapshot);
        };

        const startedAt = Date.now();
        const runPromise = runChildProcess(
          randomUUID(),
          process.execPath,
          [
            "-e",
            childScript(
              A_TOTAL_LINES,
              A_LINE_DELAY_MS,
              A_DEADLINE_MS,
              A_WATCHDOG_MS,
            ),
          ],
          {
            cwd: process.cwd(),
            env: {},
            // Far above the stall window so `timeoutSec` cannot be the killer.
            timeoutSec: 120,
            graceSec: 1,
            onLog: makeHeartbeatShapedOnLog(sink, {
              boundTimeoutMs: null,
              hangStream: "stdout",
              hangIndex: 0,
              hangGate,
              runId: "spa13853-e2e-a",
            }),
            onLogError,
          },
        );
        // Bounded wait for the detector: the advisory must arrive (the
        // detector's first poll is its production 1000ms default).
        const seen = await withDeadline(
          snapshotPromise,
          20_000,
          "scenario A: stall advisory never arrived",
        );
        // Release the hung persist so the reader resumes and the run can
        // settle — the child is killed by the cgroup fence when a systemd
        // user session exists, and exits on its own deadline/watchdog when
        // it does not.
        hangGateOpen();
        const result = await withDeadline(
          runPromise,
          30_000,
          "scenario A: runChildProcess never settled",
        );
        const elapsedMs = Date.now() - startedAt;

        // The detector FIRED and surfaced through onLogError.
        expect(seen).not.toBeNull();
        expect(
          sink.advisories.some((a) => a.message === "stream_stall_detector"),
        ).toBe(true);
        expect(seen.errorText).toContain("model stream stalled");

        // stdout STOPPED DRAINING: at the moment the detector fired the
        // reader was still parked on the hung first chunk's persist, so the
        // drain had taken only the first chunk(s) out of the pipe — the
        // ~64KB kernel pipe was filling and the child's writes were
        // blocking. Nothing like the child's total had been drained.
        expect(seen.drainedChunks).toBeLessThanOrEqual(3);
        expect(seen.drainedLines).toBeLessThan(A_TOTAL_LINES / 10);
        expect(seen.sawChildDone).toBe(false);

        // The child never finished its lines: it was blocked in write() on
        // the full pipe while the reader stayed parked, so the run's stdout
        // carries no CHILD-DONE and far fewer lines than the child was asked
        // to write.
        expect(result.stdout).not.toContain("CHILD-DONE");
        const drainedLines = (result.stdout.match(/LINE \d+/g) ?? []).length;
        expect(drainedLines).toBeLessThan(A_TOTAL_LINES);
        expect(drainedLines).toBeLessThan(A_TOTAL_LINES / 2);

        // The run was NOT a timeoutSec kill, and the detector's closed-class
        // code is on the result: `streamStalled` is sticky (set by onStall,
        // read by the close handler), so a run that resolves AFTER the
        // detector fired carries it.
        expect(result.timedOut).toBe(false);
        expect(result.errorCode).toBe(MODEL_STREAM_STALLED_ERROR_CODE);
        expect(elapsedMs).toBeLessThan(30_000);

        console.log(
          "SPA13853-A",
          JSON.stringify({
            advisoryFired: true,
            drainedChunksAtStall: seen.drainedChunks,
            drainedLinesAtStall: seen.drainedLines,
            drainedLinesAtEnd: drainedLines,
            childTotalLines: A_TOTAL_LINES,
            errorCode: result.errorCode,
            exitCode: result.exitCode,
            signal: result.signal,
            elapsedMs,
          }),
        );
      },
    );
  }, 60_000);

  it("scenario B — with the bound active the same hung onLog keeps stdout draining, logs progress_flush_dropped, and the run is not killed", async () => {
    await withEnv(
      {
        // Window must comfortably exceed the 150ms drop bound plus event-loop jitter, so CI load cannot false-fire the detector in B.
        [STALL_IDLE_ENV]: "600",
        [SETTLE_ENV]: "500",
        // The card's pasted evidence: sample the onLog instrumentation so the
        // production `onLog_resolve` lines (with their awaiting= labels) are
        // emitted and captured.
        [SAMPLE_ENV]: "1",
        [ONLOG_DRAIN_TIMEOUT_ENV_VAR]: "150",
      },
      async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "spa13853-b-"));
        touchedTempPaths.push(dir);
        sink.logPath = path.join(dir, "run.log");
        const startedAt = Date.now();
        const result = await withDeadline(
          runChildProcess(
            randomUUID(),
            process.execPath,
            [
              "-e",
              childScript(
                B_TOTAL_LINES,
                B_LINE_DELAY_MS,
                B_DEADLINE_MS,
                B_WATCHDOG_MS,
              ),
            ],
            {
              cwd: process.cwd(),
              env: {},
              timeoutSec: 120,
              graceSec: 1,
              onLog: makeHeartbeatShapedOnLog(sink, {
                // Real seam: PAPERCLIP_ONLOG_TIMEOUT_MS resolved through
                // resolveOnLogDrainTimeoutMs (short window for test speed).
                boundTimeoutMs: 150,
                hangStream: "stdout",
                hangIndex: 0,
                hangGate,
                runId: "spa13853-e2e-b",
              }),
              onLogError: (err, _runId, message) => {
                sink.advisories.push({ message, err });
              },
            },
          ),
          30_000,
          "scenario B: runChildProcess never settled",
        );
        const elapsedMs = Date.now() - startedAt;

        // The run was NOT killed by the stall detector even though the very
        // first stdout chunk's persist hung: the bound dropped the wait, the
        // reader resumed, and every subsequent chunk kept touching the
        // detector (idle gaps stay far under the 600ms window).
        expect(result.errorCode).toBeNull();
        expect(result.errorCode).not.toBe(MODEL_STREAM_STALLED_ERROR_CODE);
        expect(result.timedOut).toBe(false);
        expect(result.exitCode).toBe(0);
        expect(
          sink.advisories.some((a) => a.message === "stream_stall_detector"),
        ).toBe(false);

        // stdout KEEPS draining: the child ran to completion and every line
        // was drained through runChildProcess's capture.
        expect(result.stdout).toContain("CHILD-DONE");
        const drainedLines = (result.stdout.match(/LINE \d+/g) ?? []).length;
        expect(drainedLines).toBe(B_TOTAL_LINES);
        // resumeReadable happened (continued reads), observable as many
        // onLog invocations after the single hung chunk.
        expect(sink.stdoutChunks.length).toBeGreaterThanOrEqual(10);

        // The dropped wait is visible in the production warn sink.
        const dropped = sink.warns.filter(
          (w) => w.msg === "progress_flush_dropped",
        );
        expect(dropped.length).toBeGreaterThanOrEqual(1);
        expect(dropped[0]?.fields.runId).toBe("spa13853-e2e-b");
        expect(dropped[0]?.fields.awaiting).toBe("fs");

        // The production onLog instrumentation is captured too: at least one
        // `onLog_resolve` line, carrying its `awaiting` label.
        const resolves = sink.infos.filter((i) => i.msg === "onLog_resolve");
        expect(resolves.length).toBeGreaterThanOrEqual(1);
        expect(resolves[0]?.fields.awaiting).toBeDefined();
        expect(
          resolves.every((i) =>
            ["fs", "db_flush", "heartbeat_touch"].includes(
              String(i.fields.awaiting),
            ),
          ),
        ).toBe(true);

        // And the matching `onLog_start` lines, through the REAL
        // buildOnLogStartFields helper (source/queue/runId fields), paired
        // 1:1 with the resolves because both gate on the same entry roll.
        const starts = sink.infos.filter((i) => i.msg === "onLog_start");
        expect(starts.length).toBeGreaterThanOrEqual(1);
        expect(starts[0]?.fields.source).toBe("stdout");
        expect(starts[0]?.fields.runId).toBe("spa13853-e2e-b");
        expect(typeof starts[0]?.fields.queue).toBe("number");
        expect(starts.length).toBe(resolves.length);

        // The race never cancels the work: once the hang gate opens, the
        // delayed chunk's fs append still lands (late-settle guard).
        hangGateOpen();
        const deadline = Date.now() + 5_000;
        while (
          sink.fsAppends < sink.stdoutChunks.length &&
          Date.now() < deadline
        ) {
          await new Promise((r) => setTimeout(r, 25));
        }
        expect(sink.fsAppends).toBe(sink.stdoutChunks.length);
        expect(elapsedMs).toBeLessThan(30_000);

        console.log(
          "SPA13853-B",
          JSON.stringify({
            linesDrained: drainedLines,
            childTotalLines: B_TOTAL_LINES,
            progressFlushDropped: dropped.length,
            onLogResolveLines: resolves.length,
            errorCode: result.errorCode,
            exitCode: result.exitCode,
            elapsedMs,
          }),
        );
        console.log(
          "SPA13853-B-ONLOG-START",
          JSON.stringify(starts.slice(0, 5).map((i) => i.fields)),
        );
        console.log(
          "SPA13853-B-ONLOG-RESOLVE",
          JSON.stringify(resolves.slice(0, 5).map((i) => i.fields)),
        );
      },
    );
  }, 60_000);
});
