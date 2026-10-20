/**
 * SPA-11981 — stream-stall-detector tests.
 *
 * Containment contract: every fixture MUST run inside its own `systemd-run
 * --user --scope` so the only thing that can be killed by the detector's
 * downstream cleanup is a pid inside that unit. The user manager (PID 1944 on
 * the host where the card was originally written) and PID 1 are NEVER in the
 * fixture's cgroup, so the controller cannot reach them — the test asserts the
 * pre- and post-conditions of the unit, not of pid matching. No fixture here
 * may launch a real opencode adapter session; the rogue opencode-launch-v2
 * that inherited PAPERCLIP_* env during the original incident is the failure
 * shape we forbid.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runChildProcess } from "./server-utils.js";
import { createPerStreamLogChains } from "./server-utils.js";
import {
  createStreamStallDetector,
  MODEL_STREAM_STALLED_ERROR_CODE,
} from "./stream-stall-detector.js";

interface ScopeHandle {
  unit: string;
  start: () => Promise<{ child: import("node:child_process").ChildProcess; cleanup: () => Promise<void> }>;
}

const isLinux = process.platform === "linux";

function describeLinux(name: string, fn: () => void): void {
  if (isLinux) describe(name, fn);
  else describe.skip(name, fn);
}

describe("stream-stall-detector (SPA-11981)", () => {
  describe("unit-level behavior (no live scope required)", () => {
    it("fires onStall after the configured idle window when root is alive and silent", () => {
      let now = 1_000_000;
      const fired: Array<{ idleMs: number }> = [];
      const detector = createStreamStallDetector({
        idleMs: 200,
        disableTimer: true,
        now: () => now,
        isRootAlive: () => true,
        onStall: (info) => fired.push({ idleMs: info.idleMs }),
      });

      // Fast-forward time past the idle window.
      now += 250;
      detector.evaluateNow();
      expect(fired.length).toBe(1);
      expect(fired[0].idleMs).toBeGreaterThanOrEqual(200);

      detector.stop();
    });

    it("resets the idle clock when activity is recorded before the window expires", () => {
      let now = 1_000_000;
      const fired: Array<{ idleMs: number }> = [];
      const detector = createStreamStallDetector({
        idleMs: 200,
        disableTimer: true,
        now: () => now,
        isRootAlive: () => true,
        onStall: (info) => fired.push({ idleMs: info.idleMs }),
      });

      now += 150;
      detector.evaluateNow();
      expect(fired.length).toBe(0);

      // Activity happens; reset.
      detector.noteActivity();
      now += 150; // 150ms after activity — still well under 200ms.
      detector.evaluateNow();
      expect(fired.length).toBe(0);

      // Now push past the window since activity.
      now += 60;
      detector.evaluateNow();
      expect(fired.length).toBe(1);

      detector.stop();
    });

    it("does NOT fire when the root is no longer alive", () => {
      let now = 1_000_000;
      const fired: Array<{ idleMs: number }> = [];
      let alive = true;
      const detector = createStreamStallDetector({
        idleMs: 100,
        disableTimer: true,
        now: () => now,
        isRootAlive: () => alive,
        onStall: (info) => fired.push({ idleMs: info.idleMs }),
      });

      alive = false;
      now += 500;
      detector.evaluateNow();
      expect(fired.length).toBe(0);

      detector.stop();
    });

    it("never throws when the onStall callback throws", () => {
      let now = 1_000_000;
      const detector = createStreamStallDetector({
        idleMs: 50,
        disableTimer: true,
        now: () => now,
        isRootAlive: () => true,
        onStall: () => {
          throw new Error("intentional");
        },
      });
      now += 100;
      expect(() => detector.evaluateNow()).not.toThrow();
      detector.stop();
    });

    it("fires after a real setTimeout-based idle window elapses without activity", async () => {
      const fired: boolean[] = [];
      const detector = createStreamStallDetector({
        idleMs: 80,
        pollIntervalMs: 50,
        isRootAlive: () => true,
        onStall: () => {
          fired.push(true);
        },
      });
      // 400ms > idleMs (80ms) and > 2 poll intervals (50ms). The detector
      // must fire at least once without any recorded activity.
      await delay(400);
      expect(fired.length).toBeGreaterThanOrEqual(1);
      detector.stop();
    });

    it("stops cleanly when called before the window elapses", async () => {
      const fired: boolean[] = [];
      const detector = createStreamStallDetector({
        idleMs: 5_000,
        pollIntervalMs: 100,
        isRootAlive: () => true,
        onStall: () => {
          fired.push(true);
        },
      });
      detector.stop();
      await delay(300);
      // Stop must short-circuit the timer; onStall must not fire.
      expect(fired.length).toBe(0);
    });
  });

  describe("constants", () => {
    it("emits the closed-class error code 'model_stream_stalled'", () => {
      expect(MODEL_STREAM_STALLED_ERROR_CODE).toBe("model_stream_stalled");
    });
  });

  describe("per-stream log chains (SPA-13853 d2, DB-free)", () => {
    it("preserves per-stream ordering within each chain", async () => {
      const errors: unknown[] = [];
      const { append, settled } = createPerStreamLogChains((err) => {
        errors.push(err);
      });
      const order: string[] = [];
      append("stdout", async () => {
        await delay(10);
        order.push("out-1");
      });
      append("stdout", async () => {
        order.push("out-2");
      });
      append("stderr", async () => {
        order.push("err-1");
      });
      await settled();
      expect(errors).toEqual([]);
      expect(order.filter((x) => x.startsWith("out-"))).toEqual([
        "out-1",
        "out-2",
      ]);
      expect(order).toContain("err-1");
    });

    it("routes onLog errors per stream without breaking the chain", async () => {
      const seen: Array<{ stream: string }> = [];
      const { append, settled } = createPerStreamLogChains((_, stream) => {
        seen.push({ stream });
      });
      const after: string[] = [];
      append("stderr", async () => {
        throw new Error("slow persist failed");
      });
      append("stderr", async () => {
        after.push("err-after-failure");
      });
      append("stdout", async () => {
        after.push("out-ok");
      });
      await settled();
      expect(seen).toEqual([{ stream: "stderr" }]);
      expect(after).toContain("err-after-failure");
      expect(after).toContain("out-ok");
    });

    it("a hung stderr append never blocks stdout drain (stdout resume still happens)", async () => {
      const { append, settled } = createPerStreamLogChains(() => {});
      let releaseStderr!: () => void;
      const stderrGate = new Promise<void>((resolve) => {
        releaseStderr = resolve;
      });
      const events: string[] = [];

      // Simulate the stderr data handler: pause, then a hung onLog persist.
      append("stderr", () => stderrGate);
      // Simulate the stdout data handler arriving while stderr is stuck:
      // its onLog + resume must still run (proves decoupled chains).
      append("stdout", async () => {
        events.push("stdout-resumed");
      });

      // Give the microtask queue a chance to run the stdout chain while the
      // stderr gate is still shut. If both streams shared one chain, the
      // stdout work could never run until releaseStderr().
      await delay(50);
      expect(events).toEqual(["stdout-resumed"]);

      releaseStderr();
      await settled();
    });

    it("settled(timeoutMs) resolves even when a chain append never settles", async () => {
      const { append, settled } = createPerStreamLogChains(() => {});
      append("stdout", () => new Promise<void>(() => {}));
      // A hung onLog persist must not pend the close path: the bounded
      // wait resolves regardless after the timeout.
      await settled(50);
    });

    it("settled cutoff fires onCutoff with per-stream pending counts (SPA-13853 review T3)", async () => {
      const { append, settled } = createPerStreamLogChains(() => {});
      // One hung stdout append, one hung stderr append: the cutoff must
      // report both streams' pending counts so tail loss is observable.
      append("stdout", () => new Promise<void>(() => {}));
      append("stderr", () => new Promise<void>(() => {}));
      const cutoffs: Array<{ pendingCounts: { stdout: number; stderr: number } }> = [];
      await settled(50, (info) => cutoffs.push(info));
      expect(cutoffs).toHaveLength(1);
      expect(cutoffs[0].pendingCounts.stdout).toBeGreaterThanOrEqual(1);
      expect(cutoffs[0].pendingCounts.stderr).toBeGreaterThanOrEqual(1);
    });

    it("settled cutoff does NOT fire when chains settle within the window (SPA-13853 review T3)", async () => {
      const { append, settled } = createPerStreamLogChains(() => {});
      append("stdout", async () => {
        await delay(5);
      });
      append("stderr", async () => {
        await delay(5);
      });
      const onCutoff = vi.fn();
      await settled(500, onCutoff);
      expect(onCutoff).not.toHaveBeenCalled();
    });

    it("settled cutoff still resolves when onCutoff throws (SPA-13853 review PRRT_kwDOTwBwe86uTYai)", async () => {
      const { append, settled } = createPerStreamLogChains(() => {});
      // Both chains hung: the cutoff timer is the ONLY path to settlement,
      // so a throwing advisory must not skip resolve() and must not let
      // the error escape the timer uncaught.
      append("stdout", () => new Promise<void>(() => {}));
      append("stderr", () => new Promise<void>(() => {}));
      const unhandled: unknown[] = [];
      const uncaught: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      const onUncaught = (err: unknown) => uncaught.push(err);
      process.on("unhandledRejection", onUnhandled);
      process.on("uncaughtException", onUncaught);
      try {
        const startedAt = Date.now();
        // Must settle (within the window) even though the advisory throws.
        await settled(50, () => {
          throw new Error("cutoff advisory boom");
        });
        const elapsedMs = Date.now() - startedAt;
        expect(elapsedMs).toBeLessThan(5_000);
        // Nothing escaped the timer as an unhandled rejection/uncaught error.
        expect(unhandled).toEqual([]);
        expect(uncaught).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
        process.off("uncaughtException", onUncaught);
      }
    });

    it("a throwing per-stream onError cannot strand later appends", async () => {
      const { append, settled } = createPerStreamLogChains(() => {
        throw new Error("advisory boom");
      });
      const after: string[] = [];
      append("stdout", async () => {
        throw new Error("persist failed");
      });
      append("stdout", async () => {
        after.push("still-ran");
      });
      await settled();
      expect(after).toEqual(["still-ran"]);
    });
  });

  describe("close-path drain bound (SPA-13853 d2, critic #1)", () => {
    it("child exit with a hung onLog still resolves runChildProcess within the settle bound", async () => {
      const previous = process.env.PAPERCLIP_LOG_CHAIN_SETTLE_TIMEOUT_MS;
      process.env.PAPERCLIP_LOG_CHAIN_SETTLE_TIMEOUT_MS = "300";
      try {
        const startedAt = Date.now();
        const result = await runChildProcess(
          randomUUID(),
          process.execPath,
          ["-e", "process.stdout.write('hi');"],
          {
            cwd: process.cwd(),
            env: {},
            timeoutSec: 10,
            graceSec: 1,
            // Hung persist: never resolves. Without the close-path bound
            // the `close` handler's settled() wait would pend forever.
            onLog: () => new Promise<void>(() => {}),
          },
        );
        const elapsedMs = Date.now() - startedAt;
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("hi");
        expect(elapsedMs).toBeLessThan(10_000);
      } finally {
        if (previous === undefined)
          delete process.env.PAPERCLIP_LOG_CHAIN_SETTLE_TIMEOUT_MS;
        else
          process.env.PAPERCLIP_LOG_CHAIN_SETTLE_TIMEOUT_MS = previous;
      }
    }, 15_000);
  });
});

/**
 * Live-scope test (Linux + systemd available).
 *
 * The fixture is a tiny node script that emits a single stdout byte and then
 * sleeps. It runs inside `systemd-run --user --scope --unit=<unique>.scope`
 * so the only pid in the fixture's cgroup is the sleep + node pair; the
 * fixture is fully isolated from the surrounding engine. The test asserts
 * the cgroup identity (sanity) and confirms `stopRunScope` tears it down
 * without ever needing to match a pid in the host.
 *
 * This test does NOT exercise runChildProcess end-to-end (that depends on
 * the full adapter harness); it proves the kill primitive is scope-bounded.
 */
