import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  HEARTBEAT_QUERY_DIAGNOSTIC_TAGS,
  HEARTBEAT_QUERY_DIAGNOSTIC_WINDOW_MS,
  createHeartbeatQueryDiagnostics,
  type HeartbeatQueryDiagnosticSummary,
} from "../services/heartbeat-query-diagnostics.js";

const WINDOW = HEARTBEAT_QUERY_DIAGNOSTIC_WINDOW_MS;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(options: {
  clock?: { value: number };
  emit?: (summary: HeartbeatQueryDiagnosticSummary) => void;
} = {}) {
  const clock = options.clock ?? { value: 1_000 };
  const emitted: HeartbeatQueryDiagnosticSummary[] = [];
  const diagnostics = createHeartbeatQueryDiagnostics({
    monotonicNow: () => clock.value,
    windowMs: WINDOW,
    emit: options.emit ?? ((summary) => emitted.push(summary)),
  });
  return {
    emitted,
    diagnostics,
    clock,
    advance: (ms: number) => {
      clock.value += ms;
    },
  };
}

const last = (emitted: HeartbeatQueryDiagnosticSummary[]) => emitted.at(-1)!;

const STATIC_FIELDS = ["event", "tag", "windowMs", "elapsedWindowMs"];
const NUMERIC_FIELDS = [
  "started",
  "completed",
  "failed",
  "inFlight",
  "peakInFlight",
  "successTotalDurationMs",
  "successMaxDurationMs",
  "failureTotalDurationMs",
  "failureMaxDurationMs",
];

const OWNERSHIP = HEARTBEAT_QUERY_DIAGNOSTIC_TAGS[0];
const WATCHDOG = HEARTBEAT_QUERY_DIAGNOSTIC_TAGS[1];
const REDACTION = HEARTBEAT_QUERY_DIAGNOSTIC_TAGS[2];

function measuredCall(source: string): { callIndex: number; body: string } {
  const callIndex = source.indexOf("measureHeartbeatQuery(HEARTBEAT_QUERY_DIAGNOSTIC_TAGS[");
  expect(callIndex).toBeGreaterThanOrEqual(0);
  expect(source.slice(callIndex - 6, callIndex)).toBe("await ");
  let depth = 0;
  let closeIndex = -1;
  for (let index = source.indexOf("(", callIndex); index < source.length; index++) {
    if (source[index] === "(") depth += 1;
    if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        closeIndex = index;
        break;
      }
    }
  }
  expect(closeIndex).toBeGreaterThan(callIndex);
  expect(source.slice(closeIndex + 1).trimStart().startsWith(";")).toBe(true);
  return { callIndex, body: source.slice(callIndex, closeIndex) };
}

function readWiringSources() {
  return {
    ownership: readFileSync(
      new URL("../services/conversation-continuation.ts", import.meta.url),
      "utf8",
    ),
    watchdog: readFileSync(
      new URL("../modules/active-run-watchdog/adapters/postgres.ts", import.meta.url),
      "utf8",
    ),
    redaction: readFileSync(
      new URL("../services/run-secret-redaction.ts", import.meta.url),
      "utf8",
    ),
  };
}