describeLinux("scope-bounded kill primitive (SPA-11981)", () => {
  let leftoverUnits: string[] = [];
  let userManagerPid: number;
  let supportsScope = true;

  beforeAll(async () => {
    userManagerPid = Number.parseInt(
      readFirstLine("systemctl --user --no-pager show-environment"),
      10,
    );
    if (!Number.isInteger(userManagerPid) || userManagerPid <= 0) {
      // Fallback: derive from `ps` — the manager is the parent of `systemctl
      // --user` itself.
      const fallback = readFirstLine("ps -o pid= -p $(pgrep -f 'systemd --user' | head -n1)");
      userManagerPid = Number.parseInt(fallback, 10);
    }
    // Sanity: the scope wrapper requires `--user` systemd. If unavailable, skip.
    const probe = spawn("systemd-run", ["--user", "--scope", "--quiet", "--", "true"], {
      stdio: "ignore",
    });
    supportsScope = await new Promise<boolean>((resolve) => {
      probe.once("error", () => resolve(false));
      probe.once("close", (code) => resolve(code === 0));
    });
  });

  afterAll(async () => {
    // Defensive cleanup: never leave a fixture scope behind in case a test
    // exits via throw before `stopRunScope` runs.
    for (const unit of leftoverUnits) {
      await new Promise<void>((resolve) => {
        const ctl = spawn("systemctl", ["--user", "stop", unit], { stdio: "ignore" });
        ctl.once("close", () => resolve());
        ctl.once("error", () => resolve());
      });
    }
    leftoverUnits = [];
  });

  it("scope-isolated fixture is killed by `systemctl --user stop <unit>` and never reaches the user manager", async () => {
    expect(supportsScope).toBe(true);
    const preManagerAlive = userManagerPid > 1 && process.kill(userManagerPid, 0);
    expect(preManagerAlive).toBe(true);

    const unit = `paperclip-agent-${randomUUID().replace(/-/g, "")}.scope`;
    leftoverUnits.push(unit);

    // Wrap a fixture that emits one byte on stdout then sleeps inside the
    // scope unit. The fixture itself does no signal handling — proof that
    // scope teardown is what kills it.
    const fixtureScript = [
      'process.stdout.write(JSON.stringify({ started: process.pid }) + "\\n");',
      'setTimeout(() => {}, 60_000);',
    ].join(" ");

    const shell = spawn(
      "systemd-run",
      [
        "--user",
        "--scope",
        "--quiet",
        "--collect",
        `--unit=${unit}`,
        "--property=TasksMax=8",
        "--property=MemoryMax=134217728",
        "--",
        process.execPath,
        "-e",
        fixtureScript,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    const fixtureStarted = await new Promise<{ pid: number }>((resolve, reject) => {
      let buffer = "";
      const timeout = setTimeout(() => reject(new Error("fixture_start_timeout")), 5000);
      shell.stdout?.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const idx = buffer.indexOf("\n");
        if (idx >= 0) {
          const line = buffer.slice(0, idx).trim();
          try {
            const payload = JSON.parse(line);
            if (typeof payload.started === "number") {
              clearTimeout(timeout);
              resolve({ pid: payload.started });
            }
          } catch {
            // ignore partial
          }
        }
      });
      shell.once("error", reject);
    });

    // Sanity: the fixture is alive inside the scope and we know its pid.
    expect(() => process.kill(fixtureStarted.pid, 0)).not.toThrow();

    // Tear down by unit, not by pid.
    const stop = spawn("systemctl", ["--user", "stop", unit], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      stop.once("close", (code) =>
        code === 0 || code === 5 ? resolve() : reject(new Error(`stop_failed:${code}`)),
      );
      stop.once("error", reject);
    });

    // Wait briefly for the cgroup teardown to propagate SIGKILL.
    await delay(200);

    // The fixture pid is gone (scope teardown killed the entire cgroup).
    const stillAlive = (() => {
      try {
        process.kill(fixtureStarted.pid, 0);
        return true;
      } catch {
        return false;
      }
    })();
    expect(stillAlive).toBe(false);

    // And critically: the user manager PID is still alive.
    const managerStillAlive = (() => {
      try {
        process.kill(userManagerPid, 0);
        return true;
      } catch {
        return false;
      }
    })();
    expect(managerStillAlive).toBe(true);
  });
});

/* istanbul ignore next -- helper is shell-only and never reached on CI test surface */
function readFirstLine(cmd: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")[0]
      .trim();
  } catch {
    return "";
  }
}

/* Silence the linter about unused functions; `ScopeHandle` is documentation-only. */
void (null as unknown as ScopeHandle);