describe("heartbeat query diagnostics collector", () => {
  it("allowlists exactly the three fixed caller tags", () => {
    expect([...HEARTBEAT_QUERY_DIAGNOSTIC_TAGS]).toEqual([
      "conversation_ownership_blocker",
      "watchdog_candidate_silent_runs",
      "issue_secret_redaction_registry",
    ]);
    expect(new Set(HEARTBEAT_QUERY_DIAGNOSTIC_TAGS).size).toBe(
      HEARTBEAT_QUERY_DIAGNOSTIC_TAGS.length,
    );
    expect(WINDOW).toBe(60_000);
  });

  it("returns independent results and rejections without altering them", async () => {
    const { diagnostics } = harness();
    const failure = new Error("connection terminated unexpectedly");

    await expect(
      diagnostics.measure(OWNERSHIP, async () => "resolved-value"),
    ).resolves.toBe("resolved-value");
    await expect(
      diagnostics.measure(OWNERSHIP, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it("counts overlap as in-flight above one and tracks peak", async () => {
    const { diagnostics, emitted, advance } = harness();
    const first = deferred<string>();
    const second = deferred<string>();
    const third = deferred<string>();

    const a = diagnostics.measure(OWNERSHIP, () => first.promise);
    const b = diagnostics.measure(OWNERSHIP, () => second.promise);
    const c = diagnostics.measure(OWNERSHIP, () => third.promise);

    expect(emitted).toHaveLength(0);
    second.resolve("b");
    await b;
    third.resolve("c");
    await c;
    first.resolve("a");
    await a;

    expect(emitted).toHaveLength(0);
    advance(WINDOW);
    await diagnostics.measure(OWNERSHIP, async () => "next-window");

    const summary = last(emitted);
    expect(summary.tag).toBe(OWNERSHIP);
    expect(summary.started).toBe(3);
    expect(summary.completed).toBe(3);
    expect(summary.failed).toBe(0);
    expect(summary.inFlight).toBe(0);
    expect(summary.peakInFlight).toBe(3);
    expect(summary.successTotalDurationMs).toBe(0);
    expect(summary.successMaxDurationMs).toBe(0);
  });

  it("counts a rejection as failed without counting it completed", async () => {
    const { diagnostics, emitted, advance } = harness();
    await expect(
      diagnostics.measure(REDACTION, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    advance(WINDOW);
    await diagnostics.measure(REDACTION, async () => "next-window");

    const summary = last(emitted);
    expect(summary.started).toBe(1);
    expect(summary.completed).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.inFlight).toBe(0);
  });

  it("accumulates success duration separately from failure duration", async () => {
    const { diagnostics, emitted, advance } = harness();

    await diagnostics.measure(WATCHDOG, async () => {
      advance(250);
      return "ok-1";
    });
    await diagnostics.measure(WATCHDOG, async () => {
      advance(1_000);
      return "ok-2";
    });
    advance(WINDOW);
    await expect(
      diagnostics.measure(WATCHDOG, async () => {
        advance(40);
        throw new Error("failed-1");
      }),
    ).rejects.toThrow("failed-1");
    advance(WINDOW);
    await diagnostics.measure(WATCHDOG, async () => "next-window");

    expect(emitted).toHaveLength(2);
    expect(emitted[0].completed).toBe(2);
    expect(emitted[0].failed).toBe(0);
    expect(emitted[0].successTotalDurationMs).toBe(1_250);
    expect(emitted[0].successMaxDurationMs).toBe(1_000);
    expect(emitted[0].failureTotalDurationMs).toBe(0);
    expect(emitted[0].failureMaxDurationMs).toBe(0);

    expect(emitted[1].completed).toBe(0);
    expect(emitted[1].failed).toBe(1);
    expect(emitted[1].successTotalDurationMs).toBe(0);
    expect(emitted[1].successMaxDurationMs).toBe(0);
    expect(emitted[1].failureTotalDurationMs).toBe(40);
    expect(emitted[1].failureMaxDurationMs).toBe(40);
  });

  it("logs at most one aggregate per window and resets counts across windows", async () => {
    const { diagnostics, emitted, advance } = harness();

    for (const value of ["one", "two", "three", "four", "five"]) {
      await diagnostics.measure(WATCHDOG, async () => value);
    }
    expect(emitted).toHaveLength(0);

    advance(WINDOW);
    await diagnostics.measure(WATCHDOG, async () => "six");
    expect(emitted).toHaveLength(1);
    expect(emitted[0].started).toBe(5);
    expect(emitted[0].completed).toBe(5);
    expect(emitted[0].failed).toBe(0);
    expect(emitted[0].inFlight).toBe(0);

    await diagnostics.measure(WATCHDOG, async () => "seven");
    await diagnostics.measure(WATCHDOG, async () => "eight");
    expect(emitted).toHaveLength(1);

    advance(WINDOW);
    await diagnostics.measure(WATCHDOG, async () => "nine");
    expect(emitted).toHaveLength(2);
    expect(emitted[1].started).toBe(3);
    expect(emitted[1].completed).toBe(3);
  });

  it("closes a window at the exact boundary and not one millisecond short", async () => {
    const { diagnostics, emitted, advance } = harness();

    await diagnostics.measure(OWNERSHIP, async () => "first");
    advance(WINDOW - 1);
    await diagnostics.measure(OWNERSHIP, async () => "still-inside");
    expect(emitted).toHaveLength(0);

    advance(1);
    await diagnostics.measure(OWNERSHIP, async () => "boundary");
    expect(emitted).toHaveLength(1);
    expect(emitted[0].started).toBe(2);
    expect(emitted[0].completed).toBe(2);
    expect(emitted[0].elapsedWindowMs).toBe(WINDOW);
  });

  it("reports the real elapsed window after a long idle gap instead of the nominal width", async () => {
    const { diagnostics, emitted, advance } = harness();

    await diagnostics.measure(OWNERSHIP, async () => "only-call");
    advance(3_600_000);
    await diagnostics.measure(OWNERSHIP, async () => "after-hour-idle");

    expect(emitted).toHaveLength(1);
    expect(emitted[0].windowMs).toBe(WINDOW);
    expect(emitted[0].elapsedWindowMs).toBe(3_600_000);
    expect(emitted[0].started).toBe(1);
    expect(emitted[0].completed).toBe(1);
  });

  it("assigns a completion that lands in a later window to the window it completed in", async () => {
    const { diagnostics, emitted, advance } = harness();
    const pending = deferred<string>();

    const open = diagnostics.measure(OWNERSHIP, () => pending.promise);
    advance(WINDOW);
    pending.resolve("landed-after-boundary");
    await open;

    expect(emitted).toHaveLength(1);
    expect(emitted[0].started).toBe(1);
    expect(emitted[0].completed).toBe(0);
    expect(emitted[0].inFlight).toBe(1);

    advance(WINDOW);
    await diagnostics.measure(OWNERSHIP, async () => "close-next");

    expect(emitted).toHaveLength(2);
    expect(emitted[1].started).toBe(0);
    expect(emitted[1].completed).toBe(1);
    expect(emitted[1].failed).toBe(0);
    expect(emitted[1].inFlight).toBe(0);
    expect(emitted[1].successTotalDurationMs).toBe(WINDOW);
  });

  it("emits a window that recorded only a failure, with no start", async () => {
    const { diagnostics, emitted, advance } = harness();
    const pending = deferred<string>();

    const open = diagnostics.measure(REDACTION, () => pending.promise);
    advance(WINDOW);
    pending.reject(new Error("failed after the boundary"));
    await expect(open).rejects.toThrow("failed after the boundary");

    expect(emitted).toHaveLength(1);
    expect(emitted[0].started).toBe(1);
    expect(emitted[0].completed).toBe(0);
    expect(emitted[0].failed).toBe(0);
    expect(emitted[0].inFlight).toBe(1);

    advance(WINDOW);
    await diagnostics.measure(REDACTION, async () => "next");

    expect(emitted).toHaveLength(2);
    expect(emitted[1].failed).toBe(1);
    expect(emitted[1].completed).toBe(0);
  });

  it("carries the retained in-flight count forward as the next window's peak", async () => {
    const { diagnostics, emitted, advance } = harness();
    const first = deferred<string>();
    const second = deferred<string>();

    const a = diagnostics.measure(OWNERSHIP, () => first.promise);
    const b = diagnostics.measure(OWNERSHIP, () => second.promise);
    advance(WINDOW);
    await diagnostics.measure(OWNERSHIP, async () => "closing-call");

    expect(emitted).toHaveLength(1);
    expect(emitted[0].inFlight).toBe(2);
    expect(emitted[0].peakInFlight).toBe(2);

    first.resolve("a");
    second.resolve("b");
    await Promise.all([a, b]);

    advance(WINDOW);
    await diagnostics.measure(OWNERSHIP, async () => "after");

    expect(emitted).toHaveLength(2);
    expect(emitted[1].inFlight).toBe(0);
    expect(emitted[1].peakInFlight).toBe(3);
    expect(emitted[1].started).toBe(1);
    expect(emitted[1].completed).toBe(3);
  });

  it("emits nothing for an unmeasured caller tag", async () => {
    const { diagnostics, emitted, advance } = harness();
    await diagnostics.measure("not_a_known_caller" as never, async () => "x");
    advance(WINDOW);
    await diagnostics.measure("not_a_known_caller" as never, async () => "y");
    expect(emitted).toHaveLength(0);
  });

  it("emits only static tag and numeric summary fields", async () => {
    const secret = "select * from heartbeat_runs where token = 'live-secret'";
    const { diagnostics, emitted, advance } = harness();
    await diagnostics.measure(OWNERSHIP, async () => secret);
    advance(WINDOW);
    await diagnostics.measure(OWNERSHIP, async () => "next");

    const summary = last(emitted);
    expect(Object.keys(summary).sort()).toEqual(
      [...STATIC_FIELDS, ...NUMERIC_FIELDS].sort(),
    );
    for (const field of STATIC_FIELDS) {
      expect(typeof summary[field as keyof HeartbeatQueryDiagnosticSummary]).not.toBe(
        "object",
      );
    }
    for (const field of NUMERIC_FIELDS) {
      const value = summary[field as keyof HeartbeatQueryDiagnosticSummary];
      expect(typeof value).toBe("number");
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(summary.windowMs).toBe(WINDOW);
    expect(summary.event).toBe("heartbeat_query_timing");
    expect(JSON.stringify(summary)).not.toContain("select");
    expect(JSON.stringify(summary)).not.toContain("live-secret");
  });

  it("never leaks an error message into the emitted summary", async () => {
    const { diagnostics, emitted, advance } = harness();
    await expect(
      diagnostics.measure(REDACTION, async () => {
        throw new Error("relation heartbeat_runs does not exist");
      }),
    ).rejects.toThrow("does not exist");
    advance(WINDOW);
    await diagnostics.measure(REDACTION, async () => "next");

    expect(emitted).toHaveLength(1);
    expect(JSON.stringify(emitted)).not.toContain("relation");
  });

  it("keeps the caller unaffected when the diagnostic sink throws or returns a promise", async () => {
    for (const emit of [
      () => {
        throw new Error("sink failure");
      },
      () => Promise.reject(new Error("async sink failure")),
      () => new Promise<void>(() => {}),
    ]) {
      const { diagnostics, advance } = harness({ emit });
      await expect(
        diagnostics.measure(OWNERSHIP, async () => "still-resolved"),
      ).resolves.toBe("still-resolved");
      await expect(
        diagnostics.measure(OWNERSHIP, async () => {
          throw new Error("still-rejected");
        }),
      ).rejects.toThrow("still-rejected");
      advance(WINDOW);
      await expect(
        diagnostics.measure(OWNERSHIP, async () => "still-resolved-again"),
      ).resolves.toBe("still-resolved-again");
      advance(WINDOW);
      await expect(
        diagnostics.measure(OWNERSHIP, async () => "still-resolved-third"),
      ).resolves.toBe("still-resolved-third");
    }
  });

  it("releases the in-flight slot even when the measured caller throws", async () => {
    const { diagnostics, emitted, advance } = harness();
    await expect(
      diagnostics.measure(OWNERSHIP, async () => {
        throw new Error("caller threw");
      }),
    ).rejects.toThrow("caller threw");
    advance(WINDOW);
    await diagnostics.measure(OWNERSHIP, async () => "next");

    expect(last(emitted).inFlight).toBe(0);
  });

  it("does not schedule timers or poll", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const { diagnostics, advance } = harness();
      await diagnostics.measure(OWNERSHIP, async () => "value");
      advance(WINDOW);
      await diagnostics.measure(OWNERSHIP, async () => "value-2");
      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(setTimeoutSpy).not.toHaveBeenCalled();
    } finally {
      setIntervalSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });

  it("keeps per-tag counters independent", async () => {
    const { diagnostics, emitted, advance } = harness();
    await diagnostics.measure(OWNERSHIP, async () => "ownership");
    await diagnostics.measure(WATCHDOG, async () => "watchdog-a");
    await diagnostics.measure(WATCHDOG, async () => "watchdog-b");
    await diagnostics.measure(REDACTION, async () => "redaction");

    advance(WINDOW);
    await diagnostics.measure(OWNERSHIP, async () => "ownership-2");
    advance(WINDOW);
    await diagnostics.measure(WATCHDOG, async () => "watchdog-c");
    advance(WINDOW);
    await diagnostics.measure(REDACTION, async () => "redaction-2");

    expect(emitted).toHaveLength(3);
    const byTag = new Map(emitted.map((entry) => [entry.tag, entry]));
    expect(byTag.get(OWNERSHIP)!.started).toBe(1);
    expect(byTag.get(WATCHDOG)!.started).toBe(2);
    expect(byTag.get(REDACTION)!.started).toBe(1);
  });

  it("wires exactly the three fixed tags around the three database awaits", () => {
    const { ownership, watchdog, redaction } = readWiringSources();

    expect(ownership.match(/measureHeartbeatQuery\(/g) ?? []).toHaveLength(1);
    expect(watchdog.match(/measureHeartbeatQuery\(/g) ?? []).toHaveLength(1);
    expect(redaction.match(/measureHeartbeatQuery\(/g) ?? []).toHaveLength(1);

    for (const source of [ownership, watchdog, redaction]) {
      expect(source).toMatch(
        /import\s*\{[^}]*HEARTBEAT_QUERY_DIAGNOSTIC_TAGS\s*,\s*measureHeartbeatQuery\s*,?[^}]*\}\s*from\s*"[^"]*heartbeat-query-diagnostics\.js"/s,
      );
      expect(source).toMatch(
        /measureHeartbeatQuery\(HEARTBEAT_QUERY_DIAGNOSTIC_TAGS\[\d\], \(\) =>/,
      );
    }

    expect(ownership).toMatch(
      /measureHeartbeatQuery\(HEARTBEAT_QUERY_DIAGNOSTIC_TAGS\[0\], \(\) =>/,
    );
    expect(watchdog).toMatch(
      /measureHeartbeatQuery\(HEARTBEAT_QUERY_DIAGNOSTIC_TAGS\[1\], \(\) =>/,
    );
    expect(redaction).toMatch(
      /measureHeartbeatQuery\(HEARTBEAT_QUERY_DIAGNOSTIC_TAGS\[2\], \(\) =>/,
    );

    expect(HEARTBEAT_QUERY_DIAGNOSTIC_TAGS[0]).toBe("conversation_ownership_blocker");
    expect(HEARTBEAT_QUERY_DIAGNOSTIC_TAGS[1]).toBe("watchdog_candidate_silent_runs");
    expect(HEARTBEAT_QUERY_DIAGNOSTIC_TAGS[2]).toBe("issue_secret_redaction_registry");
  });

  it("wraps each measured await without touching its query, predicates or transaction boundary", () => {
    const { ownership, watchdog, redaction } = readWiringSources();

    for (const source of [ownership, watchdog, redaction]) {
      const { body } = measuredCall(source);
      expect(body).toContain("=>");
      expect(body).toMatch(/\bdb\b[\s\S]{0,40}?\.select\(/);
      expect(body).not.toContain(".catch(");
      expect(body).not.toContain("?? ");
      expect(body).not.toContain("?.");
      expect(body).not.toContain("db.transaction");
      expect(body).not.toContain("tx.");
    }

    expect(ownership).toContain(
      "sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${issueId}`",
    );
    expect(ownership).toContain(
      'inArray(heartbeatRuns.status, ["failed", "timed_out", "interrupted", "cancelled"])',
    );
    expect(ownership).toContain(
      ".orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))",
    );
    expect(ownership).toContain("db.select({ run: heartbeatRuns, activeLease }).from(heartbeatRuns)");
    expect(watchdog).toContain('eq(heartbeatRuns.status, "running")');
    expect(watchdog).toContain(".limit(100)");
    expect(redaction).toContain(
      "sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`",
    );
    expect(redaction).toContain(
      "sql`${heartbeatRuns.contextSnapshot} -> 'paperclipIssue' ->> 'id' = ${issueId}`",
    );
    });
});